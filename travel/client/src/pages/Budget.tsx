import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { RoadmapData, RoadmapDest, RoadmapSettings } from "../types";
import { AnimatePresence, animate, motion } from "framer-motion";
import { Bar, BarChart, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from "recharts";
import { AlertTriangle, Flower2, Leaf, Link2, Plane, Snowflake, Sun, Upload, SlidersHorizontal } from "lucide-react";
import { Badge, Button, Card, Input, Select, Skeleton } from "../components/ui";
import { MOBILITY, SEASONS, YearSummary, destCost, fmt, summarize } from "../lib/roadmap";

export function NumCell({ value, onSave, w = "4rem" }: { value: number | null; onSave: (n: number | null) => void; w?: string }) {
  const [v, setV] = useState(value == null ? "" : String(value));
  useEffect(() => setV(value == null ? "" : String(value)), [value]);
  return (
    <Input
      type="number" className="!px-1.5 !py-0.5" style={{ width: w }} value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { const n = v === "" ? null : Number(v); if (n !== value) onSave(n); }}
    />
  );
}

function SettingsBar({ s, onSave }: { s: RoadmapSettings; onSave: (p: Partial<RoadmapSettings>) => void }) {
  return (
    <Card className="p-4 mb-6">
      <div className="flex flex-wrap items-end gap-4 text-sm">
        <label className="text-xs text-slate-500">Annual cap<NumCell w="6rem" value={s.annualCap} onSave={(n) => n != null && onSave({ annualCap: n })} /></label>
        <label className="text-xs text-slate-500">Max far trips / yr<NumCell value={s.maxFarPerYear} onSave={(n) => n != null && onSave({ maxFarPerYear: n })} /></label>
        <label className="text-xs text-slate-500">Demanding trips through<NumCell value={s.highMobilityUntil} onSave={(n) => onSave({ highMobilityUntil: n })} /></label>
        <label className="text-xs text-slate-500">Ages in {s.startYear}
          <span className="flex gap-1"><NumCell value={s.ageA} onSave={(n) => onSave({ ageA: n })} /><NumCell value={s.ageB} onSave={(n) => onSave({ ageB: n })} /></span>
        </label>
        <label className="text-xs text-slate-500">Horizon
          <span className="flex gap-1"><NumCell w="5rem" value={s.startYear} onSave={(n) => n != null && onSave({ startYear: n })} /><NumCell w="5rem" value={s.endYear} onSave={(n) => n != null && onSave({ endYear: n })} /></span>
        </label>
      </div>
    </Card>
  );
}

import { SEASON_META } from "../lib/seasons";

function CountUp({ value, format }: { value: number; format: (n: number) => string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const c = animate(0, value, { duration: 0.9, ease: "easeOut", onUpdate: setN });
    return () => c.stop();
  }, [value]);
  return <>{format(n)}</>;
}

function Stat({ label, value, format, tone }: { label: string; value: number; format: (n: number) => string; tone?: "bad" | "ok" }) {
  return (
    <div className="rounded-xl bg-white/10 backdrop-blur px-4 py-3 ring-1 ring-white/15">
      <div className="text-xs uppercase tracking-wide text-brand-100">{label}</div>
      <div className={`text-2xl font-display font-semibold mt-1 tabular-nums ${tone === "bad" ? "text-amber-300" : "text-white"}`}>
        <CountUp value={value} format={format} />
      </div>
    </div>
  );
}

