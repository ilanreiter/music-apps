import { useEffect, useId, useMemo, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { Place, searchPlaces } from "../lib/placeNames";
import { Input } from "./ui";

/** Text input with a predictive dropdown of countries, US states, regions and well-known places. Free text is still allowed. */
export default function PlaceInput({ value, onChange, onPick, existing = [], disabled, placeholder }: {
  value: string; onChange: (v: string) => void; onPick?: (p: Place) => void; existing?: string[]; disabled?: boolean; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const results = useMemo(() => searchPlaces(value), [value]);
  const have = useMemo(() => new Set(existing.map((n) => n.toLowerCase())), [existing]);
  useEffect(() => setActive(0), [value]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const show = open && results.length > 0 && !(results.length === 1 && results[0].name.toLowerCase() === value.trim().toLowerCase());
  const pick = (p: Place) => { onChange(p.name); onPick?.(p); setOpen(false); };

  return (
    <div ref={box} className="relative">
      <Input autoFocus value={value} disabled={disabled} placeholder={placeholder} autoComplete="off"
        role="combobox" aria-expanded={show} aria-controls={listId} aria-autocomplete="list"
        onChange={(e) => { onChange(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!show) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % results.length); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + results.length) % results.length); }
          else if (e.key === "Enter") { e.preventDefault(); pick(results[active]); }
          else if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
        }} />
      {open && value.trim().length >= 2 && results.length === 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-600 dark:text-slate-300 shadow-lg">
          Not in the list — that's fine. Press <b>Enter</b> to add “{value.trim()}” as typed; its details will be estimated.
        </div>
      )}
      {show && (
        <ul id={listId} role="listbox" className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-lg text-sm">
          {results.map((p, i) => (
            <li key={p.name} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); pick(p); }}
              className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 ${i === active ? "bg-brand-50 text-slate-900 dark:bg-slate-700 dark:text-white" : ""}`}>
              <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              <span className="flex-1 truncate">{p.name}</span>
              {have.has(p.name.toLowerCase()) && <span className="text-[10px] text-amber-600">already added</span>}
              <span className="text-[10px] uppercase tracking-wide text-slate-400">{p.kind}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
