import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";

const router = Router({ mergeParams: true });

const itemSchema = z.object({
  type: z.enum(["TRANSPORT", "STAY", "POI", "ACTIVITY", "OTHER"]),
  title: z.string().min(1),
  provider: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  startAt: z.string().datetime().nullable().optional(),
  endAt: z.string().datetime().nullable().optional(),
  cost: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  bookingStatus: z.enum(["IDEA", "RESEARCHING", "READY_TO_BOOK", "BOOKED", "CONFIRMED", "CANCELLED"]).optional(),
  confirmationNo: z.string().nullable().optional(),
  bookingUrl: z.string().nullable().optional(),
  bookingAgentId: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
  notes: z.string().nullable().optional(),
});

function toDate(v: string | null | undefined) {
  if (v === undefined) return undefined;
  return v ? new Date(v) : null;
}

router.post("/", async (req, res) => {
  const parsed = itemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { startAt, endAt, ...rest } = parsed.data;
  const item = await prisma.tripItem.create({
    data: {
      ...rest,
      tripId: (req.params as Record<string, string>).tripId,
      startAt: toDate(startAt) ?? undefined,
      endAt: toDate(endAt) ?? undefined,
    },
  });
  res.status(201).json(item);
});

router.patch("/:itemId", async (req, res) => {
  const parsed = itemSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { startAt, endAt, ...rest } = parsed.data;
  const item = await prisma.tripItem.update({
    where: { id: req.params.itemId },
    data: {
      ...rest,
      ...(startAt !== undefined && { startAt: toDate(startAt) }),
      ...(endAt !== undefined && { endAt: toDate(endAt) }),
    },
  });
  res.json(item);
});

router.delete("/:itemId", async (req, res) => {
  await prisma.tripItem.delete({ where: { id: req.params.itemId } });
  res.status(204).end();
});

export default router;
