// Universal trip importer: classifies a source (booking / itinerary / schedule / general material / irrelevant),
// extracts everything useful, and files it into the trip's sections. Every item is matched against what the trip
// already holds first, so importing the same thing twice never duplicates or conflicts.
import { pageImage } from "./sourceText";
import { geocodeTrip } from "./geocodeTrip";
import crypto from "crypto";
import { prisma } from "../db";
import { askJson, iso, str } from "./tripPlanningAi";

export type Category = "booking" | "itinerary" | "schedule" | "general" | "irrelevant";
export type Action = "new" | "update" | "duplicate";

export interface BookingData {
  type: "TRANSPORT" | "STAY" | "ACTIVITY" | "OTHER"; title: string; provider: string | null; confirmationNo: string | null; traveler: string | null;
  startAt: string | null; endAt: string | null; location: string | null; cost: number | null; currency: string | null;
  freeCancelUntil: string | null; bookingUrl: string | null; notes: string | null; bookingStatus: "BOOKED" | "CONFIRMED";
}
export interface ItineraryData {
  type: "TRANSPORT" | "STAY" | "POI" | "ACTIVITY" | "OTHER"; title: string; location: string | null; startAt: string | null; endAt: string | null;
  day: number | null; time: string | null; durationHours: number | null; notes: string | null; cost: number | null; currency: string | null; traveler: string | null;
}
export interface ResourceData { title: string; url: string | null; category: string | null; notes: string | null }
export interface ChecklistData { text: string; category: string | null; dueDate: string | null }

export type Proposal =
  | { kind: "booking"; data: BookingData; action: Action; matchTitle?: string }
  | { kind: "itinerary"; data: ItineraryData; action: Action; matchTitle?: string }
  | { kind: "resource"; data: ResourceData; action: Action; matchTitle?: string }
  | { kind: "checklist"; data: ChecklistData; action: Action; matchTitle?: string };

export interface SourceResult {
  name: string; hash: string; category: Category; reason: string; summary: string; travelers: string[];
  alreadyImported: boolean; proposals: Proposal[]; error?: string;
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9֐-׿]+/g, " ").trim();
export const hashText = (t: string) => crypto.createHash("sha256").update(norm(t)).digest("hex");
const day = (iso0: string | null | undefined) => (iso0 ? iso0.slice(0, 10) : null);
const placeholder = (d: Date | string | null | undefined) => !!d && new Date(d).getTime() < Date.UTC(2001, 0, 1);
const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);
const STATUS_RANK: Record<string, number> = { IDEA: 0, RESEARCHING: 1, READY_TO_BOOK: 2, BOOKED: 3, CONFIRMED: 4, CANCELLED: 0 };

// ---------------------------------------------------------------- analysis

