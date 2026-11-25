import { useEffect, useState } from "react";
import { Download, ExternalLink, FileText, Image as ImageIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import DocViewer, { ViewDoc } from "../DocViewer";
import { Card } from "../ui";

interface Doc { id: string; name: string; size: number; mime: string; createdAt: string; folder: string }

const kb = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The trip's original files on the NAS (kept when documents are imported). */
export default function DocumentsTab({ tripId }: { tripId: string }) {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState<ViewDoc | null>(null);
  useEffect(() => { api.get<Doc[]>(`/docs/trip/${tripId}`).then(setDocs).catch((e) => setError(e.message)); }, [tripId]);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!docs) return <p className="text-sm text-slate-400">Loading…</p>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">
        Original files imported into this trip{docs[0] ? <>, kept in <code className="text-xs">{docs[0].folder}</code> on the NAS</> : ""}. Add more from <Link to={`/import?trip=${tripId}`} className="text-brand-600 hover:underline">Import</Link>.
      </p>
      {docs.length === 0 ? (
        <Card className="p-4 text-sm text-slate-500">No documents yet. PDFs, photos and email attachments you import into this trip appear here (a documents folder must be chosen in Preferences).</Card>
      ) : (
        <Card className="divide-y divide-slate-100 dark:divide-slate-800">
          {docs.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              {d.mime.startsWith("image/") ? <ImageIcon className="h-4 w-4 shrink-0 text-slate-400" /> : <FileText className="h-4 w-4 shrink-0 text-slate-400" />}
              <button type="button" onClick={() => setViewing(d)} className="min-w-0 flex-1 truncate text-left hover:underline">{d.name}</button>
              <span className="text-xs text-slate-400">{kb(d.size)} · {new Date(d.createdAt).toLocaleDateString()}</span>
              <button type="button" onClick={() => setViewing(d)} className="flex items-center gap-1 text-xs text-brand-600 hover:underline"><ExternalLink className="h-3.5 w-3.5" />View</button>
              <a href={`/api/docs/${d.id}/file?download=1`} className="flex items-center gap-1 text-xs text-brand-600 hover:underline"><Download className="h-3.5 w-3.5" />Download</a>
            </div>
          ))}
        </Card>
      )}
      <DocViewer doc={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
