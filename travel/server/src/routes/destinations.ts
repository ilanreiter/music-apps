import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";

const router = Router();

const destinationSchema = z.object({
  name: z.string().min(1),
  country: z.string().optional(),
  region: z.string().optional(),
  notes: z.string().optional(),
  status: z.enum(["IDEA", "RESEARCHING", "PLANNED", "BOOKED", "VISITED", "ARCHIVED"]).optional(),
  priority: z.number().int().optional(),
  tags: z.array(z.string()).optional(),
  imageUrl: z.string().optional(),
  roughCostEstimate: z.number().optional(),
  bestSeason: z.string().optional(),
});

router.get("/", async (_req, res) => {
  const destinations = await prisma.destination.findMany({
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    include: { _count: { select: { trips: true } } },
  });
  res.json(destinations);
});

router.get("/:id", async (req, res) => {
  const dest = await prisma.destination.findUnique({
    where: { id: req.params.id },
    include: { trips: true, resources: true },
  });
  if (!dest) return res.status(404).json({ error: "Not found" });
  res.json(dest);
});

router.post("/", async (req, res) => {
  const parsed = destinationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const count = await prisma.destination.count();
  const dest = await prisma.destination.create({
    data: { ...parsed.data, priority: parsed.data.priority ?? count },
  });
  res.status(201).json(dest);
});

router.patch("/:id", async (req, res) => {
  const parsed = destinationSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const dest = await prisma.destination.update({
    where: { id: req.params.id },
    data: parsed.data,
  });
  res.json(dest);
});

router.delete("/:id", async (req, res) => {
  await prisma.destination.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

// Bulk reorder: [{ id, priority }, ...]
router.post("/reorder", async (req, res) => {
  const schema = z.array(z.object({ id: z.string(), priority: z.number().int() }));
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  await prisma.$transaction(
    parsed.data.map((item) =>
      prisma.destination.update({ where: { id: item.id }, data: { priority: item.priority } })
    )
  );
  res.json({ ok: true });
});

export default router;
