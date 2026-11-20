import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { urlToText } from "../lib/sourceText";
import { analyzeSource, annotate, applyProposals, Proposal } from "../lib/tripImport";

const router = Router({ mergeParams: true });
const tripId = (req: any) => (req.params as Record<string, string>).tripId as string;

const sourceSchema = z.object({ name: z.string().max(200).default("pasted text"), kind: z.enum(["text", "url"]), text: z.string().max(400_000).optional(), url: z.string().max(2000).optional() });

// Read every source (files arrive as text, URLs are fetched), classify it and propose what to file where. Nothing is saved yet.
router.post("/analyze", async (req, res) => {
  const parsed = z.object({ sources: z.array(sourceSchema).min(1).max(12) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const trip = await prisma.trip.findUnique({ where: { id: tripId(req) }, include: { destination: true } });
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  const profiles = await prisma.traveler.findMany({ select: { name: true } });
  const known = [...new Set([...trip.travelers, ...profiles.map((p) => p.name)])];
  const results = [];
  for (const s of parsed.data.sources) {
    try {
      let text = s.text ?? "", name = s.name, url: string | null = null;
      if (s.kind === "url") { const r = await urlToText(s.url ?? ""); text = r.text; name = r.title || s.url!; url = s.url!.trim(); }
      if (text.trim().length < 15) throw new Error("There is no readable text in this item.");
      const r = await analyzeSource(trip, name, text, url, known);
      r.proposals = await annotate(trip.id, r.proposals);
      results.push(r);
    } catch (e: any) {
      results.push({ name: s.name, hash: "", category: "irrelevant", reason: "", summary: "", travelers: [], alreadyImported: false, proposals: [], error: e?.message || "Could not read this item." });
    }
  }
  res.json({ results });
});

const proposalSchema: z.ZodType<Proposal> = z.any();

// File the selected proposals into the trip. Matching is repeated here, so applying the same thing twice changes nothing.
router.post("/apply", async (req, res) => {
  const parsed = z.object({
    proposals: z.array(proposalSchema).max(500),
    sources: z.array(z.object({ hash: z.string().min(8), name: z.string(), category: z.string(), summary: z.string().nullable() })).max(12),
    travelers: z.array(z.string()).max(40).default([]),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const trip = await prisma.trip.findUnique({ where: { id: tripId(req) } });
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  try {
    res.json(await applyProposals(trip.id, parsed.data.proposals, parsed.data.sources, parsed.data.travelers));
  } catch (e: any) {
    console.error("import apply failed:", String(e?.message ?? e).slice(0, 300));
    res.status(500).json({ error: "Could not save the import. Nothing was lost; try again." });
  }
});

export default router;
