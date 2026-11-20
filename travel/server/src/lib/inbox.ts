// Dedicated-mailbox inbox: forward trip emails to one address, the server polls it over IMAP and stores each
// message (body + readable attachments) as a pending InboxItem. Filing into a trip reuses the normal import review.
import { ImapFlow } from "imapflow";
import { simpleParser, ParsedMail } from "mailparser";
import { prisma } from "../db";
import { bytesToText, htmlToText } from "./sourceText";
import { askJson } from "./tripPlanningAi";
import { analyzeSource, annotate } from "./tripImport";

const env = process.env;
export const inboxConfigured = () => !!(env.IMAP_USER && env.IMAP_PASSWORD);
const allowed = () => (env.INBOX_ALLOWED_SENDERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export interface InboxAttachment { name: string; text: string; note?: string }

const TEXT_TYPES = /^(text\/(plain|calendar|csv|html)|application\/(ics|json))/i;

async function attachmentTexts(mail: ParsedMail): Promise<InboxAttachment[]> {
  const out: InboxAttachment[] = [];
  for (const a of mail.attachments.slice(0, 10)) {
    const name = a.filename || "attachment";
    try {
      if (a.size > 15_000_000) continue;
      const isImage = /^image\//i.test(a.contentType);
      if (isImage && (a.related || a.size < 30_000)) continue; // signatures, logos, tracking pixels
      let text = "", note: string | undefined;
      if (TEXT_TYPES.test(a.contentType) || /\.(ics|txt|csv)$/i.test(name)) {
        text = /html/i.test(a.contentType) ? htmlToText(a.content.toString("utf8")).text : a.content.toString("utf8");
      } else if (isImage || /pdf/i.test(a.contentType) || /\.pdf$/i.test(name)) {
        const r = await bytesToText(a.content);
        text = r.text; if (r.method !== "text") note = r.method;
      } else continue;
      if (text.trim().length >= 15) out.push({ name, text: text.slice(0, 200_000), note });
    } catch (e: any) {
      console.error("inbox: attachment skipped:", name, String(e?.message ?? e).slice(0, 120));
    }
  }
  return out;
}

// Suggest which trip the mail belongs to (subject tag first, then Claude against the open trips). Failure just means "unsorted".
async function suggestTrip(subject: string, body: string): Promise<{ tripId: string | null; note: string | null }> {
  const trips = await prisma.trip.findMany({ where: { status: { not: "CANCELLED" } }, include: { destination: { select: { name: true } } }, orderBy: { startDate: "asc" } });
  if (!trips.length) return { tripId: null, note: null };
  const tagged = trips.find((t) => subject.toLowerCase().includes(`[${t.title.toLowerCase()}]`));
  if (tagged) return { tripId: tagged.id, note: "Matched the trip tag in the subject" };
  try {
    const list = trips.map((t) => `${t.id} | ${t.title}${t.destination ? ` | ${t.destination.name}` : ""} | ${t.startDate?.toISOString().slice(0, 10) ?? "no dates"} to ${t.endDate?.toISOString().slice(0, 10) ?? "?"}`).join("\n");
    const j = await askJson(`Which trip does this email belong to? Trips (id | title | destination | dates):\n${list}\n\nReturn ONLY JSON {"tripId":"an id from the list, or null if unsure or unrelated","reason":"one short sentence"}.\n\nSubject: ${subject}\n"""\n${body.slice(0, 6000)}\n"""`, 300);
    const t = trips.find((x) => x.id === j.tripId);
    return t ? { tripId: t.id, note: typeof j.reason === "string" ? j.reason.slice(0, 200) : null } : { tripId: null, note: null };
  } catch { return { tripId: null, note: null }; }
}

let running = false;
export async function pollInbox(): Promise<{ added: number; skipped: number }> {
  if (!inboxConfigured()) throw new Error("Inbox is not configured. Set IMAP_USER and IMAP_PASSWORD.");
  if (running) return { added: 0, skipped: 0 };
  running = true;
  let added = 0, skipped = 0;
  const client = new ImapFlow({ host: env.IMAP_HOST || "imap.gmail.com", port: Number(env.IMAP_PORT || 993), secure: true, auth: { user: env.IMAP_USER!, pass: env.IMAP_PASSWORD! }, logger: false });
  client.on("error", () => {});
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Shared mailbox: never touch flags (other apps read it too). Look at recent mail and keep only what is addressed to this app's alias.
      const since = new Date(Date.now() - 14 * 86400_000);
      const alias = (env.INBOX_ALIAS ?? "").trim().toLowerCase();
      const wanted: number[] = [];
      for await (const m of client.fetch({ since }, { uid: true, envelope: true, headers: ["delivered-to", "x-original-to", "to", "cc"] }, { uid: true })) {
        const from = (m.envelope?.from?.[0]?.address ?? "").toLowerCase();
        const list = allowed();
        if (list.length && !list.includes(from)) { skipped++; continue; }
        const hdr = (m.headers ? m.headers.toString("utf8") : "").toLowerCase();
        if (alias && !hdr.includes(`+${alias}@`)) { skipped++; continue; }
        if (m.envelope?.messageId && (await prisma.inboxItem.findUnique({ where: { messageId: m.envelope.messageId } }))) continue;
        wanted.push(m.uid);
      }
      for (const uid of wanted) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const mail = await simpleParser(msg.source);
        const from = (mail.from?.value[0]?.address ?? "").toLowerCase();
        const messageId = mail.messageId || `${from}-${mail.date?.toISOString()}-${mail.subject}`;
        if (await prisma.inboxItem.findUnique({ where: { messageId } })) continue;
        const body = (mail.text || (mail.html ? htmlToText(mail.html).text : "")).trim();
        const attachments = await attachmentTexts(mail);
        const subject = (mail.subject || "(no subject)").slice(0, 300);
        if (body.length < 15 && !attachments.length) continue;
        const sg = await suggestTrip(subject, body || attachments[0].text);
        const baseSubject = subject.replace(/^((fwd?|re)\s*:\s*)+/i, "").trim().toLowerCase();
        const earlier = (await prisma.inboxItem.findMany({ where: { fromAddr: from, createdAt: { gte: new Date(Date.now() - 30 * 86400_000) } }, select: { id: true, subject: true } }))
          .find((x) => x.subject.replace(/^((fwd?|re)\s*:\s*)+/i, "").trim().toLowerCase() === baseSubject);
        const created = await prisma.inboxItem.create({ data: { dupOfId: earlier?.id ?? null, messageId, fromAddr: from, subject, receivedAt: mail.date ?? new Date(), bodyText: body.slice(0, 400_000), bodyHtml: typeof mail.html === "string" && mail.html.length < 1_500_000 ? mail.html : null, attachments: attachments as any, suggestedTripId: sg.tripId, suggestionNote: sg.note } });
        added++;
        if (sg.tripId) await parseInboxItem(created.id, sg.tripId).catch((e) => console.error("inbox: parse failed:", String(e?.message ?? e).slice(0, 120)));
      }
    } finally { lock.release(); }
    await client.logout();
  } catch (e: any) {
    console.error("inbox poll failed:", String(e?.message ?? e).slice(0, 200));
    try { client.close(); } catch {}
    throw new Error("Could not read the mailbox. Check IMAP_USER / IMAP_PASSWORD (use an app password).");
  } finally { running = false; }
  return { added, skipped };
}