function SpendChart({ years, cap, onPick, active }: { years: YearSummary[]; cap: number; onPick: (y: number) => void; active: number | null }) {
  const top = Math.max(cap, ...years.map((y) => y.spend)) * 1.05;
  const raw = top / 4, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw)!;
  const ticks = Array.from({ length: Math.ceil(top / step) + 1 }, (_, i) => i * step);
  const data = years.map((y) => ({ year: String(y.year), spend: y.spend, over: y.spend > cap, trips: y.departures, days: y.days }));
  return (
    <Card className="p-5 mb-6">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="font-semibold">Annual spend vs. cap</h2>
        <div className="flex items-center gap-4 text-xs text-slate-500">
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--viz-bar)" }} />Within cap</span>
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--viz-bad)" }} />Over cap</span>
          <span className="flex items-center gap-1.5"><i className="h-0 w-4 border-t-2 border-dashed" style={{ borderColor: "var(--viz-muted)" }} />Cap</span>
        </div>
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 16, right: 8, left: 0, bottom: 0 }} onClick={(e: any) => e?.activeLabel && onPick(Number(e.activeLabel))}>
            <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
            <XAxis dataKey="year" tickLine={false} axisLine={false} tick={{ fill: "var(--viz-muted)", fontSize: 12 }} />
            <YAxis domain={[0, ticks[ticks.length - 1]]} ticks={ticks} tickLine={false} axisLine={false} width={44} tick={{ fill: "var(--viz-muted)", fontSize: 12 }} tickFormatter={(v) => `$${+(v / 1000).toFixed(1)}k`} />
            <Tooltip
              cursor={{ fill: "var(--viz-grid)", opacity: 0.5 }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload;
                return (
                  <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs shadow-lg text-slate-800 dark:text-slate-100">
                    <div className="font-semibold mb-1">{d.year}</div>
                    <div>{fmt(d.spend)} · {Math.round((d.spend / cap) * 100)}% of cap</div>
                    <div className="text-slate-500">{d.trips} trips · {d.days} days{d.over ? " · over cap" : ""}</div>
                  </div>
                );
              }}
            />
            <ReferenceLine y={cap} stroke="var(--viz-muted)" strokeDasharray="5 4" />
            <Bar dataKey="spend" radius={[4, 4, 0, 0]} maxBarSize={44} cursor="pointer" isAnimationActive animationDuration={700}>
              {data.map((d) => (
                <Cell key={d.year} fill={d.over ? "var(--viz-bad)" : "var(--viz-bar)"} fillOpacity={active == null || Number(d.year) === active ? 1 : 0.7} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function YearCard({ y, s, active, onClick }: { y: YearSummary; s: RoadmapSettings; active: boolean; onClick: () => void }) {
  const pct = Math.min(100, (y.spend / s.annualCap) * 100);
  const over = y.spend > s.annualCap;
  return (
    <motion.button
      layout whileHover={{ y: -3 }} whileTap={{ scale: 0.98 }} onClick={onClick}
      className={`text-left self-stretch flex flex-col items-stretch justify-start rounded-xl border p-4 bg-white dark:bg-slate-900 shadow-sm transition-colors ${
        active ? "border-brand-500 ring-2 ring-brand-500/30" : "border-slate-200 dark:border-slate-800 hover:border-brand-300"
      }`}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xl font-display font-semibold">{y.year}</div>
          <div className="text-xs text-slate-500">{y.ageA != null ? `Ages ${y.ageA} & ${y.ageB}` : "\u00a0"}</div>
        </div>
        <div className="flex items-center gap-1" title={`${y.far} of ${s.maxFarPerYear} far trips`}>
          {Array.from({ length: Math.max(s.maxFarPerYear, y.far) }, (_, i) => (
            <Plane key={i} className={`h-4 w-4 ${i < y.far ? (y.far > s.maxFarPerYear ? "text-red-500" : "text-brand-600") : "text-slate-300 dark:text-slate-700"}`} />
          ))}
        </div>
      </div>
      <div className="mt-3 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
        <motion.div className="h-full rounded-full" style={{ background: over ? "var(--viz-bad)" : "var(--viz-bar)" }}
          initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.8, ease: "easeOut" }} />
      </div>
      <div className="mt-1.5 flex justify-between text-xs text-slate-500 tabular-nums">
        <span>{fmt(y.spend)}</span><span>{y.days} d</span>
      </div>
      <ul className="mt-3 space-y-1">
        {y.dests.map((d) => {
          const m = SEASON_META[d.planSeason ?? ""];
          return (
            <li key={d.id} className="flex items-center gap-1.5 text-xs">
              {m ? <m.Icon className="h-3.5 w-3.5 shrink-0" style={{ color: m.color }} /> : <span className="w-3.5" />}
              <span className="truncate">{d.name}</span>
              {d.pairingId && <Link2 className="h-3 w-3 shrink-0 text-slate-400" />}
            </li>
          );
        })}
      </ul>
      {y.warnings.length > 0 && (
        <div className="mt-3 flex items-center gap-1 text-xs font-medium text-amber-600">
          <AlertTriangle className="h-3.5 w-3.5" />{y.warnings.length} {y.warnings.length === 1 ? "issue" : "issues"}
        </div>
      )}
    </motion.button>
  );
}

export default function Budget() {
  const nav = useNavigate();
  const [data, setData] = useState<RoadmapData | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => api.get<RoadmapData>("/roadmap").then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (data && open == null) setOpen(data.settings.startYear); }, [data, open]);

  const patchDest = async (id: string, body: Partial<RoadmapDest>) => {
    try { await api.patch(`/roadmap/destinations/${id}`, body); await load(); } catch (e: any) { setError(e.message); }
  };
  const patchSettings = async (body: Partial<RoadmapSettings>) => {
    try { await api.patch("/roadmap/settings", body); await load(); } catch (e: any) { setError(e.message); }
  };
  const importFile = async (f: File) => {
    setError("");
    try {
      const r = await api.post<{ planned: number; visited: number; pairings: number }>("/roadmap/import", { markdown: await f.text() });
      setError(`Imported ${r.planned} planned, ${r.visited} visited, ${r.pairings} pairings.`);
      await load();
    } catch (e: any) { setError(e.message); }
  };
  const openTrip = async (d: RoadmapDest) => {
    if (d.trips[0]) return nav(`/trips/${d.trips[0].id}`);
    const t = await api.post<{ id: string }>("/trips", { title: `Trip to ${d.name}`, destinationId: d.id, status: "PLANNING" });
    nav(`/trips/${t.id}`);
  };

  if (!data) return <div>{error ? <p className="text-sm text-red-600">{error}</p> : <Skeleton className="h-64 w-full rounded-2xl" />}</div>;

  const years = summarize(data);
  const visited = data.destinations.filter((d) => d.status === "VISITED");
  const plannedCount = years.reduce((t, y) => t + y.dests.length, 0);
  const total = years.reduce((t, y) => t + y.spend, 0);
  const totalDays = years.reduce((t, y) => t + y.days, 0);
  const issues = years.filter((y) => y.warnings.length).length;
  const s = data.settings;
  const pairName = (id: string | null) => data.pairings.find((p) => p.id === id);
  const activeYear = years.find((y) => y.year === open) ?? null;
  const empty = plannedCount === 0 && visited.length === 0;

  return (
    <div>
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-brand-800 via-brand-700 to-brand-500 text-white p-6 mb-6 shadow-lg">
        <div className="absolute -right-10 -top-10 h-56 w-56 rounded-full bg-white/10 blur-2xl" aria-hidden />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-display font-semibold">Budget &amp; Guardrails</h1>
            <p className="text-sm text-brand-100 mt-1">{s.startYear}–{s.endYear} · {plannedCount} planned · {visited.length} visited</p>
          </div>
          <div className="flex gap-2">
            <input ref={fileRef} type="file" accept=".md,text/markdown,text/plain" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ""; }} />
            <button onClick={() => setShowSettings((v) => !v)} className="inline-flex items-center gap-1.5 rounded-md bg-white/15 hover:bg-white/25 px-3 py-1.5 text-sm font-medium transition-colors">
              <SlidersHorizontal className="h-4 w-4" />Guardrails
            </button>
            <button onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1.5 rounded-md bg-white text-brand-800 hover:bg-brand-50 px-3 py-1.5 text-sm font-medium transition-colors">
              <Upload className="h-4 w-4" />Import
            </button>
          </div>
        </div>
        {!empty && (
          <div className="relative grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
            <Stat label="Total scheduled" value={total} format={fmt} />
            <Stat label="Avg per year" value={total / Math.max(1, years.length)} format={fmt} />
            <Stat label="Days away" value={totalDays} format={(n) => `${Math.round(n)} d`} />
            <Stat label="Years with issues" value={issues} format={(n) => `${Math.round(n)} / ${years.length}`} tone={issues ? "bad" : "ok"} />
          </div>
        )}
      </div>

      {error && <p className="mb-4 text-sm text-slate-600 dark:text-slate-300">{error}</p>}

      <AnimatePresence initial={false}>
        {showSettings && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <SettingsBar s={s} onSave={patchSettings} />
          </motion.div>
        )}
      </AnimatePresence>

      {empty ? (
        <Card className="p-10 text-center text-sm text-slate-500">
          Nothing on the roadmap yet. Use <b>Import</b> to load your portfolio summary markdown.
        </Card>
      ) : (
        <>
          <SpendChart years={years} cap={s.annualCap} onPick={setOpen} active={open} />

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            {years.map((y) => <YearCard key={y.year} y={y} s={s} active={open === y.year} onClick={() => setOpen(y.year)} />)}
          </div>

          <AnimatePresence mode="wait">
            {activeYear && (
              <motion.div key={activeYear.year} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                <Card className="p-4 mb-6 overflow-x-auto">
                  <h2 className="font-semibold mb-2">{activeYear.year} — details</h2>
                  <YearDetail y={activeYear} s={s} patchDest={patchDest} openTrip={openTrip} pairName={pairName} />
                </Card>
              </motion.div>
            )}
          </AnimatePresence>

          <h2 className="font-semibold mb-3">Pairings</h2>
          <div className="grid md:grid-cols-2 gap-3 mb-6">
            {data.pairings.map((p) => (
              <Card key={p.id} className="p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <b className="flex items-center gap-1.5"><Link2 className="h-4 w-4 text-brand-600" />{p.year} {p.quarter} — {p.name}</b>
                  <Badge tone="green">saves {fmt(p.savings)}</Badge>
                </div>
                <div className="text-slate-500 mt-1">{data.destinations.filter((d) => d.pairingId === p.id).map((d) => d.name).join(" + ")}</div>
              </Card>
            ))}
          </div>

          <h2 className="font-semibold mb-3">Already visited ({visited.length})</h2>
          <Card className="p-3 text-sm flex flex-wrap gap-2">
            {visited.map((d) => <Badge key={d.id}>{d.name}{d.days ? ` · ${d.days}d` : ""}</Badge>)}
          </Card>
        </>
      )}
    </div>
  );
}

