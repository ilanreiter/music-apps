import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { pageImage } from "../lib/sourceText";

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
  // Fill in missing preview pictures in the background (a few per request) so older resources get one too.
  for (const r of resources.filter((x) => x.url && x.imageUrl === null).slice(0, 6)) {
    pageImage(r.url!).then((img) => prisma.resource.update({ where: { id: r.id }, data: { imageUrl: img ?? "" } })).catch(() => {});
  }
});

router.post("/", async (req, res) => {
  const parsed = resourceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const imageUrl = parsed.data.url ? (await pageImage(parsed.data.url)) ?? "" : undefined;
  const resource = await prisma.resource.create({ data: { ...parsed.data, imageUrl } });
  res.status(201).json(resource);
});

router.delete("/:id", async (req, res) => {
  await prisma.resource.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

export default router;
