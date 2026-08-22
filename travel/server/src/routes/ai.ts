import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { getAnthropicClient, AI_MODEL } from "../lib/anthropic";
import { formatTravelerProfilesBlock, formatHomeLocationsInstruction, getHomeLocations } from "../lib/itineraryAi";

const router = Router();

const SYSTEM_PROMPT = `You are a helpful, concise travel planning assistant embedded in a trip-planning app
used by a married couple. You help with: suggesting destinations, drafting itineraries, estimating
rough travel costs, finding points of interest, and giving practical booking/logistics advice.
Keep answers focused and actionable. Use bullet points for lists. When giving cost estimates, state
they are rough and depend on season/booking timing.`;

router.get("/status", (_req, res) => {
  res.json({ configured: !!getAnthropicClient() });
});

const chatSchema = z.object({
  tripId: z.string().nullable().optional(),
  message: z.string().min(1),
});

router.post("/chat", async (req, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tripId, message } = parsed.data;

  const client = getAnthropicClient();
  if (!client) {
    return res.status(503).json({
      error: "AI is not configured. Set ANTHROPIC_API_KEY in the server environment to enable it.",
    });
  }

  const travelerProfiles = await prisma.traveler.findMany({ orderBy: { createdAt: "asc" } });
  let contextBlock = `\n\n${formatTravelerProfilesBlock(travelerProfiles)}\n${formatHomeLocationsInstruction(travelerProfiles)}`;
  if (tripId) {
    const trip = await prisma.trip.findUnique({
      where: { id: tripId },
      include: { destination: true, items: true, budgetLines: true },
    });
    if (trip) {
      contextBlock += `\n\nCurrent trip context (JSON):\n${JSON.stringify({
        title: trip.title,
        destination: trip.destination?.name,
        startDate: trip.startDate,
        endDate: trip.endDate,
        items: trip.items.map((i) => ({ type: i.type, title: i.title, startAt: i.startAt, endAt: i.endAt, cost: i.cost })),
        budget: trip.budgetLines.map((b) => ({ category: b.category, label: b.label, estimated: b.estimated, actual: b.actual })),
      })}`;
    }
  }

  await prisma.aiMessage.create({ data: { tripId: tripId ?? null, role: "user", content: message } });

  const history = await prisma.aiMessage.findMany({
    where: { tripId: tripId ?? null },
    orderBy: { createdAt: "asc" },
    take: 20,
  });

  const response = await client.messages.create({
    model: AI_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT + contextBlock,
    messages: history.map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content })),
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const reply = textBlock && "text" in textBlock ? textBlock.text : "";

  await prisma.aiMessage.create({ data: { tripId: tripId ?? null, role: "assistant", content: reply } });

  res.json({ reply });
});

router.get("/history", async (req, res) => {
  const tripId = req.query.tripId ? String(req.query.tripId) : null;
  const history = await prisma.aiMessage.findMany({
    where: { tripId },
    orderBy: { createdAt: "asc" },
  });
  res.json(history);
});

const estimateSchema = z.object({
  destinationName: z.string().min(1),
  travelers: z.number().int().min(1).default(2),
  nights: z.number().int().min(1).default(7),
  style: z.enum(["budget", "mid-range", "luxury"]).default("mid-range"),
  originCity: z.string().optional(),
});

router.post("/estimate-cost", async (req, res) => {
  const parsed = estimateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const client = getAnthropicClient();
  if (!client) {
    return res.status(503).json({
      error: "AI is not configured. Set ANTHROPIC_API_KEY in the server environment to enable it.",
    });
  }

  const { destinationName, travelers, nights, style, originCity } = parsed.data;
  const travelerProfiles = await prisma.traveler.findMany({ orderBy: { createdAt: "asc" } });
  const effectiveOriginCity = originCity || getHomeLocations(travelerProfiles)[0];
  const prompt = `Give a rough travel cost estimate for a trip to ${destinationName} for ${travelers} travelers,
${nights} nights, ${style} style${effectiveOriginCity ? `, departing from ${effectiveOriginCity} (the trip starts and ends there — include round-trip flights/transport from and back to this origin)` : ""}.
${formatTravelerProfilesBlock(travelerProfiles)}
Take stay, transport, and food preferences into account when estimating lodging/flights/food (e.g. a preference for direct flights, higher-end stays, or fine dining should push those line items up).
Respond ONLY with strict JSON, no prose, in this shape:
{"currency":"USD","flights":number,"lodging":number,"food":number,"activities":number,"localTransport":number,"misc":number,"total":number,"notes":"short caveat string"}`;

  const response = await client.messages.create({
    model: AI_MODEL,
    max_tokens: 512,
    system: "You produce only valid JSON when asked to. No markdown fences, no commentary.",
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock && "text" in textBlock ? textBlock.text : "{}";

  try {
    const cleaned = text.trim().replace(/^```json\s*|```$/g, "");
    res.json(JSON.parse(cleaned));
  } catch {
    res.status(502).json({ error: "AI returned an unparseable estimate", raw: text });
  }
});

export default router;
