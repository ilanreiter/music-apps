import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { metaFor } from "../lib/roadmapMeta";
import { parseRoadmap, pairingMembers } from "../lib/roadmapImport";

const router = Router();

async function getSettings() {
  return prisma.roadmapSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
}

router.get("/", async (_req, res) => {
  const [settings, pairings, destinations] = await Promise.all([
    getSettings(),
    prisma.pairing.findMany({ orderBy: [{ year: "asc" }] }),
    prisma.destination.findMany({
      where: { OR: [{ planYear: { not: null } }, { status: { in: ["VISITED", "IDEA", "RESEARCHING", "PLANNED", "BOOKED"] } }] },
      orderBy: [{ priority: "asc" }],
      select: {
        id: true, name: true, status: true, priority: true, notes: true, planYear: true, planSeason: true,
        tier: true, isFar: true, days: true, dailyCost: true, transitCost: true, mobility: true,
        pairingId: true, bestSeason: true, secondSeason: true, weather: true, weatherAlt: true,
        lat: true, lng: true, suggestedYear: true, suggestedSeason: true, suggestedPriority: true, pinned: true, _count: { select: { trips: true } },
        trips: { select: { id: true }, take: 1, orderBy: { createdAt: "desc" } },
      },
    }),
  ]);
  res.json({ settings, pairings, destinations });
});

const settingsSchema = z.object({
  startYear: z.number().int(), endYear: z.number().int(), annualCap: z.number().nonnegative(),
  maxFarPerYear: z.number().int().nonnegative(), ageA: z.number().int().nullable(),
  ageB: z.number().int().nullable(), highMobilityUntil: z.number().int().nullable(),
  ruleOrder: z.array(z.string()), ruleDisabled: z.array(z.string()),
}).partial();

router.patch("/settings", async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  await getSettings();
  res.json(await prisma.roadmapSettings.update({ where: { id: "default" }, data: parsed.data }));
});

const planSchema = z.object({
  planYear: z.number().int().nullable(), planSeason: z.string().nullable(), tier: z.string().nullable(),
  isFar: z.boolean(), days: z.number().int().nullable(), dailyCost: z.number().nullable(),
  transitCost: z.number().nullable(), mobility: z.string().nullable(), pairingId: z.string().nullable(),
  bestSeason: z.string().nullable(), secondSeason: z.string().nullable(), weather: z.string().nullable(),
  weatherAlt: z.string().nullable(), pinned: z.boolean(), lat: z.number().nullable(), lng: z.number().nullable(),
}).partial();

// Edit a destination's roadmap slot (year, season, days, costs, ...).
router.patch("/destinations/:id", async (req, res) => {
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(await prisma.destination.update({ where: { id: req.params.id }, data: parsed.data }));
});

const pairingSchema = z.object({
  name: z.string().min(1), year: z.number().int().nullable(), quarter: z.string().nullable(), savings: z.number().nonnegative(),
}).partial();

