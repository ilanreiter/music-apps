import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";

const router = Router();

const travelerSchema = z.object({
  name: z.string().min(1),
  age: z.number().int().min(0).max(130).nullable().optional(),
  homeLocation: z.string().nullable().optional(),
  avatarEmoji: z.string().nullable().optional(),
  photoUrl: z.string().nullable().optional(),
  travelPreferences: z.string().nullable().optional(),
  stayPreferences: z.string().nullable().optional(),
  transportPreferences: z.string().nullable().optional(),
  foodPreferences: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

router.get("/", async (_req, res) => {
  const travelers = await prisma.traveler.findMany({ orderBy: { createdAt: "asc" } });
  res.json(travelers);
});

router.post("/", async (req, res) => {
  const parsed = travelerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const traveler = await prisma.traveler.create({ data: parsed.data });
  res.status(201).json(traveler);
});

router.patch("/:id", async (req, res) => {
  const parsed = travelerSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const traveler = await prisma.traveler.update({ where: { id: req.params.id }, data: parsed.data });
  res.json(traveler);
});

router.delete("/:id", async (req, res) => {
  await prisma.traveler.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

export default router;
