import { useCallback, useEffect, useState } from "react";
import { Loader2, Paperclip, RefreshCw, X } from "lucide-react";
import { api } from "../lib/api";
import { Trip } from "../types";
import ImportCard from "../components/trip/ImportCard";
import { Badge, Button, Card, PageHeader, Select } from "../components/ui";

interface Item { id: string; fromAddr: string; subject: string; receivedAt: string; preview: string; attachmentNames: string[]; suggestedTripId: string | null; suggestionNote: string | null }
interface Review { id: string; tripId: string; sources: { name: string; text: string; note?: string }[] }

export default function Inbox() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [info, setInfo] = useState<{ configured: boolean; address: string | null }>({ configured: true, address: null });
  const [trips, setTrips] = useState<Trip[]>([]);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [review, setReview] = useState<Review | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api.get<{ configured: boolean; address: string | null; items: Item[] }>("/inbox").then((r) => {
      setItems(r.items); setInfo({ configured: r.configured, address: r.address });
      setChoice((c) => { const n = { ...c }; r.items.forEach((i) => { if (!n[i.id] && i.suggestedTripId) n[i.id] = i.suggestedTripId; }); return n; });
    }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); api.get<Trip[]>("/trips").then(setTrips).catch(() => {}); }, [load]);

  const check = async () => {
    setChecking(true); setError("");
    try { await api.post("/inbox/poll"); load(); } catch (e: any) { setError(e.message); }
    setChecking(false);
  };
  const open = async (id: string) => {
    setError("");
    try { const r = await api.get<{ sources: Review["sources"] }>(`/inbox/${id}`); setReview({ id, tripId: choice[id], sources: r.sources }); }
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
                  {i.attachmentNames.length > 0 && <Badge tone="slate"><Paperclip className="inline h-3 w-3 mr-0.5" />{i.attachmentNames.length}</Badge>}
                </div>
                <div className="text-xs text-slate-500">{i.fromAddr} · {new Date(i.receivedAt).toLocaleString()}</div>
                <p className="mt-1 line-clamp-2 text-xs text-slate-500">{i.preview}</p>
                {i.suggestionNote && i.suggestedTripId && <p className="mt-1 text-[11px] text-slate-400">Suggested trip: {i.suggestionNote}</p>}
              </div>
              <button type="button" onClick={() => dismiss(i.id)} aria-label="Dismiss" title="Dismiss" className="text-slate-400 hover:text-red-600"><X className="h-4 w-4" /></button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Select value={choice[i.id] ?? ""} onChange={(e) => setChoice((c) => ({ ...c, [i.id]: e.target.value }))} className="max-w-xs">
                <option value="">Choose a trip…</option>
                {trips.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              </Select>
              <Button onClick={() => open(i.id)} disabled={!choice[i.id]}>Review & import</Button>
            </div>
          </Card>
        ))}
      </div>
      {review && (
        <ImportCard tripId={review.tripId} initialSources={review.sources} reload={() => {}} onClose={() => { setReview(null); load(); }}
          onApplied={() => { api.post(`/inbox/${review.id}/filed`, { tripId: review.tripId }).catch(() => {}); }} />
      )}
    </div>
  );
}
