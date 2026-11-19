import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { metaFor } from "../lib/roadmapMeta";
import { parseRoadmap, pairingMembers } from "../lib/roadmapImport";
import { getAnthropicClient, AI_MODEL } from "../lib/anthropic";
import { getHomeLocations, formatTravelerProfilesBlock } from "../lib/itineraryAi";

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
        id: true, name: true, country: true, countryCode: true, status: true, priority: true, notes: true, planYear: true, planSeason: true,
        tier: true, isFar: true, days: true, dailyCost: true, transitCost: true, mobility: true,
        pairingId: true, bestSeason: true, secondSeason: true, weather: true, weatherAlt: true,
        lat: true, lng: true, suggestedYear: true, suggestedSeason: true, suggestedPriority: true, pinned: true, seasonFactors: true, _count: { select: { trips: true } },
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
  ruleOrder: z.array(z.string()), ruleDisabled: z.array(z.string()), autoOrder: z.boolean(),
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
  weatherAlt: z.string().nullable(), pinned: z.boolean(), status: z.enum(["IDEA", "RESEARCHING", "PLANNED", "BOOKED", "VISITED", "ARCHIVED"]), seasonFactors: z.record(z.number().min(0.3).max(3)).nullable(), lat: z.number().nullable(), lng: z.number().nullable(),
}).partial();

// Edit a destination's roadmap slot (year, season, days, costs, ...).
// A pairing left with fewer than two members is dissolved.
async function tidyPairing(pairingId: string | null | undefined) {
  if (!pairingId) return;
  if ((await prisma.destination.count({ where: { pairingId, status: { not: "VISITED" } } })) < 2) {
    await prisma.destination.updateMany({ where: { pairingId }, data: { pairingId: null } });
    await prisma.pairing.deleteMany({ where: { id: pairingId } });
  }
}

router.patch("/destinations/:id", async (req, res) => {
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { seasonFactors, ...rest } = parsed.data;
  const before = await prisma.destination.findUnique({ where: { id: req.params.id }, select: { pairingId: true } });
  // Marking a place as traveled takes it off the board and out of any combined trip.
  if (rest.status === "VISITED") Object.assign(rest, { planYear: null, planSeason: null, pairingId: null, pinned: false });
  const updated = await prisma.destination.update({ where: { id: req.params.id }, data: { ...rest, ...(seasonFactors === undefined ? {} : { seasonFactors: seasonFactors === null ? Prisma.DbNull : seasonFactors }) } });
  if (rest.status === "VISITED" || rest.pairingId === null) await tidyPairing(before?.pairingId);
  res.json(updated);
});

