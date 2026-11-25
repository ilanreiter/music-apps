import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FileText, Image as ImageIcon, Search } from "lucide-react";
import { api } from "../lib/api";
import DocViewer, { ViewDoc } from "../components/DocViewer";
import { Card, Input, PageHeader } from "../components/ui";

interface Doc { id: string; name: string; size: number; mime: string; createdAt: string; trip: { id: string; title: string; startDate: string | null } | null; waiting: boolean }
const kb = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Every original file the app keeps on the NAS, grouped by trip, each viewable in the app. */
export default function Documents() {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [params, setParams] = useSearchParams();
  const [viewing, setViewing] = useState<ViewDoc | null>(null);

  useEffect(() => { api.get<Doc[]>("/docs").then(setDocs).catch((e) => setError(e.message)); }, []);
  // /documents?open=<id> (from search) opens that file straight away
  useEffect(() => {
    const id = params.get("open");
    if (id && docs) { const d = docs.find((x) => x.id === id); if (d) setViewing(d); }
  }, [params, docs]);

  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = (docs ?? []).filter((d) => !f || d.name.toLowerCase().includes(f) || d.trip?.title.toLowerCase().includes(f));
    const m = new Map<string, { title: string; tripId: string | null; start: string; docs: Doc[] }>();
    for (const d of list) {
      const key = d.trip?.id ?? "_waiting";
      if (!m.has(key)) m.set(key, { title: d.trip?.title ?? "Waiting in Import", tripId: d.trip?.id ?? null, start: d.trip?.startDate ?? "", docs: [] });
      m.get(key)!.docs.push(d);
    }
    return [...m.values()].sort((a, b) => (a.tripId ? 1 : 0) - (b.tripId ? 1 : 0) || (b.start || "").localeCompare(a.start || ""));
  }, [docs, filter]);

  const close = () => { setViewing(null); if (params.get("open")) { params.delete("open"); setParams(params, { replace: true }); } };

  return (
    <div className="space-y-4">
      <PageHeader title="Documents" subtitle="Original PDFs, photos and email attachments kept on your NAS, by trip. Click one to view it here." />
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by file or trip name" className="pl-9" />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {docs && !docs.length && <Card className="p-4 text-sm text-slate-500">No documents yet. Files you add on the <Link to="/import" className="text-brand-600 hover:underline">Import</Link> page are kept here once a documents folder is chosen in <Link to="/preferences" className="text-brand-600 hover:underline">Preferences</Link>.</Card>}
      {groups.map((g) => (
        <div key={g.tripId ?? "_waiting"}>
          <h2 className="mb-1.5 text-sm font-semibold text-slate-600 dark:text-slate-300">
            {g.tripId ? <Link to={`/trips/${g.tripId}?tab=Documents`} className="hover:underline">{g.title}</Link> : g.title}
            <span className="ml-1.5 font-normal text-slate-400">{g.docs.length}</span>
          </h2>
          <Card className="divide-y divide-slate-100 dark:divide-slate-800">
            {g.docs.map((d) => (
              <button key={d.id} type="button" onClick={() => setViewing(d)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800/50">
                {d.mime.startsWith("image/") ? <ImageIcon className="h-4 w-4 shrink-0 text-slate-400" /> : <FileText className="h-4 w-4 shrink-0 text-slate-400" />}
                <span className="min-w-0 flex-1 truncate">{d.name}</span>
                <span className="text-xs text-slate-400">{kb(d.size)} · {new Date(d.createdAt).toLocaleDateString()}</span>
              </button>
            ))}
          </Card>
        </div>
      ))}
      <DocViewer doc={viewing} onClose={close} />
    </div>
  );
}
