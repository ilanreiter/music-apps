import { useState } from "react";
import SourceLink from "../SourceLink";
import { Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { ChecklistItem, Trip } from "../../types";
import { Button, Card, Input, Select } from "../ui";
import { dateToIso, daysFromNow, isoToDate } from "./shared";

export const CHECKLIST_CATEGORIES = ["Documents", "Health & insurance", "Money", "Bookings", "Packing", "Home & other"];

export default function ChecklistTab({ trip, reload }: { trip: Trip; reload: () => void }) {
  const items = trip.checklist ?? [];
  const [text, setText] = useState("");
  const [category, setCategory] = useState(CHECKLIST_CATEGORIES[0]);
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const done = items.filter((i) => i.done).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  const base = `/trips/${trip.id}/checklist`;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    await api.post(base, { text: text.trim(), category, dueDate: dateToIso(due) });
    setText(""); setDue(""); reload();
  };
  const patch = async (i: ChecklistItem, body: Partial<{ done: boolean; dueDate: string | null; text: string }>) => { await api.patch(`${base}/${i.id}`, body); reload(); };
  const remove = async (i: ChecklistItem) => { await api.delete(`${base}/${i.id}`); reload(); };
  const generate = async () => {
    setBusy(true); setError(""); setNote("");
    try {
      const r = await api.post<{ added: number; usedProfiles: number }>(`${base}/generate`, {});
      setNote(`Added ${r.added} suggested item${r.added === 1 ? "" : "s"}, tailored with ${r.usedProfiles} traveler profile${r.usedProfiles === 1 ? "" : "s"}`);
      reload();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  };

  const groups = CHECKLIST_CATEGORIES.map((c) => ({ c, list: items.filter((i) => (i.category ?? "Home & other") === c) }))
    .concat([{ c: "Other", list: items.filter((i) => i.category && !CHECKLIST_CATEGORIES.includes(i.category)) }])
    .filter((g) => g.list.length);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[10rem] flex-1">
            <div className="flex justify-between text-sm"><span className="font-medium">Checklist</span><span className="tabular-nums text-slate-500">{done} of {items.length} done</span></div>
            <div className="mt-1.5 h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden"><div className="h-full bg-brand-600 transition-all" style={{ width: `${pct}%` }} /></div>
          </div>
          <Button variant="secondary" onClick={generate} disabled={busy} title="Suggests visa, insurance, packing and other tasks using your traveler profiles">
            {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1.5" />}Suggest with AI
          </Button>
        </div>
        {note && <p className="mt-2 text-xs text-slate-500">{note}</p>}
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      </Card>

      <form onSubmit={add} className="flex flex-wrap items-center gap-2">
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a task, e.g. Renew passport" className="min-w-[14rem] flex-1" />
        <div className="w-44"><Select value={category} onChange={(e) => setCategory(e.target.value)}>{CHECKLIST_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</Select></div>
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" className="rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-sm" />
        <Button type="submit" disabled={!text.trim()}><Plus className="h-4 w-4 mr-1" />Add</Button>
      </form>

      {!items.length && <Card className="p-8 text-center text-sm text-slate-500">No tasks yet. Add your own, or let the AI suggest a starting list for this trip.</Card>}
      {groups.map((g) => (
        <Card key={g.c} className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-600 dark:text-slate-300">{g.c} <span className="font-normal text-slate-400">· {g.list.filter((i) => i.done).length}/{g.list.length}</span></h3>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {g.list.map((i) => {
              const overdue = !i.done && i.dueDate && daysFromNow(i.dueDate) < 0;
              return (
                <li key={i.id} className="flex items-center gap-3 py-2 text-sm">
                  <input type="checkbox" checked={i.done} onChange={(e) => patch(i, { done: e.target.checked })} className="h-4 w-4 accent-brand-600" aria-label={`Done: ${i.text}`} />
                  <span className={`flex-1 ${i.done ? "line-through text-slate-400" : ""}`}>{i.text} <SourceLink inboxId={i.sourceInboxId} className="ml-1" /></span>
                  <input type="date" value={isoToDate(i.dueDate)} onChange={(e) => patch(i, { dueDate: dateToIso(e.target.value) })} aria-label="Due date"
                    className={`rounded border px-1.5 py-0.5 text-xs bg-white dark:bg-slate-900 ${overdue ? "border-red-400 text-red-600" : "border-slate-200 dark:border-slate-700 text-slate-500"}`} />
                  <button type="button" onClick={() => remove(i)} aria-label={`Delete ${i.text}`} className="text-slate-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                </li>
              );
            })}
          </ul>
        </Card>
      ))}
    </div>
  );
}