export async function analyzeSource(trip: { id: string; title: string; startDate: Date | null; endDate: Date | null; destination?: { name: string } | null; travelers: string[] }, name: string, text: string, url: string | null, knownTravelers: string[]): Promise<SourceResult> {
  const hash = hashText(text);
  const base: SourceResult = { name, hash, category: "irrelevant", reason: "", summary: "", travelers: [], alreadyImported: false, proposals: [] };
  const seen = await prisma.tripImport.findUnique({ where: { tripId_hash: { tripId: trip.id, hash } } });
  if (seen) return { ...base, category: seen.category as Category, summary: seen.summary ?? "", alreadyImported: true, reason: `Already imported on ${seen.createdAt.toLocaleDateString("en-US")}` };

  const today = new Date().toISOString().slice(0, 10);
  const j = await askJson(`Today is ${today}. You file material into a trip planner for the trip "${trip.title}"${trip.destination ? ` (destination: ${trip.destination.name})` : ""}${trip.startDate ? `, dates ${trip.startDate.toISOString().slice(0, 10)} to ${trip.endDate?.toISOString().slice(0, 10) ?? "?"}` : ", dates not set yet"}.
Travelers known so far (for reference only; material may name other people): ${knownTravelers.join(", ") || "none"}.
Read the material and decide what it is, then extract EVERYTHING useful. Return ONLY strict JSON:
{"category":"booking|itinerary|schedule|general|irrelevant","reason":"one short sentence why","summary":"one or two sentences on what this material is",
"travelers":["only the traveler / passenger / guest names that actually appear in THIS material; never add the known travelers unless the material names them"],
"bookings":[{"type":"TRANSPORT|STAY|ACTIVITY|OTHER","title":"short title e.g. 'Flight BOS→AUS DL1677' / 'Hotel X'","provider":null,"confirmationNo":null,"traveler":"passenger/guest this booking is for, or null",
 "startAt":"YYYY-MM-DDTHH:MM or YYYY-MM-DD","endAt":"same or null","location":null,"cost":number or null,"currency":"ISO code or null","freeCancelUntil":"YYYY-MM-DD or null","bookingUrl":null,"notes":"seat, room, baggage, check-in rules, etc.","status":"BOOKED|CONFIRMED"}],
"itinerary":[{"type":"POI|ACTIVITY|TRANSPORT|STAY|OTHER","title":"","date":"YYYY-MM-DD or null","day":day number of the trip or null,"time":"HH:MM or null","durationHours":number or null,"location":null,"notes":null,"cost":number or null,"currency":null,"traveler":null}],
"checklist":[{"text":"a to-do the material implies, e.g. 'Check in online 24h before the flight'","category":"Documents|Health & insurance|Money|Bookings|Packing|Home & other","dueDate":"YYYY-MM-DD or null"}],
"resource":{"title":"short title","category":"Guide|Visa & entry|Insurance|Transport|Accommodation|Food|Other","notes":"the key facts worth keeping, as short bullet lines (max about 1500 characters)"} or null}
Rules:
- booking = a confirmation, ticket, reservation, receipt or invoice for something already booked; fill "bookings" (one entry per flight leg, stay, car, tour, per traveler when tickets are per person).
- itinerary or schedule = a plan of places/activities/days; fill "itinerary" (use "date" when given, else "day").
- general = useful reference (guide, article, visa rules, policy, packing list, map notes); fill "resource".
- irrelevant = contains no travel information at all (e.g. a recipe or an unrelated bill); leave all lists empty. Never call material irrelevant because a name does not match the known travelers (guests and companions vary) or because it mentions another city; classify it by what it is and let the user decide.
- A document may contain several kinds: fill every list that applies, and set category to the main one.
- When a date has no year, use the weekday if given, otherwise the next occurrence after today. Never invent data that is not in the material.
Material${url ? ` (from ${url})` : ""} named "${name}":
"""
${text.slice(0, 28000)}
"""`, 12000);

  const cat = (["booking", "itinerary", "schedule", "general", "irrelevant"].includes(j.category) ? j.category : "irrelevant") as Category;
  const out: SourceResult = { ...base, category: cat, reason: str(j.reason) ?? "", summary: str(j.summary) ?? "", travelers: (Array.isArray(j.travelers) ? j.travelers : []).map(str).filter(Boolean) as string[] };
  const props: Proposal[] = [];
  for (const b of Array.isArray(j.bookings) ? j.bookings : []) {
    if (!str(b?.title)) continue;
    const type = (["TRANSPORT", "STAY", "ACTIVITY", "OTHER"].includes(b.type) ? b.type : "OTHER") as BookingData["type"];
    props.push({ kind: "booking", action: "new", data: {
      type, title: str(b.title)!, provider: str(b.provider), confirmationNo: str(b.confirmationNo), traveler: str(b.traveler),
      startAt: iso(b.startAt, type === "STAY" ? "15:00" : "09:00", type === "STAY"), endAt: iso(b.endAt, type === "STAY" ? "11:00" : "09:00", type === "STAY"),
      location: str(b.location), cost: num(b.cost), currency: str(b.currency), freeCancelUntil: iso(b.freeCancelUntil), bookingUrl: str(b.bookingUrl) ?? (url && cat === "booking" ? url : null),
      notes: str(b.notes), bookingStatus: b.status === "CONFIRMED" ? "CONFIRMED" : "BOOKED",
    } });
  }
  for (const i of Array.isArray(j.itinerary) ? j.itinerary : []) {
    if (!str(i?.title)) continue;
    const type = (["TRANSPORT", "STAY", "POI", "ACTIVITY", "OTHER"].includes(i.type) ? i.type : "POI") as ItineraryData["type"];
    const date = typeof i.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(i.date) ? i.date.slice(0, 10) : null;
    const time = typeof i.time === "string" && /^\d{1,2}:\d{2}/.test(i.time) ? i.time.slice(0, 5).padStart(5, "0") : null;
    const dur = num(i.durationHours);
    const startAt = date ? iso(`${date}T${time ?? "09:00"}`) : null;
    props.push({ kind: "itinerary", action: "new", data: {
      type, title: str(i.title)!, location: str(i.location), startAt, endAt: startAt && dur ? new Date(new Date(startAt).getTime() + dur * 3600_000).toISOString() : null,
      day: !date && Number.isInteger(i.day) && i.day > 0 ? i.day : null, time, durationHours: dur, notes: str(i.notes), cost: num(i.cost), currency: str(i.currency), traveler: str(i.traveler),
    } });
  }
  for (const c of Array.isArray(j.checklist) ? j.checklist : []) {
    if (!str(c?.text)) continue;
    props.push({ kind: "checklist", action: "new", data: { text: String(c.text).trim().slice(0, 200), category: str(c.category), dueDate: iso(c.dueDate) } });
  }
  if (j.resource && str(j.resource.title) && cat !== "irrelevant") {
    props.push({ kind: "resource", action: "new", data: { title: String(j.resource.title).trim().slice(0, 160), url, category: str(j.resource.category), notes: str(j.resource.notes)?.slice(0, 3000) ?? null } });
  }
  out.proposals = props;
  return out;
}

