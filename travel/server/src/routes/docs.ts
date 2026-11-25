import { Router } from "express";
import fs from "fs";
import { z } from "zod";
import { prisma } from "../db";
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
  res.json(docs.map((d) => ({ id: d.id, name: d.name, size: d.size, mime: d.mime, createdAt: d.createdAt, trip: d.trip ? { id: d.trip.id, title: d.trip.title, startDate: d.trip.startDate } : null, waiting: !d.tripId })));
});

router.get("/trip/:tripId", async (req, res) => {
  const docs = await prisma.tripDocument.findMany({ where: { tripId: req.params.tripId }, orderBy: { createdAt: "desc" } });
  res.json(docs.map((d) => ({ id: d.id, name: d.name, size: d.size, mime: d.mime, createdAt: d.createdAt, folder: d.relPath.split("/").slice(0, -1).join("/") })));
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
  // never let an uploaded HTML/SVG run as a page on the app's origin
  if (/html|svg|xml/i.test(d.mime)) res.setHeader("Content-Security-Policy", "sandbox");
  fs.createReadStream(full).pipe(res);
});

export default router;
