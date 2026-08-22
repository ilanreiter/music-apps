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
"day" is 1-indexed relative to the first day of the trip. Use STAY once per lodging (checked in day, checked out on the departure day is fine to omit a duplicate). Use TRANSPORT for inter-city/inter-region movement and arrival/departure flights. Use POI for sights/landmarks, ACTIVITY for booked/planned activities (tours, classes, etc). Keep costs in USD unless told otherwise, and only estimate when you have a reasonable basis. Include "lat"/"lng" (decimal degrees) whenever you can identify a real, mappable place for the item (landmarks, hotels, neighborhoods, airports) — use your knowledge of the actual location, not a guess at the trip's general area. Leave both null for anything without a concrete single location (e.g. "free time", "travel day").`;

export function parseProposedItinerary(text: string): ProposedItinerary {
  const cleaned = text.trim().replace(/^```json\s*|^```\s*|```$/g, "");
  const json = JSON.parse(cleaned);
  return proposedItinerarySchema.parse(json);
}

export interface ProposeItineraryInput {
  destinationName: string;
  nights: number;
  goal: string;
  goalDetail?: string;
  travelers: number;
  planningType: string;
  preferences?: { interests: string[]; pace?: string | null; budgetStyle?: string | null; notes?: string | null } | null;
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
${input.extraNotes ? `Additional context from the travelers: ${input.extraNotes}` : ""}

${ITEM_SHAPE_INSTRUCTIONS}`;

  const response = await client.messages.create({
    model: AI_MODEL,
    max_tokens: 4096,
    system: "You are a meticulous travel planner. You produce only valid JSON when asked to.",
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock && "text" in textBlock ? textBlock.text : "{}";
  return parseProposedItinerary(text);
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

  const response = await client.messages.create({
    model: AI_MODEL,
    max_tokens: 4096,
    system: "You are precise at extracting structured travel data from messy text. You produce only valid JSON when asked to.",
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock && "text" in textBlock ? textBlock.text : "{}";
  return parseProposedItinerary(text);
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
