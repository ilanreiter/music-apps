import { prisma } from "../db";
import { geocodeItems } from "./itineraryAi";

const routeLike = (i: { type: string; title: string }) => i.type === "TRANSPORT" && /→|->|\bto\b/i.test(i.title);

/** Fills in missing map coordinates for a trip's items (and the departure point of flights/drives). Returns null if the trip doesn't exist. */
export async function geocodeTrip(tripId: string): Promise<{ updated: number; checked?: number } | null> {
  const trip = await prisma.trip.findUnique({ where: { id: tripId }, include: { destination: true, items: true } });
  if (!trip) return null;
  const missing = trip.items.filter((i) => i.lat == null || i.lng == null || (routeLike(i) && i.fromLat == null));
  if (missing.length === 0) return { updated: 0 };
  const results = await geocodeItems(
    trip.destination?.name || trip.title,
    missing.map((i) => ({ id: i.id, title: i.title, location: i.location, needsFrom: routeLike(i), hasTo: i.lat != null && i.lng != null }))
  );
  const byId = new Map(missing.map((i) => [i.id, i]));
  const ops = results.flatMap((r) => {
    const it = byId.get(r.id); if (!it) return [];
    const data: { lat?: number; lng?: number; fromLat?: number; fromLng?: number } = {};
    if ((it.lat == null || it.lng == null) && r.lat != null && r.lng != null) { data.lat = r.lat; data.lng = r.lng; }
    if (routeLike(it) && it.fromLat == null && r.fromLat != null && r.fromLng != null) { data.fromLat = r.fromLat; data.fromLng = r.fromLng; }
    return Object.keys(data).length ? [prisma.tripItem.update({ where: { id: r.id }, data })] : [];
  });
  await prisma.$transaction(ops);
  return { updated: ops.length, checked: missing.length };
}
