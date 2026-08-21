import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { detectConflicts } from "../lib/conflicts";
import { optimizeRoute } from "../lib/routeOptimize";

const router = Router();

const tripSchema = z.object({
  title: z.string().min(1),
  destinationId: z.string().nullable().optional(),
  startDate: z.string().datetime().nullable().optional(),
  endDate: z.string().datetime().nullable().optional(),
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

export default router;