// ---------------------------------------------------------------- matching

type Item = Awaited<ReturnType<typeof loadTrip>>["items"][number];

export async function loadTrip(id: string) {
  return prisma.trip.findUniqueOrThrow({ where: { id }, include: { destination: true, items: true, resources: true, checklist: true } });
}

const travDiff = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && norm(a) !== norm(b);
const nums = (s: string) => new Set(s.match(/\d{2,4}/g) ?? []);
const words = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 3 && !["hotel", "lodging", "stay", "flight", "resort", "booking", "reservation"].includes(w)));
const BOOKABLE = new Set(["TRANSPORT", "STAY", "ACTIVITY", "OTHER"]);

function matchBooking(items: Item[], b: BookingData): Item | undefined {
  const ref = norm(b.confirmationNo).replace(/ /g, "");
  const cands = items.filter((e) => BOOKABLE.has(e.type) && e.type === b.type);
  // One reference often covers several legs (outbound + return, or both nights of a stay), so a shared reference only counts
  // when it is also the same flight number / same day / same name.
  const sameThing = (e: Item) => {
    const sameDay = !b.startAt || !e.startAt || placeholder(e.startAt) || day(e.startAt.toISOString()) === day(b.startAt);
    if (norm(e.title) === norm(b.title) && sameDay) return true;
    if (b.type === "TRANSPORT") {
      // same reference and the exact same departure time is the same booking even when the AI words the title differently (car rentals have no flight number)
      if (b.startAt && b.startAt.length > 10 && e.startAt && !placeholder(e.startAt) && e.startAt.toISOString().slice(0, 16) === b.startAt.slice(0, 16)) return true;
      const n = nums(b.title); return [...nums(e.title)].some((x) => n.has(x)) && sameDay;
    }
    if (b.type === "STAY") { const w = words(b.title); return sameDay && [...words(e.title)].some((x) => w.has(x)); }
    return sameDay;
  };
  if (ref) { const hit = cands.find((e) => norm(e.confirmationNo).replace(/ /g, "") === ref && !travDiff(e.traveler, b.traveler) && sameThing(e)); if (hit) return hit; }
  for (const e of cands) {
    if (travDiff(e.traveler, b.traveler)) continue;
    const eRef = norm(e.confirmationNo).replace(/ /g, "");
    if (ref && eRef && ref !== eRef) continue;
    const sameDay = !b.startAt || !e.startAt || placeholder(e.startAt) || day(e.startAt.toISOString()) === day(b.startAt);
    if (b.type === "TRANSPORT") {
      const n = nums(b.title);
      if (sameDay && [...nums(e.title)].some((x) => n.has(x))) return e;
    }
    if (norm(e.title) === norm(b.title) && sameDay) return e;
    if (b.type === "STAY") {
      const w = words(b.title), ew = words(e.title);
      if (sameDay && [...ew].some((x) => w.has(x))) return e;
    }
  }
  // an unbooked placeholder lodging item (from an earlier day-by-day plan) is the same stay
  if (b.type === "STAY") {
    const open = cands.filter((e) => !e.confirmationNo && STATUS_RANK[e.bookingStatus] < 3 && !travDiff(e.traveler, b.traveler));
    if (open.length === 1) return open[0];
  }
  return undefined;
}

