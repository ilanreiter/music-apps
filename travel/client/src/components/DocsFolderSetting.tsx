import { useEffect, useState } from "react";
import { ChevronRight, Folder, FolderPlus, HardDrive, Loader2, X } from "lucide-react";
import { api } from "../lib/api";
import { Button, Card, Input, Label, Select } from "./ui";

interface DocsSettings { folder: string | null; naming: "month" | "title"; rootLabel: string; available: boolean }

/** Preferences card: which NAS folder keeps the original documents, and how each trip's folder is named. */
export default function DocsFolderSetting() {
  const [s, setS] = useState<DocsSettings | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => { api.get<DocsSettings>("/docs/settings").then(setS).catch((e) => setError(e.message)); }, []);

  const save = async (next: Partial<DocsSettings>) => {
    if (!s) return;
    setError("");
    try {
      setS(await api.put<DocsSettings>("/docs/settings", { folder: next.folder !== undefined ? next.folder : s.folder, naming: next.naming ?? s.naming }));
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e: any) { setError(e.message); }
  };

  if (!s) return error ? <p className="text-sm text-red-600">{error}</p> : null;
  const example = s.naming === "month" ? "Vietnam - February 2027" : "Trip to Vietnam";
  return (
    <Card className="p-5 max-w-2xl mt-6 space-y-4">
      <div>
        <h2 className="font-display text-lg font-semibold">Documents folder</h2>
        <p className="text-sm text-slate-500">Original PDFs, photos and email attachments you import are kept here, in one folder per trip.</p>
      </div>
      {!s.available && <p className="text-sm text-amber-700 dark:text-amber-400">The NAS share ({s.rootLabel}) isn't reachable from the server right now. Check that it's mounted, then reload.</p>}
      <div>
        <Label>Folder</Label>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-slate-100 dark:bg-slate-800 px-2 py-1.5 text-sm">{s.folder ? `${s.rootLabel}/${s.folder}` : "Not set: originals are not kept"}</code>
          <Button variant="secondary" onClick={() => setBrowsing(true)} disabled={!s.available}><Folder className="h-4 w-4 mr-1.5" />Browse…</Button>
          {s.folder && <Button variant="ghost" onClick={() => save({ folder: null })}>Clear</Button>}
        </div>
      </div>
      <div className="max-w-sm">
        <Label>Trip folder names</Label>
        <Select value={s.naming} onChange={(e) => save({ naming: e.target.value as "month" | "title" })}>
          <option value="month">Destination - Month Year</option>
          <option value="title">Trip title</option>
        </Select>
        <p className="mt-1 text-xs text-slate-500">For example: <span className="font-medium">{example}</span>. New files wait in a "Wander Inbox" sub-folder until they are imported into a trip.</p>
      </div>
      {saved && <p className="text-sm text-green-600 dark:text-green-400">Saved</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {browsing && <FolderBrowser rootLabel={s.rootLabel} start={s.folder ?? ""} onClose={() => setBrowsing(false)} onPick={(f) => { setBrowsing(false); save({ folder: f }); }} />}
    </Card>
  );
}

function FolderBrowser({ rootLabel, start, onClose, onPick }: { rootLabel: string; start: string; onClose: () => void; onPick: (rel: string) => void }) {
  const [path, setPath] = useState(start);
  const [folders, setFolders] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [newName, setNewName] = useState("");

  const open = (rel: string) => {
    setFolders(null); setError("");
    api.get<{ folders: string[] }>(`/docs/browse?path=${encodeURIComponent(rel)}`).then((r) => { setPath(rel); setFolders(r.folders); })
      .catch((e) => { setError(e.message); if (rel !== "") open(""); });
  };
  useEffect(() => { open(start); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const parts = path ? path.split("/") : [];
  const create = async () => {
    if (!newName.trim()) return;
    try { const r = await api.post<{ path: string }>("/docs/mkdir", { path, name: newName.trim() }); setNewName(""); open(r.path); }
    catch (e: any) { setError(e.message); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-[8vh]" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-xl">
        <Card className="p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-display font-semibold">Choose the documents folder</h3>
            <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700"><X className="h-5 w-5" /></button>
          </div>
          <nav className="flex flex-wrap items-center gap-1 text-sm">
            <button type="button" onClick={() => open("")} className="flex items-center gap-1 text-brand-600 hover:underline"><HardDrive className="h-4 w-4" />{rootLabel}</button>
            {parts.map((p, k) => (
              <span key={k} className="flex items-center gap-1"><ChevronRight className="h-3.5 w-3.5 text-slate-400" />
                <button type="button" onClick={() => open(parts.slice(0, k + 1).join("/"))} className="text-brand-600 hover:underline">{p}</button></span>
            ))}
          </nav>
          <ul className="h-72 overflow-y-auto rounded-md border border-slate-200 dark:border-slate-800 text-sm">
            {folders === null && <li className="flex items-center gap-2 px-3 py-2 text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />Loading…</li>}
            {folders?.length === 0 && <li className="px-3 py-2 text-slate-400">No sub-folders here.</li>}
            {folders?.map((f) => (
              <li key={f}><button type="button" onClick={() => open(path ? `${path}/${f}` : f)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800"><Folder className="h-4 w-4 shrink-0 text-amber-500" /><span className="truncate">{f}</span></button></li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} placeholder="New folder name" />
            <Button variant="secondary" onClick={create} disabled={!newName.trim()}><FolderPlus className="h-4 w-4 mr-1.5" />Create here</Button>
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex items-center justify-between gap-2 border-t border-slate-100 dark:border-slate-800 pt-3">
            <span className="min-w-0 truncate text-xs text-slate-500">{rootLabel}{path ? `/${path}` : ""}</span>
            <Button onClick={() => onPick(path)} disabled={!path}>Use this folder</Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
