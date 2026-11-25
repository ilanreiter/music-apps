import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Search, X } from "lucide-react";
import { api } from "../lib/api";

interface Hit { type: string; id: string; title: string; subtitle: string; snippet?: string; href: string; external?: boolean }

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Search box for the top bar: trips, bookings, itinerary, to-dos, documents, destinations, resources, agents, travelers. */
export default function GlobalSearch({ variant = "light" }: { variant?: "light" | "sidebar" }) {
  const dark = variant === "sidebar";
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  // ⌘K / Ctrl+K focuses the box from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); input.current?.focus(); input.current?.select(); setOpen(true); } };
    const onClick = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("keydown", onKey); window.addEventListener("mousedown", onClick);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onClick); };
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setHits([]); setBusy(false); return; }
    setBusy(true);
    const t = setTimeout(() => {
      api.get<{ q: string; hits: Hit[] }>(`/search?q=${encodeURIComponent(term)}`)
        .then((r) => { if (r.q === term) { setHits(r.hits); setActive(0); } })
        .catch(() => setHits([])).finally(() => setBusy(false));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  const groups = useMemo(() => {
    const m = new Map<string, Hit[]>();
    hits.forEach((h) => m.set(h.type, [...(m.get(h.type) ?? []), h]));
    return [...m.entries()];
  }, [hits]);

  const go = (h: Hit) => {
    setOpen(false); input.current?.blur();
    if (h.external) window.open(h.href, "_blank", "noopener"); else nav(h.href);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter" && hits[active]) { e.preventDefault(); go(hits[active]); }
    else if (e.key === "Escape") { setOpen(false); input.current?.blur(); }
  };

  let n = -1;
  return (
    <div ref={box} className="relative w-full">
      <Search className={`pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${dark ? "text-brand-200" : "text-slate-400"}`} />
      <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKeyDown}
        placeholder={dark ? "Search…" : "Search trips, bookings, documents, places…"} aria-label="Search everything"
        className={dark ? "w-full rounded-md border border-white/15 bg-white/10 py-1.5 pl-9 pr-14 text-sm text-white placeholder:text-brand-200 focus:border-white/40 focus:bg-white/15 focus:outline-none"
          : "w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-16 text-sm shadow-sm placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200 dark:border-slate-700 dark:bg-slate-900 dark:focus:ring-brand-900"} />
      <span className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />}
        {q ? <button type="button" onClick={() => { setQ(""); input.current?.focus(); }} aria-label="Clear search" className={dark ? "text-brand-200 hover:text-white" : "text-slate-400 hover:text-slate-600"}><X className="h-4 w-4" /></button>
          : <kbd className={`rounded border px-1.5 text-[10px] ${dark ? "border-white/20 text-brand-200" : "border-slate-200 text-slate-400 dark:border-slate-700"}`}>{isMac ? "⌘K" : "Ctrl K"}</kbd>}
      </span>
      {open && q.trim().length >= 2 && (
        <div className={`absolute left-0 top-full z-[1100] mt-1 max-h-[70vh] ${dark ? "w-[34rem] max-w-[calc(100vw-1.5rem)]" : "right-0"}`}><div className="max-h-[70vh] overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-xl dark:border-slate-700 dark:bg-slate-900">
          {!busy && !hits.length && <p className="px-4 py-3 text-sm text-slate-500">Nothing matches “{q.trim()}”.</p>}
          {groups.map(([type, list]) => (
            <div key={type} className="py-1">
              <div className="px-4 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{type}</div>
              {list.map((h) => {
                n++; const me = n;
                return (
                  <button key={h.type + h.id} type="button" onMouseEnter={() => setActive(me)} onClick={() => go(h)}
                    className={`block w-full px-4 py-1.5 text-left ${active === me ? "bg-brand-50 dark:bg-slate-800" : ""}`}>
                    <div className="truncate text-sm text-slate-800 dark:text-slate-100">{h.title}</div>
                    {(h.subtitle || h.snippet) && <div className="truncate text-xs text-slate-500">{[h.subtitle, h.snippet].filter(Boolean).join(" · ")}</div>}
                  </button>
                );
              })}
            </div>
          ))}
        </div></div>
      )}
    </div>
  );
}
