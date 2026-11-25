import { Router } from "express";
import fs from "fs";
import { z } from "zod";
import { prisma } from "../db";
import { simpleParser } from "mailparser";
import { docsSettings, listFolders, makeFolder, resolveRel, rootAvailable, ROOT_LABEL } from "../lib/docStore";

const router = Router();

router.get("/settings", async (_req, res) => {
  res.json({ ...(await docsSettings()), rootLabel: ROOT_LABEL, available: await rootAvailable() });
});

router.put("/settings", async (req, res) => {
  const p = z.object({ folder: z.string().max(1000).nullable(), naming: z.enum(["month", "title"]) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  try {
    if (p.data.folder) { const st = fs.statSync(resolveRel(p.data.folder)); if (!st.isDirectory()) throw new Error("Not a folder."); }
  } catch (e: any) { return res.status(400).json({ error: e?.message?.includes("outside") ? e.message : "That folder can't be found on the share." }); }
  const data = { docsFolder: p.data.folder, docsNaming: p.data.naming };
  await prisma.preferences.upsert({ where: { id: "default" }, update: data, create: { id: "default", ...data } });
  res.json({ ...(await docsSettings()), rootLabel: ROOT_LABEL, available: await rootAvailable() });
});

router.get("/browse", async (req, res) => {
  const rel = String(req.query.path ?? "");
  try { res.json({ path: rel, folders: await listFolders(rel) }); }
  catch (e: any) { res.status(400).json({ error: e?.message?.includes("outside") ? e.message : "That folder can't be opened." }); }
});

router.post("/mkdir", async (req, res) => {
  const p = z.object({ path: z.string().max(1000), name: z.string().min(1).max(120) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  try { res.json({ path: await makeFolder(p.data.path, p.data.name) }); }
  catch (e: any) { res.status(400).json({ error: e?.message?.includes("outside") ? e.message : "Could not create that folder." }); }
});

// Every kept file: filed ones with their trip, and ones still waiting on an Import card.
router.get("/", async (_req, res) => {
  const docs = await prisma.tripDocument.findMany({ include: { trip: { select: { id: true, title: true, startDate: true } } }, orderBy: { createdAt: "desc" } });
  res.json(docs.map((d) => ({ id: d.id, name: d.name, size: d.size, mime: d.mime, role: d.role, sourceUrl: d.sourceUrl, createdAt: d.createdAt, trip: d.trip ? { id: d.trip.id, title: d.trip.title, startDate: d.trip.startDate } : null, waiting: !d.tripId })));
});

// The original an imported item came from: the Import card's own source (email, upload, text, page), else its first file.
router.get("/source/:inboxId", async (req, res) => {
  const docs = await prisma.tripDocument.findMany({ where: { inboxItemId: req.params.inboxId }, orderBy: [{ role: "desc" }, { createdAt: "asc" }] });
  const d = docs.find((x) => x.role === "source") ?? docs[0];
  if (!d) return res.status(404).json({ error: "The original of this item wasn't kept." });
  res.json({ id: d.id, name: d.name, mime: d.mime, sourceUrl: d.sourceUrl });
});

router.get("/trip/:tripId", async (req, res) => {
  const docs = await prisma.tripDocument.findMany({ where: { tripId: req.params.tripId }, orderBy: { createdAt: "desc" } });
  res.json(docs.map((d) => ({ id: d.id, name: d.name, size: d.size, mime: d.mime, role: d.role, sourceUrl: d.sourceUrl, createdAt: d.createdAt, folder: d.relPath.split("/").slice(0, -1).join("/") })));
});

const SAFE_CSP = "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https:; font-src https: data:";
// emails: no remote images (they are often trackers)
const EMAIL_CSP = "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// A saved email (.eml) shown as a readable page: its headers, then the message with its own formatting.
router.get("/:id/view", async (req, res) => {
  const d = await prisma.tripDocument.findUnique({ where: { id: req.params.id } });
  if (!d) return res.status(404).json({ error: "Not found" });
  let full: string;
  try { full = resolveRel(d.relPath); fs.accessSync(full); } catch { return res.status(404).json({ error: "The file is no longer in its folder on the NAS." }); }
  if (!/rfc822/.test(d.mime) && !/\.eml$/i.test(d.name)) return res.redirect(`/api/docs/${d.id}/file`);
  const m = await simpleParser(fs.readFileSync(full));
  const head = [["From", m.from?.text], ["To", (Array.isArray(m.to) ? m.to.map((t) => t.text).join(", ") : m.to?.text)], ["Date", m.date?.toLocaleString("en-US")], ["Subject", m.subject]]
    .filter(([, v]) => v).map(([k, v]) => `<tr><th>${k}</th><td>${esc(String(v))}</td></tr>`).join("");
  const files = m.attachments.filter((a) => !a.related).map((a) => esc(a.filename || "attachment")).join(", ");
  const body = m.html ? m.html : `<pre>${esc(m.text ?? "")}</pre>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", EMAIL_CSP);
  res.send(`<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{font-family:system-ui,sans-serif;margin:0}header{background:#f1f5f9;padding:12px 16px;border-bottom:1px solid #e2e8f0;font-size:13px}th{text-align:left;color:#64748b;padding-right:12px;vertical-align:top;font-weight:600}pre{white-space:pre-wrap;padding:16px;font-size:13px}.msg{padding:8px 16px}</style><header><table>${head}</table>${files ? `<div style="margin-top:6px;color:#64748b">Attachments: ${files}</div>` : ""}</header><div class="msg">${body}</div>`);
});

// Opens (inline) or downloads (?download=1) the original file.
router.get("/:id/file", async (req, res) => {
  const d = await prisma.tripDocument.findUnique({ where: { id: req.params.id } });
  if (!d) return res.status(404).json({ error: "Not found" });
  let full: string;
  try { full = resolveRel(d.relPath); fs.accessSync(full); } catch { return res.status(404).json({ error: "The file is no longer in its folder on the NAS." }); }
  const disposition = req.query.download ? "attachment" : "inline";
  res.setHeader("Content-Type", d.mime);
  res.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(d.name)}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  // never let a saved web page / email / SVG run scripts on the app's origin, or load trackers
  if (/html|svg|xml/i.test(d.mime)) res.setHeader("Content-Security-Policy", SAFE_CSP);
  fs.createReadStream(full).pipe(res);
});

export default router;
