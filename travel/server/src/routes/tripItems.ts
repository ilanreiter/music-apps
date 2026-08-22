import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";

const router = Router({ mergeParams: true });

const itemSchema = z.object({
  type: z.enum(["TRANSPORT", "STAY", "POI", "ACTIVITY", "OTHER"]),
  title: z.string().min(1),
  provider: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  startAt: z.string().datetime().nullable().optional(),
  endAt: z.string().datetime().nullable().optional(),
  cost: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  bookingStatus: z.enum(["IDEA", "RESEARCHING", "READY_TO_BOOK", "BOOKED", "CONFIRMED", "CANCELLED"]).optional(),
  confirmationNo: z.string().nullable().optional(),
  bookingUrl: z.string().nullable().optional(),
  bookingAgentId: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
  notes: z.string().nullable().optional(),
});

function toDate(v: string | null | undefined) {
  if (v === undefined) return undefined;
  return v ? new Date(v) : null;
}

router.post("/", async (req, res) => {
  const parsed = itemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { startAt, endAt, ...rest } = parsed.data;
  const item = await prisma.tripItem.create({
    data: {
      ...rest,
      tripId: (req.params as Record<string, string>).tripId,
      startAt: toDate(startAt) ?? undefined,
      endAt: toDate(endAt) ?? undefined,
    },
  });
  res.status(201).json(item);
});

router.patch("/:itemId", async (req, res) => {
  const parsed = itemSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { startAt, endAt, ...rest } = parsed.data;
  const item = await prisma.tripItem.update({
    where: { id: req.params.itemId },
    data: {
      ...rest,
      ...(startAt !== undefined && { startAt: toDate(startAt) }),
      ...(endAt !== undefined && { endAt: toDate(endAt) }),
    },
  });
  res.json(item);
});

router.delete("/:itemId", async (req, res) => {
  await prisma.tripItem.delete({ where: { id: req.params.itemId } });
  res.status(204).end();
});

// Clears every item on a trip in one shot — used by the "regenerate itinerary"
// flow before applying a fresh AI proposal or a re-import. The client is
// responsible for confirming this destructive action with the user first.
router.delete("/", async (req, res) => {
  const tripId = (req.params as Record<string, string>).tripId;
  await prisma.tripItem.deleteMany({ where: { tripId } });
  res.status(204).end();
});

const bulkItemSchema = z.object({
  day: z.number().int().min(1),
  type: z.enum(["TRANSPORT", "STAY", "POI", "ACTIVITY", "OTHER"]),
  title: z.string().min(1),
  time: z.string().nullable().optional(),
  durationHours: z.number().nullable().optional(),
  location: z.string().nullable().optional(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  notes: z.string().nullable().optional(),
  estimatedCost: z.number().nullable().optional(),
});

const bulkSchema = z.object({ items: z.array(bulkItemSchema).min(1) });

// Trips planned before exact dates are picked have no real anchor date, but
// we still want to preserve the AI's time-of-day and duration for each item
// (otherwise "10:00, 2h" is silently thrown away). This fixed, meaningless
// date anchors day/time arithmetic in that case; the client knows to render
// only the time portion (not this date) when trip.startDate is null.
const UNDATED_TRIP_ANCHOR = new Date(Date.UTC(2000, 0, 1));

// Applies a day-relative AI proposal (from /trips/:id/propose-itinerary or
// /import-itinerary) to real TripItems, resolving day+time into datetimes
// (real ones if the trip has a start date, otherwise anchored to a fixed
// placeholder date so time-of-day and duration still round-trip).
router.post("/bulk", async (req, res) => {
  const parsed = bulkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const tripId = (req.params as Record<string, string>).tripId;
  const trip = await prisma.trip.findUnique({ where: { id: tripId } });
  if (!trip) return res.status(404).json({ error: "Trip not found" });

  const created = await prisma.$transaction(
    parsed.data.items.map((item, index) => {
      const [h, m] = (item.time || "09:00").split(":").map((n) => parseInt(n, 10) || 0);
      const startAt = new Date(trip.startDate ?? UNDATED_TRIP_ANCHOR);
      startAt.setDate(startAt.getDate() + (item.day - 1));
      startAt.setHours(h, m, 0, 0);
      const endAt = item.durationHours ? new Date(startAt.getTime() + item.durationHours * 3600_000) : undefined;

      const notes = item.notes ?? undefined;

      return prisma.tripItem.create({
        data: {
          tripId,
          type: item.type,
          title: item.title,
          location: item.location ?? undefined,
          lat: item.lat ?? undefined,
          lng: item.lng ?? undefined,
          cost: item.estimatedCost ?? undefined,
          startAt,
          endAt,
          notes,
          sortOrder: item.day * 100 + index,
        },
      });
    })
  );

  res.status(201).json(created);
});

export default router;
