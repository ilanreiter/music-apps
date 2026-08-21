import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";

const router = Router();

const resourceSchema = z.object({
  title: z.string().min(1),
  url: z.string().optional(),
  category: z.string().optional(),
  notes: z.string().optional(),
  destinationId: z.string().nullable().optional(),
  tripId: z.string().nullable().optional(),
});

router.get("/", async (req, res) => {
  const { destinationId, tripId } = req.query;
  const resources = await prisma.resource.findMany({
    where: {
      ...(destinationId ? { destinationId: String(destinationId) } : {}),
      ...(tripId ? { tripId: String(tripId) } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(resources);
});

router.post("/", async (req, res) => {
  const parsed = resourceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const resource = await prisma.resource.create({ data: parsed.data });
  res.status(201).json(resource);
});

router.delete("/:id", async (req, res) => {
  await prisma.resource.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

export default router;