function bookingPatch(e: Item, b: BookingData) {
  const patch: Record<string, unknown> = {};
  const fill = (k: keyof Item & string, v: unknown) => { if (v != null && (e as any)[k] == null) patch[k] = v; };
  fill("confirmationNo", b.confirmationNo); fill("traveler", b.traveler); fill("provider", b.provider); fill("location", b.location);
  fill("cost", b.cost); fill("currency", b.currency); fill("bookingUrl", b.bookingUrl);
  if (b.freeCancelUntil && !e.freeCancelUntil) patch.freeCancelUntil = new Date(b.freeCancelUntil);
  if (b.startAt && (!e.startAt || placeholder(e.startAt))) { patch.startAt = new Date(b.startAt); if (b.endAt) patch.endAt = new Date(b.endAt); }
  else if (b.endAt && !e.endAt) patch.endAt = new Date(b.endAt);
  if (b.notes && !(e.notes ?? "").includes(b.notes)) patch.notes = [e.notes, b.notes].filter(Boolean).join(" · ");
  if (STATUS_RANK[b.bookingStatus] > STATUS_RANK[e.bookingStatus]) patch.bookingStatus = b.bookingStatus;
  if (b.title && STATUS_RANK[e.bookingStatus] < 3 && norm(b.title) !== norm(e.title)) patch.title = b.title;
  return patch;
}

function matchItinerary(items: Item[], d: ItineraryData): Item | undefined {
  return items.find((e) => norm(e.title) === norm(d.title) && !travDiff(e.traveler, d.traveler)
    && (!d.startAt || !e.startAt || day(e.startAt.toISOString()) === day(d.startAt) || placeholder(e.startAt)));
}

/** Marks each proposal as new / update (adds missing details) / duplicate (nothing new), against the trip as it is now. */
export async function annotate(tripId: string, proposals: Proposal[]): Promise<Proposal[]> {
  const trip = await loadTrip(tripId);
  const seenInBatch: Proposal[] = [];
  return proposals.map((p) => {
    let out: Proposal = { ...p, action: "new", matchTitle: undefined } as Proposal;
    if (p.kind === "booking") {
      const e = matchBooking(trip.items, p.data);
      if (e) out = { ...p, action: Object.keys(bookingPatch(e, p.data)).length ? "update" : "duplicate", matchTitle: e.title };
    } else if (p.kind === "itinerary") {
      const e = matchItinerary(trip.items, p.data);
      if (e) out = { ...p, action: "duplicate", matchTitle: e.title };
    } else if (p.kind === "resource") {
      const e = trip.resources.find((r) => (p.data.url && r.url === p.data.url) || norm(r.title) === norm(p.data.title));
      if (e) out = { ...p, action: "duplicate", matchTitle: e.title };
    } else if (p.kind === "checklist") {
      const e = trip.checklist.find((c) => norm(c.text) === norm(p.data.text));
      if (e) out = { ...p, action: "duplicate", matchTitle: e.text };
    }
    // the same thing twice inside one upload
    const key = JSON.stringify([out.kind, norm((out.data as any).title ?? (out.data as any).text), (out.data as any).startAt ?? (out.data as any).day ?? "", norm((out.data as any).traveler), norm((out.data as any).confirmationNo)]);
    if (seenInBatch.some((s) => (s as any)._k === key)) out = { ...out, action: "duplicate", matchTitle: "(repeated in this upload)" } as Proposal;
    (out as any)._k = key; seenInBatch.push(out);
    delete (out as any)._k;
    return out;
  });
}

