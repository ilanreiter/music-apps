// Dedicated-mailbox inbox: forward trip emails to one address, the server polls it over IMAP and stores each
// message (body + readable attachments) as a pending InboxItem. Filing into a trip reuses the normal import review.
import { ImapFlow } from "imapflow";
import { simpleParser, ParsedMail } from "mailparser";
import { prisma } from "../db";
import { bytesToText, htmlToText } from "./sourceText";
import { askJson } from "./tripPlanningAi";
import { analyzeSource, annotate } from "./tripImport";
import { saveIncoming, sourceFileName } from "./docStore";

const env = process.env;
export const inboxConfigured = () => !!(env.IMAP_USER && env.IMAP_PASSWORD);
const allowed = () => (env.INBOX_ALLOWED_SENDERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export interface InboxAttachment { name: string; text: string; note?: string }
/** Originals worth keeping as files (the text goes into the card; the file goes to the NAS). */
export interface KeptFile { name: string; mime: string; buf: Buffer }

const TEXT_TYPES = /^(text\/(plain|calendar|csv|html)|application\/(ics|json))/i;

async function attachmentTexts(mail: ParsedMail, keep: KeptFile[] = []): Promise<InboxAttachment[]> {
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
      keep.push({ name, mime: a.contentType || "application/octet-stream", buf: a.content });
    } catch (e: any) {
      console.error("inbox: attachment skipped:", name, String(e?.message ?? e).slice(0, 120));
    }
  }
  return out;
}

export interface NewTripHint { title: string; place: string | null; startDate: string | null; endDate: string | null }
export interface Suggestion { tripId: string | null; note: string | null; relevant: boolean; reason: string | null; newTrip?: NewTripHint | null }

// One call decides two things: is this mail about a trip at all (booking, ticket, itinerary, travel document) and which trip is it.
// Failure or doubt means "relevant, unsorted", so nothing real is filtered out by accident.
export async function suggestTrip(subject: string, body: string): Promise<Suggestion> {
  const trips = await prisma.trip.findMany({ where: { status: { not: "CANCELLED" } }, include: { destination: { select: { name: true } } }, orderBy: { startDate: "asc" } });
  const tagged = trips.find((t) => subject.toLowerCase().includes(`[${t.title.toLowerCase()}]`));
  if (tagged) return { tripId: tagged.id, note: "Matched the trip tag in the subject", relevant: true, reason: null };
  try {
    const list = trips.length ? trips.map((t) => `${t.id} | ${t.title}${t.destination ? ` | ${t.destination.name}` : ""} | ${t.startDate?.toISOString().slice(0, 10) ?? "no dates"} to ${t.endDate?.toISOString().slice(0, 10) ?? "?"}`).join("\n") : "(no trips yet)";
    const j = await askJson(`Classify an email forwarded to a trip planner. Trips (id | title | destination | dates):\n${list}\n\nReturn ONLY JSON {"relevant":true or false,"tripId":"an id from the list, or null if unsure or no trip fits","reason":"one short sentence","newTrip":{"title":"Trip to <main destination>","place":"main country/region/city","startDate":"YYYY-MM-DD or null","endDate":"YYYY-MM-DD or null"} or null}.\n"newTrip" is filled only when the material is relevant and no listed trip fits; take the dates from the material (first and last day of the travel it describes) and never invent them.\n"relevant" is true for a booking confirmation, ticket, reservation, itinerary, travel document, visa/insurance/check-in notice, or a message about a specific trip, including for a trip that is not in the list yet. It is false for promotions, newsletters, marketing, deals, loyalty-program news, surveys, receipts unrelated to travel, and anything not about travel. When unsure, answer true.\n\nSubject: ${subject}\n"""\n${body.slice(0, 6000)}\n"""`, 300);
    const t = trips.find((x) => x.id === j.tripId);
    const reason = typeof j.reason === "string" ? j.reason.slice(0, 200) : null;
    const nt = !t && j.relevant !== false && j.newTrip && typeof j.newTrip.title === "string" ? {
      title: String(j.newTrip.title).slice(0, 120), place: typeof j.newTrip.place === "string" ? j.newTrip.place.slice(0, 120) : null,
      startDate: /^\d{4}-\d{2}-\d{2}$/.test(j.newTrip.startDate ?? "") ? j.newTrip.startDate : null, endDate: /^\d{4}-\d{2}-\d{2}$/.test(j.newTrip.endDate ?? "") ? j.newTrip.endDate : null,
    } : null;
    return { tripId: j.relevant === false ? null : t?.id ?? null, note: t ? reason : null, relevant: j.relevant !== false, reason, newTrip: nt };
  } catch { return { tripId: null, note: null, relevant: true, reason: null }; }
}

