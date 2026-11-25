import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Loader2, ChevronDown, ChevronRight, FileUp, Globe, Mail, Paperclip, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { api } from "../lib/api";
import { Trip } from "../types";
import ImportCard from "../components/trip/ImportCard";
import DocViewer, { ViewDoc } from "../components/DocViewer";
import { Badge, Button, Card, Input, PageHeader, Select, Textarea } from "../components/ui";
import { Link } from "react-router-dom";

interface NewTripHint { title: string; place: string | null; startDate: string | null; endDate: string | null }
interface Item { id: string; source?: string; documents?: { id: string; name: string }[]; newTripHint?: NewTripHint | null; fromAddr: string; subject: string; receivedAt: string; preview: string; attachmentNames: string[]; suggestedTripId: string | null; suggestionNote: string | null; parsed: Parsed | null; duplicateOf: string | null; legacyParse?: boolean }
interface PSource { name: string; category: string; summary: string; reason: string; travelers: string[]; alreadyImported: boolean; error?: string; mismatch?: { place: string | null; otherTrip: { id: string; title: string } | null } | null; proposals: { kind: string; action: string; title: string; when: string | null; matchTitle: string | null; data?: any }[] }
interface Parsed { tripId: string; sources: PSource[] }
const CAT: Record<string, { label: string; tone: string }> = { booking: { label: "Booking", tone: "green" }, itinerary: { label: "Itinerary", tone: "blue" }, schedule: { label: "Schedule", tone: "blue" }, general: { label: "General material", tone: "purple" }, irrelevant: { label: "Not relevant", tone: "slate" } };
const KIND: Record<string, string> = { booking: "Booking", itinerary: "Itinerary", resource: "Resource", checklist: "To-do", insurance: "Insurance" };
interface Review { id: string; tripId: string; results: any[] }

