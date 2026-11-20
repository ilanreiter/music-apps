import { useEffect, useState } from "react";
import { FileText, Loader2, Mail, Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { BookingAgent, BookingStatus, Traveler, Trip, TripItem, TripItemType } from "../../types";
import { Badge, BadgeSelect, Button, Card, Input, Select, Textarea } from "../ui";
import { BOOKING_STATUSES, BOOKING_TONE, dateToIso, daysFromNow, isBookable, isBooked, isoToDate, money, readDocumentText, shortDate } from "./shared";

interface Extracted {
  type: TripItemType; title: string; provider: string | null; confirmationNo: string | null; startAt: string | null; endAt: string | null;
  location: string | null; cost: number | null; currency: string | null; freeCancelUntil: string | null; bookingUrl: string | null; notes: string | null; bookingStatus: BookingStatus; traveler?: string | null;
}

const PLACEHOLDER_END = Date.UTC(2001, 0, 1);
const when = (i: TripItem, dated: boolean) => {
  if (!i.startAt) return "—";
  // Items planned before the trip had dates sit on a placeholder calendar: show "Day N" instead of a meaningless 2000 date.
  if (!dated && new Date(i.startAt).getTime() < PLACEHOLDER_END) {
    const day = (iso: string) => Math.floor((new Date(iso).getTime() - Date.UTC(2000, 0, 1)) / 86_400_000) + 1;
    return i.endAt && day(i.endAt) !== day(i.startAt) ? `Day ${day(i.startAt)} → Day ${day(i.endAt)}` : `Day ${day(i.startAt)}`;
  }
  const a = shortDate(i.startAt);
  return i.endAt && shortDate(i.endAt) !== a ? `${a} → ${shortDate(i.endAt)}` : a;
};

const nums = (s: string) => new Set(s.match(/\d{3,4}/g) ?? []);
const sameDay = (a?: string | null, c?: string | null) => !a || !c || a.slice(0, 10) === c.slice(0, 10);
/**
 * An imported booking that is really an item already on the trip: the same flight (matching flight number, same day) or
 * the single not-yet-booked lodging item. `already` means that item is booked already, so importing it again would duplicate it.
 */
function matchExisting(trip: Trip, b: Extracted): { item: TripItem; already: boolean } | undefined {
  const booked = (i: TripItem) => i.bookingStatus === "BOOKED" || i.bookingStatus === "CONFIRMED" || !!i.confirmationNo;
  // One ticket per traveler for the same flight is normal: a different traveler or a different reference is a different booking.
  const same = trip.items.filter((i) => i.type === b.type
    && !(b.traveler && i.traveler && b.traveler.toLowerCase() !== i.traveler.toLowerCase())
    && !(b.confirmationNo && i.confirmationNo && b.confirmationNo !== i.confirmationNo));
  if (b.type === "TRANSPORT") {
    const n = nums(b.title);
    const hit = same.filter((i) => [...nums(i.title)].some((x) => n.has(x)) && sameDay(i.startAt, b.startAt));
    const open = hit.find((i) => !booked(i));
    if (open) return { item: open, already: false };
    return hit[0] ? { item: hit[0], already: true } : undefined;
  }
  if (b.type === "STAY") {
    const open = same.filter((i) => !booked(i));
    if (open.length === 1) return { item: open[0], already: false };
    const dup = same.find((i) => i.title.toLowerCase() === b.title.toLowerCase() && sameDay(i.startAt, b.startAt));
    return dup ? { item: dup, already: true } : undefined;
  }
  return undefined;
}

/** Groups of identical items (same type, title and start) — keeps the most complete one, offers to remove the rest. */
function duplicateIds(items: TripItem[]): string[] {
  const groups = new Map<string, TripItem[]>();
  for (const i of items) {
    if (!isBookable(i)) continue;
    const k = `${i.type}|${i.title.trim().toLowerCase()}|${i.startAt ?? ""}|${i.confirmationNo ?? ""}|${(i.traveler ?? "").toLowerCase()}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  const score = (i: TripItem) => (i.confirmationNo ? 4 : 0) + (isBooked(i) ? 2 : 0) + (i.cost != null ? 1 : 0) + (i.notes ? 1 : 0);
  return [...groups.values()].filter((g) => g.length > 1).flatMap((g) => g.slice().sort((a, c) => score(c) - score(a)).slice(1).map((i) => i.id));
}

export default function BookingsTab({ trip, agents, reload, openPanel, onPanelOpened }: { trip: Trip; agents: BookingAgent[]; reload: () => void; openPanel?: "" | "email"; onPanelOpened?: () => void }) {
  const items = trip.items.filter(isBookable);
  const [show, setShow] = useState<"" | "add" | "email">(openPanel || "email");
  const [people, setPeople] = useState<string[]>([]);
  useEffect(() => { api.get<Traveler[]>("/travelers").then((l) => setPeople(l.map((t) => t.name))).catch(() => {}); }, []);
  useEffect(() => { if (openPanel) { setShow(openPanel); onPanelOpened?.(); } }, [openPanel]);
  const [filter, setFilter] = useState<"all" | "todo" | "booked">("all");
  const base = `/trips/${trip.id}/items`;
  const patch = async (i: TripItem, body: Record<string, unknown>) => { await api.patch(`${base}/${i.id}`, body); reload(); };
  const remove = async (i: TripItem) => { if (confirm(`Remove “${i.title}”?`)) { await api.delete(`${base}/${i.id}`); reload(); } };

  const dupes = duplicateIds(items);
  const removeDupes = async () => { for (const id of dupes) await api.delete(`${base}/${id}`); reload(); };
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

      <datalist id="trip-travelers">{people.map((n) => <option key={n} value={n} />)}</datalist>
      {dupes.length > 0 && (
        <Card className="p-3 border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="flex-1 text-amber-800 dark:text-amber-300">{dupes.length} duplicate item{dupes.length === 1 ? "" : "s"} found (same title, time, reference and traveler).</span>
            <Button variant="secondary" onClick={removeDupes}>Remove {dupes.length} duplicate{dupes.length === 1 ? "" : "s"}</Button>
          </div>
        </Card>
      )}
      {show === "email" && <EmailImport trip={trip} reload={reload} />}
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
                      <div className="mt-0.5 flex items-center gap-1 text-xs text-slate-500">for
                        <RefInput value={i.traveler ?? ""} onSave={(v) => patch(i, { traveler: v || null })} placeholder="Add traveler name" label="Traveler" list="trip-travelers" wide />
                      </div>
                      {i.bookingUrl && <a href={i.bookingUrl} target="_blank" rel="noreferrer" className="text-xs text-brand-600 hover:underline">Open booking</a>}
                    </td>
                    <td className="p-3 align-top whitespace-nowrap text-slate-600 dark:text-slate-300">{when(i, !!trip.startDate)}</td>
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

function RefInput({ value, onSave, placeholder = "Add reference", label = "Confirmation number", list, wide }: { value: string; onSave: (v: string) => void; placeholder?: string; label?: string; list?: string; wide?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v.trim())} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    placeholder={placeholder} aria-label={label} list={list}
    className={`${wide ? "w-40" : "w-32 font-mono"} rounded border border-transparent hover:border-slate-200 dark:hover:border-slate-700 bg-transparent px-1.5 py-0.5 text-sm focus:border-brand-500 focus:outline-none`} />;
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
  const [note, setNote] = useState("");
  const [found, setFound] = useState<Extracted[] | null>(null);
  const [pick, setPick] = useState<Set<number>>(new Set());

  const [over, setOver] = useState(false);
  const onFiles = async (files?: FileList | File[] | null) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    setBusy(true); setError(""); setNote("");
    const notes: string[] = [];
    for (const file of list) {
      try {
        const r = await readDocumentText(file);
        setText((prev) => (prev ? prev + "\n\n" : "") + r.text);
        if (r.note) notes.push(`${file.name}: ${r.note}`);
      } catch (e: any) { setError(`${file.name}: ${e.message}`); }
    }
    if (notes.length) setNote(notes.join(" "));
    setBusy(false);
  };
  const parse = async () => {
    setBusy(true); setError(""); setFound(null);
    try {
      const r = await api.post<{ bookings: Extracted[] }>(`/trips/${trip.id}/import-bookings`, { rawText: text });
      const have = new Set(trip.items.map((i) => (i.confirmationNo ?? "").toLowerCase()).filter(Boolean));
      setFound(r.bookings);
      setPick(new Set(r.bookings.map((b, n) => ((b.confirmationNo && have.has(b.confirmationNo.toLowerCase())) || matchExisting(trip, b)?.already ? -1 : n)).filter((n) => n >= 0)));
      if (!r.bookings.length) setError("No bookings were found in that text.");
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  };
  const [done, setDone] = useState("");
  const add = async () => {
    setBusy(true); setError(""); setNote(""); setDone("");
    try {
      const chosen = (found ?? []).filter((_, n) => pick.has(n));
      let updated = 0;
      for (const b of chosen) {
        const mm = matchExisting(trip, b);
        const m = mm && !mm.already ? mm.item : undefined;
        if (m) { updated++; await api.patch(`/trips/${trip.id}/items/${m.id}`, { ...b, notes: [m.notes, b.notes].filter(Boolean).join(" · ") || null }); }
        else await api.post(`/trips/${trip.id}/items`, { ...b, bookingAgentId: null });
      }
      // A trip without dates takes them from what was just booked (first departure to last arrival / check-out).
      let datesSet = "";
      const starts = chosen.map((b) => b.startAt).filter(Boolean) as string[];
      if (!trip.startDate && starts.length) {
        // Noon UTC of the local calendar date, so the date never shifts with the timezone.
        const midnight = (iso: string) => { const d = new Date(iso); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 12)); };
        const first = midnight(starts.sort()[0]);
        const ends = chosen.map((b) => b.endAt ?? b.startAt).filter(Boolean) as string[];
        const last = midnight(ends.sort().slice(-1)[0]);
        await api.patch(`/trips/${trip.id}`, { startDate: first.toISOString(), endDate: last.toISOString(), durationNights: Math.max(0, Math.round((last.getTime() - first.getTime()) / 86_400_000)) });
        datesSet = ` Trip dates set to ${first.toLocaleDateString(undefined, { timeZone: "UTC" })} – ${last.toLocaleDateString(undefined, { timeZone: "UTC" })}.`;
      }
      setDone(`${chosen.length - updated} added, ${updated} updated.${datesSet} Paste another email to add more.`);
      setFound(null); setText(""); setPick(new Set());
      reload();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  };

  return (
    <div
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={(e) => { setOver(false); if (e.dataTransfer.files.length) { e.preventDefault(); onFiles(e.dataTransfer.files); } }}>
    <Card className={`p-4 space-y-3 transition-colors ${over ? "ring-2 ring-brand-500" : ""}`}>
      <div>
        <h3 className="text-sm font-semibold">Import bookings from email</h3>
        <p className="text-xs text-slate-500">Paste one or more confirmation emails or receipts (or drag files here, or upload PDFs, .eml, .txt and .html files; scanned PDFs are read with OCR). You can also drag selected email text into the box. The AI pulls out flights, hotels, cars and tours, with confirmation numbers, dates and prices. After you click Import pasted text, you see the bookings it found and confirm them before anything is added.</p>
      </div>
      {!found && (
        <>
          <Textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the email text here, or drop files / selected text onto this box…" />
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
              <FileText className="h-4 w-4" />Choose a file instead<input type="file" multiple accept=".pdf,.eml,.txt,.html,.htm,.md,application/pdf,text/*" hidden onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }} />
            </label>
            <Button onClick={parse} disabled={busy || text.trim().length < 10}>{busy ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Reading…</> : "Import pasted text"}</Button>
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
                  <div className="text-xs text-slate-500">{[b.traveler && `for ${b.traveler}`, b.provider, b.confirmationNo && `ref ${b.confirmationNo}`, b.startAt && shortDate(b.startAt) + (b.endAt ? ` → ${shortDate(b.endAt)}` : ""), b.cost != null && money(b.cost, b.currency), b.location].filter(Boolean).join(" · ")}</div>
                  {b.notes && <div className="text-xs text-slate-400">{b.notes}</div>}
                  {(() => { const m = matchExisting(trip, b); return m && (m.already
                    ? <div className="text-xs text-amber-600">Looks like it is already on this trip (“{m.item.title}”). Unticked so it isn't added twice. Tick it to add it as a separate booking, e.g. another traveler's ticket.</div>
                    : <div className="text-xs text-brand-600">Updates the existing itinerary item “{m.item.title}” instead of adding a new one</div>); })()}
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
      {done && <p className="text-xs text-green-600">{done}</p>}
      {note && <p className="text-xs text-amber-600">{note}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </Card>
    </div>
  );
}
