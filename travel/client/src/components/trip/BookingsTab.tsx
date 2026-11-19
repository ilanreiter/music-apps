import { useState } from "react";
import { FileText, Loader2, Mail, Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { BookingAgent, BookingStatus, Trip, TripItem, TripItemType } from "../../types";
import { Badge, BadgeSelect, Button, Card, Input, Select, Textarea } from "../ui";
import { BOOKING_STATUSES, BOOKING_TONE, dateToIso, daysFromNow, isBookable, isBooked, isoToDate, money, readFileText, shortDate } from "./shared";

interface Extracted {
  type: TripItemType; title: string; provider: string | null; confirmationNo: string | null; startAt: string | null; endAt: string | null;
  location: string | null; cost: number | null; currency: string | null; freeCancelUntil: string | null; bookingUrl: string | null; notes: string | null; bookingStatus: BookingStatus;
}

const when = (i: TripItem) => {
  if (!i.startAt) return "—";
  const a = shortDate(i.startAt);
  return i.endAt && shortDate(i.endAt) !== a ? `${a} → ${shortDate(i.endAt)}` : a;
};

export default function BookingsTab({ trip, agents, reload }: { trip: Trip; agents: BookingAgent[]; reload: () => void }) {
  const items = trip.items.filter(isBookable);
  const [show, setShow] = useState<"" | "add" | "email">("");
  const [filter, setFilter] = useState<"all" | "todo" | "booked">("all");
  const base = `/trips/${trip.id}/items`;
  const patch = async (i: TripItem, body: Record<string, unknown>) => { await api.patch(`${base}/${i.id}`, body); reload(); };
  const remove = async (i: TripItem) => { if (confirm(`Remove “${i.title}”?`)) { await api.delete(`${base}/${i.id}`); reload(); } };

  const booked = items.filter(isBooked);
  const todo = items.filter((i) => !isBooked(i) && i.bookingStatus !== "CANCELLED");
  const total = booked.reduce((t, i) => t + (i.cost ?? 0), 0);
  const paid = booked.filter((i) => i.paid).reduce((t, i) => t + (i.cost ?? 0), 0);
  const shown = (filter === "todo" ? todo : filter === "booked" ? booked : items).slice().sort((a, b) => (a.startAt ?? "9").localeCompare(b.startAt ?? "9"));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Booked" value={`${booked.length} of ${items.length}`} />
        <Stat label="Still to book" value={String(todo.length)} tone={todo.length ? "text-amber-600" : undefined} />
        <Stat label="Booked cost" value={money(total)} />
        <Stat label="Paid so far" value={money(paid)} sub={total ? `${Math.round((paid / total) * 100)}%` : undefined} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden text-sm">
          {([["all", "All"], ["todo", "To book"], ["booked", "Booked"]] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setFilter(k)} className={`px-3 py-1.5 ${filter === k ? "bg-brand-600 text-white" : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300"}`}>{l}</button>
          ))}
        </div>
        <div className="flex-1" />
        <Button variant="secondary" onClick={() => setShow(show === "email" ? "" : "email")}><Mail className="h-4 w-4 mr-1.5" />Import from email</Button>
        <Button onClick={() => setShow(show === "add" ? "" : "add")}><Plus className="h-4 w-4 mr-1" />Add booking</Button>
      </div>

      {show === "email" && <EmailImport trip={trip} reload={() => { reload(); setShow(""); }} />}
      {show === "add" && <AddBooking trip={trip} agents={agents} done={() => { setShow(""); reload(); }} />}

      {!shown.length ? (
        <Card className="p-8 text-center text-sm text-slate-500">{items.length ? "Nothing matches this filter." : "No bookings yet. Add one, or paste a confirmation email to import flights, hotels and tours automatically."}</Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500 border-b border-slate-200 dark:border-slate-800">
              <tr><th className="p-3">Booking</th><th className="p-3">When</th><th className="p-3">Confirmation</th><th className="p-3 text-right">Cost</th><th className="p-3">Status</th><th className="p-3">Free cancel until</th><th className="p-3">Paid</th><th className="p-3" /></tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {shown.map((i) => {
                const left = i.freeCancelUntil && isBooked(i) ? daysFromNow(i.freeCancelUntil) : null;
                return (
                  <tr key={i.id} className={i.bookingStatus === "CANCELLED" ? "opacity-50" : ""}>
                    <td className="p-3 align-top">
                      <div className="font-medium">{i.title}</div>
                      <div className="text-xs text-slate-500">{[i.type[0] + i.type.slice(1).toLowerCase(), i.provider, i.bookingAgent?.name, i.location].filter(Boolean).join(" · ")}</div>
                      {i.bookingUrl && <a href={i.bookingUrl} target="_blank" rel="noreferrer" className="text-xs text-brand-600 hover:underline">Open booking</a>}
                    </td>
                    <td className="p-3 align-top whitespace-nowrap text-slate-600 dark:text-slate-300">{when(i)}</td>
                    <td className="p-3 align-top"><RefInput value={i.confirmationNo ?? ""} onSave={(v) => patch(i, { confirmationNo: v || null })} /></td>
                    <td className="p-3 align-top text-right tabular-nums">{money(i.cost, i.currency)}</td>
                    <td className="p-3 align-top"><BadgeSelect value={i.bookingStatus} tone={BOOKING_TONE[i.bookingStatus]} options={BOOKING_STATUSES} onChange={(v) => patch(i, { bookingStatus: v })} /></td>
                    <td className="p-3 align-top">
                      <input type="date" value={isoToDate(i.freeCancelUntil)} onChange={(e) => patch(i, { freeCancelUntil: dateToIso(e.target.value) })} aria-label="Free cancellation until"
                        className="rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 py-0.5 text-xs" />
                      {left != null && left >= 0 && left <= 30 && <div className="mt-0.5"><Badge tone={left <= 7 ? "red" : "amber"}>{left === 0 ? "today" : `${left}d left`}</Badge></div>}
                      {left != null && left < 0 && <div className="mt-0.5 text-[11px] text-slate-400">passed</div>}
                    </td>
                    <td className="p-3 align-top"><input type="checkbox" checked={!!i.paid} onChange={(e) => patch(i, { paid: e.target.checked })} aria-label={`Paid: ${i.title}`} className="h-4 w-4 accent-brand-600" /></td>
                    <td className="p-3 align-top"><button type="button" onClick={() => remove(i)} aria-label={`Remove ${i.title}`} className="text-slate-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <Card className="p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-0.5 text-xl font-display font-semibold tabular-nums ${tone ?? ""}`}>{value}{sub && <span className="ml-1.5 text-xs font-normal text-slate-400">{sub}</span>}</div>
    </Card>
  );
}

function RefInput({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  return <input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v.trim())} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    placeholder="Add reference" aria-label="Confirmation number" className="w-32 rounded border border-transparent hover:border-slate-200 dark:hover:border-slate-700 bg-transparent px-1.5 py-0.5 text-sm font-mono focus:border-brand-500 focus:outline-none" />;
}

function AddBooking({ trip, agents, done }: { trip: Trip; agents: BookingAgent[]; done: () => void }) {
  const [f, setF] = useState({ type: "TRANSPORT" as TripItemType, title: "", provider: "", confirmationNo: "", startAt: "", endAt: "", cost: "", status: "BOOKED" as BookingStatus, agent: "", freeCancel: "" });
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await api.post(`/trips/${trip.id}/items`, {
      type: f.type, title: f.title.trim(), provider: f.provider || null, confirmationNo: f.confirmationNo || null, bookingStatus: f.status,
      startAt: f.startAt ? new Date(f.startAt).toISOString() : null, endAt: f.endAt ? new Date(f.endAt).toISOString() : null,
      cost: f.cost ? parseFloat(f.cost) : null, bookingAgentId: f.agent || null, freeCancelUntil: dateToIso(f.freeCancel),
    });
    done();
  };
  const lbl = "block text-xs text-slate-500";
  return (
    <Card className="p-4">
      <form onSubmit={submit} className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <label className={lbl}>Type<Select value={f.type} onChange={(e) => set("type", e.target.value)}><option value="TRANSPORT">Transport</option><option value="STAY">Stay</option><option value="ACTIVITY">Activity</option><option value="OTHER">Other</option></Select></label>
        <label className={`${lbl} md:col-span-2`}>Title<Input required value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="Flight BOS → LIS" /></label>
        <label className={lbl}>Status<Select value={f.status} onChange={(e) => set("status", e.target.value)}>{BOOKING_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select></label>
        <label className={lbl}>Provider<Input value={f.provider} onChange={(e) => set("provider", e.target.value)} placeholder="Airline / hotel" /></label>
        <label className={lbl}>Confirmation #<Input value={f.confirmationNo} onChange={(e) => set("confirmationNo", e.target.value)} /></label>
        <label className={lbl}>Starts<Input type="datetime-local" value={f.startAt} onChange={(e) => set("startAt", e.target.value)} /></label>
        <label className={lbl}>Ends<Input type="datetime-local" value={f.endAt} onChange={(e) => set("endAt", e.target.value)} /></label>
        <label className={lbl}>Cost<Input type="number" step="0.01" value={f.cost} onChange={(e) => set("cost", e.target.value)} /></label>
        <label className={lbl}>Free cancel until<Input type="date" value={f.freeCancel} onChange={(e) => set("freeCancel", e.target.value)} /></label>
        <label className={lbl}>Booking agent<Select value={f.agent} onChange={(e) => set("agent", e.target.value)}><option value="">—</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></label>
        <div className="flex items-end"><Button type="submit" disabled={!f.title.trim()}>Add booking</Button></div>
      </form>
    </Card>
  );
}

function EmailImport({ trip, reload }: { trip: Trip; reload: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [found, setFound] = useState<Extracted[] | null>(null);
  const [pick, setPick] = useState<Set<number>>(new Set());

  const onFile = async (file?: File) => {
    if (!file) return;
    if (/\.pdf$/i.test(file.name)) { setError("PDFs can't be read here — open the PDF, copy its text and paste it below."); return; }
    setText(await readFileText(file)); setError("");
  };
  const parse = async () => {
    setBusy(true); setError(""); setFound(null);
    try {
      const r = await api.post<{ bookings: Extracted[] }>(`/trips/${trip.id}/import-bookings`, { rawText: text });
      const have = new Set(trip.items.map((i) => (i.confirmationNo ?? "").toLowerCase()).filter(Boolean));
      setFound(r.bookings);
      setPick(new Set(r.bookings.map((b, n) => (b.confirmationNo && have.has(b.confirmationNo.toLowerCase()) ? -1 : n)).filter((n) => n >= 0)));
      if (!r.bookings.length) setError("No bookings were found in that text.");
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  };
  const add = async () => {
    setBusy(true);
    try {
      for (const [n, b] of (found ?? []).entries()) {
        if (!pick.has(n)) continue;
        await api.post(`/trips/${trip.id}/items`, { ...b, bookingAgentId: null });
      }
      reload();
    } catch (e: any) { setError(e.message); setBusy(false); }
  };

  return (
    <Card className="p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Import bookings from email</h3>
        <p className="text-xs text-slate-500">Paste one or more confirmation emails or receipts (or upload an .eml / .txt / .html file). The AI pulls out flights, hotels, cars and tours, with confirmation numbers, dates and prices. You review before anything is added.</p>
      </div>
      {!found && (
        <>
          <Textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the email text here…" />
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
              <FileText className="h-4 w-4" />Upload file<input type="file" accept=".eml,.txt,.html,.htm,.md,text/*" hidden onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
            <Button onClick={parse} disabled={busy || text.trim().length < 10}>{busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}Find bookings</Button>
          </div>
        </>
      )}
      {found && found.length > 0 && (
        <>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-md border border-slate-200 dark:border-slate-800">
            {found.map((b, n) => (
              <li key={n} className="flex items-start gap-3 p-3 text-sm">
                <input type="checkbox" className="mt-1 h-4 w-4 accent-brand-600" checked={pick.has(n)} onChange={(e) => setPick((s) => { const x = new Set(s); e.target.checked ? x.add(n) : x.delete(n); return x; })} aria-label={`Add ${b.title}`} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{b.title} <Badge tone={b.type === "STAY" ? "purple" : b.type === "TRANSPORT" ? "blue" : "slate"}>{b.type.toLowerCase()}</Badge></div>
                  <div className="text-xs text-slate-500">{[b.provider, b.confirmationNo && `ref ${b.confirmationNo}`, b.startAt && shortDate(b.startAt) + (b.endAt ? ` → ${shortDate(b.endAt)}` : ""), b.cost != null && money(b.cost, b.currency), b.location].filter(Boolean).join(" · ")}</div>
                  {b.notes && <div className="text-xs text-slate-400">{b.notes}</div>}
                  {b.confirmationNo && trip.items.some((i) => i.confirmationNo?.toLowerCase() === b.confirmationNo!.toLowerCase()) && <div className="text-xs text-amber-600">Already on this trip (same confirmation number)</div>}
                </div>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button onClick={add} disabled={busy || !pick.size}>{busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}Add {pick.size} booking{pick.size === 1 ? "" : "s"}</Button>
            <Button variant="secondary" onClick={() => { setFound(null); setError(""); }}>Back</Button>
          </div>
        </>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </Card>
  );
}
