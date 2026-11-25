import { useRef, useState } from "react";
import { AlertTriangle, Check, FileUp, Globe, Loader2, Plus, X } from "lucide-react";
import { api } from "../../lib/api";
import { Badge, Button, Card, Textarea } from "../ui";
import { money, readDocumentText, shortDate } from "./shared";

type Category = "booking" | "itinerary" | "schedule" | "general" | "irrelevant";
type Action = "new" | "update" | "duplicate";
interface Proposal { kind: "booking" | "itinerary" | "resource" | "checklist"; action: Action; matchTitle?: string; data: any }
interface Result { name: string; hash: string; category: Category; reason: string; summary: string; travelers: string[]; alreadyImported: boolean; proposals: Proposal[]; error?: string; mismatch?: { place: string | null; reason: string; otherTrip: { id: string; title: string } | null } | null }
interface Source { id: number; name: string; kind: "text" | "url"; text?: string; url?: string; note?: string }
interface Applied { created: number; updated: number; skipped: number; travelers: string[]; datesSet: boolean }

const CAT: Record<Category, { label: string; tone: string }> = {
  booking: { label: "Booking", tone: "green" }, itinerary: { label: "Itinerary", tone: "blue" }, schedule: { label: "Schedule", tone: "blue" },
  general: { label: "General material", tone: "purple" }, irrelevant: { label: "Not relevant", tone: "slate" },
};
const KIND_LABEL: Record<Proposal["kind"], string> = { booking: "Bookings", itinerary: "Itinerary & schedule", resource: "Resources", checklist: "Checklist" };

function detail(p: Proposal): string {
  const d = p.data;
  if (p.kind === "booking") return [d.traveler && `for ${d.traveler}`, d.provider, d.confirmationNo && `ref ${d.confirmationNo}`, d.startAt && shortDate(d.startAt) + (d.endAt && d.endAt.slice(0, 10) !== d.startAt.slice(0, 10) ? ` → ${shortDate(d.endAt)}` : ""), d.cost != null && money(d.cost, d.currency), d.location].filter(Boolean).join(" · ");
  if (p.kind === "itinerary") return [d.startAt ? shortDate(d.startAt) : d.day ? `Day ${d.day}` : null, d.time, d.location, d.cost != null && money(d.cost, d.currency)].filter(Boolean).join(" · ");
  if (p.kind === "resource") return [d.category, d.url].filter(Boolean).join(" · ");
  return [d.category, d.dueDate && `due ${shortDate(d.dueDate)}`].filter(Boolean).join(" · ");
}
const title = (p: Proposal) => p.data.title ?? p.data.text;