// ---------------------------------------------------------------- applying

export interface ApplyResult { created: number; updated: number; skipped: number; travelers: string[]; datesSet: boolean }

/** Sets the trip's dates once (from the earliest/latest dated item) and moves day-numbered placeholder items onto the real calendar. */
export async function maybeSetTripDates(tripId: string, starts: string[], ends: string[]): Promise<boolean> {
  const trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId }, select: { startDate: true } });
  if (trip.startDate || !starts.length) return false;
  const d = (s: string) => { const x = new Date(s); return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate(), 12)); };
  const first = d([...starts].sort()[0]);
  const last = d([...ends, ...starts].sort().slice(-1)[0]);
  const delta = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate()) - Date.UTC(2000, 0, 1);
  const ph = await prisma.tripItem.findMany({ where: { tripId, startAt: { lt: new Date(Date.UTC(2001, 0, 1)) } } });
  await prisma.$transaction([
    ...ph.map((i) => prisma.tripItem.update({ where: { id: i.id }, data: { startAt: i.startAt ? new Date(i.startAt.getTime() + delta) : undefined, endAt: i.endAt ? new Date(i.endAt.getTime() + delta) : undefined } })),
    prisma.trip.update({ where: { id: tripId }, data: { startDate: first, endDate: last, durationNights: Math.max(0, Math.round((last.getTime() - first.getTime()) / 86_400_000)) } }),
  ]);
  return true;
}

/**
 * A hotel booked by dates only gets typical times (check-in 3 PM, check-out 11 AM). When a flight or drive overlaps those
 * edges (you land at 10 PM on check-in day), move the edge to the arrival / departure so a normal trip shows no clash.
 */
async function reconcileStayEdges(tripId: string) {
  const items = await prisma.tripItem.findMany({ where: { tripId, startAt: { gt: new Date(Date.UTC(2001, 0, 1)) } } });
  const moves = items.filter((i) => i.type === "TRANSPORT" && i.startAt && i.endAt);
  for (const s of items.filter((i) => i.type === "STAY" && i.startAt && i.endAt)) {
    const hm = (d: Date) => `${d.getUTCHours()}:${d.getUTCMinutes()}`;
    const data: { startAt?: Date; endAt?: Date } = {};
    if (hm(s.startAt!) === "15:0") {
      const clash = moves.filter((m) => m.startAt! < new Date(s.startAt!.getTime() + 12 * 3600_000) && m.endAt! > s.startAt! && m.startAt!.getUTCDate() === s.startAt!.getUTCDate());
      if (clash.length) data.startAt = new Date(Math.max(...clash.map((m) => m.endAt!.getTime())));
    }
    if (hm(s.endAt!) === "11:0") {
      const clash = moves.filter((m) => m.endAt! > new Date(s.endAt!.getTime() - 12 * 3600_000) && m.startAt! < s.endAt! && m.startAt!.getUTCDate() === s.endAt!.getUTCDate());
      if (clash.length) data.endAt = new Date(Math.min(...clash.map((m) => m.startAt!.getTime())));
    }
    if (data.startAt || data.endAt) await prisma.tripItem.update({ where: { id: s.id }, data });
  }
}

