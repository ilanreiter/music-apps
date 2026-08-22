import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { detectConflicts } from "../lib/conflicts";
import { optimizeRoute } from "../lib/routeOptimize";
import { proposeItinerary, importItinerary, geocodeItems } from "../lib/itineraryAi";

const router = Router();

const tripSchema = z.object({
  title: z.string().min(1),
  destinationId: z.string().nullable().optional(),
  startDate: z.string().datetime().nullable().optional(),
  endDate: z.string().datetime().nullable().optional(),
  durationNights: z.number().int().nullable().optional(),
  travelSeason: z.string().nullable().optional(),
  planningType: z.enum(["SELF_PLANNED", "GROUP", "ORGANIZED"]).nullable().optional(),
  goal: z.enum(["NATURE", "SIGHTSEEING", "CITY", "RELAXATION", "ADVENTURE", "MIXED", "OTHER"]).nullable().optional(),
  goalDetail: z.string().nullable().optional(),
  status: z.enum(["DRAFT", "PLANNING", "BOOKED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]).optional(),
  travelers: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

router.get("/", async (_req, res) => {
  const trips = await prisma.trip.findMany({
    orderBy: { createdAt: "desc" },
    include: { destination: true, _count: { select: { items: true } } },
  });
  res.json(trips);
});

router.get("/:id", async (req, res) => {
  const trip = await prisma.trip.findUnique({
    where: { id: req.params.id },
    include: {
      destination: true,
      items: { orderBy: [{ startAt: "asc" }, { sortOrder: "asc" }], include: { bookingAgent: true } },
      budgetLines: true,
      resources: true,
    },
  });
  if (!trip) return res.status(404).json({ error: "Not found" });
  res.json(trip);
});

router.post("/", async (req, res) => {
  const parsed = tripSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { startDate, endDate, ...rest } = parsed.data;
  const trip = await prisma.trip.create({
    data: {
      ...rest,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    },
  });
  res.status(201).json(trip);
});

router.patch("/:id", async (req, res) => {
  const parsed = tripSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { startDate, endDate, ...rest } = parsed.data;
  const trip = await prisma.trip.update({
    where: { id: req.params.id },
    data: {
      ...rest,
      ...(startDate !== undefined && { startDate: startDate ? new Date(startDate) : null }),
      ...(endDate !== undefined && { endDate: endDate ? new Date(endDate) : null }),
    },
  });
  res.json(trip);
});

router.delete("/:id", async (req, res) => {
  await prisma.trip.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

router.get("/:id/conflicts", async (req, res) => {
  const items = await prisma.tripItem.findMany({
    where: { tripId: req.params.id },
    select: { id: true, title: true, type: true, startAt: true, endAt: true },
  });
  res.json(detectConflicts(items));
});

router.get("/:id/optimize-route", async (req, res) => {
  const items = await prisma.tripItem.findMany({
    where: { tripId: req.params.id, type: { in: ["POI", "ACTIVITY"] }, lat: { not: null }, lng: { not: null } },
  });

  const points = items
    .filter((i) => i.lat !== null && i.lng !== null)
    .map((i) => ({ id: i.id, title: i.title, lat: i.lat as number, lng: i.lng as number }));

  const result = optimizeRoute(points);
  res.json(result);
});

const proposeSchema = z.object({
  extraNotes: z.string().optional(),
});

router.post("/:id/propose-itinerary", async (req, res) => {
  const parsed = proposeSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const trip = await prisma.trip.findUnique({ where: { id: req.params.id }, include: { destination: true } });
  if (!trip) return res.status(404).json({ error: "Not found" });

  const nights =
    trip.durationNights ??
    (trip.startDate && trip.endDate
      ? Math.max(1, Math.round((trip.endDate.getTime() - trip.startDate.getTime()) / (1000 * 60 * 60 * 24)))
      : 5);

  const preferences = await prisma.preferences.findUnique({ where: { id: "default" } });

  try {
    const proposal = await proposeItinerary({
      destinationName: trip.destination?.name || trip.title,
      nights,
      goal: trip.goal || "MIXED",
      goalDetail: trip.goalDetail || undefined,
      travelers: trip.travelers.length || 2,
      planningType: trip.planningType || "SELF_PLANNED",
      preferences,
      extraNotes: parsed.data.extraNotes,
    });
    res.json(proposal);
  } catch (err: any) {
    res.status(503).json({ error: err.message || "AI proposal failed" });
  }
});

const importSchema = z.object({
  rawText: z.string().min(1),
});

router.post("/:id/import-itinerary", async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const trip = await prisma.trip.findUnique({ where: { id: req.params.id }, include: { destination: true } });
  if (!trip) return res.status(404).json({ error: "Not found" });

  try {
    const proposal = await importItinerary({
      rawText: parsed.data.rawText,
      destinationName: trip.destination?.name || trip.title,
    });
    res.json(proposal);
  } catch (err: any) {
    res.status(503).json({ error: err.message || "AI import failed" });
  }
});

router.post("/:id/geocode-items", async (req, res) => {
  const trip = await prisma.trip.findUnique({
    where: { id: req.params.id },
    include: { destination: true, items: true },
  });
  if (!trip) return res.status(404).json({ error: "Not found" });

  const missing = trip.items.filter((i) => i.lat == null || i.lng == null);
  if (missing.length === 0) return res.json({ updated: 0 });

  try {
    const results = await geocodeItems(
      trip.destination?.name || trip.title,
      missing.map((i) => ({ id: i.id, title: i.title, location: i.location }))
    );
    const resolved = results.filter((r) => r.lat != null && r.lng != null);
    await prisma.$transaction(
      resolved.map((r) => prisma.tripItem.update({ where: { id: r.id }, data: { lat: r.lat, lng: r.lng } }))
    );
    res.json({ updated: resolved.length, checked: missing.length });
  } catch (err: any) {
    res.status(503).json({ error: err.message || "Geocoding failed" });
  }
});

export default router;
