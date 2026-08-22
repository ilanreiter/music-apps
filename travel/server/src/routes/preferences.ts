import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";

const router = Router();

const prefsSchema = z.object({
  interests: z.array(z.string()).optional(),
  pace: z.string().nullable().optional(),
  budgetStyle: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

router.get("/", async (_req, res) => {
  const prefs = await prisma.preferences.findUnique({ where: { id: "default" } });
  res.json(prefs ?? { id: "default", interests: [], pace: null, budgetStyle: null, notes: null });
});

router.put("/", async (req, res) => {
  const parsed = prefsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const prefs = await prisma.preferences.upsert({
    where: { id: "default" },
    update: parsed.data,
    create: { id: "default", ...parsed.data },
  });
  res.json(prefs);
});

export default router;
