// Original documents (PDFs, photos, email attachments) kept as files on the NAS share mounted at DOCS_ROOT.
// The folder inside the share and the trip-folder naming are chosen in Preferences. New files wait in
// "<folder>/Wander Inbox" until their Import card is filed, then move into the trip's own folder.
import fs from "fs/promises";
import path from "path";
import { prisma } from "../db";

export const DOCS_ROOT = path.resolve(process.env.DOCS_ROOT || "/nas");
export const ROOT_LABEL = process.env.DOCS_ROOT_LABEL || DOCS_ROOT;
const INBOX_DIR = "Wander Inbox";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Resolves a path relative to DOCS_ROOT, refusing anything that escapes it. */
export function resolveRel(rel: string): string {
  const full = path.resolve(DOCS_ROOT, "." + path.sep + (rel || "").replace(/^[/\\]+/, ""));
  if (full !== DOCS_ROOT && !full.startsWith(DOCS_ROOT + path.sep)) throw new Error("That folder is outside the documents share.");
  return full;
}
const toRel = (full: string) => path.relative(DOCS_ROOT, full).split(path.sep).join("/");
const cleanName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 120) || "document";

export async function rootAvailable(): Promise<boolean> {
  try { return (await fs.stat(DOCS_ROOT)).isDirectory(); } catch { return false; }
}

export async function docsSettings() {
  const p = await prisma.preferences.findUnique({ where: { id: "default" } });
  return { folder: p?.docsFolder ?? null, naming: (p?.docsNaming === "title" ? "title" : "month") as "month" | "title" };
}

/** Sub-folders of a folder, for the folder picker. */
export async function listFolders(rel: string) {
  const full = resolveRel(rel);
  const entries = await fs.readdir(full, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("@") && !e.name.startsWith("#"))
    .map((e) => e.name).sort((a, b) => a.localeCompare(b)).slice(0, 1000);
}

export async function makeFolder(rel: string, name: string) {
  const full = path.join(resolveRel(rel), cleanName(name));
  resolveRel(toRel(full));
  await fs.mkdir(full, { recursive: true });
  return toRel(full);
}

async function uniquePath(dir: string, name: string) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, n === 1 ? name : `${base} (${n})${ext}`);
    try { await fs.access(candidate); } catch { return candidate; }
  }
}

/** Saves an incoming original into the Wander Inbox folder. Returns null (and keeps nothing) when no folder is set up. */
export async function saveIncoming(buf: Buffer, name: string, mime: string, inboxItemId: string, opts: { role?: "source" | "attachment"; sourceUrl?: string | null } = {}) {
  const { folder } = await docsSettings();
  if (!folder || !(await rootAvailable())) return null;
  const dir = path.join(resolveRel(folder), INBOX_DIR);
  await fs.mkdir(dir, { recursive: true });
  const dest = await uniquePath(dir, cleanName(name));
  await fs.writeFile(dest, buf);
  return prisma.tripDocument.create({ data: { inboxItemId, name: path.basename(dest), relPath: toRel(dest), size: buf.length, mime: mime || "application/octet-stream", role: opts.role ?? "attachment", sourceUrl: opts.sourceUrl ?? null } });
}

export function tripFolderName(trip: { title: string; startDate: Date | null; destination?: { name: string } | null }, naming: "month" | "title") {
  if (naming === "title" || !trip.startDate) return cleanName(trip.title);
  const place = trip.destination?.name || trip.title.replace(/^trip to\s+/i, "");
  return cleanName(`${place} - ${MONTHS[trip.startDate.getUTCMonth()]} ${trip.startDate.getUTCFullYear()}`);
}

async function moveFile(from: string, to: string) {
  try { await fs.rename(from, to); }
  catch (e: any) { if (e?.code !== "EXDEV") throw e; await fs.copyFile(from, to); await fs.unlink(from); }
}

/** Moves a filed card's originals into its trip's folder and links them to the trip. */
export async function fileDocumentsToTrip(inboxItemId: string, tripId: string) {
  const docs = await prisma.tripDocument.findMany({ where: { inboxItemId } });
  if (!docs.length) return 0;
  const { folder, naming } = await docsSettings();
  const trip = await prisma.trip.findUnique({ where: { id: tripId }, include: { destination: { select: { name: true } } } });
  if (!folder || !trip) return 0;
  const dir = path.join(resolveRel(folder), tripFolderName(trip, naming));
  await fs.mkdir(dir, { recursive: true });
  let moved = 0;
  for (const d of docs) {
    try {
      const from = resolveRel(d.relPath);
      const already = path.dirname(from) === dir;
      const to = already ? from : await uniquePath(dir, d.name);
      if (!already) await moveFile(from, to);
      await prisma.tripDocument.update({ where: { id: d.id }, data: { tripId, relPath: toRel(to), name: path.basename(to) } });
      moved++;
    } catch (e: any) { console.error("docs: could not file", d.name, String(e?.message ?? e).slice(0, 120)); }
  }
  return moved;
}

/** File name for a saved source: the subject / first line, made safe, with the right extension. */
export function sourceFileName(label: string, ext: string) {
  return `${cleanName(label).slice(0, 90)}.${ext}`;
}
