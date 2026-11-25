import { useState } from "react";
import { FileSearch } from "lucide-react";
import { api } from "../lib/api";
import DocViewer, { ViewDoc } from "./DocViewer";

/** "Source" link on an imported item: opens the email, file, text or web page it came from. */
export default function SourceLink({ inboxId, className = "" }: { inboxId?: string | null; className?: string }) {
  const [doc, setDoc] = useState<ViewDoc | null>(null);
  const [msg, setMsg] = useState("");
  if (!inboxId) return null;
  const open = async (e: React.MouseEvent) => {
    e.stopPropagation(); setMsg("");
    try { setDoc(await api.get<ViewDoc>(`/docs/source/${inboxId}`)); }
    catch (err: any) { setMsg(err.message); setTimeout(() => setMsg(""), 4000); }
  };
  return (
    <>
      <button type="button" onClick={open} title="View the original this came from" className={`inline-flex items-center gap-0.5 text-[11px] text-brand-600 hover:underline ${className}`}>
        <FileSearch className="h-3 w-3" />Source
      </button>
      {msg && <span className="ml-1 text-[11px] text-amber-700">{msg}</span>}
      <DocViewer doc={doc} onClose={() => setDoc(null)} />
    </>
  );
}
