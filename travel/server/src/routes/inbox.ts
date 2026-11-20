import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { inboxConfigured, pollInbox } from "../lib/inbox";

const router = Router();
function forwardAddress() {
  const u = process.env.IMAP_USER, a = (process.env.INBOX_ALIAS ?? "").trim();
  if (!u) return null;
  return a && u.includes("@") ? u.replace("@", `+${a}@`) : u;
}

router.get("/", async (_req, res) => {
  const items = await prisma.inboxItem.findMany({ where: { status: "PENDING" }, orderBy: { receivedAt: "desc" }, take: 200 });
  res.json({
    configured: inboxConfigured(), address: forwardAddress(),
    items: items.map((i) => ({ id: i.id, fromAddr: i.fromAddr, subject: i.subject, receivedAt: i.receivedAt, preview: i.bodyText.slice(0, 240), attachmentNames: (i.attachments as any[]).map((a) => a.name), suggestedTripId: i.suggestedTripId, suggestionNote: i.suggestionNote })),
  });
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
  res.json({ id: i.id, subject: i.subject, sources });
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
