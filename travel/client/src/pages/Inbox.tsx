import { useCallback, useEffect, useState } from "react";
import { Loader2, Paperclip, RefreshCw, Trash2, X } from "lucide-react";
import { api } from "../lib/api";
import { Trip } from "../types";
import ImportCard from "../components/trip/ImportCard";
import { Badge, Button, Card, PageHeader, Select } from "../components/ui";

interface Item { id: string; fromAddr: string; subject: string; receivedAt: string; preview: string; attachmentNames: string[]; suggestedTripId: string | null; suggestionNote: string | null; parsed: Parsed | null; duplicateOf: string | null; legacyParse?: boolean }
interface PSource { name: string; category: string; summary: string; reason: string; travelers: string[]; alreadyImported: boolean; error?: string; proposals: { kind: string; action: string; title: string; when: string | null; matchTitle: string | null }[] }
interface Parsed { tripId: string; sources: PSource[] }
const CAT: Record<string, { label: string; tone: string }> = { booking: { label: "Booking", tone: "green" }, itinerary: { label: "Itinerary", tone: "blue" }, schedule: { label: "Schedule", tone: "blue" }, general: { label: "General material", tone: "purple" }, irrelevant: { label: "Not relevant", tone: "slate" } };
const KIND: Record<string, string> = { booking: "Booking", itinerary: "Itinerary", resource: "Resource", checklist: "To-do" };
interface Review { id: string; tripId: string; results: any[] }

