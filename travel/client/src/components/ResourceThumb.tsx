import { useState } from "react";
import { FileText } from "lucide-react";

/** Preview picture of a resource (taken from its web page), or a neutral placeholder. */
export default function ResourceThumb({ src, className = "" }: { src?: string | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  const box = `h-14 w-20 shrink-0 overflow-hidden rounded-md bg-slate-100 dark:bg-slate-800 ${className}`;
  if (!src || failed) return <div className={`${box} flex items-center justify-center text-slate-400`}><FileText className="h-5 w-5" /></div>;
  return <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={`${box} object-cover`} />;
}
