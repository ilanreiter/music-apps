import { useEffect, useState } from "react";
import { Download, ExternalLink, Loader2, X } from "lucide-react";

export interface ViewDoc { id: string; name: string; mime?: string; sourceUrl?: string | null }

const kind = (d: ViewDoc) => {
  const m = d.mime ?? "", n = d.name.toLowerCase();
  if (/rfc822/.test(m) || n.endsWith(".eml")) return "email";
  if (/html/.test(m) || /\.html?$/.test(n)) return "html";
  if (m === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (m.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(n)) return "image";
  if (m.startsWith("text/") || /\.(txt|csv|md|ics|json|eml)$/.test(n)) return "text";
  return "other";
};

/** Shows a kept original (PDF, photo, text) inside the app, with Download and Open-in-new-tab. */
export default function DocViewer({ doc, onClose }: { doc: ViewDoc | null; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState("");
  const src = doc ? `/api/docs/${doc.id}/file` : "";
  const k = doc ? kind(doc) : "other";

  useEffect(() => {
    setText(null); setFailed("");
    if (!doc) return;
    // check the file is still in its folder before showing it (a moved/deleted file gives a clear message instead of a blank frame)
    fetch(src, { method: "HEAD", credentials: "include" }).then((r) => { if (!r.ok) setFailed("This file is no longer in its folder on the NAS."); }).catch(() => {});
    if (k === "text") fetch(src, { credentials: "include" }).then((r) => (r.ok ? r.text() : Promise.reject())).then((t) => setText(t.slice(0, 500_000))).catch(() => setFailed("This file couldn't be opened."));
  }, [doc?.id]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!doc) return null;
  return (
    <div className="fixed inset-0 z-[1300] flex flex-col bg-slate-900/70 p-3 sm:p-6" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl dark:bg-slate-900">
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-2.5 dark:border-slate-800">
          <span className="min-w-0 flex-1 truncate font-medium">{doc.name}{k === "html" && doc.sourceUrl && <span className="ml-2 text-xs font-normal text-slate-500">saved copy of <a href={doc.sourceUrl} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">the live page</a></span>}</span>
          <a href={src} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-brand-600 hover:underline"><ExternalLink className="h-3.5 w-3.5" />New tab</a>
          <a href={`${src}?download=1`} className="flex items-center gap-1 text-xs text-brand-600 hover:underline"><Download className="h-3.5 w-3.5" />Download</a>
          <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700"><X className="h-5 w-5" /></button>
        </div>
        <div className="min-h-0 flex-1 bg-slate-100 dark:bg-slate-950">
          {failed ? <p className="p-6 text-sm text-red-600">{failed}</p>
            : k === "pdf" ? <iframe title={doc.name} src={src} className="h-full w-full border-0" />
            : k === "email" ? <iframe title={doc.name} src={`/api/docs/${doc.id}/view`} sandbox="allow-popups allow-popups-to-escape-sandbox" className="h-full w-full border-0 bg-white" />
            : k === "html" ? <iframe title={doc.name} src={src} sandbox="allow-popups allow-popups-to-escape-sandbox" className="h-full w-full border-0 bg-white" />
            : k === "image" ? <div className="flex h-full items-center justify-center overflow-auto p-4"><img src={src} alt={doc.name} className="max-h-full max-w-full object-contain" /></div>
            : k === "text" ? (text === null ? <p className="flex items-center gap-2 p-6 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
              : <pre className="h-full overflow-auto whitespace-pre-wrap p-4 text-xs text-slate-700 dark:text-slate-300">{text}</pre>)
            : <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-sm text-slate-500">This type of file can't be shown in the browser.<a href={`${src}?download=1`} className="font-medium text-brand-600 hover:underline">Download it</a></div>}
        </div>
      </div>
    </div>
  );
}
