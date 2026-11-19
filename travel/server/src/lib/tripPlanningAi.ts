import { getAnthropicClient, AI_MODEL } from "./anthropic";

// The SDK's types lag the API; extended reasoning is switched off so short JSON answers are not starved of tokens.
const NO_THINKING = { thinking: { type: "disabled" } } as object;

async function askJson(prompt: string, maxTokens = 8000): Promise<any> {
  const client = getAnthropicClient();
  if (!client) throw new Error("AI is not configured. Set ANTHROPIC_API_KEY in the server environment.");
  const response = await client.messages.create({
    model: AI_MODEL, max_tokens: maxTokens, ...NO_THINKING,
    system: "You produce only valid JSON when asked to. No markdown fences, no commentary.",
    messages: [{ role: "user", content: prompt }],
  }, { timeout: 100_000, maxRetries: 0 });
  const block = response.content.find((b) => b.type === "text");
  const text = block && "text" in block ? block.text : "";
  const m = text.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : text); } catch { throw new Error("The AI answer could not be read. Try again."); }
}

export interface ExtractedBooking {
  type: "TRANSPORT" | "STAY" | "ACTIVITY" | "OTHER"; title: string; provider: string | null; confirmationNo: string | null;
  startAt: string | null; endAt: string | null; location: string | null; cost: number | null; currency: string | null;
  freeCancelUntil: string | null; bookingUrl: string | null; notes: string | null; bookingStatus: "BOOKED" | "CONFIRMED";
}

// Naive local date-times ("2027-03-14T10:30") become ISO instants the same way the rest of the app stores itinerary times.
function iso(input: unknown, defaultTime = "12:00", midnightMeansDateOnly = false): string | null {
  if (typeof input !== "string" || !input.trim()) return null;
  let v: string = input;
  // Models often fill an unknown time with 00:00; for hotels treat that as "date only".
  if (midnightMeansDateOnly && /T00:00(:00)?$/.test(v.trim())) v = v.trim().slice(0, 10);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : v.length <= 10 ? `${v}T${defaultTime}:00` : v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function extractBookings(rawText: string, tripName: string): Promise<ExtractedBooking[]> {
  const j = await askJson(`Extract every travel booking from the text below (confirmation emails, receipts, itineraries) for a trip to ${tripName}.
Return ONLY strict JSON: {"bookings":[{"type":"TRANSPORT|STAY|ACTIVITY|OTHER","title":"short title, e.g. 'Flight BOS→LIS TP208' or 'Hotel Avenida Palace'",
"provider":"airline / hotel / company or null","confirmationNo":"booking reference or null","startAt":"YYYY-MM-DDTHH:MM (departure / check-in / start) or null","endAt":"YYYY-MM-DDTHH:MM (arrival / check-out / end) or null",
"location":"city or address or null","cost":total price as a number or null,"currency":"USD or other ISO code or null","freeCancelUntil":"YYYY-MM-DD or null","bookingUrl":"link or null","notes":"seat, room type, baggage, check-in instructions, etc. or null","status":"BOOKED or CONFIRMED"}]}
Use CONFIRMED when the text shows a confirmation number, otherwise BOOKED. Create one entry per flight leg, hotel stay, rental car, train, tour or activity. Never invent data that is not in the text.
Text:
"""
${rawText.slice(0, 20000)}
"""`, 8000);
  const list: any[] = Array.isArray(j.bookings) ? j.bookings : [];
  return list.map((b) => ({
    type: (["TRANSPORT", "STAY", "ACTIVITY", "OTHER"].includes(b.type) ? b.type : "OTHER") as ExtractedBooking["type"],
    title: str(b.title) ?? "Booking", provider: str(b.provider), confirmationNo: str(b.confirmationNo),
    // Date-only values get typical hotel times (check-in 3 PM, check-out 11 AM) so a stay never overlaps the flight that arrives that morning.
    startAt: iso(b.startAt, b.type === "STAY" ? "15:00" : "09:00", b.type === "STAY"), endAt: iso(b.endAt, b.type === "STAY" ? "11:00" : "09:00", b.type === "STAY"), location: str(b.location),
    cost: typeof b.cost === "number" && isFinite(b.cost) ? b.cost : null, currency: str(b.currency),
    freeCancelUntil: iso(b.freeCancelUntil), bookingUrl: str(b.bookingUrl), notes: str(b.notes),
    bookingStatus: b.status === "CONFIRMED" ? "CONFIRMED" : "BOOKED",
  }));
}

export interface ChecklistSuggestion { text: string; category: string; daysBefore: number | null }

export async function suggestChecklist(input: { tripName: string; country: string | null; season: string | null; nights: number | null; goal: string | null; profiles: string; existing: string[] }): Promise<ChecklistSuggestion[]> {
  const j = await askJson(`Create a practical pre-trip checklist for a trip to ${input.tripName}${input.country ? ` (${input.country})` : ""}${input.season ? ` in ${input.season}` : ""}${input.nights ? `, about ${input.nights} nights` : ""}${input.goal ? `, goal: ${input.goal}` : ""}. 2 travelers.
${input.profiles}
Cover entry/visa rules, passport validity, health/vaccines and travel insurance, money and cards, phone/eSIM, bookings to make or confirm, packing for the season and activities, and home preparation. Tailor it to the traveler profiles (ages, mobility, preferences).
Do not repeat these existing items: ${input.existing.slice(0, 60).join("; ") || "(none)"}.
Return ONLY strict JSON: {"items":[{"text":"short imperative task","category":"Documents|Health & insurance|Money|Bookings|Packing|Home & other","daysBefore":integer days before departure it should be done, or null}]}  — 18 to 28 items.`, 6000);
  const list: any[] = Array.isArray(j.items) ? j.items : [];
  const cats = ["Documents", "Health & insurance", "Money", "Bookings", "Packing", "Home & other"];
  return list.filter((i) => str(i.text)).map((i) => ({
    text: String(i.text).trim().slice(0, 200), category: cats.includes(i.category) ? i.category : "Home & other",
    daysBefore: typeof i.daysBefore === "number" && isFinite(i.daysBefore) ? Math.max(0, Math.round(i.daysBefore)) : null,
  }));
}