router.post("/pairings", async (req, res) => {
  const parsed = pairingSchema.extend({ name: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.status(201).json(await prisma.pairing.create({ data: parsed.data }));
});
router.patch("/pairings/:id", async (req, res) => {
  const parsed = pairingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(await prisma.pairing.update({ where: { id: req.params.id }, data: parsed.data }));
});
router.delete("/pairings/:id", async (req, res) => {
  await prisma.pairing.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

// Fill location / second season / weather for planned destinations that lack
// them, and record the rules-based slot so drag-and-drop moves can be reset.
router.post("/enrich", async (_req, res) => {
  const rows = await prisma.destination.findMany({ where: { status: { not: "VISITED" }, planYear: { not: null } } });
  let updated = 0;
  for (const d of rows) {
    const m = metaFor(d.name);
    const data: Record<string, unknown> = {};
    if (m && d.lat == null) Object.assign(data, m);
    if (d.suggestedYear == null) { data.suggestedYear = d.planYear; data.suggestedSeason = d.planSeason; }
    if (d.suggestedPriority == null) data.suggestedPriority = d.priority;
    if (Object.keys(data).length) { await prisma.destination.update({ where: { id: d.id }, data }); updated++; }
  }
  res.json({ updated });
});

// Drag-and-drop result: new slot + priority for each moved/reordered card.
router.post("/reorder", async (req, res) => {
  const parsed = z.array(z.object({
    id: z.string(), planYear: z.number().int().nullable(), planSeason: z.string().nullable(), priority: z.number().int(),
  })).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  await prisma.$transaction(parsed.data.map((u) => prisma.destination.update({
    where: { id: u.id }, data: { planYear: u.planYear, planSeason: u.planSeason, priority: u.priority },
  })));
  res.json({ ok: true });
});

// Put every UNPINNED card back in the slot/order the prioritization rules gave it.
router.post("/reset-suggested", async (_req, res) => {
  const rows = await prisma.destination.findMany({
    where: { suggestedYear: { not: null }, pinned: false },
    select: { id: true, suggestedYear: true, suggestedSeason: true, suggestedPriority: true, priority: true },
  });
  await prisma.$transaction(rows.map((r) => prisma.destination.update({
    where: { id: r.id },
    data: { planYear: r.suggestedYear, planSeason: r.suggestedSeason, priority: r.suggestedPriority ?? r.priority },
  })));
  res.json({ reset: rows.length });
});

// One-time import from the markdown summary. Destinations are matched by name
// (case-insensitive) and updated, so re-running never duplicates; pairings are
// rebuilt from the file.
router.post("/import", async (req, res) => {
  const parsed = z.object({ markdown: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = parseRoadmap(parsed.data.markdown);
  if (!data.destinations.length) return res.status(400).json({ error: "No destination tables found in that file" });

  const existing = await prisma.destination.findMany({ select: { id: true, name: true } });
  const byName = new Map(existing.map((d) => [d.name.toLowerCase(), d.id]));
  const idByParsed = new Map<ParsedKey, string>();
  type ParsedKey = (typeof data.destinations)[number];

  await prisma.$transaction(async (tx) => {
    await tx.destination.updateMany({ data: { pairingId: null } });
    await tx.pairing.deleteMany({});
    let visitedIdx = 0;
    for (const d of data.destinations) {
      const fields = {
        planYear: d.planYear, planSeason: d.season || null, tier: d.tier || null,
        isFar: /^far/i.test(d.tier), days: d.days, dailyCost: d.dailyCost, transitCost: d.transitCost,
        mobility: d.mobility || null, notes: d.notes || null,
        status: d.visited ? ("VISITED" as const) : ("PLANNED" as const),
        priority: d.rank ?? 1000 + visitedIdx++,
        bestSeason: d.season || null,
        suggestedYear: d.planYear, suggestedSeason: d.season || null, suggestedPriority: d.rank ?? 1000 + visitedIdx,
        ...(metaFor(d.name) ?? {}),
      };
      const id = byName.get(d.name.toLowerCase());
      const row = id
        ? await tx.destination.update({ where: { id }, data: fields })
        : await tx.destination.create({ data: { name: d.name, ...fields } });
      idByParsed.set(d, row.id);
    }
    for (const p of data.pairings) {
      const pair = await tx.pairing.create({ data: { name: p.name, year: p.year, quarter: p.quarter, savings: p.savings } });
      const ids = pairingMembers(p, data.destinations).map((d) => idByParsed.get(d)!);
      if (ids.length) await tx.destination.updateMany({ where: { id: { in: ids } }, data: { pairingId: pair.id } });
    }
    await tx.roadmapSettings.upsert({ where: { id: "default" }, update: data.settings, create: { id: "default", ...data.settings } });
  });

  res.json({
    planned: data.destinations.filter((d) => !d.visited).length,
    visited: data.destinations.filter((d) => d.visited).length,
    pairings: data.pairings.length,
  });
});

export default router;