export default function Inbox() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [info, setInfo] = useState<{ configured: boolean; address: string | null }>({ configured: true, address: null });
  const [trips, setTrips] = useState<Trip[]>([]);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [review, setReview] = useState<Review | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [showFiltered, setShowFiltered] = useState(false);
  const [filteredCount, setFilteredCount] = useState(0);
  const [filtered, setFiltered] = useState<{ items: { id: string; fromAddr: string; subject: string; receivedAt: string; filterReason: string | null }[]; blocked: { id: string; addr: string }[] } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [original, setOriginal] = useState<{ subject: string; fromAddr: string; html: string | null; sources: { name: string; text: string }[] } | null>(null);
  const [view, setView] = useState<"formatted" | "text">("formatted");
  const [images, setImages] = useState(false);
  const [viewing, setViewing] = useState<ViewDoc | null>(null);
  const [params] = useSearchParams();
  const presetTrip = params.get("trip") || "";
  const [newTrip, setNewTrip] = useState<Record<string, NewTripHint>>({});   // open "New trip…" forms, by card
  const [day1, setDay1] = useState<Record<string, string>>({});
  // drop zone
  const [queue, setQueue] = useState<{ name: string; kind: "text" | "url" | "file"; text?: string; url?: string; file?: File }[]>([]);
  const [docsReady, setDocsReady] = useState<boolean | null>(null);
  const [paste, setPaste] = useState("");
  const [link, setLink] = useState("");
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api.get<{ configured: boolean; address: string | null; filteredCount: number; items: Item[] }>("/inbox").then((r) => {
      setItems(r.items); setFilteredCount(r.filteredCount); setInfo({ configured: r.configured, address: r.address });
      setChoice((c) => { const n = { ...c }; r.items.forEach((i) => { if (!n[i.id] && i.suggestedTripId) n[i.id] = i.suggestedTripId; }); return n; });
    }).catch((e) => setError(e.message));
  }, []);
  const loadTrips = useCallback(() => { api.get<Trip[]>("/trips").then(setTrips).catch(() => {}); }, []);
  useEffect(() => { load(); loadTrips(); api.get<{ folder: string | null; available: boolean }>("/docs/settings").then((d) => setDocsReady(!!d.folder && d.available)).catch(() => setDocsReady(false)); }, [load, loadTrips]);
  const tripTitle = (id: string) => trips.find((t) => t.id === id)?.title;

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
    try { const r = await api.post<{ results: any[] }>(`/inbox/${id}/results`, { tripId: choice[id], ...(needsDay1(id) && day1[id] ? { day1: day1[id] } : {}) }); setReview({ id, tripId: choice[id], results: r.results }); }
    catch (e: any) { setError(e.message); }
    setReading(null);
  };
  const pick = async (id: string, tripId: string) => {
    if (tripId === "__new") {
      const it = items?.find((x) => x.id === id);
      setNewTrip((m) => ({ ...m, [id]: it?.newTripHint ?? { title: "", place: null, startDate: null, endDate: null } }));
      return;
    }
    setNewTrip((m) => { const n = { ...m }; delete n[id]; return n; });
    setChoice((c) => ({ ...c, [id]: tripId }));
    const it = items?.find((x) => x.id === id);
    if (!tripId || it?.parsed?.tripId === tripId) return;
    setReading(id); setError("");
    try { const parsed = await api.post<Parsed>(`/inbox/${id}/parse`, { tripId }); setItems((l) => l && l.map((x) => (x.id === id ? { ...x, parsed } : x))); }
    catch (e: any) { setError(e.message); }
    setReading(null);
  };
  const createTrip = async (id: string) => {
    const f = newTrip[id]; if (!f?.title.trim()) return;
    setReading(id); setError("");
    try {
      const r = await api.post<{ trip: { id: string; title: string }; parsed: Parsed | null }>(`/inbox/${id}/new-trip`, f);
      loadTrips();
      setChoice((c) => ({ ...c, [id]: r.trip.id }));
      setNewTrip((m) => { const n = { ...m }; delete n[id]; return n; });
      setItems((l) => l && l.map((x) => (x.id === id ? { ...x, suggestedTripId: r.trip.id, suggestionNote: "New trip created from this document", parsed: r.parsed } : x)));
    } catch (e: any) { setError(e.message); }
    setReading(null);
  };
  // itineraries written as "Day 1, Day 2…" are placed from a Day 1 date the user can see and change
  const needsDay1 = (id: string) => {
    const it = items?.find((x) => x.id === id);
    return !!it?.parsed && it.parsed.tripId === choice[id] && it.parsed.sources.some((src) => src.proposals.some((p) => p.kind === "itinerary" && p.data?.day && !p.data?.startAt));
  };
  const mismatchOf = (i: Item) => (i.parsed && i.parsed.tripId === choice[i.id] ? i.parsed.sources.find((x) => x.mismatch && !x.alreadyImported)?.mismatch ?? null : null);
  const day1Default = (id: string) => { const t = trips.find((x) => x.id === choice[id]); return t?.startDate ? String(t.startDate).slice(0, 10) : ""; };
  useEffect(() => {
    // pre-fill Day 1 with the trip's start date the first time a card needs it
    items?.forEach((i) => { if (!day1[i.id] && needsDay1(i.id) && !mismatchOf(i) && day1Default(i.id)) setDay1((m) => ({ ...m, [i.id]: day1Default(i.id) })); });
  });

  // ---- drop zone: every file / text / link becomes a card
  const addFiles = (files?: FileList | File[] | null) => {
    const list = Array.from(files ?? []); if (!list.length) return;
    setError(""); setQueue((q) => [...q, ...list.map((f) => ({ name: f.name, kind: "file" as const, file: f }))]);
  };
  const upload = async () => {
    let q = queue;
    if (paste.trim().length >= 15) q = [...q, { name: "Pasted text", kind: "text", text: paste }];
    if (link.trim()) q = [...q, { name: link.trim(), kind: "url", url: link.trim() }];
    if (!q.length) return;
    setPaste(""); setLink(""); setError("");
    for (const [n, src] of q.entries()) {
      setUploading(`Reading ${n + 1} of ${q.length}: ${src.name.slice(0, 60)}`);
      try {
        if (src.kind === "file" && src.file) {
          const qs = new URLSearchParams({ name: src.file.name, mime: src.file.type || "application/octet-stream", ...(presetTrip ? { tripId: presetTrip } : {}) });
          const r = await fetch(`/api/inbox/upload-file?${qs}`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/octet-stream" }, body: src.file });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Could not read ${src.file.name}`);
        } else await api.post("/inbox/upload", { name: src.name, kind: src.kind, text: src.text, url: src.url, ...(presetTrip ? { tripId: presetTrip } : {}) });
      }
      catch (e: any) { setError(e.message); }
      setQueue((cur) => cur.filter((x) => x !== src));
      load();
    }
    setUploading("");
  };

  const viewOriginal = async (i: Item) => {
    setError("");
    try { const r = await api.get<{ html: string | null; sources: { name: string; text: string }[] }>(`/inbox/${i.id}`); setView("formatted"); setImages(false); setOriginal({ subject: i.subject, fromAddr: i.fromAddr, html: r.html, sources: r.sources }); }
    catch (e: any) { setError(e.message); }
  };
  const loadFiltered = useCallback(() => { api.get<NonNullable<typeof filtered>>("/inbox/filtered").then(setFiltered).catch((e) => setError(e.message)); }, []);
  useEffect(() => { if (showFiltered) loadFiltered(); }, [showFiltered, loadFiltered, filteredCount]);
  const act = async (id: string, fn: () => Promise<unknown>) => { setBusyId(id); setError(""); try { await fn(); } catch (e: any) { setError(e.message); } setBusyId(null); load(); if (showFiltered) loadFiltered(); };
  const ignoreSender = (i: Item) => { if (window.confirm(`Ignore all future mail from this sender? Their emails will go to Filtered instead of the Inbox.`)) act(i.id, () => api.post(`/inbox/${i.id}/block-sender`)); };
  const dismiss = async (id: string) => { await api.post(`/inbox/${id}/dismiss`).catch(() => {}); load(); };

  return (
    <div className="space-y-4">
      <PageHeader title="Import" subtitle={`Add documents here, or forward emails${info.address ? ` to ${info.address}` : ""}. Each one is read, matched to the trip it belongs to, and filed only after you check it.`}
        actions={info.configured ? <Button variant="secondary" onClick={check} disabled={checking}>{checking ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1.5" />}Check now</Button> : undefined} />
      {!info.configured && (
        <Card className="p-4 text-sm text-slate-600 dark:text-slate-300">
          The mailbox isn't connected yet. Set <code>IMAP_USER</code> and <code>IMAP_PASSWORD</code> (an app password for a dedicated mailbox) in <code>.env</code>, optionally <code>INBOX_ALLOWED_SENDERS</code>, then restart the server. See <code>.env.example</code>.
        </Card>
      )}
      <Card className={`p-4 space-y-3 ${over ? "ring-2 ring-brand-500" : ""}`}>
        <div onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
          onDrop={(e) => { setOver(false); if (e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } }}
          className="grid gap-3 md:grid-cols-3">
          <button type="button" onClick={() => fileRef.current?.click()} className="flex flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-slate-300 dark:border-slate-700 px-3 py-4 text-sm text-slate-500 hover:border-brand-400">
            <FileUp className="h-5 w-5" />Drop files or click to choose
            <span className="text-[11px] text-slate-400">PDF, screenshots, .eml, .txt…</span>
          </button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          <Textarea rows={3} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="…or paste an email, confirmation or itinerary" />
          <div className="flex flex-col gap-2">
            <div className="flex gap-2"><Globe className="mt-2 h-4 w-4 shrink-0 text-slate-400" /><Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="…or a web address" /></div>
            <Button onClick={upload} disabled={!!uploading || (!queue.length && paste.trim().length < 15 && !link.trim())}>
              {uploading ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Upload className="h-4 w-4 mr-1.5" />}Read & match to a trip
            </Button>
          </div>
        </div>
        {queue.length > 0 && (
          <ul className="flex flex-wrap gap-2 text-xs">
            {queue.map((q, k) => <li key={k} className="flex items-center gap-1 rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-1"><FileUp className="h-3 w-3" />{q.name}<button type="button" aria-label={`Remove ${q.name}`} onClick={() => setQueue((l) => l.filter((x) => x !== q))} className="text-slate-400 hover:text-red-600"><X className="h-3 w-3" /></button></li>)}
          </ul>
        )}
        {uploading && <p className="text-xs text-slate-500">{uploading}</p>}
        {docsReady === false && <p className="text-xs text-amber-700 dark:text-amber-400">Original files aren't being kept yet: only their text is read. Choose a documents folder in <Link to="/preferences" className="underline">Preferences</Link> to keep the PDFs and photos on your NAS.</p>}
        {presetTrip && <p className="text-xs text-slate-500">Opened from <span className="font-medium">{tripTitle(presetTrip) ?? "a trip"}</span>: new documents start on that trip. If one looks like it belongs elsewhere you'll see a warning, and you can move it below.</p>}
      </Card>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {items && !items.length && <p className="text-sm text-slate-500">Nothing waiting. Add a document above{info.configured ? ", or forward an email to the address above" : ""}.</p>}
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
                <div className="flex items-center gap-1 text-xs text-slate-500">{i.source === "upload" ? <><Upload className="h-3 w-3" />Added</> : <><Mail className="h-3 w-3" />{i.fromAddr}</>} · {new Date(i.receivedAt).toLocaleString()}</div>
                {(() => {
                  const ps = i.parsed && i.parsed.tripId === choice[i.id] ? i.parsed.sources.filter((x) => x.category !== "irrelevant" || x.error || x.proposals.length || x === i.parsed!.sources[0]) : null;
                  if (reading === i.id) return <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />Reading…</p>;
                  if (!ps) return <p className="mt-1 text-xs text-slate-400">{choice[i.id] ? "Not read yet." : "Choose a trip below to see what's in this document."}</p>;
                  const nothingNew = ps.every((x) => !x.error && (x.alreadyImported || x.proposals.every((p) => p.action === "duplicate")));
                  return (
                    <div className="mt-2 space-y-2">
                      {nothingNew && <p className="text-xs font-medium text-green-700 dark:text-green-400">Nothing new: everything in this document is already on the trip.</p>}
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
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                  <button type="button" onClick={() => viewOriginal(i)} className="text-brand-600 hover:underline">{i.source === "upload" ? "View text" : "View original"}</button>
                  {i.documents?.map((d) => <button type="button" key={d.id} onClick={() => setViewing(d)} className="flex items-center gap-1 text-brand-600 hover:underline"><Paperclip className="h-3 w-3" />{d.name}</button>)}
                </div>
                <div className="mt-2 rounded-md bg-slate-50 dark:bg-slate-900 px-3 py-2 text-xs">
                  {choice[i.id] && mismatchOf(i) ? (
                    <span className="flex flex-wrap items-center gap-2 text-amber-800 dark:text-amber-300">
                      <span>This looks like it's for <span className="font-semibold">{mismatchOf(i)!.place ?? "another destination"}</span>, not {tripTitle(choice[i.id]) ?? "this trip"}.</span>
                      {mismatchOf(i)!.otherTrip
                        ? <button type="button" onClick={() => pick(i.id, mismatchOf(i)!.otherTrip!.id)} className="font-medium text-brand-600 hover:underline">Move to {mismatchOf(i)!.otherTrip!.title}</button>
                        : <button type="button" onClick={() => setNewTrip((m) => ({ ...m, [i.id]: { title: `Trip to ${mismatchOf(i)!.place ?? ""}`.trim(), place: mismatchOf(i)!.place, startDate: null, endDate: null } }))} className="font-medium text-brand-600 hover:underline">Create a trip for {mismatchOf(i)!.place ?? "it"}</button>}
                    </span>
                  ) : choice[i.id] ? <span>Trip: <span className="font-semibold">{tripTitle(choice[i.id]) ?? "…"}</span>{choice[i.id] === i.suggestedTripId && i.suggestionNote ? <span className="text-slate-500"> · {i.suggestionNote}</span> : null}</span>
                    : i.newTripHint ? <span className="flex flex-wrap items-center gap-2">No existing trip fits. Suggested: <span className="font-semibold">{i.newTripHint.title}</span>{i.newTripHint.startDate && <span className="text-slate-500">{i.newTripHint.startDate}{i.newTripHint.endDate ? ` → ${i.newTripHint.endDate}` : ""}</span>}
                      <button type="button" onClick={() => pick(i.id, "__new")} className="font-medium text-brand-600 hover:underline">Create this trip</button></span>
                    : <span className="text-slate-500">No trip matched. Choose one below or create a new trip.</span>}
                </div>
                {newTrip[i.id] && (
                  <div className="mt-2 flex flex-wrap items-end gap-2 rounded-md border border-slate-200 dark:border-slate-800 p-2 text-xs">
                    <label className="flex min-w-[14rem] flex-1 flex-col gap-0.5">Trip name<Input value={newTrip[i.id].title} onChange={(e) => setNewTrip((m) => ({ ...m, [i.id]: { ...m[i.id], title: e.target.value } }))} placeholder="Trip to …" /></label>
                    <label className="flex flex-col gap-0.5">Start<Input type="date" value={newTrip[i.id].startDate ?? ""} onChange={(e) => setNewTrip((m) => ({ ...m, [i.id]: { ...m[i.id], startDate: e.target.value || null } }))} /></label>
                    <label className="flex flex-col gap-0.5">End<Input type="date" value={newTrip[i.id].endDate ?? ""} onChange={(e) => setNewTrip((m) => ({ ...m, [i.id]: { ...m[i.id], endDate: e.target.value || null } }))} /></label>
                    <Button onClick={() => createTrip(i.id)} disabled={!newTrip[i.id].title.trim() || reading === i.id}><Plus className="h-4 w-4 mr-1" />Create trip</Button>
                    <Button variant="ghost" onClick={() => setNewTrip((m) => { const n = { ...m }; delete n[i.id]; return n; })}>Cancel</Button>
                  </div>
                )}
                {needsDay1(i.id) && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <span>This itinerary counts days (Day 1, Day 2…). <span className="font-medium">Day 1 is</span></span>
                    <span className="w-44"><Input type="date" value={day1[i.id] ?? ""} onChange={(e) => setDay1((m) => ({ ...m, [i.id]: e.target.value }))} /></span>
                    {!day1[i.id] && <span className="text-amber-700 dark:text-amber-400">Set the date of Day 1 so the days land on the right dates.</span>}
                  </div>
                )}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="order-last ml-auto flex gap-2">{i.source !== "upload" && <Button variant="secondary" onClick={() => ignoreSender(i)} disabled={busyId === i.id}>Ignore sender</Button>}<Button variant="secondary" onClick={() => dismiss(i.id)}><Trash2 className="h-4 w-4 mr-1.5" />Discard</Button></span>
              <Select value={choice[i.id] ?? ""} onChange={(e) => pick(i.id, e.target.value)} className="max-w-xs">
                <option value="">Choose a trip…</option>
                {trips.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                <option value="__new">+ New trip…</option>
              </Select>
              {i.parsed && i.parsed.tripId === choice[i.id] && i.parsed.sources.every((x) => !x.error && (x.alreadyImported || x.proposals.every((p) => p.action === "duplicate")))
                ? <Button onClick={() => { api.post(`/inbox/${i.id}/filed`, { tripId: choice[i.id] }).catch(() => {}).then(load); }}>Mark as done</Button>
                : <Button onClick={() => open(i.id)} disabled={!choice[i.id] || reading === i.id || (needsDay1(i.id) && !day1[i.id])}>Import</Button>}
            </div>
          </Card>
        ))}
      </div>
      {(filteredCount > 0 || showFiltered) && (
        <div className="pt-2">
          <button type="button" onClick={() => setShowFiltered((v) => !v)} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
            {showFiltered ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}Filtered ({filteredCount})
          </button>
          {showFiltered && (
            <Card className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
              <p className="px-4 py-2 text-xs text-slate-500">Newsletters, promotions, mail that isn't about a trip, and blocked senders. Kept for 30 days, then deleted.</p>
              {filtered?.items.map((f) => (
                <div key={f.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{f.subject}</div>
                    <div className="truncate text-xs text-slate-500">{f.fromAddr} · {new Date(f.receivedAt).toLocaleDateString()}{f.filterReason ? ` · ${f.filterReason}` : ""}</div>
                  </div>
                  <Button variant="secondary" disabled={busyId === f.id} onClick={() => act(f.id, () => api.post(`/inbox/${f.id}/restore`))}>{busyId === f.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "Not noise, move to Inbox"}</Button>
                </div>
              ))}
              {filtered && !filtered.items.length && <p className="px-4 py-3 text-xs text-slate-400">Nothing filtered.</p>}
              {filtered && filtered.blocked.length > 0 && (
                <div className="px-4 py-2">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Ignored senders</div>
                  <ul className="space-y-1">
                    {filtered.blocked.map((b) => (
                      <li key={b.id} className="flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate">{b.addr}</span>
                        <button type="button" onClick={() => act(b.id, () => api.delete(`/inbox/blocked/${b.id}`))} className="text-brand-600 hover:underline">Stop ignoring</button></li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          )}
        </div>
      )}
      {original && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-[6vh]" onClick={() => setOriginal(null)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-3xl">
            <Card className="p-5 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><h2 className="font-display text-lg font-semibold break-words">{original.subject}</h2>{original.fromAddr && <p className="text-xs text-slate-500">From {original.fromAddr}</p>}</div>
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
      <DocViewer doc={viewing} onClose={() => setViewing(null)} />
      {review && (
        <ImportCard tripId={review.tripId} initialResults={review.results} reload={() => {}} onClose={() => { setReview(null); load(); }}
          onApplied={() => { api.post(`/inbox/${review.id}/filed`, { tripId: review.tripId }).catch(() => {}); }} />
      )}
    </div>
  );
}
