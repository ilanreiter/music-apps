import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { annotate } from "../lib/tripImport";
import { inboxConfigured, originalSender, parseInboxItem, pollInbox, suggestTrip } from "../lib/inbox";

const router = Router();
function forwardAddress() {
  const u = process.env.IMAP_USER, a = (process.env.INBOX_ALIAS ?? "").trim();
  if (!u) return null;
  return a && u.includes("@") ? u.replace("@", `+${a}@`) : u;
}

router.get("/", async (_req, res) => {
  const items = await prisma.inboxItem.findMany({ where: { status: "PENDING" }, orderBy: { receivedAt: "desc" }, take: 200 });
  const originals = await prisma.inboxItem.findMany({ where: { id: { in: items.map((i) => i.dupOfId).filter(Boolean) as string[] } }, select: { id: true, status: true } });
  const orig = new Map(originals.map((o) => [o.id, o.status]));
  // The stored parse is from when the mail arrived; re-check it against the trip as it is now (no AI call).
  const fresh = new Map<string, any>();
  for (const i of items) {
    const pr: any = i.parsed;
    if (!pr?.tripId) continue;
    try {
      const sources = [];
      for (const src of pr.sources) {
        if (!src.proposals.every((x: any) => x.data)) { sources.push(src); continue; }
        const ann = await annotate(pr.tripId, src.proposals.map((x: any) => ({ kind: x.kind, data: x.data, action: "new" })));
        sources.push({ ...src, proposals: src.proposals.map((x: any, k: number) => ({ ...x, action: ann[k].action, matchTitle: ann[k].matchTitle ?? null })) });
      }
      fresh.set(i.id, { ...pr, sources });
    } catch { /* trip deleted etc.: show the stored parse */ }
  }
  res.json({
    filteredCount: await prisma.inboxItem.count({ where: { status: "FILTERED" } }),
    configured: inboxConfigured(), address: forwardAddress(),
    items: items.map((i) => ({ id: i.id, fromAddr: i.fromAddr, subject: i.subject, receivedAt: i.receivedAt, preview: i.bodyText.slice(0, 1500), attachmentNames: (i.attachments as any[]).map((a) => a.name), suggestedTripId: i.suggestedTripId, suggestionNote: i.suggestionNote, parsed: fresh.get(i.id) ?? i.parsed, legacyParse: !!(i.parsed as any)?.sources?.some((x: any) => x.proposals?.some((p: any) => !p.data)), duplicateOf: i.dupOfId ? (orig.get(i.dupOfId) ?? "GONE") : null })),
  });
});

router.get("/filtered", async (_req, res) => {
  const items = await prisma.inboxItem.findMany({ where: { status: "FILTERED" }, orderBy: { receivedAt: "desc" }, take: 200, select: { id: true, fromAddr: true, subject: true, receivedAt: true, filterReason: true } });
  const blocked = await prisma.inboxBlockedSender.findMany({ orderBy: { addr: "asc" } });
  res.json({ items, blocked });
});

router.delete("/blocked/:id", async (req, res) => { await prisma.inboxBlockedSender.deleteMany({ where: { id: req.params.id } }); res.json({ ok: true }); });

router.post("/:id/restore", async (req, res) => {
  const i = await prisma.inboxItem.findUnique({ where: { id: req.params.id } });
  if (!i) return res.status(404).json({ error: "Not found" });
  const sg = await suggestTrip(i.subject, i.bodyText);
  await prisma.inboxItem.update({ where: { id: i.id }, data: { status: "PENDING", filterReason: null, suggestedTripId: sg.tripId, suggestionNote: sg.note } });
  if (sg.tripId) await parseInboxItem(i.id, sg.tripId).catch(() => {});
  res.json({ ok: true });
});

