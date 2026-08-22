import { z } from "zod";
import { getAnthropicClient, AI_MODEL } from "./anthropic";

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
      "estimatedCost": number or null
    }
  ]
}
"day" is 1-indexed relative to the first day of the trip. Use STAY once per lodging (checked in day, checked out on the departure day is fine to omit a duplicate). Use TRANSPORT for inter-city/inter-region movement and arrival/departure flights. Use POI for sights/landmarks, ACTIVITY for booked/planned activities (tours, classes, etc). Keep costs in USD unless told otherwise, and only estimate when you have a reasonable basis. Include "lat"/"lng" (decimal degrees) whenever you can identify a real, mappable place for the item (landmarks, hotels, neighborhoods, airports) — use your knowledge of the actual location, not a guess at the trip's general area. Leave both null for anything without a concrete single location (e.g. "free time", "travel day"). Critical: this output is parsed by a strict JSON parser. If any string value (title, location, notes, summary) itself contains a double-quote character — e.g. a nickname or quoted phrase like the "Golden Gate" — you MUST escape it as \\" so the JSON stays valid. Prefer rephrasing to avoid inner quotes entirely when possible. Do not include trailing commas.`;

// Retries the AI call + parse a few times, since the model occasionally emits
// a formatting slip (an unescaped inner quote, a trailing comma) that breaks
// JSON.parse — a fresh sample from the same prompt reliably self-corrects.
async function requestProposedItinerary(
  client: NonNullable<ReturnType<typeof getAnthropicClient>>,
  system: string,
  prompt: string,
  maxTokens: number,
  attempts = 3
): Promise<ProposedItinerary> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const response = await client.messages.create({
      model: AI_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    });
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

export function parseProposedItinerary(text: string): ProposedItinerary {
  const cleaned = text.trim().replace(/^```json\s*|^```\s*|```$/g, "");
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[itineraryAi] Failed to parse AI JSON response:\n", cleaned);
    throw err;
  }
  return proposedItinerarySchema.parse(json);
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
  nights: number;
  goal: string;
  goalDetail?: string;
  travelers: number;
  planningType: string;
  preferences?: { interests: string[]; pace?: string | null; budgetStyle?: string | null; notes?: string | null } | null;
  travelerProfiles?: TravelerProfileInput[] | null;
  extraNotes?: string;
}

export async function proposeItinerary(input: ProposeItineraryInput): Promise<ProposedItinerary> {
  const client = getAnthropicClient();
  if (!client) throw new Error("AI is not configured");

  const prefsBlock = input.preferences
    ? `Household travel preferences: interests=${(input.preferences.interests || []).join(", ") || "none specified"}; pace=${input.preferences.pace || "unspecified"}; budget style=${input.preferences.budgetStyle || "unspecified"}; notes="${input.preferences.notes || ""}".`
    : "No saved travel preferences.";

  const prompt = `Propose a day-by-day itinerary for a trip to ${input.destinationName}, ${input.nights} night(s), for ${input.travelers} traveler(s).
Trip goal/style: ${input.goal}. Planning type: ${input.planningType}.
${input.goalDetail ? `Specifically, what the travelers want out of this trip: "${input.goalDetail}". Weight this heavily — it's more specific than the general goal/style category above.` : ""}
${prefsBlock}
${formatTravelerProfilesBlock(input.travelerProfiles)}
${input.extraNotes ? `Additional context from the travelers: ${input.extraNotes}` : ""}

Take the traveler profiles into account: their ages, stay/transport/food preferences, and any notes (dietary, mobility, etc) should shape which items you propose.
${formatHomeLocationsInstruction(input.travelerProfiles)}

${ITEM_SHAPE_INSTRUCTIONS}`;

  return requestProposedItinerary(
    client,
    "You are a meticulous travel planner. You produce only valid JSON when asked to.",
    prompt,
    16384
  );
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
