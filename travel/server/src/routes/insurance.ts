import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";

const router = Router({ mergeParams: true });
const tripId = (req: any) => (req.params as Record<string, string>).tripId as string;
const day = (v: string | null | undefined) => (v === undefined ? undefined : v ? new Date(`${v.slice(0, 10)}T00:00:00Z`) : null);

const schema = z.object({
  provider: z.string().trim().min(1).max(200), planName: z.string().max(200).nullable(), policyNumber: z.string().max(120).nullable(),
  coverageStart: z.string().nullable(), coverageEnd: z.string().nullable(), travelers: z.array(z.string().max(120)).max(20),
  emergencyPhone: z.string().max(200).nullable(), claimsContact: z.string().max(400).nullable(), url: z.string().max(2000).nullable(), notes: z.string().max(8000).nullable(),
}).partial();

router.get("/", async (req, res) => {
  res.json(await prisma.insurancePolicy.findMany({ where: { tripId: tripId(req) }, orderBy: { coverageStart: "asc" } }));
});

router.post("/", async (req, res) => {
  const p = schema.extend({ provider: z.string().trim().min(1).max(200) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  const { coverageStart, coverageEnd, ...rest } = p.data;
  res.status(201).json(await prisma.insurancePolicy.create({ data: { ...rest, provider: p.data.provider, tripId: tripId(req), coverageStart: day(coverageStart), coverageEnd: day(coverageEnd) } }));
});

router.patch("/:id", async (req, res) => {
  const p = schema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  const { coverageStart, coverageEnd, ...rest } = p.data;
  res.json(await prisma.insurancePolicy.update({ where: { id: req.params.id }, data: { ...rest, coverageStart: day(coverageStart), coverageEnd: day(coverageEnd) } }));
});

router.delete("/:id", async (req, res) => {
  await prisma.insurancePolicy.deleteMany({ where: { id: req.params.id, tripId: tripId(req) } });
  res.status(204).end();
});

export default router;