/** One place to bring anything into a trip: files, screenshots, pasted text and emails, web addresses. */
export default function ImportCard({ tripId, onClose, reload, initialResults, onApplied }: { tripId: string; onClose: () => void; reload: () => void; initialResults?: Result[]; onApplied?: () => void }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [over, setOver] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const [busy, setBusy] = useState<"" | "reading" | "analyzing" | "applying">("");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [results, setResults] = useState<Result[] | null>(initialResults ?? null);
  // opened from the Inbox with the email already read: duplicates start unticked, same as after a fresh read
  const [pick, setPick] = useState<Set<string>>(() => new Set((initialResults ?? []).flatMap((r, ri) => r.proposals.map((p, pi) => (p.action === "duplicate" || r.mismatch ? null : `${ri}:${pi}`)).filter(Boolean) as string[])));
  const [applied, setApplied] = useState<Applied | null>(null);
  const idRef = useRef(1);
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files?: FileList | File[] | null) => {
    const list = Array.from(files ?? []); if (!list.length) return;
    setBusy("reading"); setError("");
    for (const f of list) {
      try { const r = await readDocumentText(f); setSources((s) => [...s, { id: idRef.current++, name: f.name, kind: "text", text: r.text, note: r.note }]); }
      catch (e: any) { setError(`${f.name}: ${e.message}`); }
    }
    setBusy("");
  };
  const addText = () => { if (text.trim().length < 15) return; setSources((s) => [...s, { id: idRef.current++, name: "Pasted text", kind: "text", text }]); setText(""); };
  const addUrl = () => { const u = url.trim(); if (!u) return; setSources((s) => [...s, { id: idRef.current++, name: u, kind: "url", url: /^https?:\/\//i.test(u) ? u : `https://${u}` }]); setUrl(""); };

  const analyze = async () => {
    // include text still sitting in the box
    let queue = sources;
    if (text.trim().length >= 15) { queue = [...queue, { id: idRef.current++, name: "Pasted text", kind: "text", text }]; setText(""); }
    if (url.trim()) { const u = url.trim(); queue = [...queue, { id: idRef.current++, name: u, kind: "url", url: /^https?:\/\//i.test(u) ? u : `https://${u}` }]; setUrl(""); }
    if (!queue.length) return;
    setSources(queue); setBusy("analyzing"); setError(""); setResults(null); setApplied(null);
    const out: Result[] = [];
    for (const [n, s] of queue.entries()) {
      setProgress(`Reading ${n + 1} of ${queue.length}: ${s.name.slice(0, 50)}`);
      try {
        const r = await api.post<{ results: Result[] }>(`/trips/${tripId}/import/analyze`, { sources: [{ name: s.name, kind: s.kind, text: s.text, url: s.url }] });
        out.push(...r.results);
      } catch (e: any) { out.push({ name: s.name, hash: "", category: "irrelevant", reason: "", summary: "", travelers: [], alreadyImported: false, proposals: [], error: e.message }); }
    }
    setResults(out);
    setPick(new Set(out.flatMap((r, ri) => r.proposals.map((p, pi) => (p.action === "duplicate" || r.mismatch ? null : `${ri}:${pi}`)).filter(Boolean) as string[])));
    setBusy(""); setProgress("");
  };

  const apply = async () => {
    if (!results) return;
    setBusy("applying"); setError("");
    try {
      const chosen: Proposal[] = []; const srcs: any[] = []; const names = new Set<string>();
      results.forEach((r, ri) => {
        const mine = r.proposals.filter((_, pi) => pick.has(`${ri}:${pi}`));
        // remember sources that were filed, were not relevant, or had nothing new, so uploading them again is recognised
        const remember = !r.error && !r.alreadyImported && r.hash && (mine.length > 0 || r.category === "irrelevant" || r.proposals.every((p) => p.action === "duplicate"));
        if (remember) { chosen.push(...mine); srcs.push({ hash: r.hash, name: r.name, category: r.category, summary: r.summary || null }); r.travelers.forEach((t) => names.add(t)); }
      });
      const a = await api.post<Applied>(`/trips/${tripId}/import/apply`, { proposals: chosen.map(({ kind, data, action }) => ({ kind, data, action })), sources: srcs, travelers: [...names] });
      setApplied(a); setResults(null); setSources([]); reload(); onApplied?.();
    } catch (e: any) { setError(e.message); }
    setBusy("");
  };

  // Claude judged a document "not relevant" but the user knows it is a booking: read that one again with that hint.
  const [rereading, setRereading] = useState<number | null>(null);
  const rereadAsBooking = async (ri: number) => {
    const src = sources[ri]; if (!src) return;
    setRereading(ri); setError("");
    try {
      const r = await api.post<{ results: Result[] }>(`/trips/${tripId}/import/analyze`, { sources: [{ name: src.name, kind: src.kind, text: src.text, url: src.url, userSaysBooking: true }] });
      const fresh = r.results[0];
      setResults((l) => l && l.map((x, k) => (k === ri ? fresh : x)));
      setPick((p) => { const n = new Set([...p].filter((k) => !k.startsWith(`${ri}:`))); fresh.proposals.forEach((q, pi) => { if (q.action !== "duplicate" && !fresh.mismatch) n.add(`${ri}:${pi}`); }); return n; });
    } catch (e: any) { setError(e.message); }
    setRereading(null);
  };

  const toggle = (k: string) => setPick((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const selected = pick.size;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-[6vh]" onClick={() => !busy && onClose()}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-3xl"
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
        onDrop={(e) => { setOver(false); if (e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } }}>
        <Card className={`p-5 space-y-4 ${over ? "ring-2 ring-brand-500" : ""}`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold">Import into this trip</h2>
              <p className="text-xs text-slate-500">Drop PDFs, screenshots, emails or text files, paste text, or add a web address. Each item is read, classified (booking, itinerary, general material or not relevant) and filed in the right place. Items already on the trip are recognised, so importing twice is safe.</p>
            </div>
            <button type="button" onClick={onClose} disabled={!!busy} aria-label="Close" className="text-slate-400 hover:text-slate-700"><X className="h-5 w-5" /></button>
          </div>

          {applied && (
            <div className="rounded-md border border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-950/30 p-3 text-sm text-green-800 dark:text-green-300">
              <div className="flex items-center gap-1.5 font-medium"><Check className="h-4 w-4" />Import finished</div>
              <div className="mt-0.5 text-xs">{applied.created} added, {applied.updated} updated with new details, {applied.skipped} already there.{applied.datesSet ? " Trip dates were set from the dates found." : ""}{applied.travelers.length ? ` Travelers added: ${applied.travelers.join(", ")}.` : ""}</div>
            </div>
          )}

          {!results && (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-slate-500">Paste text or an email</label>
                  <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste a confirmation email, an itinerary, notes…" />
                  <button type="button" onClick={addText} disabled={text.trim().length < 15} className="mt-1 text-xs text-brand-600 hover:underline disabled:text-slate-400 disabled:no-underline"><Plus className="inline h-3 w-3" /> Add to the list</button>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs text-slate-500">Files</label>
                    <button type="button" onClick={() => fileRef.current?.click()} className="flex w-full flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-slate-300 dark:border-slate-700 px-3 py-4 text-sm text-slate-500 hover:border-brand-400">
                      <FileUp className="h-5 w-5" />Drop files here or click to choose
                      <span className="text-[11px] text-slate-400">PDF, screenshots/photos (OCR), .eml, .txt, .html, .csv…</span>
                    </button>
                    <input ref={fileRef} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-slate-500">Web address</label>
                    <div className="flex gap-2">
                      <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addUrl())} placeholder="https://…" className="min-w-0 flex-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-sm" />
                      <Button variant="secondary" onClick={addUrl} disabled={!url.trim()}><Globe className="h-4 w-4" /></Button>
                    </div>
                  </div>
                </div>
              </div>

              {sources.length > 0 && (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-md border border-slate-200 dark:border-slate-800 text-sm">
                  {sources.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                      <span className="text-slate-400">{s.kind === "url" ? <Globe className="h-4 w-4" /> : <FileUp className="h-4 w-4" />}</span>
                      <span className="min-w-0 flex-1 truncate">{s.name}</span>
                      {s.note && <span className="text-[11px] text-amber-600" title={s.note}>OCR</span>}
                      {s.text && <span className="text-[11px] text-slate-400">{Math.round(s.text.length / 100) / 10}k chars</span>}
                      {s.text && <button type="button" onClick={() => setPreview(preview === s.id ? null : s.id)} className="text-[11px] text-brand-600 hover:underline">{preview === s.id ? "Hide" : "Preview"}</button>}
                      <button type="button" onClick={() => setSources((l) => l.filter((x) => x.id !== s.id))} aria-label={`Remove ${s.name}`} className="text-slate-400 hover:text-red-600"><X className="h-4 w-4" /></button>
                    {preview === s.id && s.text && <pre className="mt-1 max-h-64 w-full overflow-auto whitespace-pre-wrap rounded bg-slate-50 dark:bg-slate-900 p-2 text-[11px] text-slate-600 dark:text-slate-300">{s.text.slice(0, 20000)}{s.text.length > 20000 ? "\n… (preview cut; the full text is still read)" : ""}</pre>}
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-3">
                <Button onClick={analyze} disabled={!!busy || (!sources.length && text.trim().length < 15 && !url.trim())}>
                  {busy === "analyzing" ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Reading…</> : busy === "reading" ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Loading files…</> : "Read & classify"}
                </Button>
                {progress && <span className="text-xs text-slate-500">{progress}</span>}
              </div>
            </>
          )}

          {results && (
            <div className="space-y-4">
              {results.map((r, ri) => {
                const groups = (["booking", "itinerary", "resource", "checklist"] as const).map((k) => ({ k, items: r.proposals.map((p, pi) => ({ p, pi })).filter((x) => x.p.kind === k) })).filter((g) => g.items.length);
                return (
                  <div key={ri} className="rounded-md border border-slate-200 dark:border-slate-800">
                    <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 dark:border-slate-800 px-3 py-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{r.name}</span>
                      {r.error ? <Badge tone="red">Couldn't read</Badge> : <Badge tone={CAT[r.category].tone}>{CAT[r.category].label}</Badge>}
                    </div>
                    <div className="space-y-2 px-3 py-2 text-sm">
                      {r.error && <p className="flex items-start gap-1.5 text-xs text-red-600"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{r.error}</p>}
                      {r.alreadyImported && <p className="text-xs text-amber-600">{r.reason}. Nothing to add again.</p>}
                      {r.mismatch && !r.alreadyImported && (
                        <div className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>This looks like it's for {r.mismatch.place ?? "a different trip"}, not this trip.{r.mismatch.reason ? ` ${r.mismatch.reason}` : ""}{r.mismatch.otherTrip ? <> It may belong to <a href={`/trips/${r.mismatch.otherTrip.id}`} className="font-medium underline">{r.mismatch.otherTrip.title}</a>.</> : ""} Its items are left unticked; tick them only if they really belong here.</span>
                        </div>
                      )}
                      {!r.error && !r.alreadyImported && (r.summary || r.reason) && <p className="text-xs text-slate-500">{r.summary} {r.category === "irrelevant" && r.reason ? r.reason : ""}</p>}
                      {!r.error && !r.alreadyImported && r.category === "irrelevant" && sources[ri] && (
                        <button type="button" onClick={() => rereadAsBooking(ri)} disabled={rereading !== null} className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline disabled:text-slate-400">
                          {rereading === ri && <Loader2 className="h-3 w-3 animate-spin" />}This is a booking for this trip: read it again
                        </button>
                      )}
                      {r.travelers.length > 0 && !r.alreadyImported && <p className="text-xs text-slate-500">Travelers found: {r.travelers.join(", ")}</p>}
                      {groups.map((g) => (
                        <div key={g.k}>
                          <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{KIND_LABEL[g.k]}</div>
                          <ul className="space-y-1">
                            {g.items.map(({ p, pi }) => (
                              <li key={pi} className="flex items-start gap-2">
                                <input type="checkbox" className="mt-1 h-4 w-4 accent-brand-600" checked={pick.has(`${ri}:${pi}`)} onChange={() => toggle(`${ri}:${pi}`)} aria-label={`Add ${title(p)}`} />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2"><span className="truncate">{title(p)}</span>
                                    {p.action === "new" && <Badge tone="green">New</Badge>}
                                    {p.action === "update" && <Badge tone="blue">Adds details</Badge>}
                                    {p.action === "duplicate" && <Badge tone="slate">Already there</Badge>}
                                  </div>
                                  <div className="text-xs text-slate-500">{detail(p)}</div>
                                  {p.action !== "new" && p.matchTitle && <div className="text-[11px] text-slate-400">{p.action === "update" ? "Fills in missing details on" : "Matches"} “{p.matchTitle}”</div>}
                                </div>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={apply} disabled={!!busy || !selected}>{busy === "applying" ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}Add {selected} item{selected === 1 ? "" : "s"} to the trip</Button>
                <Button variant="secondary" onClick={() => setResults(null)} disabled={!!busy}>Back</Button>
                <span className="text-xs text-slate-400">Items marked “Already there” are left unticked.</span>
              </div>
            </div>
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
          {applied && !results && <div className="flex justify-end"><Button variant="secondary" onClick={onClose}>Done</Button></div>}
        </Card>
      </div>
    </div>
  );
}