// Filters this sender (and, for mail you forwarded by hand, the original sender) from now on, and sweeps their pending mail into Filtered.
router.post("/:id/block-sender", async (req, res) => {
  const i = await prisma.inboxItem.findUnique({ where: { id: req.params.id } });
  if (!i) return res.status(404).json({ error: "Not found" });
  const addr = originalSender(i.fromAddr, i.bodyText);
  const mine = (process.env.INBOX_ALLOWED_SENDERS ?? "").toLowerCase().split(",").map((x) => x.trim());
  if (mine.includes(addr)) return res.status(400).json({ error: "This email was forwarded by you and the original sender could not be found, so nothing was blocked. Use Discard instead." });
  await prisma.inboxBlockedSender.upsert({ where: { addr }, create: { addr }, update: {} });
  const swept = await prisma.inboxItem.updateMany({ where: { status: "PENDING", OR: [{ fromAddr: addr }, { id: i.id }] }, data: { status: "FILTERED", filterReason: "Blocked sender" } });
  res.json({ addr, moved: swept.count });
});

router.get("/count", async (_req, res) => res.json({ pending: await prisma.inboxItem.count({ where: { status: "PENDING" } }) }));

router.post("/poll", async (_req, res) => {
  try { res.json(await pollInbox()); } catch (e: any) { res.status(502).json({ error: e.message }); }
});

// Full content, as import sources for the review dialog.
router.get("/:id", async (req, res) => {
  const i = await prisma.inboxItem.findUnique({ where: { id: req.params.id } });
  if (!i) return res.status(404).json({ error: "Not found" });
  const sources = [{ name: `${i.subject} (email)`, text: `From: ${i.fromAddr}\nSubject: ${i.subject}\nDate: ${i.receivedAt.toISOString()}\n\n${i.bodyText}` },
    ...(i.attachments as any[]).map((a) => ({ name: a.name, text: a.text, note: a.note }))];
  res.json({ id: i.id, subject: i.subject, html: i.bodyHtml, sources });
});

router.post("/:id/parse", async (req, res) => {
  const p = z.object({ tripId: z.string() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  try { res.json(await parseInboxItem(req.params.id, p.data.tripId)); }
  catch (e: any) { res.status(500).json({ error: "Could not read this email. Try again." }); }
});

// The stored parse as import-dialog results (no AI call). Duplicate status is re-checked against the trip as it is now.
router.post("/:id/results", async (req, res) => {
  const p = z.object({ tripId: z.string() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  try {
    const item = await prisma.inboxItem.findUniqueOrThrow({ where: { id: req.params.id } });
    let parsed: any = item.parsed;
    const usable = parsed && parsed.tripId === p.data.tripId && parsed.sources.every((s: any) => s.error || s.hash !== undefined && s.proposals.every((x: any) => x.data));
    if (!usable) parsed = await parseInboxItem(item.id, p.data.tripId);
    const results = [];
    for (const s of parsed.sources) {
      const seen = s.hash ? await prisma.tripImport.findUnique({ where: { tripId_hash: { tripId: p.data.tripId, hash: s.hash } } }) : null;
      const proposals = s.error || seen ? [] : await annotate(p.data.tripId, s.proposals.map((x: any) => ({ kind: x.kind, data: x.data, action: "new" })));
      results.push({ name: s.name, hash: s.hash, category: s.category, reason: seen ? `Already imported on ${seen.createdAt.toLocaleDateString("en-US")}` : s.reason, summary: s.summary, travelers: s.travelers, alreadyImported: !!seen, proposals, error: s.error });
    }
    res.json({ results });
  } catch { res.status(500).json({ error: "Could not load this email. Try again." }); }
});

router.post("/:id/filed", async (req, res) => {
  const p = z.object({ tripId: z.string() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  await prisma.inboxItem.updateMany({ where: { id: req.params.id }, data: { status: "FILED", tripId: p.data.tripId } });
  res.json({ ok: true });
});

router.post("/:id/dismiss", async (req, res) => {
  await prisma.inboxItem.updateMany({ where: { id: req.params.id }, data: { status: "DISMISSED" } });
  res.json({ ok: true });
});

export default router;
