import { Router } from "express";
import { prisma } from "../db";

const router = Router();

export interface Hit { type: string; id: string; title: string; subtitle: string; snippet?: string; href: string; external?: boolean }

const fmt = (d: Date | null | undefined) => (d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : null);
/** A short piece of text around the match, for fields the title doesn't show (notes, addresses…). */
function snippet(q: string, ...fields: (string | null | undefined)[]) {
  const ql = q.toLowerCase();
  for (const f of fields) {
    if (!f) continue;
    const at = f.toLowerCase().indexOf(ql);
    if (at < 0) continue;
    const start = Math.max(0, at - 40);
    return (start > 0 ? "…" : "") + f.slice(start, at + q.length + 60).replace(/\s+/g, " ").trim() + (at + q.length + 60 < f.length ? "…" : "");
  }
  return undefined;
}

// One box that searches everything: trips, their bookings/itinerary/to-dos/documents, roadmap destinations,
// resources, booking agents, travelers and waiting Import cards.
router.get("/", async (req, res) => {
  const q = String(req.query.q ?? "").trim().slice(0, 100);
  if (q.length < 2) return res.json({ q, hits: [] });
  const has = { contains: q, mode: "insensitive" as const };
  const N = 6;
  const [trips, items, dests, resources, todos, docs, agents, travelers, cards, policies] = await Promise.all([
    prisma.trip.findMany({ where: { OR: [{ title: has }, { notes: has }, { goalDetail: has }, { destination: { name: has } }] }, include: { destination: { select: { name: true } } }, take: N, orderBy: { startDate: "asc" } }),
    prisma.tripItem.findMany({ where: { OR: [{ title: has }, { location: has }, { provider: has }, { confirmationNo: has }, { notes: has }, { traveler: has }] }, include: { trip: { select: { title: true } } }, take: 10, orderBy: { startAt: "asc" } }),
    prisma.destination.findMany({ where: { OR: [{ name: has }, { notes: has }, { region: has }, { country: has }] }, take: N }),
    prisma.resource.findMany({ where: { OR: [{ title: has }, { notes: has }, { url: has }, { category: has }] }, include: { trip: { select: { title: true } } }, take: N }),
    prisma.checklistItem.findMany({ where: { text: has }, include: { trip: { select: { title: true } } }, take: N }),
    prisma.tripDocument.findMany({ where: { name: has }, include: { trip: { select: { title: true } } }, take: N }),
    prisma.bookingAgent.findMany({ where: { OR: [{ name: has }, { contact: has }, { notes: has }, { type: has }] }, take: N }),
    prisma.traveler.findMany({ where: { OR: [{ name: has }, { notes: has }, { homeLocation: has }] }, take: N }),
    prisma.inboxItem.findMany({ where: { status: "PENDING", OR: [{ subject: has }, { bodyText: has }] }, take: N, orderBy: { receivedAt: "desc" } }),
    prisma.insurancePolicy.findMany({ where: { OR: [{ provider: has }, { planName: has }, { policyNumber: has }, { notes: has }] }, include: { trip: { select: { title: true } } }, take: N }),
  ]);
  const KIND: Record<string, string> = { TRANSPORT: "Transport", STAY: "Stay", POI: "Place", ACTIVITY: "Activity", OTHER: "Item" };
  const hits: Hit[] = [
    ...trips.map((t) => ({ type: "Trips", id: t.id, title: t.title, subtitle: [t.destination?.name, fmt(t.startDate) && `${fmt(t.startDate)}${t.endDate ? ` – ${fmt(t.endDate)}` : ""}`].filter(Boolean).join(" · "), snippet: snippet(q, t.notes, t.goalDetail), href: `/trips/${t.id}` })),
    ...items.map((i) => ({ type: "Bookings & itinerary", id: i.id, title: i.title, subtitle: [KIND[i.type] ?? i.type, i.trip.title, fmt(i.startAt)].filter(Boolean).join(" · "), snippet: snippet(q, i.location, i.provider, i.confirmationNo, i.notes, i.traveler), href: `/trips/${i.tripId}?tab=${["IDEA", "RESEARCHING"].includes(i.bookingStatus) ? "Itinerary" : "Bookings"}` })),
    ...policies.map((x) => ({ type: "Insurance", id: x.id, title: [x.provider, x.planName].filter(Boolean).join(" · "), subtitle: [x.trip.title, x.policyNumber && `policy ${x.policyNumber}`].filter(Boolean).join(" · "), href: `/trips/${x.tripId}?tab=Insurance` })),
    ...docs.map((d) => ({ type: "Documents", id: d.id, title: d.name, subtitle: d.trip?.title ?? "Waiting in Import", href: `/documents?open=${d.id}` })),
    ...todos.map((c) => ({ type: "To-dos", id: c.id, title: c.text, subtitle: [c.trip.title, c.done ? "done" : fmt(c.dueDate) && `due ${fmt(c.dueDate)}`].filter(Boolean).join(" · "), href: `/trips/${c.tripId}?tab=Checklist` })),
    ...dests.map((d) => ({ type: "Roadmap destinations", id: d.id, title: d.name, subtitle: [d.planYear && `${d.planSeason ?? ""} ${d.planYear}`.trim(), d.status.toLowerCase()].filter(Boolean).join(" · "), snippet: snippet(q, d.notes, d.region), href: `/?dest=${d.id}` })),
    ...resources.map((r) => ({ type: "Resources", id: r.id, title: r.title, subtitle: [r.category, r.trip?.title].filter(Boolean).join(" · "), snippet: snippet(q, r.notes, r.url), href: r.tripId ? `/trips/${r.tripId}?tab=Resources` : "/resources" })),
    ...agents.map((a) => ({ type: "Booking agents", id: a.id, title: a.name, subtitle: a.type ?? "", snippet: snippet(q, a.contact, a.notes), href: "/booking-agents" })),
    ...travelers.map((t) => ({ type: "Travelers", id: t.id, title: t.name, subtitle: t.homeLocation ?? "", href: "/travelers" })),
    ...cards.map((c) => ({ type: "Waiting in Import", id: c.id, title: c.subject, subtitle: fmt(c.receivedAt) ?? "", snippet: snippet(q, c.bodyText), href: "/import" })),
  ];
  res.json({ q, hits });
});

export default router;