// For mail you forwarded by hand the "From" is you; the original sender is in the forwarded header block.
export function originalSender(from: string, body: string): string {
  if (!allowed().includes(from)) return from;
  const m = body.match(/Forwarded message[\s\S]{0,400}?From:[^\n<]*<([^>\s]+@[^>\s]+)>/i) || body.match(/Forwarded message[\s\S]{0,400}?From:\s*([^\s<>]+@[^\s<>]+)/i);
  return (m?.[1] ?? from).toLowerCase();
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
    await prisma.inboxItem.deleteMany({ where: { status: "FILTERED", createdAt: { lt: new Date(Date.now() - 30 * 86400_000) } } }); // filtered mail is kept 30 days
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Shared mailbox: never touch flags (other apps read it too). Look at recent mail and keep only what is addressed to this app's alias.
      const since = new Date(Date.now() - 14 * 86400_000);
      const alias = (env.INBOX_ALIAS ?? "").trim().toLowerCase();
      const wanted: number[] = [];
      for await (const m of client.fetch({ since }, { uid: true, envelope: true, headers: ["delivered-to", "x-original-to", "to", "cc", "x-forwarded-for"] }, { uid: true })) {
        const from = (m.envelope?.from?.[0]?.address ?? "").toLowerCase();
        const list = allowed();
        const hdr = (m.headers ? m.headers.toString("utf8") : "").toLowerCase();
        // Gmail forwarding keeps the original From, and records who forwarded in X-Forwarded-For.
        const fwdBy = (hdr.match(/^x-forwarded-for:[^\n]*/m)?.[0] ?? "");
        if (list.length && !list.includes(from) && !list.some((a) => fwdBy.includes(a))) { skipped++; continue; }
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
        const keep: KeptFile[] = [];
        const attachments = await attachmentTexts(mail, keep);
        const subject = (mail.subject || "(no subject)").slice(0, 300);
        if (body.length < 15 && !attachments.length) continue;
        const blocked = await prisma.inboxBlockedSender.findFirst({ where: { addr: { in: [from, originalSender(from, body)] } } });
        const hd = mail.headers;
        let filterReason: string | null = null;
        let sg: Suggestion = { tripId: null, note: null, relevant: true, reason: null };
        if (blocked) filterReason = "Blocked sender";
        else if (hd.get("list-unsubscribe") || /bulk|list|junk/i.test(String(hd.get("precedence") ?? ""))) filterReason = "Looks like a newsletter or promotion";
        else { sg = await suggestTrip(subject, body || attachments[0].text); if (!sg.relevant) filterReason = sg.reason || "Not about a trip"; }
        const baseSubject = subject.replace(/^((fwd?|re)\s*:\s*)+/i, "").trim().toLowerCase();
        const earlier = (await prisma.inboxItem.findMany({ where: { fromAddr: from, createdAt: { gte: new Date(Date.now() - 30 * 86400_000) } }, select: { id: true, subject: true } }))
          .find((x) => x.subject.replace(/^((fwd?|re)\s*:\s*)+/i, "").trim().toLowerCase() === baseSubject);
        const created = await prisma.inboxItem.create({ data: { status: filterReason ? "FILTERED" : "PENDING", filterReason, dupOfId: earlier?.id ?? null, messageId, fromAddr: from, subject, receivedAt: mail.date ?? new Date(), bodyText: body.slice(0, 400_000), bodyHtml: typeof mail.html === "string" && mail.html.length < 1_500_000 ? mail.html : null, attachments: attachments as any, suggestedTripId: sg.tripId, suggestionNote: sg.note, newTripHint: (sg.newTrip ?? undefined) as any } });
        if (!filterReason) {
          added++;
          // the email itself (as the original .eml) and its attachments
          await saveIncoming(msg.source, sourceFileName(subject, "eml"), "message/rfc822", created.id, { role: "source" }).catch((e) => console.error("inbox: could not keep the email", String(e?.message ?? e).slice(0, 120)));
          for (const f of keep) await saveIncoming(f.buf, f.name, f.mime, created.id).catch((e) => console.error("inbox: could not keep", f.name, String(e?.message ?? e).slice(0, 120)));
        }
        if (!filterReason && sg.tripId) await parseInboxItem(created.id, sg.tripId).catch((e) => console.error("inbox: parse failed:", String(e?.message ?? e).slice(0, 120)));
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
  const sources = [{ name: item.source === "upload" ? item.subject : `${item.subject} (email)`, text: item.bodyText }, ...(item.attachments as unknown as InboxAttachment[]).map((a) => ({ name: a.name, text: a.text }))];
  const out = [];
  for (const s of sources) {
    if (s.text.trim().length < 15) continue;
    try {
      const r = await analyzeSource(trip, s.name, s.text, null, known);
      const proposals = (await annotate(trip.id, r.proposals)).map((p) => {
        const d: any = p.data;
        const when = [d.startAt ? String(d.startAt).slice(0, 10) : d.day ? `Day ${d.day}` : d.dueDate ? String(d.dueDate).slice(0, 10) : d.coverageStart ? `${String(d.coverageStart).slice(0, 10)} → ${String(d.coverageEnd ?? "").slice(0, 10)}` : null, d.location].filter(Boolean).join(" · ");
        return { kind: p.kind, action: p.action, title: d.title ?? d.text ?? [d.provider, d.planName].filter(Boolean).join(" · "), when: when || null, matchTitle: p.matchTitle ?? null, data: p.data };
      });
      out.push({ name: s.name, hash: r.hash, category: r.category, summary: r.summary, reason: r.reason, travelers: r.travelers, alreadyImported: r.alreadyImported, mismatch: r.mismatch ?? null, proposals });
    } catch (e: any) {
      out.push({ name: s.name, hash: "", category: "irrelevant", summary: "", reason: "", travelers: [], alreadyImported: false, proposals: [], error: String(e?.message ?? "Could not read this item.").slice(0, 200) });
    }
  }
  const parsed = { tripId, sources: out };
  await prisma.inboxItem.update({ where: { id }, data: { parsed: parsed as any } });
  return parsed;
}
