import React from "react";
import { AU, BR, BW, CH, CN, CO, EC, ES, FO, GB, GR, HR, IE, IT, JP, KH, LA, NO, NZ, PA, PE, PT, SI, TH, TW, US, VN, ZA, ZW } from "country-flag-icons/react/3x2";

const FLAGS: Record<string, React.ComponentType<{ className?: string; "aria-label"?: string }>> = { AU, BR, BW, CH, CN, CO, EC, ES, FO, GB, GR, HR, IE, IT, JP, KH, LA, NO, NZ, PA, PE, PT, SI, TH, TW, US, VN, ZA, ZW };

/** One or two country flags (inline SVG, works offline and on every OS). */
export function Flags({ codes, fallback: Fallback }: { codes?: string[]; fallback: React.ComponentType<{ className?: string }> }) {
  const list = (codes ?? []).filter((c) => FLAGS[c]);
  if (!list.length) return <span className="grid h-6 w-8 shrink-0 place-items-center rounded bg-slate-100 dark:bg-slate-800 text-slate-500"><Fallback className="h-4 w-4" /></span>;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {list.map((c) => { const F = FLAGS[c]; return <F key={c} className="h-5 w-7 rounded-[3px] shadow-sm ring-1 ring-black/10" aria-label={c} />; })}
    </span>
  );
}