export default function Inbox() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [info, setInfo] = useState<{ configured: boolean; address: string | null }>({ configured: true, address: null });
  const [trips, setTrips] = useState<Trip[]>([]);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [review, setReview] = useState<Review | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [reading, setReading] = useState<string | null>(null);
  const [original, setOriginal] = useState<{ subject: string; fromAddr: string; html: string | null; sources: { name: string; text: string }[] } | null>(null);
  const [view, setView] = useState<"formatted" | "text">("formatted");
  const [images, setImages] = useState(false);

  const load = useCallback(() => {
    api.get<{ configured: boolean; address: string | null; items: Item[] }>("/inbox").then((r) => {
      setItems(r.items); setInfo({ configured: r.configured, address: r.address });
      setChoice((c) => { const n = { ...c }; r.items.forEach((i) => { if (!n[i.id] && i.suggestedTripId) n[i.id] = i.suggestedTripId; }); return n; });
    }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); api.get<Trip[]>("/trips").then(setTrips).catch(() => {}); }, [load]);

  // parses saved before full data was kept: re-read them once in the background so their badges can be refreshed
  useEffect(() => {
    const stale = items?.find((x) => x.legacyParse && x.parsed?.tripId);
    if (!stale || reading) return;
    setReading(stale.id);
    api.post<Parsed>(`/inbox/${stale.id}/parse`, { tripId: stale.parsed!.tripId }).then(load).catch(() => setItems((l) => l && l.map((x) => (x.id === stale.id ? { ...x, legacyParse: false } : x)))).finally(() => setReading(null));
  }, [items, reading, load]);

  const check = async () => {
    setChecking(true); setError("");
    try { await api.post("/inbox/poll"); load(); } catch (e: any) { setError(e.message); }
    setChecking(false);
  };
  const open = async (id: string) => {
    setError(""); setReading(id);
    try { const r = await api.post<{ results: any[] }>(`/inbox/${id}/results`, { tripId: choice[id] }); setReview({ id, tripId: choice[id], results: r.results }); }
    catch (e: any) { setError(e.message); }
    setReading(null);
  };
  const pick = async (id: string, tripId: string) => {
    setChoice((c) => ({ ...c, [id]: tripId }));
    const it = items?.find((x) => x.id === id);
    if (!tripId || it?.parsed?.tripId === tripId) return;
    setReading(id); setError("");
    try { const parsed = await api.post<Parsed>(`/inbox/${id}/parse`, { tripId }); setItems((l) => l && l.map((x) => (x.id === id ? { ...x, parsed } : x))); }
    catch (e: any) { setError(e.message); }
    setReading(null);
  };
  const viewOriginal = async (i: Item) => {
    setError("");
    try { const r = await api.get<{ html: string | null; sources: { name: string; text: string }[] }>(`/inbox/${i.id}`); setView("formatted"); setImages(false); setOriginal({ subject: i.subject, fromAddr: i.fromAddr, html: r.html, sources: r.sources }); }
    catch (e: any) { setError(e.message); }
  };
  const dismiss = async (id: string) => { await api.post(`/inbox/${id}/dismiss`).catch(() => {}); load(); };

  return (
    <div className="space-y-4">
      <PageHeader title="Inbox" subtitle={info.address ? `Forward trip emails and confirmations to ${info.address}. They land here to be filed into a trip.` : "Forward trip emails to the app's mailbox and file them into a trip."}
        actions={info.configured ? <Button variant="secondary" onClick={check} disabled={checking}>{checking ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1.5" />}Check now</Button> : undefined} />
      {!info.configured && (
        <Card className="p-4 text-sm text-slate-600 dark:text-slate-300">
          The mailbox isn't connected yet. Set <code>IMAP_USER</code> and <code>IMAP_PASSWORD</code> (an app password for a dedicated mailbox) in <code>.env</code>, optionally <code>INBOX_ALLOWED_SENDERS</code>, then restart the server. See <code>.env.example</code>.
        </Card>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
      {items && info.configured && !items.length && <p className="text-sm text-slate-500">Nothing waiting. Forward an email to the address above and it shows up here within a few minutes.</p>}
      <div className="space-y-3">
        {items?.map((i) => (
          <Card key={i.id} className="p-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium">{i.subject}</span>
                  {i.duplicateOf && <Badge tone="amber">{i.duplicateOf === "FILED" ? "Same email as one already filed" : "Same email as an earlier one"}</Badge>}
                  {i.attachmentNames.length > 0 && <Badge tone="slate"><Paperclip className="inline h-3 w-3 mr-0.5" />{i.attachmentNames.length}</Badge>}
                </div>
                <div className="text-xs text-slate-500">{i.fromAddr} · {new Date(i.receivedAt).toLocaleString()}</div>
                {(() => {
                  const ps = i.parsed && i.parsed.tripId === choice[i.id] ? i.parsed.sources.filter((x) => x.category !== "irrelevant" || x.error || x.proposals.length || x === i.parsed!.sources[0]) : null;
                  if (reading === i.id) return <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />Reading the email…</p>;
                  if (!ps) return <p className="mt-1 text-xs text-slate-400">{choice[i.id] ? "Not read yet." : "Choose a trip to see what's in this email."}</p>;
                  const nothingNew = ps.every((x) => !x.error && (x.alreadyImported || x.proposals.every((p) => p.action === "duplicate")));
                  return (
                    <div className="mt-2 space-y-2">
                      {nothingNew && <p className="text-xs font-medium text-green-700 dark:text-green-400">Nothing new: everything in this email is already on the trip.</p>}
                      {ps.map((src, si) => (
                        <div key={si} className="text-sm">
                          <div className="flex flex-wrap items-center gap-2">
                            {src.error ? <Badge tone="red">Couldn't read</Badge> : <Badge tone={CAT[src.category]?.tone ?? "slate"}>{CAT[src.category]?.label ?? src.category}</Badge>}
                            {si > 0 && <span className="text-xs text-slate-500">{src.name}</span>}
                            {src.alreadyImported && <Badge tone="amber">Already imported</Badge>}
                          </div>
                          {src.error ? <p className="text-xs text-red-600">{src.error}</p> : <p className="mt-0.5 text-xs text-slate-500">{src.summary || src.reason}</p>}
                          {src.proposals.length > 0 && (
                            <ul className="mt-1 space-y-0.5">
                              {src.proposals.map((p, pi) => (
                                <li key={pi} className="flex items-baseline gap-2 text-xs">
                                  <span className="w-16 shrink-0 text-[11px] uppercase tracking-wide text-slate-400">{KIND[p.kind] ?? p.kind}</span>
                                  <span className="min-w-0 flex-1 truncate">{p.title}{p.when && <span className="text-slate-400"> · {p.when}</span>}</span>
                                  {p.action === "new" && <Badge tone="green">New</Badge>}
                                  {p.action === "update" && <Badge tone="blue">Adds details</Badge>}
                                  {p.action === "duplicate" && <Badge tone="slate">Already there</Badge>}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                  );
                })()}
                <button type="button" onClick={() => viewOriginal(i)} className="mt-1 text-[11px] text-brand-600 hover:underline">View original email</button>
                {i.suggestionNote && i.suggestedTripId && <p className="mt-1 text-[11px] text-slate-400">Suggested trip: {i.suggestionNote}</p>}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="order-last ml-auto"><Button variant="secondary" onClick={() => dismiss(i.id)}><Trash2 className="h-4 w-4 mr-1.5" />Discard</Button></span>
              <Select value={choice[i.id] ?? ""} onChange={(e) => pick(i.id, e.target.value)} className="max-w-xs">
                <option value="">Choose a trip…</option>
                {trips.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              </Select>
              {i.parsed && i.parsed.tripId === choice[i.id] && i.parsed.sources.every((x) => !x.error && (x.alreadyImported || x.proposals.every((p) => p.action === "duplicate")))
                ? <Button onClick={() => { api.post(`/inbox/${i.id}/filed`, { tripId: choice[i.id] }).catch(() => {}).then(load); }}>Mark as done</Button>
                : <Button onClick={() => open(i.id)} disabled={!choice[i.id] || reading === i.id}>Import</Button>}
            </div>
          </Card>
        ))}
      </div>
      {original && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-[6vh]" onClick={() => setOriginal(null)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-3xl">
            <Card className="p-5 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><h2 className="font-display text-lg font-semibold break-words">{original.subject}</h2><p className="text-xs text-slate-500">From {original.fromAddr}</p></div>
                <button type="button" onClick={() => setOriginal(null)} aria-label="Close" className="text-slate-400 hover:text-slate-700"><X className="h-5 w-5" /></button>
              </div>
              {original.html && (
                <div className="flex items-center gap-3 text-xs">
                  <button type="button" onClick={() => setView("formatted")} className={view === "formatted" ? "font-semibold text-brand-700" : "text-slate-500 hover:underline"}>Formatted</button>
                  <button type="button" onClick={() => setView("text")} className={view === "text" ? "font-semibold text-brand-700" : "text-slate-500 hover:underline"}>Plain text</button>
                  {view === "formatted" && !images && <button type="button" onClick={() => setImages(true)} className="ml-auto text-slate-400 hover:underline">Load remote images</button>}
                </div>
              )}
              {original.html && view === "formatted" && (
                <iframe title="Original email" sandbox="allow-popups allow-popups-to-escape-sandbox" className="h-[60vh] w-full rounded border border-slate-200 bg-white"
                  srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:${images ? " https:" : ""}; style-src 'unsafe-inline'"><base target="_blank">${original.html}`} />
              )}
              {original.sources.map((src, k) => (k === 0 && original.html && view === "formatted") ? null : (
                <div key={k}>
                  {k > 0 && <div className="mb-1 flex items-center gap-1 text-xs font-medium text-slate-500"><Paperclip className="h-3 w-3" />{src.name}</div>}
                  <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded bg-slate-50 dark:bg-slate-900 p-3 text-xs text-slate-700 dark:text-slate-300">{src.text}</pre>
                </div>
              ))}
            </Card>
          </div>
        </div>
      )}
      {review && (
        <ImportCard tripId={review.tripId} initialResults={review.results} reload={() => {}} onClose={() => { setReview(null); load(); }}
          onApplied={() => { api.post(`/inbox/${review.id}/filed`, { tripId: review.tripId }).catch(() => {}); }} />
      )}
    </div>
  );
}