// Remove a destination from the roadmap entirely.
router.delete("/destinations/:id", async (req, res) => {
  const d = await prisma.destination.findUnique({ where: { id: req.params.id }, select: { pairingId: true } });
  if (!d) return res.status(404).json({ error: "Not found" });
  await prisma.destination.delete({ where: { id: req.params.id } });
  await tidyPairing(d.pairingId);
  res.status(204).end();
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

/** Keep factors sane and make the best season exactly 1.0 (the listed cost is the best-season cost). */
function normFactors(f: Record<string, number> | undefined, best: string | null) {
  if (!f) return undefined;
  const out: Record<string, number> = {};
  for (const sn of SEASONS) out[sn] = Math.round(Math.min(1.6, Math.max(0.7, Number(f[sn]) || 1)) * 100) / 100;
  if (best && out[best] != null) { const b = out[best]; for (const sn of SEASONS) out[sn] = Math.round((out[sn] / b) * 100) / 100; }
  return out;
}

// Estimate seasonal cost multipliers for destinations that don't have them yet (names + seasons only are sent to the AI).
router.post("/season-costs", async (req, res) => {
  const client = getAnthropicClient();
  if (!client) return res.status(503).json({ error: "AI is not configured. Set ANTHROPIC_API_KEY in the server environment." });
  const force = req.body?.force === true;
  const rows = await prisma.destination.findMany({
    where: { status: { not: "VISITED" }, ...(force ? {} : { seasonFactors: { equals: Prisma.DbNull } }), OR: [{ planYear: { not: null } }, { status: { in: ["IDEA", "RESEARCHING", "PLANNED", "BOOKED"] } }] },
    select: { id: true, name: true, bestSeason: true },
  });
  if (!rows.length) return res.json({ updated: 0 });
  let updated = 0;
  // Small batches keep each AI answer short and well within the token budget.
  for (let off = 0; off < rows.length; off += 15) {
    const batch = rows.slice(off, off + 15);
    const list = batch.map((d, i) => `${i}: ${d.name} (best season: ${d.bestSeason ?? "unknown"})`).join("\n");
    const response = await client.messages.create({
      model: AI_MODEL, max_tokens: 8000,
      system: "You produce only valid JSON when asked to. No markdown fences, no commentary.",
      messages: [{ role: "user", content: `For each travel destination below, give the multiplier for TOTAL trip cost (airfare + lodging + activities) in each northern-hemisphere season relative to its best season, which is exactly 1.0. High/peak season > 1, shoulder and low season < 1. Range 0.7–1.6; be realistic and differentiated.
Respond ONLY with JSON: {"items":[{"i":0,"Winter":n,"Spring":n,"Summer":n,"Fall":n}, ...]} covering every index.
${list}` }],
    });
    const block = response.content.find((b) => b.type === "text");
    const text = block && "text" in block ? block.text : "";
    let items: any[] = [];
    try { const m = text.match(/\{[\s\S]*\}/); items = JSON.parse(m ? m[0] : text).items ?? []; }
    catch (e) { console.error("season-costs parse failed:", response.stop_reason, text.slice(0, 200), String(e)); return res.status(502).json({ error: "The AI estimate could not be read. Try again.", updated }); }
    for (const it of items) {
      const d = batch[it?.i];
      if (!d) continue;
      const f = normFactors({ Winter: it.Winter, Spring: it.Spring, Summer: it.Summer, Fall: it.Fall }, d.bestSeason);
      if (!f) continue;
      await prisma.destination.update({ where: { id: d.id }, data: { seasonFactors: f } });
      updated++;
    }
  }
  res.json({ updated, of: rows.length });
});

// Traveler profiles + shared preferences, used to steer every AI estimate.
async function travelerContext() {
  const [travelers, prefs] = await Promise.all([
    prisma.traveler.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.preferences.findUnique({ where: { id: "default" } }),
  ]);
  const home = getHomeLocations(travelers)[0];
  const lines = [
    formatTravelerProfilesBlock(travelers),
    prefs?.pace ? `Preferred pace: ${prefs.pace}.` : "",
    prefs?.budgetStyle ? `Budget style: ${prefs.budgetStyle}.` : "",
    prefs?.interests?.length ? `Interests: ${prefs.interests.join(", ")}.` : "",
    prefs?.notes ? `Household notes: ${prefs.notes}` : "",
    home ? `They fly round-trip from ${home}.` : "They fly round-trip from the US East Coast.",
    "Let the profiles shape the numbers: ages and mobility notes (slower pace, fewer long days), stay/food/transport preferences (e.g. higher-end hotels or direct flights raise cost), and the budget style.",
  ].filter(Boolean);
  return { travelers: travelers.length, text: lines.join("\n") };
}

// Re-estimate an existing card's duration and costs with Claude, using the traveler profiles.
router.post("/destinations/:id/estimate", async (req, res) => {
  const client = getAnthropicClient();
  if (!client) return res.status(503).json({ error: "AI is not configured. Set ANTHROPIC_API_KEY in the server environment to estimate trip details." });
  const d = await prisma.destination.findUnique({ where: { id: req.params.id } });
  if (!d) return res.status(404).json({ error: "Not found" });
  const ctx = await travelerContext();
  const season = d.bestSeason ?? d.planSeason;
  const prompt = `Estimate the ideal trip duration and costs for "${d.name}"${d.country ? ` (${d.country})` : ""}${season ? `, travelling in ${season}, its best season` : ""}.
The trip is for 2 travelers.
${ctx.text}
Return ONLY strict JSON, no prose:
{"days":ideal trip length in days (integer),"dailyCost":USD per day for BOTH travelers combined excluding flights (lodging, food, local transport, activities),"transitCost":USD round-trip airfare for BOTH travelers,"rationale":"one short sentence on how the traveler profiles shaped this"}`;
  const response = await client.messages.create({
    model: AI_MODEL, max_tokens: 4000,
    system: "You produce only valid JSON when asked to. No markdown fences, no commentary.",
    messages: [{ role: "user", content: prompt }],
  });
  const block = response.content.find((b) => b.type === "text");
  const text = block && "text" in block ? block.text : "";
  let raw: unknown = null;
  try { const m = text.match(/\{[\s\S]*\}/); raw = JSON.parse(m ? m[0] : text); } catch { raw = null; }
  const parsed = z.object({
    days: z.number().int().min(2).max(60), dailyCost: z.number().min(20).max(3000), transitCost: z.number().min(0).max(40000), rationale: z.string().optional(),
  }).safeParse(raw);
  if (!parsed.success) return res.status(502).json({ error: "The AI estimate could not be read. Try again." });
  const e = parsed.data;
  await prisma.destination.update({ where: { id: d.id }, data: { days: e.days, dailyCost: Math.round(e.dailyCost), transitCost: Math.round(e.transitCost) } });
  res.json({ ok: true, usedProfiles: ctx.travelers, rationale: e.rationale ?? null });
});

// Ask Claude to propose the order (year + season) of every unpinned, scheduled trip, following the
// prioritization rules and the traveler profiles. The proposal is validated before it is returned.
const RULE_TEXT: Record<string, (s: { cap: number; far: number; until: number | null }) => string> = {
  far: (s) => `Long-haul trips: at most ${s.far} departures per year (a combined trip counts as one).`,
  cap: () => "Each year's total cost must stay under the annual cap (costs below are given as a fraction of the cap; the fractions of a year's trips must sum to at most 1.0).",
  mobility: (s) => `Harder trips (higher difficulty) go in earlier years, easing off toward easy trips later${s.until ? `; no demanding trips (difficulty Moderate-High or High) after ${s.until}` : ""}.`,
  season: () => "Plan each trip in its best or 2nd-best season.",
  quarter: () => "At most one trip (departure) per season of a year.",
  gaps: () => "No empty seasons: fill every season from the first year onward before leaving gaps (empty seasons after the last trip are fine).",
  pair: () => "Keep combined trips together (they are single units below).",
  rank: () => "Prefer the existing rank order (lower rank number first) when nothing else decides.",
};

router.post("/ai-order", async (_req, res) => {
  const client = getAnthropicClient();
  if (!client) return res.status(503).json({ error: "AI is not configured. Set ANTHROPIC_API_KEY in the server environment to get an AI ordering." });
  const [settings, pairings, all, ctx] = await Promise.all([
    getSettings(), prisma.pairing.findMany(),
    prisma.destination.findMany({ where: { status: { not: "VISITED" }, planYear: { not: null } }, orderBy: { priority: "asc" } }),
    travelerContext(),
  ]);
  const years: number[] = [];
  for (let y = settings.startYear; y <= settings.endYear; y++) years.push(y);
  // Units: a combined trip moves as one.
  const unitsMap = new Map<string, typeof all>();
  for (const d of all) unitsMap.set(d.pairingId ?? d.id, [...(unitsMap.get(d.pairingId ?? d.id) ?? []), d]);
  const units = [...unitsMap.values()];
  const fixed = units.filter((u) => u.some((d) => d.pinned));
  const movable = units.filter((u) => !u.some((d) => d.pinned));
  const frac = (u: typeof all) => Math.round((u.reduce((t, d) => t + ((d.days ?? 0) * (d.dailyCost ?? 0) + (d.transitCost ?? 0)), 0) / settings.annualCap) * 100) / 100;
  const label = (u: typeof all) => u.map((d) => d.name).join(" + ");
  const desc = (u: typeof all) => {
    const d = u[0];
    const lvl = u.map((m) => m.mobility).sort((a, b) => MOBILITY.indexOf(b ?? "") - MOBILITY.indexOf(a ?? ""))[0];
    return `${label(u)} | best: ${d.bestSeason ?? "?"}, 2nd: ${d.secondSeason ?? "?"} | ${u.reduce((t, m) => t + (m.days ?? 0), 0)} days | difficulty: ${lvl ?? "?"} | long-haul: ${u.some((m) => m.isFar) ? "yes" : "no"} | cost as fraction of annual cap: ${frac(u)}${d.seasonFactors ? ` | season cost multipliers: ${JSON.stringify(d.seasonFactors)}` : ""} | current rank: ${d.priority}`;
  };
  const order = [...(settings.ruleOrder ?? []), ...Object.keys(RULE_TEXT).filter((r) => !(settings.ruleOrder ?? []).includes(r))]
    .filter((r) => RULE_TEXT[r] && !(settings.ruleDisabled ?? []).includes(r));
  const rt = { cap: settings.annualCap, far: settings.maxFarPerYear, until: settings.highMobilityUntil };
  const prompt = `Plan the order of retirement trips for a couple across ${settings.startYear}–${settings.endYear} (each year has Winter, Spring, Summer, Fall slots).
${ctx.text}

Prioritization rules, most important first (a higher rule always beats every lower one):
${order.map((r, i) => `${i + 1}. ${RULE_TEXT[r](rt)}`).join("\\n")}

Already fixed (pinned, do not move):
${fixed.length ? fixed.map((u) => `- ${label(u)} in ${u[0].planYear} ${u[0].planSeason ?? "?"}`).join("\\n") : "(none)"}

Trips to place (index: details):
${movable.map((u, i) => `${i}: ${desc(u)}`).join("\\n")}

Give EVERY listed trip one year (${settings.startYear}–${settings.endYear}) and one season. Return ONLY strict JSON:
{"placements":[{"i":0,"year":${settings.startYear},"season":"Winter"}, ...],"rationale":"two short sentences on the main trade-offs"}`;
  const response = await client.messages.create({
    model: AI_MODEL, max_tokens: 16000, ...({ thinking: { type: "disabled" } } as object),
    system: "You produce only valid JSON when asked to. No markdown fences, no commentary.",
    messages: [{ role: "user", content: prompt }],
  }, { timeout: 100_000, maxRetries: 0 }).catch((e: any) => { console.error("ai-order failed:", e?.status ?? "", String(e?.message ?? e).slice(0, 200)); return null; });
  if (!response) return res.status(504).json({ error: "The AI took too long or was unavailable. Please try again in a moment." });
  const block = response.content.find((b) => b.type === "text");
  const text = block && "text" in block ? block.text : "";
  let raw: any = null;
  try { const m = text.match(/\{[\s\S]*\}/); raw = JSON.parse(m ? m[0] : text); } catch { raw = null; }
  if (!raw || !Array.isArray(raw.placements)) {
    console.error("ai-order parse failed:", response.stop_reason, text.slice(0, 200));
    return res.status(502).json({ error: "The AI ordering could not be read. Try again." });
  }
  // Validate: known unit, year in range, valid season. Anything else keeps its current slot.
  const slot = new Map<number, { year: number; season: string }>();
  for (const p of raw.placements) {
    const i = Number(p?.i);
    if (!Number.isInteger(i) || !movable[i] || !years.includes(Number(p.year)) || !SEASONS.includes(p.season)) continue;
    slot.set(i, { year: Number(p.year), season: p.season });
  }
  const placements: { id: string; planYear: number; planSeason: string; priority: number }[] = [];
  const entries: { u: typeof all; year: number; season: string }[] = movable.map((u, i) => ({ u, year: slot.get(i)?.year ?? u[0].planYear!, season: slot.get(i)?.season ?? u[0].planSeason ?? "Winter" }));
  // Re-deal the moved cards' existing rank numbers in calendar order so ranks follow the new sequence.
  const pool = entries.flatMap((e) => e.u.map((d) => d.priority)).sort((a, b) => a - b);
  const seq = [...entries].sort((a, b) => a.year - b.year || SEASONS.indexOf(a.season) - SEASONS.indexOf(b.season));
  let k = 0;
  for (const e of seq) for (const d of e.u) placements.push({ id: d.id, planYear: e.year, planSeason: e.season, priority: pool[k++] });
  res.json({ placements, covered: slot.size, of: movable.length, rationale: typeof raw.rationale === "string" ? raw.rationale : null, usedProfiles: ctx.travelers });
});

// Add a destination and let Claude estimate its trip attributes (season, duration, cost, difficulty, ...).
const SEASONS = ["Winter", "Spring", "Summer", "Fall"];
const MOBILITY = ["Easy", "Easy-Moderate", "Moderate", "Moderate-High", "High"];
const estimateSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  country: z.string(), countryCode: z.string().length(2),
  bestSeason: z.enum(["Winter", "Spring", "Summer", "Fall"]), secondSeason: z.enum(["Winter", "Spring", "Summer", "Fall"]),
  days: z.number().int().min(2).max(60), dailyCost: z.number().min(20).max(3000), transitCost: z.number().min(0).max(40000),
  mobility: z.enum(["Easy", "Easy-Moderate", "Moderate", "Moderate-High", "High"]), isFar: z.boolean(),
  weather: z.string(), weatherAlt: z.string(), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180),
  seasonFactors: z.object({ Winter: z.number(), Spring: z.number(), Summer: z.number(), Fall: z.number() }).optional(),
  notes: z.string().optional(),
});

