import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import crypto from "crypto";
import { annotate } from "../lib/tripImport";
import express from "express";
import { simpleParser } from "mailparser";
import { bytesToText, htmlToText, urlToText } from "../lib/sourceText";
import { fileDocumentsToTrip, saveIncoming } from "../lib/docStore";
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
  const docs = await prisma.tripDocument.findMany({ where: { inboxItemId: { in: items.map((i) => i.id) } }, select: { id: true, name: true, inboxItemId: true } });
  res.json({
    filteredCount: await prisma.inboxItem.count({ where: { status: "FILTERED" } }),
    configured: inboxConfigured(), address: forwardAddress(),
    items: items.map((i) => ({ id: i.id, fromAddr: i.fromAddr, subject: i.subject, receivedAt: i.receivedAt, preview: i.bodyText.slice(0, 1500), attachmentNames: (i.attachments as any[]).map((a) => a.name), suggestedTripId: i.suggestedTripId, suggestionNote: i.suggestionNote, source: i.source, newTripHint: i.newTripHint, documents: docs.filter((d) => d.inboxItemId === i.id).map((d) => ({ id: d.id, name: d.name })), parsed: fresh.get(i.id) ?? i.parsed, legacyParse: !!(i.parsed as any)?.sources?.some((x: any) => x.proposals?.some((p: any) => !p.data)), duplicateOf: i.dupOfId ? (orig.get(i.dupOfId) ?? "GONE") : null })),
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

async function createUploadCard(name: string, text: string, tripId?: string, original?: { buf: Buffer; mime: string }) {
  const chosen = tripId ? await prisma.trip.findUnique({ where: { id: tripId } }) : null;
  const sg = chosen ? { tripId: chosen.id, note: "Imported from this trip's page", newTrip: null } : await suggestTrip(name, text);
  const item = await prisma.inboxItem.create({ data: {
    source: "upload", messageId: `upload-${crypto.randomUUID()}`, fromAddr: "", subject: name.slice(0, 300), receivedAt: new Date(), bodyText: text.slice(0, 400_000), attachments: [],
    suggestedTripId: sg.tripId, suggestionNote: sg.note, newTripHint: (sg.newTrip ?? undefined) as any,
  } });
  if (original) await saveIncoming(original.buf, name, original.mime, item.id).catch((e) => console.error("import: could not keep", name, String(e?.message ?? e).slice(0, 120)));
  if (sg.tripId) await parseInboxItem(item.id, sg.tripId).catch((e) => console.error("import: parse failed:", String(e?.message ?? e).slice(0, 120)));
  return item;
}

// A file as sent by the browser (raw body): its text is read here and the original is kept on the NAS when a folder is set.
router.post("/upload-file", express.raw({ type: () => true, limit: "25mb" }), async (req, res) => {
  const name = String(req.query.name ?? "document").slice(0, 200), tripId = req.query.tripId ? String(req.query.tripId) : undefined;
  // the browser always sends application/octet-stream (so no other body parser touches it) and names the real type here
  const mime = String(req.query.mime || "application/octet-stream").slice(0, 100);
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Send the file as the request body." });
  try {
    const buf: Buffer = req.body;
    let text = "";
    if (/\.(pdf|png|jpe?g|webp|gif|heic)$/i.test(name) || /^(application\/pdf|image\/)/.test(mime)) text = (await bytesToText(buf)).text;
    else if (/\.eml$/i.test(name) || /message\/rfc822/.test(mime)) { const m = await simpleParser(buf); text = `Subject: ${m.subject ?? ""}\n\n${m.text || (m.html ? htmlToText(m.html).text : "")}`; }
    else if (/\.html?$/i.test(name) || /text\/html/.test(mime)) text = htmlToText(buf.toString("utf8")).text;
    else text = buf.toString("utf8");
    if (text.trim().length < 15) return res.status(422).json({ error: `${name}: there is no readable text in it.` });
    res.json({ id: (await createUploadCard(name, text, tripId, { buf, mime })).id });
  } catch (e: any) { res.status(500).json({ error: `${name}: ${String(e?.message ?? "could not be read").slice(0, 200)}` }); }
});

// Central import: a file's text, pasted text or a web address becomes an Inbox card. The trip is the one given
// (opened from a trip page) or the one Claude picks; when none fits, a new trip is proposed from the document.
router.post("/upload", async (req, res) => {
  const p = z.object({ name: z.string().max(200).default("Pasted text"), kind: z.enum(["text", "url"]), text: z.string().max(400_000).optional(), url: z.string().max(2000).optional(), tripId: z.string().optional() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  try {
    let text = p.data.text ?? "", name = p.data.name;
    if (p.data.kind === "url") { const u = /^https?:\/\//i.test(p.data.url ?? "") ? p.data.url! : `https://${p.data.url}`; const r = await urlToText(u); text = `${u}\n\n${r.text}`; name = r.title || u; }
    if (text.trim().length < 15) return res.status(422).json({ error: `${name}: there is no readable text in it.` });
    if (p.data.kind === "text" && name === "Pasted text") name = `Pasted: ${text.trim().split(/\n/)[0].slice(0, 70)}${text.trim().split(/\n/)[0].length > 70 ? "…" : ""}`;
    res.json({ id: (await createUploadCard(name, text, p.data.tripId)).id });
  } catch (e: any) { res.status(500).json({ error: `${p.data.name}: ${String(e?.message ?? "could not be read").slice(0, 200)}` }); }
});

// Creates the trip a card proposes (linked to the matching roadmap destination when there is one) and reads the card against it.
router.post("/:id/new-trip", async (req, res) => {
  const p = z.object({ title: z.string().min(1).max(120), place: z.string().max(120).nullable().optional(), startDate: z.string().nullable().optional(), endDate: z.string().nullable().optional() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  const item = await prisma.inboxItem.findUnique({ where: { id: req.params.id } });
  if (!item) return res.status(404).json({ error: "Not found" });
  const day = (x?: string | null) => (x && /^\d{4}-\d{2}-\d{2}$/.test(x) ? new Date(`${x}T00:00:00Z`) : null);
  const place = (p.data.place ?? "").trim().toLowerCase();
  const dest = place ? (await prisma.destination.findMany({ select: { id: true, name: true } })).find((d) => d.name.toLowerCase() === place || place.includes(d.name.toLowerCase()) || d.name.toLowerCase().includes(place)) : undefined;
  const trip = await prisma.trip.create({ data: { title: p.data.title.trim(), destinationId: dest?.id ?? null, status: "PLANNING", startDate: day(p.data.startDate), endDate: day(p.data.endDate) } });
  await prisma.inboxItem.update({ where: { id: item.id }, data: { suggestedTripId: trip.id, suggestionNote: "New trip created from this document" } });
  try { const parsed = await parseInboxItem(item.id, trip.id); res.json({ trip: { id: trip.id, title: trip.title, startDate: trip.startDate }, parsed }); }
  catch { res.json({ trip: { id: trip.id, title: trip.title, startDate: trip.startDate }, parsed: null }); }
});

router.get("/count", async (_req, res) => res.json({ pending: await prisma.inboxItem.count({ where: { status: "PENDING" } }) }));

router.post("/poll", async (_req, res) => {
  try { res.json(await pollInbox()); } catch (e: any) { res.status(502).json({ error: e.message }); }
});

// Full content, as import sources for the review dialog.
router.get("/:id", async (req, res) => {
  const i = await prisma.inboxItem.findUnique({ where: { id: req.params.id } });
  if (!i) return res.status(404).json({ error: "Not found" });
  const sources = [i.source === "upload" ? { name: i.subject, text: i.bodyText } : { name: `${i.subject} (email)`, text: `From: ${i.fromAddr}\nSubject: ${i.subject}\nDate: ${i.receivedAt.toISOString()}\n\n${i.bodyText}` },
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
  const p = z.object({ tripId: z.string(), day1: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  try {
    const item = await prisma.inboxItem.findUniqueOrThrow({ where: { id: req.params.id } });
    let parsed: any = item.parsed;
    const usable = parsed && parsed.tripId === p.data.tripId && parsed.sources.every((s: any) => s.error || s.hash !== undefined && s.proposals.every((x: any) => x.data));
    if (!usable) parsed = await parseInboxItem(item.id, p.data.tripId);
    const results = [];
    for (const s of parsed.sources) {
      const seen = s.hash ? await prisma.tripImport.findUnique({ where: { tripId_hash: { tripId: p.data.tripId, hash: s.hash } } }) : null;
      // "Day N" items are placed from the Day 1 date the user confirmed on the card (not from the trip's start date)
      const placed = s.proposals.map((x: any) => {
        if (!p.data.day1 || x.kind !== "itinerary" || x.data.startAt || !x.data.day) return x;
        const start = new Date(Date.parse(`${p.data.day1}T${x.data.time ?? "09:00"}:00Z`) + (x.data.day - 1) * 86400_000);
        return { ...x, data: { ...x.data, day: null, startAt: start.toISOString(), endAt: x.data.durationHours ? new Date(start.getTime() + x.data.durationHours * 3600_000).toISOString() : null } };
      });
      const proposals = s.error || seen ? [] : await annotate(p.data.tripId, placed.map((x: any) => ({ kind: x.kind, data: x.data, action: "new" })));
      results.push({ name: s.name, hash: s.hash, category: s.category, reason: seen ? `Already imported on ${seen.createdAt.toLocaleDateString("en-US")}` : s.reason, summary: s.summary, travelers: s.travelers, alreadyImported: !!seen, mismatch: s.mismatch ?? null, proposals, error: s.error });
    }
    res.json({ results });
  } catch { res.status(500).json({ error: "Could not load this email. Try again." }); }
});

router.post("/:id/filed", async (req, res) => {
  const p = z.object({ tripId: z.string() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  await prisma.inboxItem.updateMany({ where: { id: req.params.id }, data: { status: "FILED", tripId: p.data.tripId } });
  await fileDocumentsToTrip(req.params.id, p.data.tripId).catch((e) => console.error("docs: filing failed:", String(e?.message ?? e).slice(0, 120)));
  res.json({ ok: true });
});

router.post("/:id/dismiss", async (req, res) => {
  await prisma.inboxItem.updateMany({ where: { id: req.params.id }, data: { status: "DISMISSED" } });
  res.json({ ok: true });
});

export default router;
