import { z } from "zod";
import { getAnthropicClient, AI_MODEL } from "./anthropic";
import { getGeminiApiKey, GEMINI_MODEL } from "./gemini";

// Day-relative shape the AI returns items in — the caller resolves `day`
// (1-indexed, relative to the trip start date) into absolute datetimes,
// since the AI shouldn't be trusted to do date arithmetic reliably.
export const proposedItemSchema = z.object({
  day: z.number().int().min(1),
  type: z.enum(["TRANSPORT", "STAY", "POI", "ACTIVITY", "OTHER"]),
  title: z.string(),
  time: z.string().nullable().optional(), // "HH:MM" 24h, optional
  durationHours: z.number().nullable().optional(),
  location: z.string().nullable().optional(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  notes: z.string().nullable().optional(),
  estimatedCost: z.number().nullable().optional(),
  // STAY items only: the nightly rate and night count, so the total is
  // computed deterministically by the app (costPerNight * nights) instead of
  // trusting the model's own arithmetic. Ignored for every other type.
  costPerNight: z.number().nullable().optional(),
  nights: z.number().int().nullable().optional(),
});

export const proposedItinerarySchema = z.object({
  items: z.array(proposedItemSchema),
  summary: z.string().optional(),
});

export type ProposedItinerary = z.infer<typeof proposedItinerarySchema>;

const ITEM_SHAPE_INSTRUCTIONS = `Respond ONLY with strict JSON (no markdown fences, no commentary) in this exact shape:
{
  "summary": "one or two sentence overview of the plan",
  "items": [
    {
      "day": 1,
      "type": "TRANSPORT" | "STAY" | "POI" | "ACTIVITY" | "OTHER",
      "title": "string",
      "time": "HH:MM or null",
      "durationHours": number or null,
      "location": "string or null",
      "lat": number or null,
      "lng": number or null,
      "notes": "string or null",
      "estimatedCost": number or null,
      "costPerNight": number or null,
      "nights": number or null
    }
  ]
}
"day" is 1-indexed relative to the first day of the trip. Use STAY once per lodging (checked in day, checked out on the departure day is fine to omit a duplicate). Use TRANSPORT for inter-city/inter-region movement and arrival/departure flights. Use POI for sights/landmarks, ACTIVITY for booked/planned activities (tours, classes, etc). Include "lat"/"lng" (decimal degrees) whenever you can identify a real, mappable place for the item (landmarks, hotels, neighborhoods, airports) — use your knowledge of the actual location, not a guess at the trip's general area. Leave both null for anything without a concrete single location (e.g. "free time", "travel day").

Every item that has a "time" set must have a window ("time"+"durationHours") exclusive of every other timed item's window that same day — the traveler can only be in one place at a time, so no two windows may overlap. In particular: if a drive includes a stop along the way (e.g. "drive to A, sightsee, then continue to B"), do NOT create one TRANSPORT item whose duration spans the whole thing — split it into two separate TRANSPORT legs ("A to the stop" and "the stop to B") with the POI/ACTIVITY item's window sitting between them, none overlapping. A TRANSPORT item's title should describe a single leg, not "X, then Y". This overlap rule doesn't apply to items with "time" left null (e.g. the daily Meals/Gas budget line items described below) — they're not scheduled against the day's timeline at all.

Critical: this output is parsed by a strict JSON parser. If any string value (title, location, notes, summary) itself contains a double-quote character — e.g. a nickname or quoted phrase like the "Golden Gate" — you MUST escape it as \\" so the JSON stays valid. Prefer rephrasing to avoid inner quotes entirely when possible. Do not include trailing commas. When writing "lat" and "lng", write each value exactly once immediately after its key ("lat": 44.59, "lng": -104.71) — never write a bare number a second time before the next key; that produces invalid JSON.

Cost estimates: keep in USD unless told otherwise, and only estimate when you have a reasonable basis. For a STAY item, do NOT compute a total yourself — instead set "costPerNight" (the nightly rate) and "nights" (how many nights this lodging covers) and leave "estimatedCost" null; the app multiplies them into the total, so your arithmetic is never trusted for this. For every other item type, use "estimatedCost" as the TOTAL dollar amount for that line covering every traveler (never per-person), and leave "costPerNight"/"nights" null.

"notes" for POI, ACTIVITY, and STAY items: this is shown to the traveler as the rationale for the pick, so always write 1-2 sentences covering (a) why this fits their stated goal/interests/traveler profiles specifically, not a generic description, and (b) what to actually expect there (pace, crowd level, what you'll see or do). For TRANSPORT/OTHER logistics items (gas, meals, transfers) keep "notes" to whatever practical context is useful (see the gas/fuel and meals guidance above) rather than a rationale.`;

const MAX_ITINERARY_TOKENS = 100_000;

// Retries the AI call + parse a few times. Two distinct failure modes here:
// - A formatting slip (an unescaped inner quote, a trailing comma) that
//   breaks JSON.parse but didn't hit the token cap — a fresh sample from the
//   same prompt reliably self-corrects, so retry at the same budget.
// - Genuine truncation (stop_reason "max_tokens") on a long itinerary (e.g. a
//   20+ night trip) — retrying at the same budget would just truncate at the
//   same point again and burn 3x the time for nothing, so bump the budget
//   instead and don't waste an attempt trying to parse the truncated text.
// Streaming (not .create()) is required once max_tokens gets large, to avoid
// the SDK's own client-side timeout on a long-running request.
// Sonnet 5 standard per-token rates ($/1M tokens); Anthropic may run a lower
// intro rate for a limited window, so treat this as an upper-bound estimate.
const INPUT_COST_PER_MTOK = 3;
const OUTPUT_COST_PER_MTOK = 15;

function logItineraryUsage(
  attempt: number,
  maxTokens: number,
  stopReason: string | null,
  usage: { input_tokens: number; output_tokens: number }
) {
  const cost =
    (usage.input_tokens / 1_000_000) * INPUT_COST_PER_MTOK +
    (usage.output_tokens / 1_000_000) * OUTPUT_COST_PER_MTOK;
  // eslint-disable-next-line no-console
  console.log(
    `[itineraryAi] attempt ${attempt} (max_tokens=${maxTokens}, stop_reason=${stopReason}): ` +
      `input=${usage.input_tokens} output=${usage.output_tokens} tokens, ~$${cost.toFixed(4)} (standard rate estimate)`
  );
}

async function requestProposedItinerary(
  client: NonNullable<ReturnType<typeof getAnthropicClient>>,
  system: string,
  prompt: string,
  initialMaxTokens: number,
  attempts = 3
): Promise<ProposedItinerary> {
  let lastErr: unknown;
  let maxTokens = initialMaxTokens;
  for (let i = 0; i < attempts; i++) {
    const response = await client.messages.stream({
      model: AI_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    }).finalMessage();

    logItineraryUsage(i + 1, maxTokens, response.stop_reason, response.usage);

    if (response.stop_reason === "max_tokens") {
      lastErr = new Error(
        `AI response was truncated at ${maxTokens} tokens — this trip may be too long to generate in one proposal. Try a shorter trip, or split it into separate trips.`
      );
      if (i < attempts - 1) {
        maxTokens = Math.min(MAX_ITINERARY_TOKENS, Math.round(maxTokens * 1.6));
      }
      continue;
    }

    const textBlock = response.content.find((b) => b.type === "text");
    const text = textBlock && "text" in textBlock ? textBlock.text : "{}";
    try {
      return parseProposedItinerary(text);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Fixes a specific but observed LLM slip on long generations: a stray bare
// number duplicated right before a property key, e.g.
// `"lat":44.5119,-109.0725,"lng":-109.0725` (should just be
// `"lat":44.5119,"lng":-109.0725`). A bare number can never legally precede a
// property key in JSON, so this is safe to strip.
function repairStrayNumericToken(text: string): string {
  return text.replace(/,\s*-?\d+(?:\.\d+)?\s*(?=,\s*"[A-Za-z_]+"\s*:)/g, "");
}

export function parseProposedItinerary(text: string): ProposedItinerary {
  const cleaned = text.trim().replace(/^```json\s*|^```\s*|```$/g, "");
  try {
    return proposedItinerarySchema.parse(JSON.parse(cleaned));
  } catch (err) {
    const repaired = repairStrayNumericToken(cleaned);
    if (repaired !== cleaned) {
      try {
        const result = proposedItinerarySchema.parse(JSON.parse(repaired));
        // eslint-disable-next-line no-console
        console.warn("[itineraryAi] Repaired a stray numeric token before parsing AI JSON response.");
        return result;
      } catch {
        // fall through to the original error below
      }
    }
    // eslint-disable-next-line no-console
    console.error("[itineraryAi] Failed to parse AI JSON response:\n", cleaned);
    throw err;
  }
}

export interface TravelerProfileInput {
  name: string;
  age?: number | null;
  homeLocation?: string | null;
  travelPreferences?: string | null;
  stayPreferences?: string | null;
  transportPreferences?: string | null;
  foodPreferences?: string | null;
  notes?: string | null;
}

export function formatTravelerProfilesBlock(travelers: TravelerProfileInput[] | null | undefined): string {
  if (!travelers || travelers.length === 0) return "No traveler profiles saved.";
  return `Traveler profiles:\n${travelers
    .map((t) => {
      const parts = [
        t.age != null ? `age ${t.age}` : null,
        t.homeLocation ? `home location: ${t.homeLocation}` : null,
        t.travelPreferences ? `travel preferences: ${t.travelPreferences}` : null,
        t.stayPreferences ? `hotel/stay preferences: ${t.stayPreferences}` : null,
        t.transportPreferences ? `transport preferences: ${t.transportPreferences}` : null,
        t.foodPreferences ? `food preferences: ${t.foodPreferences}` : null,
        t.notes ? `other notes: ${t.notes}` : null,
      ].filter(Boolean);
      return `- ${t.name}${parts.length ? ` (${parts.join("; ")})` : ""}`;
    })
    .join("\n")}`;
}

// Distinct home locations across traveler profiles, in profile order — used
// to anchor trip start/end points (outbound transport from home, return
// transport back to home) in AI-generated itineraries.
export function getHomeLocations(travelers: TravelerProfileInput[] | null | undefined): string[] {
  if (!travelers) return [];
  const seen = new Set<string>();
  const locations: string[] = [];
  for (const t of travelers) {
    const loc = t.homeLocation?.trim();
    if (loc && !seen.has(loc)) {
      seen.add(loc);
      locations.push(loc);
    }
  }
  return locations;
}

export function formatHomeLocationsInstruction(travelers: TravelerProfileInput[] | null | undefined): string {
  const homes = getHomeLocations(travelers);
  if (homes.length === 0) return "";
  return `The trip starts and ends at the travelers' home location(${homes.length > 1 ? "s" : ""}): ${homes.join(", ")}. Include the outbound TRANSPORT leg from home to the destination on day 1 and the return TRANSPORT leg from the destination back home on the last day, unless such legs are already covered elsewhere (e.g. a booked flight noted in extra context).`;
}

export interface ProposeItineraryInput {
  destinationName: string;
  destinationCountry?: string | null;
  destinationRegion?: string | null;
  destinationNotes?: string | null;
  destinationTags?: string[] | null;
  destinationBestSeason?: string | null;
  nights: number;
  startDate?: Date | null;
  endDate?: Date | null;
  travelSeason?: string | null;
  goal: string;
  goalDetail?: string;
  travelers: number;
  planningType: string;
  preferences?: { interests: string[]; pace?: string | null; budgetStyle?: string | null; notes?: string | null } | null;
  travelerProfiles?: TravelerProfileInput[] | null;
  extraNotes?: string;
}

function formatDateRangeInstruction(input: ProposeItineraryInput): string {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  if (input.startDate && input.endDate) {
    return `Trip dates: ${fmt(input.startDate)} to ${fmt(input.endDate)}. Use these actual calendar dates to inform seasonal/weather-appropriate choices (opening hours, closures, weather, crowd levels, local events/holidays in that window).`;
  }
  if (input.travelSeason) {
    return `Time of year: ${input.travelSeason} (exact dates not set yet). Use this to inform seasonal/weather-appropriate choices.`;
  }
  return "";
}

function formatDestinationDetails(input: ProposeItineraryInput): string {
  const parts = [
    input.destinationCountry ? `country: ${input.destinationCountry}` : null,
    input.destinationRegion ? `region: ${input.destinationRegion}` : null,
    input.destinationBestSeason ? `known best season: ${input.destinationBestSeason}` : null,
    input.destinationTags && input.destinationTags.length ? `tags: ${input.destinationTags.join(", ")}` : null,
    input.destinationNotes ? `notes: "${input.destinationNotes}"` : null,
  ].filter(Boolean);
  return parts.length ? `Destination details — ${parts.join("; ")}.` : "";
}

const PROPOSE_SYSTEM_PROMPT = "You are a meticulous travel planner. You produce only valid JSON when asked to.";

// Shared by proposeItinerary (calls the API) and the propose-itinerary-prompt
// route (returns the prompt text as-is, e.g. for pasting into claude.ai chat
// instead of paying for the API call).
export function buildProposePrompt(input: ProposeItineraryInput): { system: string; prompt: string; maxTokens: number } {
  const prefsBlock = input.preferences
    ? `Household travel preferences: interests=${(input.preferences.interests || []).join(", ") || "none specified"}; pace=${input.preferences.pace || "unspecified"}; budget style=${input.preferences.budgetStyle || "unspecified"}; notes="${input.preferences.notes || ""}".`
    : "No saved travel preferences.";

  const prompt = `Propose a day-by-day itinerary for a trip to ${input.destinationName}, ${input.nights} night(s), for ${input.travelers} traveler(s).
Trip goal/style: ${input.goal}. Planning type: ${input.planningType}.
${formatDateRangeInstruction(input)}
${formatDestinationDetails(input)}
${input.goalDetail ? `Specifically, what the travelers want out of this trip: "${input.goalDetail}". Weight this heavily — it's more specific than the general goal/style category above.` : ""}
${prefsBlock}
${formatTravelerProfilesBlock(input.travelerProfiles)}
${input.extraNotes ? `Additional context from the travelers: ${input.extraNotes}` : ""}

Take the traveler profiles into account: their ages, stay/transport/food preferences, and any notes (dietary, mobility, etc) should shape which items you propose.
${formatHomeLocationsInstruction(input.travelerProfiles)}

Also include ongoing living-cost items so the total budget is realistic, not just bookable reservations. These are budget line items, not scheduled events — leave "time" and "durationHours" both null for them (do not invent a clock time), since they don't need to fit into the day's schedule or avoid overlapping with anything else that day:
- One OTHER item per day titled "Meals" (or "Meals - Day N") with "estimatedCost" covering breakfast/lunch/dinner for all travelers that day, sized to the household's budget style and any food preferences/dietary notes above. Skip a day only if all meals are already covered elsewhere (e.g. an all-inclusive stay or a flight day with no time to eat out). Exception: if a meal is at a specific restaurant you're recommending (not a generic daily estimate), give it its own item with a real "time" instead — that's a scheduled reservation, not a budget line.
- If the trip involves a rental car or self-driving (road trip, day trips beyond walking/transit distance), one TRANSPORT item titled "Gas / fuel" (or per-leg if driving segments are far apart) with a total estimated fuel cost for that driving, separate from any rental car booking fee itself — not a scheduled pump stop, just the day's/leg's fuel cost. You MUST fill in "notes" with the cost basis every time, e.g. "Estimated fuel for ~150 miles of driving today" — never leave notes null on a Gas/fuel item.

${ITEM_SHAPE_INSTRUCTIONS}`;

  // Each night generates several verbose items (transport/stay/meals/
  // activities with notes) — budget generously per night so long trips
  // (multi-week road trips) don't truncate on the first attempt.
  const maxTokens = Math.min(MAX_ITINERARY_TOKENS, Math.max(16_384, 2_500 * input.nights + 4_000));

  return { system: PROPOSE_SYSTEM_PROMPT, prompt, maxTokens };
}

export async function proposeItinerary(input: ProposeItineraryInput): Promise<ProposedItinerary> {
  const client = getAnthropicClient();
  if (!client) throw new Error("AI is not configured");

  const { system, prompt, maxTokens } = buildProposePrompt(input);

  return requestProposedItinerary(client, system, prompt, maxTokens);
}

// Google's free tier returns transient 429 (rate limit) / 503 (overloaded)
// fairly often — the Anthropic SDK retries these automatically, but raw
// fetch doesn't, so we do it ourselves with a short backoff.
async function fetchGeminiWithRetry(url: string, body: unknown, retries = 3): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const text = (await res.text()).slice(0, 500);
    lastErr = new Error(`Gemini API error ${res.status}: ${text}`);
    if ((res.status === 429 || res.status >= 500) && i < retries) {
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)));
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

// Same retry shape as requestProposedItinerary (truncation -> bigger budget,
// malformed JSON -> resample), against Google's Gemini API instead of
// Claude's. Free-tier eligible, so this is the no-cost generation path.
async function requestProposedItineraryGemini(
  apiKey: string,
  system: string,
  prompt: string,
  initialMaxTokens: number,
  attempts = 3
): Promise<ProposedItinerary> {
  let lastErr: unknown;
  let maxTokens = initialMaxTokens;
  for (let i = 0; i < attempts; i++) {
    const data: any = await fetchGeminiWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, responseMimeType: "application/json" },
      }
    );
    const candidate = data.candidates?.[0];
    const finishReason: string | undefined = candidate?.finishReason;

    // eslint-disable-next-line no-console
    console.log(
      `[itineraryAi] gemini attempt ${i + 1} (max_tokens=${maxTokens}, finish_reason=${finishReason}): ` +
        `input=${data.usageMetadata?.promptTokenCount ?? "?"} output=${data.usageMetadata?.candidatesTokenCount ?? "?"} tokens (free tier)`
    );

    if (finishReason === "MAX_TOKENS") {
      lastErr = new Error(
        `Gemini response was truncated at ${maxTokens} tokens — this trip may be too long to generate in one proposal.`
      );
      if (i < attempts - 1) maxTokens = Math.min(MAX_ITINERARY_TOKENS, Math.round(maxTokens * 1.6));
      continue;
    }

    const text = candidate?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "{}";
    try {
      return parseProposedItinerary(text);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function proposeItineraryGemini(input: ProposeItineraryInput): Promise<ProposedItinerary> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error("Gemini is not configured");

  const { system, prompt, maxTokens } = buildProposePrompt(input);

  return requestProposedItineraryGemini(apiKey, system, prompt, maxTokens);
}

export interface ImportItineraryInput {
  rawText: string;
  destinationName?: string;
}

export async function importItinerary(input: ImportItineraryInput): Promise<ProposedItinerary> {
  const client = getAnthropicClient();
  if (!client) throw new Error("AI is not configured");

  const prompt = `Extract a structured itinerary from the following text (this may be a pasted confirmation email, a booking summary, or free-form travel plans${input.destinationName ? ` for a trip to ${input.destinationName}` : ""}). Infer day numbers relative to the first day mentioned. If a date is given instead of a relative day, still number days starting at 1 from the earliest date found.

${ITEM_SHAPE_INSTRUCTIONS}

Text to parse:
"""
${input.rawText.slice(0, 15000)}
"""`;

  return requestProposedItinerary(
    client,
    "You are precise at extracting structured travel data from messy text. You produce only valid JSON when asked to.",
    prompt,
    16384
  );
}

export interface GeocodeInputItem {
  id: string;
  title: string;
  location?: string | null;
}

const geocodeResultSchema = z.array(
  z.object({ id: z.string(), lat: z.number().nullable(), lng: z.number().nullable() })
);
export type GeocodeResultItem = z.infer<typeof geocodeResultSchema>[number];

// Backfills lat/lng for items that already exist (e.g. from a trip built
// before coordinate support existed, or added manually without them) — same
// approach as the propose/import prompts, just retrofitted onto existing rows.
export async function geocodeItems(destinationName: string, items: GeocodeInputItem[]): Promise<GeocodeResultItem[]> {
  const client = getAnthropicClient();
  if (!client) throw new Error("AI is not configured");
  if (items.length === 0) return [];

  const prompt = `For a trip to ${destinationName}, identify approximate real-world coordinates (decimal degrees) for each itinerary item below, using your knowledge of actual places. If an item has no single identifiable place (e.g. "Drive home", "Free time", a vague activity), return null for both lat and lng rather than guessing.

Respond ONLY with strict JSON: an array of exactly ${items.length} objects, one per item below, ids matching exactly, in this shape:
[{"id": "string", "lat": number|null, "lng": number|null}]

Items:
${items.map((i) => `- id="${i.id}" title="${i.title}"${i.location ? ` location="${i.location}"` : ""}`).join("\n")}`;

  const geoResponse = await client.messages.create({
    model: AI_MODEL,
    max_tokens: 2048,
    system: "You produce only valid JSON when asked to. No markdown fences, no commentary.",
    messages: [{ role: "user", content: prompt }],
  });

  const geoTextBlock = geoResponse.content.find((b) => b.type === "text");
  const geoText = geoTextBlock && "text" in geoTextBlock ? geoTextBlock.text : "[]";
  const cleaned = geoText.trim().replace(/^```json\s*|^```\s*|```$/g, "");
  return geocodeResultSchema.parse(JSON.parse(cleaned));
}