router.post("/destinations", async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(2).max(80) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const client = getAnthropicClient();
  if (!client) return res.status(503).json({ error: "AI is not configured. Set ANTHROPIC_API_KEY in the server environment to estimate trip details." });
  const { name } = parsed.data;
  const [ctx, top] = await Promise.all([
    travelerContext(),
    prisma.destination.findFirst({ orderBy: { priority: "desc" }, select: { priority: true } }),
  ]);
  const prompt = `Estimate trip planning attributes for 2 travelers visiting: "${name}".
${ctx.text}
Return ONLY strict JSON, no prose, in exactly this shape:
{"name":"the destination's proper full name, expanding abbreviations (e.g. \"Badlands np\" → \"Badlands National Park\"); keep it as given if already proper",
"country":"country name as in Natural Earth / world-atlas (e.g. \"United States of America\", \"Czechia\")","countryCode":"ISO 3166-1 alpha-2",
"bestSeason":"Winter|Spring|Summer|Fall","secondSeason":"Winter|Spring|Summer|Fall (different from bestSeason)",
"days":ideal trip length in days (integer),"dailyCost":USD per day for BOTH travelers combined excluding flights (lodging, food, local transport, activities),
"transitCost":USD round-trip airfare for BOTH travelers,"mobility":"${MOBILITY.join("|")}" (physical difficulty: altitude, hiking, bush, self-drive),
"isFar":true if it is a long-haul trip (roughly 8+ hours of flying),"weather":"short phrase with temperature range in °F for the best season, e.g. \"Dry & mild, 60–77°F\"",
"weatherAlt":"same for the second-best season","lat":number,"lng":number (centre of the destination),"seasonFactors":{"Winter":n,"Spring":n,"Summer":n,"Fall":n} (total trip cost multiplier per season vs. the best season, which is exactly 1.0; peak/high season > 1, shoulder/low < 1, range 0.7–1.6),"notes":"one short sentence of caveats"}
Seasons are northern-hemisphere calendar seasons (Winter = Dec–Feb). Pick the best season for comfortable weather and fewer crowds.`;
  const response = await client.messages.create({
    model: AI_MODEL, max_tokens: 700,
    system: "You produce only valid JSON when asked to. No markdown fences, no commentary.",
    messages: [{ role: "user", content: prompt }],
  });
  const block = response.content.find((b) => b.type === "text");
  const text = block && "text" in block ? block.text : "";
  let est: z.infer<typeof estimateSchema>;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const r = estimateSchema.safeParse(JSON.parse(m ? m[0] : text));
    if (!r.success) throw new Error("shape");
    est = r.data;
  } catch {
    return res.status(502).json({ error: "The AI estimate could not be read. Try again." });
  }
  if (est.secondSeason === est.bestSeason) est.secondSeason = SEASONS[(SEASONS.indexOf(est.bestSeason) + 1) % 4] as typeof est.secondSeason;
  const finalName = est.name?.trim() || name;
  const priority = (top?.priority ?? 0) + 1;
  const d = await prisma.destination.create({
    data: {
      name: finalName, country: est.country, countryCode: est.countryCode.toUpperCase(), status: "IDEA", priority,
      bestSeason: est.bestSeason, secondSeason: est.secondSeason, days: est.days,
      dailyCost: Math.round(est.dailyCost), transitCost: Math.round(est.transitCost), mobility: est.mobility, isFar: est.isFar,
      weather: est.weather, weatherAlt: est.weatherAlt, lat: est.lat, lng: est.lng, notes: est.notes ?? null,
      suggestedPriority: priority, seasonFactors: normFactors(est.seasonFactors, est.bestSeason),
    },
    select: { id: true, name: true },
  });
  res.status(201).json(d);
});

