import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";

const router = Router({ mergeParams: true });

const budgetSchema = z.object({
  category: z.enum(["TRANSPORT", "LODGING", "FOOD", "ACTIVITIES", "SHOPPING", "INSURANCE", "MISC"]),
  label: z.string().min(1),
  estimated: z.number().default(0),
  actual: z.number().nullable().optional(),
  currency: z.string().optional(),
});

router.get("/", async (req, res) => {
  const lines = await prisma.budgetLine.findMany({ where: { tripId: (req.params as Record<string, string>).tripId } });
  const totals = lines.reduce(
    (acc, l) => {
      acc.estimated += l.estimated;
      acc.actual += l.actual ?? 0;
      return acc;
    },
    { estimated: 0, actual: 0 }
  );
  res.json({ lines, totals });
});

router.post("/", async (req, res) => {
  const parsed = budgetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const line = await prisma.budgetLine.create({ data: { ...parsed.data, tripId: (req.params as Record<string, string>).tripId } });
  res.status(201).json(line);
});

router.patch("/:lineId", async (req, res) => {
  const parsed = budgetSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const line = await prisma.budgetLine.update({ where: { id: req.params.lineId }, data: parsed.data });
  res.json(line);
});

router.delete("/:lineId", async (req, res) => {
  await prisma.budgetLine.delete({ where: { id: req.params.lineId } });
  res.status(204).end();
});

export default router;