export function startInboxPolling() {
  if (!inboxConfigured()) { console.log("Inbox polling off (IMAP_USER / IMAP_PASSWORD not set)"); return; }
  const every = Math.max(1, Number(env.INBOX_POLL_MINUTES || 5)) * 60_000;
  const tick = () => pollInbox().then((r) => r.added && console.log(`inbox: ${r.added} new message(s)`)).catch(() => {});
  setTimeout(tick, 10_000);
  setInterval(tick, every);
}

/** Reads the email and each attachment with the trip importer and stores a compact summary of what is in them (nothing is filed). */
export async function parseInboxItem(id: string, tripId: string) {
  const item = await prisma.inboxItem.findUniqueOrThrow({ where: { id } });
  const trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId }, include: { destination: true } });
  const profiles = await prisma.traveler.findMany({ select: { name: true } });
  const known = [...new Set([...trip.travelers, ...profiles.map((p) => p.name)])];
  const sources = [{ name: `${item.subject} (email)`, text: item.bodyText }, ...(item.attachments as unknown as InboxAttachment[]).map((a) => ({ name: a.name, text: a.text }))];
  const out = [];
  for (const s of sources) {
    if (s.text.trim().length < 15) continue;
    try {
      const r = await analyzeSource(trip, s.name, s.text, null, known);
      const proposals = (await annotate(trip.id, r.proposals)).map((p) => {
        const d: any = p.data;
        const when = [d.startAt ? String(d.startAt).slice(0, 10) : d.day ? `Day ${d.day}` : d.dueDate ? String(d.dueDate).slice(0, 10) : null, d.location].filter(Boolean).join(" · ");
        return { kind: p.kind, action: p.action, title: d.title ?? d.text, when: when || null, matchTitle: p.matchTitle ?? null, data: p.data };
      });
      out.push({ name: s.name, hash: r.hash, category: r.category, summary: r.summary, reason: r.reason, travelers: r.travelers, alreadyImported: r.alreadyImported, proposals });
    } catch (e: any) {
      out.push({ name: s.name, hash: "", category: "irrelevant", summary: "", reason: "", travelers: [], alreadyImported: false, proposals: [], error: String(e?.message ?? "Could not read this item.").slice(0, 200) });
    }
  }
  const parsed = { tripId, sources: out };
  await prisma.inboxItem.update({ where: { id }, data: { parsed: parsed as any } });
  return parsed;
}