// Combine cards into one pairing (one departure). Reuses an existing pairing among them.
router.post("/combine", async (req, res) => {
  const parsed = z.object({ ids: z.array(z.string()).min(2), name: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { ids, name } = parsed.data;
  const rows = await prisma.destination.findMany({ where: { id: { in: ids } }, select: { id: true, planYear: true, pairingId: true } });
  const old = [...new Set(rows.map((r) => r.pairingId).filter((x): x is string => !!x))];
  const year = rows.find((r) => r.planYear != null)?.planYear ?? null;
  const target = old[0] ?? (await prisma.pairing.create({ data: { name, year } })).id;
  // Members of a merged pairing that were not in the selection come along too.
  await prisma.destination.updateMany({ where: { OR: [{ id: { in: ids } }, { pairingId: { in: old } }] }, data: { pairingId: target } });
  const gone = old.filter((p) => p !== target);
  if (gone.length) await prisma.pairing.deleteMany({ where: { id: { in: gone } } });
  res.json({ pairingId: target });
});

// Split cards apart: drop them from their pairing and move them to the given seasons.
// The new season also becomes the card's "suggested" season so a reset keeps the split.
router.post("/split", async (req, res) => {
  const parsed = z.array(z.object({ id: z.string(), planSeason: z.string().nullable() })).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const ids = parsed.data.map((m) => m.id);
  const before = await prisma.destination.findMany({ where: { id: { in: ids } }, select: { pairingId: true } });
  await prisma.$transaction(parsed.data.map((m) => prisma.destination.update({
    where: { id: m.id }, data: { pairingId: null, planSeason: m.planSeason, suggestedSeason: m.planSeason },
  })));
  const pids = [...new Set(before.map((b) => b.pairingId).filter((x): x is string => !!x))];
  for (const p of pids) if ((await prisma.destination.count({ where: { pairingId: p } })) < 2) {
    await prisma.destination.updateMany({ where: { pairingId: p }, data: { pairingId: null } });
    await prisma.pairing.delete({ where: { id: p } });
  }
  res.json({ ok: true });
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
