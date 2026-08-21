import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";

const router = Router();

const agentSchema = z.object({
  name: z.string().min(1),
  type: z.string().optional(),
  contact: z.string().optional(),
  website: z.string().optional(),
  notes: z.string().optional(),
});

router.get("/", async (_req, res) => {
  const agents = await prisma.bookingAgent.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { items: true } } },
  });
  res.json(agents);
});

router.post("/", async (req, res) => {
  const parsed = agentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const agent = await prisma.bookingAgent.create({ data: parsed.data });
  res.status(201).json(agent);
});

router.patch("/:id", async (req, res) => {
  const parsed = agentSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const agent = await prisma.bookingAgent.update({ where: { id: req.params.id }, data: parsed.data });
  res.json(agent);
});

router.delete("/:id", async (req, res) => {
  await prisma.bookingAgent.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

export default router;