export async function applyProposals(tripId: string, proposals: Proposal[], sources: { hash: string; name: string; category: string; summary: string | null }[], travelers: string[]): Promise<ApplyResult> {
  const res: ApplyResult = { created: 0, updated: 0, skipped: 0, travelers: [], datesSet: false };
  // dates first, so day-numbered items land on the real calendar
  const dated = proposals.filter((p) => (p.kind === "booking" || p.kind === "itinerary") && p.data.startAt) as Extract<Proposal, { kind: "booking" | "itinerary" }>[];
  res.datesSet = await maybeSetTripDates(tripId, dated.map((p) => p.data.startAt!), dated.map((p) => p.data.endAt ?? p.data.startAt!));

  let trip = await loadTrip(tripId);
  let order = trip.items.length;
  for (const p of proposals) {
    trip = await loadTrip(tripId); // re-read so items added earlier in this same upload are matched too
    if (p.kind === "booking") {
      const e = matchBooking(trip.items, p.data);
      if (e) {
        const patch = bookingPatch(e, p.data);
        if (Object.keys(patch).length) { await prisma.tripItem.update({ where: { id: e.id }, data: patch as any }); res.updated++; } else res.skipped++;
      } else {
        await prisma.tripItem.create({ data: {
          tripId, type: p.data.type, title: p.data.title, provider: p.data.provider, confirmationNo: p.data.confirmationNo, traveler: p.data.traveler,
          startAt: p.data.startAt ? new Date(p.data.startAt) : undefined, endAt: p.data.endAt ? new Date(p.data.endAt) : undefined, location: p.data.location,
          cost: p.data.cost, currency: p.data.currency ?? undefined, freeCancelUntil: p.data.freeCancelUntil ? new Date(p.data.freeCancelUntil) : undefined,
          bookingUrl: p.data.bookingUrl, notes: p.data.notes, bookingStatus: p.data.bookingStatus, sortOrder: order++,
        } });
        res.created++;
      }
    } else if (p.kind === "itinerary") {
      if (matchItinerary(trip.items, p.data)) { res.skipped++; continue; }
      let startAt: Date | undefined = p.data.startAt ? new Date(p.data.startAt) : undefined;
      let endAt: Date | undefined = p.data.endAt ? new Date(p.data.endAt) : undefined;
      if (!startAt && p.data.day) {
        const baseDate = trip.startDate ? new Date(Date.UTC(trip.startDate.getUTCFullYear(), trip.startDate.getUTCMonth(), trip.startDate.getUTCDate())) : new Date(Date.UTC(2000, 0, 1));
        const [h, m] = (p.data.time ?? "09:00").split(":").map((n) => parseInt(n, 10) || 0);
        startAt = new Date(baseDate.getTime() + (p.data.day - 1) * 86_400_000 + (h * 60 + m) * 60_000);
        if (p.data.durationHours) endAt = new Date(startAt.getTime() + p.data.durationHours * 3600_000);
      }
      await prisma.tripItem.create({ data: {
        tripId, type: p.data.type, title: p.data.title, location: p.data.location, startAt, endAt, notes: p.data.notes, cost: p.data.cost,
        currency: p.data.currency ?? undefined, traveler: p.data.traveler, bookingStatus: "IDEA", sortOrder: order++,
      } });
      res.created++;
    } else if (p.kind === "resource") {
      if (trip.resources.some((r) => (p.data.url && r.url === p.data.url) || norm(r.title) === norm(p.data.title))) { res.skipped++; continue; }
      const imageUrl = p.data.url ? (await pageImage(p.data.url)) ?? "" : undefined;
      await prisma.resource.create({ data: { tripId, imageUrl, title: p.data.title, url: p.data.url, category: p.data.category, notes: p.data.notes, destinationId: trip.destinationId } });
      res.created++;
    } else if (p.kind === "checklist") {
      if (trip.checklist.some((c) => norm(c.text) === norm(p.data.text))) { res.skipped++; continue; }
      await prisma.checklistItem.create({ data: { tripId, text: p.data.text, category: p.data.category, dueDate: p.data.dueDate ? new Date(p.data.dueDate) : undefined, sortOrder: trip.checklist.length } });
      res.created++;
    }
  }
  await reconcileStayEdges(tripId);
  geocodeTrip(tripId).catch(() => {}); // best effort: place new bookings on the map
  // travelers named in the material join the trip
  const fresh = await prisma.trip.findUniqueOrThrow({ where: { id: tripId }, select: { travelers: true } });
  const known = new Set(fresh.travelers.map(norm));
  const add = [...new Set(travelers.filter(Boolean))].filter((n) => !known.has(norm(n)));
  if (add.length) await prisma.trip.update({ where: { id: tripId }, data: { travelers: [...fresh.travelers, ...add] } });
  res.travelers = add;
  // remember what was imported, so the same source is recognised next time
  for (const s of sources) await prisma.tripImport.upsert({ where: { tripId_hash: { tripId, hash: s.hash } }, create: { tripId, ...s }, update: { name: s.name, category: s.category, summary: s.summary } });
  return res;
}