function YearDetail({ y, s, patchDest, openTrip, pairName }: {
  y: YearSummary; s: RoadmapSettings;
  patchDest: (id: string, b: Partial<RoadmapDest>) => void; openTrip: (d: RoadmapDest) => void;
  pairName: (id: string | null) => { name: string; savings: number } | undefined;
}) {
  return (
    <>

      {y.warnings.map((w) => <div key={w} className="text-xs text-amber-700 dark:text-amber-400 mb-1">⚠ {w}</div>)}
      <table className="w-full text-xs mt-1">
        <thead className="text-slate-500"><tr className="text-left"><th>Destination</th><th>Year</th><th>Season</th><th>Mobility</th><th>Far</th><th>Days</th><th>Daily</th><th>Transit</th><th className="text-right">Cost</th><th></th></tr></thead>
        <tbody>
          {y.dests.map((d) => {
            const pr = pairName(d.pairingId);
            return (
              <tr key={d.id} className="border-t border-slate-200 dark:border-slate-800 align-middle">
                <td className="py-1.5 pr-2"><b>{d.name}</b>{pr && <div><Badge tone="blue">{pr.name}</Badge></div>}</td>
                <td><Select className="!py-0.5 !px-1 w-20" value={d.planYear ?? ""} onChange={(e) => patchDest(d.id, { planYear: Number(e.target.value) })}>
                  {Array.from({ length: s.endYear - s.startYear + 1 }, (_, i) => s.startYear + i).map((yr) => <option key={yr}>{yr}</option>)}
                </Select></td>
                <td><Select className="!py-0.5 !px-1 w-24" value={d.planSeason ?? ""} onChange={(e) => patchDest(d.id, { planSeason: e.target.value })}>
                  {SEASONS.map((x) => <option key={x}>{x}</option>)}</Select></td>
                <td><Select className="!py-0.5 !px-1 w-32" value={d.mobility ?? ""} onChange={(e) => patchDest(d.id, { mobility: e.target.value })}>
                  <option value="">—</option>{MOBILITY.map((x) => <option key={x}>{x}</option>)}</Select></td>
                <td><input type="checkbox" checked={d.isFar} onChange={(e) => patchDest(d.id, { isFar: e.target.checked })} /></td>
                <td><NumCell w="3.5rem" value={d.days} onSave={(n) => patchDest(d.id, { days: n })} /></td>
                <td><NumCell w="5rem" value={d.dailyCost} onSave={(n) => patchDest(d.id, { dailyCost: n })} /></td>
                <td><NumCell w="5rem" value={d.transitCost} onSave={(n) => patchDest(d.id, { transitCost: n })} /></td>
                <td className="text-right">{fmt(destCost(d))}</td>
                <td className="text-right pl-2"><Button variant="ghost" className="!py-0.5 !px-2 text-xs" onClick={() => openTrip(d)}>{d.trips[0] ? "Open trip" : "Plan trip"}</Button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
            </>
  );
}
