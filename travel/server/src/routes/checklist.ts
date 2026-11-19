import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { travelerContext } from "../lib/travelerContext";
import { suggestChecklist } from "../lib/tripPlanningAi";

const router = Router({ mergeParams: true });
const tripId = (req: any) => (req.params as Record<string, string>).tripId as string;

const schema = z.object({
  text: z.string().trim().min(1).max(200), category: z.string().nullable(), dueDate: z.string().datetime().nullable(), done: z.boolean(), sortOrder: z.number().int(),
}).partial();

router.post("/", async (req, res) => {
  const parsed = schema.extend({ text: z.string().trim().min(1).max(200) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { dueDate, ...rest } = parsed.data;
  res.status(201).json(await prisma.checklistItem.create({ data: { ...rest, text: parsed.data.text, tripId: tripId(req), dueDate: dueDate ? new Date(dueDate) : undefined } }));
});

router.patch("/:itemId", async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { dueDate, ...rest } = parsed.data;
  res.json(await prisma.checklistItem.update({ where: { id: req.params.itemId }, data: { ...rest, ...(dueDate !== undefined && { dueDate: dueDate ? new Date(dueDate) : null }) } }));
});

router.delete("/:itemId", async (req, res) => {
  await prisma.checklistItem.delete({ where: { id: req.params.itemId } });
  res.status(204).end();
});

// AI-suggested checklist for this trip, tailored to the traveler profiles. Skips items already on the list.
router.post("/generate", async (req, res) => {
  const trip = await prisma.trip.findUnique({ where: { id: tripId(req) }, include: { destination: true, checklist: true } });
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  try {
    const ctx = await travelerContext();
    const items = await suggestChecklist({
      tripName: trip.destination?.name ?? trip.title, country: trip.destination?.country ?? null,
      season: trip.travelSeason ?? trip.destination?.bestSeason ?? null, nights: trip.durationNights ?? null, goal: trip.goal ?? null,
      profiles: ctx.text, existing: trip.checklist.map((c) => c.text),
    });
    const have = new Set(trip.checklist.map((c) => c.text.toLowerCase()));
    const fresh = items.filter((i) => !have.has(i.text.toLowerCase()));
    const base = trip.checklist.length;
    const created = await prisma.$transaction(fresh.map((i, n) => prisma.checklistItem.create({
      data: {
        tripId: trip.id, text: i.text, category: i.category, sortOrder: base + n,
        dueDate: trip.startDate && i.daysBefore != null ? new Date(trip.startDate.getTime() - i.daysBefore * 86_400_000) : undefined,
      },
    })));
    res.json({ added: created.length, usedProfiles: ctx.travelers });
  } catch (e: any) {
    res.status(503).json({ error: e.message || "AI checklist failed" });
  }
});

export default router;
