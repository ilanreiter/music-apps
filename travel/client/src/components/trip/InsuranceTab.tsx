import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { FileText, Pencil, Phone, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import DocViewer, { ViewDoc } from "../DocViewer";
import SourceLink from "../SourceLink";
import { Button, Card, Input, Label, Textarea } from "../ui";

interface Policy {
  id: string; provider: string; planName: string | null; policyNumber: string | null; coverageStart: string | null; coverageEnd: string | null;
  travelers: string[]; emergencyPhone: string | null; claimsContact: string | null; url: string | null; notes: string | null; sourceInboxId?: string | null;
}
interface Doc { id: string; name: string; mime: string }
type Form = { provider: string; planName: string; policyNumber: string; coverageStart: string; coverageEnd: string; travelers: string; emergencyPhone: string; claimsContact: string; url: string; notes: string };

const blank: Form = { provider: "", planName: "", policyNumber: "", coverageStart: "", coverageEnd: "", travelers: "", emergencyPhone: "", claimsContact: "", url: "", notes: "" };
const day = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : null);
// files on the trip that look like policy documents
const looksLikePolicy = (name: string) => /insur|polic|cover|certificate|protect|zurich|allianz|travel ?guard|seven ?corners|world ?nomads|img |aig/i.test(name);

/** Travel-insurance policies for a trip, with their key contacts up front and the policy documents one click away. */
export default function InsuranceTab({ tripId }: { tripId: string }) {
  const [policies, setPolicies] = useState<Policy[] | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [editing, setEditing] = useState<string | null>(null);   // policy id, or "new"
  const [form, setForm] = useState<Form>(blank);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState<ViewDoc | null>(null);

  const load = useCallback(() => {
    api.get<Policy[]>(`/trips/${tripId}/insurance`).then(setPolicies).catch((e) => setError(e.message));
    api.get<Doc[]>(`/docs/trip/${tripId}`).then((d) => setDocs(d.filter((x) => looksLikePolicy(x.name)))).catch(() => {});
  }, [tripId]);
  useEffect(load, [load]);

  const startEdit = (p?: Policy) => {
    setEditing(p?.id ?? "new");
    setForm(p ? { provider: p.provider, planName: p.planName ?? "", policyNumber: p.policyNumber ?? "", coverageStart: p.coverageStart?.slice(0, 10) ?? "", coverageEnd: p.coverageEnd?.slice(0, 10) ?? "",
      travelers: p.travelers.join(", "), emergencyPhone: p.emergencyPhone ?? "", claimsContact: p.claimsContact ?? "", url: p.url ?? "", notes: p.notes ?? "" } : blank);
  };
  const save = async () => {
    const body = { provider: form.provider.trim(), planName: form.planName || null, policyNumber: form.policyNumber || null, coverageStart: form.coverageStart || null, coverageEnd: form.coverageEnd || null,
      travelers: form.travelers.split(",").map((s) => s.trim()).filter(Boolean), emergencyPhone: form.emergencyPhone || null, claimsContact: form.claimsContact || null, url: form.url || null, notes: form.notes || null };
    setError("");
    try { editing === "new" ? await api.post(`/trips/${tripId}/insurance`, body) : await api.patch(`/trips/${tripId}/insurance/${editing}`, body); setEditing(null); load(); }
    catch (e: any) { setError(e.message); }
  };
  const remove = async (p: Policy) => {
    if (!window.confirm(`Delete the ${p.provider} policy from this trip? Its documents stay on the NAS.`)) return;
    await api.delete(`/trips/${tripId}/insurance/${p.id}`).catch((e) => setError(e.message)); load();
  };
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  if (!policies) return error ? <p className="text-sm text-red-600">{error}</p> : <p className="text-sm text-slate-400">Loading…</p>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500">Travel-insurance policies for this trip. Importing a policy document adds it here (<Link to={`/import?trip=${tripId}`} className="text-brand-600 hover:underline">Import</Link>).</p>
        {editing === null && <Button onClick={() => startEdit()}><Plus className="h-4 w-4 mr-1.5" />Add policy</Button>}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {editing !== null && (
        <Card className="p-4 space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <div><Label>Insurer *</Label><Input value={form.provider} onChange={set("provider")} placeholder="e.g. Zurich / Cover-More" /></div>
            <div><Label>Plan</Label><Input value={form.planName} onChange={set("planName")} /></div>
            <div><Label>Policy number</Label><Input value={form.policyNumber} onChange={set("policyNumber")} /></div>
            <div><Label>Coverage from</Label><Input type="date" value={form.coverageStart} onChange={set("coverageStart")} /></div>
            <div><Label>Coverage to</Label><Input type="date" value={form.coverageEnd} onChange={set("coverageEnd")} /></div>
            <div><Label>Insured travelers (comma-separated)</Label><Input value={form.travelers} onChange={set("travelers")} /></div>
            <div><Label>24/7 emergency assistance</Label><Input value={form.emergencyPhone} onChange={set("emergencyPhone")} /></div>
            <div><Label>Claims contact</Label><Input value={form.claimsContact} onChange={set("claimsContact")} /></div>
            <div><Label>Policy web page</Label><Input value={form.url} onChange={set("url")} placeholder="https://…" /></div>
          </div>
          <div><Label>Coverage notes</Label><Textarea rows={6} value={form.notes} onChange={set("notes")} placeholder="Key coverage, limits and conditions" /></div>
          <div className="flex gap-2"><Button onClick={save} disabled={!form.provider.trim()}>Save policy</Button><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button></div>
        </Card>
      )}

      {policies.length === 0 && editing === null && <Card className="p-4 text-sm text-slate-500">No insurance policy on this trip yet.</Card>}
      {policies.map((p) => (
        <Card key={p.id} className="p-4 space-y-3">
          <div className="flex flex-wrap items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{p.provider}{p.planName && <span className="font-normal text-slate-500"> · {p.planName}</span>} <SourceLink inboxId={p.sourceInboxId} className="ml-1 align-middle font-normal" /></div>
              <div className="text-xs text-slate-500">{[p.policyNumber && `Policy ${p.policyNumber}`, (p.coverageStart || p.coverageEnd) && `Covered ${day(p.coverageStart) ?? "?"} – ${day(p.coverageEnd) ?? "?"}`, p.travelers.length && p.travelers.join(", ")].filter(Boolean).join(" · ")}</div>
            </div>
            <button type="button" onClick={() => startEdit(p)} className="text-slate-400 hover:text-brand-600" aria-label="Edit policy"><Pencil className="h-4 w-4" /></button>
            <button type="button" onClick={() => remove(p)} className="text-slate-400 hover:text-red-600" aria-label="Delete policy"><Trash2 className="h-4 w-4" /></button>
          </div>
          {(p.emergencyPhone || p.claimsContact || p.url) && (
            <div className="grid gap-2 text-sm md:grid-cols-3">
              {p.emergencyPhone && <div className="rounded-md bg-red-50 px-3 py-2 dark:bg-red-950/30"><div className="text-[11px] font-semibold uppercase tracking-wide text-red-700 dark:text-red-400">Emergency assistance</div><div className="flex items-start gap-1.5"><Phone className="mt-0.5 h-3.5 w-3.5 shrink-0" />{p.emergencyPhone}</div></div>}
              {p.claimsContact && <div className="rounded-md bg-slate-50 px-3 py-2 dark:bg-slate-800/50"><div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Claims</div>{p.claimsContact}</div>}
              {p.url && <div className="rounded-md bg-slate-50 px-3 py-2 dark:bg-slate-800/50"><div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Policy page</div><a href={p.url} target="_blank" rel="noreferrer" className="break-all text-brand-600 hover:underline">{p.url}</a></div>}
            </div>
          )}
          {p.notes && <ul className="list-disc space-y-0.5 pl-5 text-sm text-slate-700 dark:text-slate-300">{p.notes.split(/\n+|\s+-\s+(?=[A-Z])/).map((l) => l.replace(/^[-•*]\s*/, "").trim()).filter(Boolean).map((l, k) => <li key={k}>{l}</li>)}</ul>}
        </Card>
      ))}

      {docs.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-sm font-semibold text-slate-600 dark:text-slate-300">Policy documents</h3>
          <Card className="divide-y divide-slate-100 dark:divide-slate-800">
            {docs.map((d) => (
              <button key={d.id} type="button" onClick={() => setViewing(d)} className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800/50">
                <FileText className="h-4 w-4 text-slate-400" />{d.name}
              </button>
            ))}
          </Card>
        </div>
      )}
      <DocViewer doc={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
