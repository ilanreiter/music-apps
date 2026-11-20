import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { geocodeTrip } from "../lib/geocodeTrip";
import { detectConflicts } from "../lib/conflicts";
import { optimizeRoute } from "../lib/routeOptimize";
import { proposeItinerary, proposeItineraryGemini, importItinerary, geocodeItems, buildProposePrompt } from "../lib/itineraryAi";
import { extractBookings } from "../lib/tripPlanningAi";
import { parsePlaces } from "../lib/placesImport";

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
      checklist: { orderBy: [{ done: "asc" }, { dueDate: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }] },
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
  // Items planned before the trip had dates sit on a placeholder calendar (Day 1 = 2000-01-01). When real dates are first
  // set, move them onto the real calendar so Day 1 becomes the start date and times of day are preserved.
  const before = startDate ? await prisma.trip.findUnique({ where: { id: req.params.id }, select: { startDate: true } }) : null;
  if (startDate && before && !before.startDate) {
    const s = new Date(startDate);
    const delta = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()) - Date.UTC(2000, 0, 1);
    const placeholder = await prisma.tripItem.findMany({ where: { tripId: req.params.id, startAt: { lt: new Date(Date.UTC(2001, 0, 1)) } } });
    await prisma.$transaction(placeholder.map((i) => prisma.tripItem.update({
      where: { id: i.id },
      data: { startAt: i.startAt ? new Date(i.startAt.getTime() + delta) : undefined, endAt: i.endAt ? new Date(i.endAt.getTime() + delta) : undefined },
    })));
  }
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
    select: { id: true, title: true, type: true, traveler: true, startAt: true, endAt: true },
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

async function resolveProposeInput(tripId: string, extraNotes: string | undefined) {
  const trip = await prisma.trip.findUnique({ where: { id: tripId }, include: { destination: true } });
  if (!trip) return null;

  const nights =
    trip.durationNights ??
    (trip.startDate && trip.endDate
      ? Math.max(1, Math.round((trip.endDate.getTime() - trip.startDate.getTime()) / (1000 * 60 * 60 * 24)))
      : 5);

  const preferences = await prisma.preferences.findUnique({ where: { id: "default" } });
  const travelerProfiles = await prisma.traveler.findMany({ orderBy: { createdAt: "asc" } });

  return {
    destinationName: trip.destination?.name || trip.title,
    destinationCountry: trip.destination?.country,
    destinationRegion: trip.destination?.region,
    destinationNotes: trip.destination?.notes,
    destinationTags: trip.destination?.tags,
    destinationBestSeason: trip.destination?.bestSeason,
    nights,
    startDate: trip.startDate,
    endDate: trip.endDate,
    travelSeason: trip.travelSeason,
    goal: trip.goal || "MIXED",
    goalDetail: trip.goalDetail || undefined,
    travelers: travelerProfiles.length || trip.travelers.length || 2,
    planningType: trip.planningType || "SELF_PLANNED",
    preferences,
    travelerProfiles,
    extraNotes,
  };
}

// Returns the exact prompt propose-itinerary would send to Claude, without
// calling the API — lets the user paste it into claude.ai chat (covered by
// a Pro/free plan) instead of paying for the API call, then paste the reply
// into /import-itinerary.
router.post("/:id/propose-itinerary-prompt", async (req, res) => {
  const parsed = proposeSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const input = await resolveProposeInput(req.params.id, parsed.data.extraNotes);
  if (!input) return res.status(404).json({ error: "Not found" });

  const { system, prompt } = buildProposePrompt(input);
  res.json({ system, prompt });
});

router.post("/:id/propose-itinerary", async (req, res) => {
  const parsed = proposeSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const input = await resolveProposeInput(req.params.id, parsed.data.extraNotes);
  if (!input) return res.status(404).json({ error: "Not found" });

  try {
    const proposal = await proposeItinerary(input);
    res.json(proposal);
  } catch (err: any) {
    res.status(503).json({ error: err.message || "AI proposal failed" });
  }
});

// Same as propose-itinerary but via Gemini's free tier — no API cost.
router.post("/:id/propose-itinerary-gemini", async (req, res) => {
  const parsed = proposeSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const input = await resolveProposeInput(req.params.id, parsed.data.extraNotes);
  if (!input) return res.status(404).json({ error: "Not found" });

  try {
    const proposal = await proposeItineraryGemini(input);
    res.json(proposal);
  } catch (err: any) {
    res.status(503).json({ error: err.message || "Gemini proposal failed" });
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

// Extract bookings (flights, hotels, cars, tours...) from pasted confirmation emails / receipts for review.
router.post("/:id/import-bookings", async (req, res) => {
  const parsed = z.object({ rawText: z.string().min(10) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const trip = await prisma.trip.findUnique({ where: { id: req.params.id }, include: { destination: true } });
  if (!trip) return res.status(404).json({ error: "Not found" });
  try {
    res.json({ bookings: await extractBookings(parsed.data.rawText, trip.destination?.name || trip.title) });
  } catch (e: any) {
    res.status(503).json({ error: e.message || "AI import failed" });
  }
});

// Parse a Google Maps export (Takeout GeoJSON/CSV, My Maps KML) or pasted places/links into places to review.
router.post("/:id/import-places", async (req, res) => {
  const parsed = z.object({ filename: z.string().default(""), content: z.string().min(1).max(5_000_000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    res.json({ places: parsePlaces(parsed.data.filename, parsed.data.content) });
  } catch {
    res.status(422).json({ error: "That file could not be read. Use a Takeout .json/.csv, a My Maps .kml, or paste place names / Google Maps links." });
  }
});

router.post("/:id/geocode-items", async (req, res) => {
  try {
    const r = await geocodeTrip(req.params.id);
    if (!r) return res.status(404).json({ error: "Not found" });
    res.json(r);
  } catch (err: any) {
    res.status(503).json({ error: err.message || "Geocoding failed" });
  }
});

export default router;
