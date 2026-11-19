import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  DndContext, DragEndEvent, DragOverlay, DragStartEvent, KeyboardSensor, PointerSensor,
  closestCorners, useDroppable, useSensor, useSensors,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, GripVertical, Link2, Loader2, CloudSun, Flag, Info, Pin, Plane, RotateCcw, ScrollText, Unlink, Upload, Wallet, X } from "lucide-react";
import { api } from "../lib/api";
import { RoadmapData, RoadmapDest, RoadmapSettings } from "../types";
import { Button, Card, Select, Skeleton } from "../components/ui";
import { MiniMap, WorldMapDefs } from "../components/WorldMap";
import { NumCell } from "./Budget";
import { MOBILITY, RuleCheck, SEASONS, cardConflicts, destCost, emptySlots, fmt, ruleChecks, summarize } from "../lib/roadmap";
import { Flags } from "../components/Flags";
import { arrange, arrangeDetailed, Placement } from "../lib/arrange";
import { destMeta } from "../lib/destMeta";
import { SEASON_META } from "../lib/seasons";

const NONE = "none";
const keyOf = (d: RoadmapDest) =>
  d.planYear == null ? NONE : `${d.planYear}|${d.planSeason && SEASONS.includes(d.planSeason) ? d.planSeason : d.bestSeason ?? "Winter"}`;
const isMoved = (d: RoadmapDest) =>
  d.suggestedYear != null && (d.planYear !== d.suggestedYear || d.planSeason !== d.suggestedSeason);

function SeasonLabel({ season }: { season: string | null }) {
  const m = season ? SEASON_META[season] : null;
  if (!m) return <span className="text-slate-400">—</span>;
  return <span className="inline-flex items-center gap-1 font-medium"><m.Icon className="h-3.5 w-3.5" style={{ color: m.color }} />{season}</span>;
}

const difficultyLevel = (m: string | null) => Math.max(0, MOBILITY.indexOf(m ?? "")) + (m ? 1 : 0);

function Card_({ d, rank, cellSeason, overlay, onPin, conflicts }: { d: RoadmapDest; rank: number; cellSeason: string | null; overlay?: boolean; onPin?: () => void; conflicts?: string[] }) {
  const lvl = difficultyLevel(d.mobility);
  const off = cellSeason && d.bestSeason && cellSeason !== d.bestSeason && cellSeason !== d.secondSeason;
  const weather = !cellSeason || cellSeason === d.bestSeason ? d.weather : cellSeason === d.secondSeason ? d.weatherAlt : null;
  const meta = destMeta(d.name);
  const Icon = meta.icon;
  return (
    <div style={d.bestSeason && SEASON_META[d.bestSeason] ? { borderColor: SEASON_META[d.bestSeason].color } : undefined}
      className={`rounded-lg border-2 bg-white dark:bg-slate-900 p-3 text-xs shadow-sm select-none ${
        d.bestSeason && SEASON_META[d.bestSeason] ? "" : "border-slate-200 dark:border-slate-700"} ${
        overlay ? "shadow-xl rotate-1" : d.pinned ? "ring-2 ring-offset-1 ring-brand-400/60 dark:ring-offset-slate-900" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Flags codes={meta.flags} fallback={Icon} />
          <span className="font-semibold text-base leading-tight">{d.name}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 text-slate-400">
          {!!conflicts?.length && (
            <span title={conflicts.join("\n")} className="flex items-center gap-0.5 rounded-full bg-red-50 dark:bg-red-950/50 px-1.5 py-0.5 text-red-600 font-medium">
              <AlertTriangle className="h-3 w-3" />{conflicts.length}
            </span>
          )}
          {d.pairingId && <span title="Combined with other cards into one trip" className="text-brand-600"><Link2 className="h-3.5 w-3.5" /></span>}
          {isMoved(d) && !d.pinned && <span title="Moved from the suggested slot" className="h-2 w-2 rounded-full bg-amber-500" />}
          <span className="tabular-nums">#{rank}</span>
          {onPin && (
            <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onPin(); }}
              title={d.pinned ? "Unpin (allow moving and resetting)" : "Pin in place"} aria-pressed={d.pinned}
              className={`rounded p-0.5 hover:bg-slate-100 dark:hover:bg-slate-800 ${d.pinned ? "text-brand-600" : ""}`}>
              <Pin className={`h-3.5 w-3.5 ${d.pinned ? "fill-current" : ""}`} />
            </button>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-slate-600 dark:text-slate-300">
        <span>Best <SeasonLabel season={d.bestSeason} /></span>
        <span className="text-slate-500">2nd <SeasonLabel season={d.secondSeason} /></span>
        {d.isFar && <Plane className="h-3.5 w-3.5 text-slate-400" aria-label="Long-haul" />}
      </div>
      <div className="mt-2 -mr-3 grid grid-cols-[1fr_50%] gap-2">
        <div className="min-w-0 flex flex-col gap-1.5">
          <dl className="rounded-md bg-slate-50 dark:bg-slate-800/60 px-2 py-1.5 space-y-0.5 tabular-nums">
            <div className="flex justify-between"><dt className="text-slate-500">Ideal</dt><dd className="font-semibold">{d.days ?? "—"} days</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Per day</dt><dd className="font-semibold">{fmt(d.dailyCost ?? 0)}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Total</dt><dd className="font-semibold">{fmt(destCost(d))}</dd></div>
          </dl>
          <div>
            <span className="block text-slate-500"><Flag className="inline h-3 w-3 mr-1 -mt-0.5" />Difficulty: <b className="text-slate-700 dark:text-slate-200 font-medium">{d.mobility ?? "—"}</b></span>
            <span className="mt-1 flex gap-0.5" aria-hidden>
              {Array.from({ length: 5 }, (_, i) => <i key={i} className={`h-1.5 flex-1 rounded-full ${i < lvl ? "bg-brand-500" : "bg-slate-200 dark:bg-slate-700"}`} />)}
            </span>
          </div>
          <div className={`flex items-start gap-1 ${off ? "text-amber-600" : "text-slate-500"}`}>
            {off ? <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" /> : <CloudSun className="h-3 w-3 mt-0.5 shrink-0" />}
            <span>{off ? `Off-season — best in ${d.bestSeason}` : weather ?? "—"}</span>
          </div>
        </div>
        <div className="relative"><MiniMap lat={d.lat} lng={d.lng} name={d.name} countries={meta.countries} states={meta.states} /></div>
      </div>
    </div>
  );
}

/** Several combined destinations shown as ONE card: totals are summed, one frame, one move. */
function GroupCard({ members, name, overlay, onPin, onSplit, onOpenMember, conflicts }: {
  members: RoadmapDest[]; name: string; overlay?: boolean; onPin?: () => void; onSplit?: () => void; onOpenMember?: (d: RoadmapDest) => void; conflicts?: string[];
}) {
  const lead = members[0];
  const metas = members.map((m) => destMeta(m.name));
  const days = members.reduce((t, m) => t + (m.days ?? 0), 0);
  const total = members.reduce((t, m) => t + destCost(m), 0);
  const level = Math.max(...members.map((m) => difficultyLevel(m.mobility)));
  const hardest = members.find((m) => difficultyLevel(m.mobility) === level)?.mobility ?? null;
  const pinned = members.some((m) => m.pinned);
  const points = members.filter((m) => m.lat != null && m.lng != null).map((m) => [m.lat!, m.lng!] as [number, number]);
  const frame = lead.bestSeason && SEASON_META[lead.bestSeason] ? SEASON_META[lead.bestSeason].color : undefined;
  return (
    <div style={frame ? { borderColor: frame } : undefined}
      className={`rounded-lg border-2 bg-white dark:bg-slate-900 p-3 text-xs shadow-sm select-none ${frame ? "" : "border-slate-200 dark:border-slate-700"} ${
        overlay ? "shadow-xl rotate-1" : pinned ? "ring-2 ring-offset-1 ring-brand-400/60 dark:ring-offset-slate-900" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Flags codes={metas.flatMap((m) => m.flags ?? [])} fallback={metas[0].icon} />
          <span className="font-semibold text-base leading-tight">{name}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 text-slate-400">
          {!!conflicts?.length && (
            <span title={conflicts.join("\n")} className="flex items-center gap-0.5 rounded-full bg-red-50 dark:bg-red-950/50 px-1.5 py-0.5 text-red-600 font-medium">
              <AlertTriangle className="h-3 w-3" />{conflicts.length}
            </span>
          )}
          {onSplit && (
            <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onSplit(); }}
              title="Split back into separate cards" className="rounded p-0.5 text-brand-600 hover:bg-slate-100 dark:hover:bg-slate-800"><Unlink className="h-3.5 w-3.5" /></button>
          )}
          {onPin && (
            <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onPin(); }}
              title={pinned ? "Unpin (allow moving and resetting)" : "Pin in place"} aria-pressed={pinned}
              className={`rounded p-0.5 hover:bg-slate-100 dark:hover:bg-slate-800 ${pinned ? "text-brand-600" : ""}`}>
              <Pin className={`h-3.5 w-3.5 ${pinned ? "fill-current" : ""}`} />
            </button>
          )}
        </div>
      </div>
      <div className="mt-0.5 text-slate-500 leading-tight">{members.map((m) => m.name).join(" + ")}</div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-slate-600 dark:text-slate-300">
        <span>Best <SeasonLabel season={lead.bestSeason} /></span>
        <span className="text-slate-500">2nd <SeasonLabel season={lead.secondSeason} /></span>
        {members.some((m) => m.isFar) && <Plane className="h-3.5 w-3.5 text-slate-400" aria-label="Long-haul" />}
      </div>
      <div className="mt-2 -mr-3 grid grid-cols-[1fr_50%] gap-2">
        <div className="min-w-0 flex flex-col gap-1.5">
          <dl className="rounded-md bg-slate-50 dark:bg-slate-800/60 px-2 py-1.5 space-y-0.5 tabular-nums">
            <div className="flex justify-between"><dt className="text-slate-500">Ideal</dt><dd className="font-semibold">{days} days</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Per day</dt><dd className="font-semibold">{days ? fmt(total / days) : "—"}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Total</dt><dd className="font-semibold">{fmt(total)}</dd></div>
          </dl>
          <span className="block text-slate-500"><Flag className="inline h-3 w-3 mr-1 -mt-0.5" />Difficulty: <b className="text-slate-700 dark:text-slate-200 font-medium">{hardest ?? "—"}</b></span>
        </div>
        <div className="relative min-h-[5.5rem]">
          <MiniMap lat={lead.lat} lng={lead.lng} name={name} countries={metas.flatMap((m) => m.countries)} states={metas.flatMap((m) => m.states ?? [])} points={points} />
        </div>
      </div>
      <ul className="mt-2 space-y-1">
        {members.map((m, i) => (
          <li key={m.id} onClick={(e) => { if (onOpenMember) { e.stopPropagation(); onOpenMember(m); } }}
            className="flex items-start gap-1.5 text-slate-500 cursor-pointer hover:text-slate-700 dark:hover:text-slate-200">
            <Flags codes={metas[i].flags} fallback={metas[i].icon} />
            <span className="min-w-0"><b className="font-medium text-slate-700 dark:text-slate-200">{m.name}</b> · {m.days ?? "—"} days · {m.weather ?? "—"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SortableCard({ d, rank, cellSeason, onOpen, onPin, conflicts, members, groupName, onSplit, onOpenMember }: { d: RoadmapDest; rank: number; cellSeason: string | null; onOpen: () => void; onPin: () => void; conflicts?: string[]; members?: RoadmapDest[]; groupName?: string; onSplit?: () => void; onOpenMember?: (d: RoadmapDest) => void }) {
  const pinned = members ? members.some((m) => m.pinned) : d.pinned;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: d.id, disabled: pinned });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }}
      className={`${pinned ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"} touch-none`} onClick={onOpen} {...attributes} {...listeners}>
      {members ? <GroupCard members={members} name={groupName ?? members.map((m) => m.name).join(" + ")} onPin={onPin} onSplit={onSplit} onOpenMember={onOpenMember} conflicts={conflicts} />
        : <Card_ d={d} rank={rank} cellSeason={cellSeason} onPin={onPin} conflicts={conflicts} />}
    </div>
  );
}

function Cell({ id, items, ranks, season, onOpen, onPin, wide, tint, conflicts, empty, onCombine, onSplit, onPinGroup, pairingName }: {
  conflicts?: Map<string, string[]>; empty?: boolean; onCombine?: (items: RoadmapDest[]) => void; onSplit?: (items: RoadmapDest[]) => void; onPinGroup?: (items: RoadmapDest[]) => void; pairingName?: (id: string) => string | undefined;
  id: string; items: RoadmapDest[]; ranks: Map<string, number>; season: string | null; onOpen: (d: RoadmapDest) => void; onPin: (d: RoadmapDest) => void; wide?: boolean; tint?: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `cell:${id}` });
  // Combined cards (same pairing, same cell) collapse into one entry.
  const entries: RoadmapDest[][] = [];
  for (const d of items) {
    const g = d.pairingId ? entries.find((e) => e[0].pairingId === d.pairingId) : undefined;
    if (g) g.push(d); else entries.push([d]);
  }
  return (
    <div ref={setNodeRef} style={{ background: isOver ? undefined : tint }}
      className={`min-h-[7rem] rounded-lg p-2 transition-colors border border-dashed ${
        isOver ? "bg-brand-50 dark:bg-brand-900/30 border-brand-400" : empty ? "border-red-300 dark:border-red-900 bg-red-50/60 dark:bg-red-950/20" : "border-slate-200 dark:border-slate-800"}`}>
      {entries.length >= 2 && onCombine && onSplit && (
        <div className="mb-2 flex items-center justify-end gap-1.5 text-[11px]">
          {(

            <button type="button" onClick={() => onCombine(items)} title="Combine these cards into one trip (one departure)"
              className="flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-0.5 text-slate-600 dark:text-slate-300 hover:border-brand-400 hover:text-brand-600">
              <Link2 className="h-3 w-3" />Combine
            </button>
          )}
          <button type="button" onClick={() => onSplit(items)} title="Separate these cards into different seasons of the year"
            className="flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-0.5 text-slate-600 dark:text-slate-300 hover:border-brand-400 hover:text-brand-600">
            <Unlink className="h-3 w-3" />Split
          </button>
        </div>
      )}
      <SortableContext items={entries.map((e) => e[0].id)} strategy={verticalListSortingStrategy}>
        <div className={wide ? "grid gap-2 grid-cols-[repeat(auto-fill,minmax(275px,1fr))]" : "space-y-2"}>
          {entries.map((e) => e.length > 1 ? (
            <SortableCard key={e[0].id} d={e[0]} rank={ranks.get(e[0].id) ?? 0} cellSeason={season} members={e} groupName={pairingName?.(e[0].pairingId!)}
              conflicts={[...new Set(e.flatMap((m) => conflicts?.get(m.id) ?? []))]} onOpen={() => onOpen(e[0])} onPin={() => onPinGroup?.(e)}
              onSplit={() => onSplit?.(e)} onOpenMember={onOpen} />
          ) : (
            <SortableCard key={e[0].id} d={e[0]} rank={ranks.get(e[0].id) ?? 0} cellSeason={season} onOpen={() => onOpen(e[0])} onPin={() => onPin(e[0])} conflicts={conflicts?.get(e[0].id)} />
          ))}
        </div>
      </SortableContext>
      {items.length === 0 && <div className={`h-full min-h-[5rem] flex items-center justify-center text-xs ${empty ? "text-red-500 font-medium" : "text-slate-400"}`}>{empty ? "Empty season" : "Drop here"}</div>}
    </div>
  );
}

export default function Dashboard() {
  const nav = useNavigate();
  const [data, setData] = useState<RoadmapData | null>(null);
  const [dests, setDests] = useState<RoadmapDest[]>([]);
  const [error, setError] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [arranging, setArranging] = useState(false);
  const [note, setNote] = useState("");
  const enriched = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      let r = await api.get<RoadmapData>("/roadmap");
      const needs = r.destinations.some((d) => d.status !== "VISITED" && d.planYear != null && (d.lat == null || d.suggestedYear == null || d.suggestedPriority == null));
      if (needs && !enriched.current) {
        enriched.current = true;
        await api.post("/roadmap/enrich");
        r = await api.get<RoadmapData>("/roadmap");
      }
      setData(r);
      setDests(r.destinations.filter((d) => d.status !== "VISITED"));
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const cells = useMemo(() => {
    const m = new Map<string, RoadmapDest[]>();
    for (const d of [...dests].sort((a, b) => a.priority - b.priority)) {
      const k = keyOf(d);
      m.set(k, [...(m.get(k) ?? []), d]);
    }
    return m;
  }, [dests]);
  const ranks = useMemo(() => new Map([...dests].sort((a, b) => a.priority - b.priority).map((d, i) => [d.id, i + 1])), [dests]);

  const onDragEnd = async (e: DragEndEvent) => {
    setDragId(null);
    const { active, over } = e;
    if (!over) return;
    const a = dests.find((d) => d.id === active.id);
    if (!a) return;
    // A combined card moves as one: every member of its pairing in this cell.
    const unit = a.pairingId ? dests.filter((d) => d.pairingId === a.pairingId && keyOf(d) === keyOf(a)) : [a];
    const unitIds = new Set(unit.map((d) => d.id));
    const overId = String(over.id);
    if (unitIds.has(overId)) return;
    let tkey: string;
    let idx: number;
    const sameKey = (k: string) => (cells.get(k) ?? []).filter((d) => !unitIds.has(d.id));
    if (overId.startsWith("cell:")) {
      tkey = overId.slice(5);
      idx = sameKey(tkey).length;
    } else {
      const o = dests.find((d) => d.id === overId);
      if (!o) return;
      tkey = keyOf(o);
      const rest = sameKey(tkey);
      const oi = rest.findIndex((d) => d.id === o.id);
      const full = cells.get(tkey) ?? [];
      const movingDown = tkey === keyOf(a) && full.findIndex((d) => d.id === a.id) < full.findIndex((d) => d.id === o.id);
      idx = movingDown ? oi + 1 : oi;
    }
    const order = sameKey(tkey);
    order.splice(idx, 0, ...unit);
    // Re-deal the cell's existing priority values in the new order, so the
    // global ranking of every other card is untouched.
    const pool = order.map((d) => d.priority).sort((x, y) => x - y);
    const [yearStr, season] = tkey === NONE ? [null, null] : tkey.split("|");
    const updates = order.map((d, i) => ({
      id: d.id, planYear: yearStr == null ? null : Number(yearStr), planSeason: season, priority: pool[i],
    })).filter((u) => {
      const d = dests.find((x) => x.id === u.id)!;
      return d.planYear !== u.planYear || d.planSeason !== u.planSeason || d.priority !== u.priority;
    });
    if (!updates.length) return;
    const byId = new Map(updates.map((u) => [u.id, u]));
    setDests((cur) => cur.map((d) => (byId.has(d.id) ? { ...d, ...byId.get(d.id)! } : d)));
    try { await api.post("/roadmap/reorder", updates); } catch (err: any) { setError(err.message); load(); }
  };

  const patch = async (id: string, body: Partial<RoadmapDest>) => {
    try { await api.patch(`/roadmap/destinations/${id}`, body); await load(); } catch (e: any) { setError(e.message); }
  };
  const importFile = async (f: File) => {
    try { await api.post("/roadmap/import", { markdown: await f.text() }); enriched.current = false; await load(); }
    catch (e: any) { setError(e.message); }
  };
  const togglePin = async (d: RoadmapDest) => {
    const next = dests.map((x) => (x.id === d.id ? { ...x, pinned: !d.pinned } : x));
    setDests(next);
    try { await api.patch(`/roadmap/destinations/${d.id}`, { pinned: !d.pinned }); } catch (e: any) { setError(e.message); load(); return; }
    if (data?.settings.autoOrder) await runAuto(next);
  };
  // Auto mode: search for the rule order with the fewest conflicts, save it and arrange the board.
  const runAuto = async (cur: RoadmapDest[] = dests, disabled: string[] = data?.settings.ruleDisabled ?? [], settings = data?.settings) => {
    if (!data || !settings) return;
    setArranging(true); setNote("");
    const started = Date.now();
    const before = arrangeDetailed(cur, settings, data.pairings, settings.ruleOrder ?? [], disabled).conflicts;
    const r: { order: string[]; placements: Placement[]; conflicts: number } = await new Promise((resolve) => {
      const w = new Worker(new URL("../lib/auto.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e) => { resolve(e.data); w.terminate(); };
      w.postMessage({ dests: cur, s: settings, pairings: data.pairings, start: settings.ruleOrder ?? [], disabled });
    });
    const wait = Math.max(0, 700 - (Date.now() - started));
    if (wait) await new Promise((x) => setTimeout(x, wait));
    setData((d) => (d ? { ...d, settings: { ...d.settings, ruleOrder: r.order } } : d));
    try {
      await api.patch("/roadmap/settings", { ruleOrder: r.order });
      if (r.placements.length) {
        const byId = new Map(r.placements.map((u) => [u.id, u]));
        setDests((c) => c.map((d) => (byId.has(d.id) ? { ...d, ...byId.get(d.id)! } : d)));
        await api.post("/roadmap/reorder", r.placements);
      }
    } catch (e: any) { setError(e.message); load(); }
    setArranging(false);
    setNote(`Auto order: ${r.conflicts} conflict${r.conflicts === 1 ? "" : "s"} (${before} with the previous order)`);
    setTimeout(() => setNote(""), 6000);
  };
  const toggleAuto = async (on: boolean) => {
    if (!data) return;
    const settings = { ...data.settings, autoOrder: on };
    setData({ ...data, settings });
    try { await api.patch("/roadmap/settings", { autoOrder: on }); } catch (e: any) { setError(e.message); load(); return; }
    if (on) await runAuto(dests, settings.ruleDisabled ?? [], settings);
  };
  // Re-arrange every unpinned card for the given rule order, immediately.
  const applyRules = async (ruleOrder: string[], disabled: string[] = data?.settings.ruleDisabled ?? []) => {
    if (!data) return;
    if (data.settings.autoOrder) return runAuto(dests, disabled);
    setArranging(true); setNote("");
    // Let the spinner paint before the (synchronous) search runs, and keep it visible long enough to notice.
    await new Promise((r) => setTimeout(r, 60));
    const started = Date.now();
    const updates = arrange(dests, data.settings, data.pairings, ruleOrder, disabled);
    const wait = Math.max(0, 700 - (Date.now() - started));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    if (updates.length) {
      const byId = new Map(updates.map((u) => [u.id, u]));
      setDests((cur) => cur.map((d) => (byId.has(d.id) ? { ...d, ...byId.get(d.id)! } : d)));
      try { await api.post("/roadmap/reorder", updates); } catch (e: any) { setError(e.message); load(); }
    }
    setArranging(false);
    setNote(updates.length ? `Rearranged ${updates.length} card${updates.length === 1 ? "" : "s"}` : "No cards needed to move for this order");
    setTimeout(() => setNote(""), 4000);
  };
  const pairingName = (id: string) => data?.pairings.find((p) => p.id === id)?.name;
  const pinGroup = async (members: RoadmapDest[]) => {
    const value = !members.every((m) => m.pinned);
    const ids = new Set(members.map((m) => m.id));
    const next = dests.map((x) => (ids.has(x.id) ? { ...x, pinned: value } : x));
    setDests(next);
    try { await Promise.all(members.map((m) => api.patch(`/roadmap/destinations/${m.id}`, { pinned: value }))); } catch (e: any) { setError(e.message); load(); return; }
    if (data?.settings.autoOrder) await runAuto(next);
  };
  const combine = async (items: RoadmapDest[]) => {
    setNote("");
    try {
      await api.post("/roadmap/combine", { ids: items.map((d) => d.id), name: items.map((d) => d.name.split(/[ (]/)[0]).join(" + ") });
      await load(); setNote(`Combined ${items.length} cards into one trip`);
    } catch (e: any) { setError(e.message); }
    setTimeout(() => setNote(""), 4000);
  };
  // Un-combine and spread the cards over different seasons of the same year.
  const split = async (items: RoadmapDest[]) => {
    setNote("");
    const year = items[0].planYear;
    const ids = new Set(items.map((d) => d.id));
    const taken = new Set(dests.filter((d) => d.planYear === year && !ids.has(d.id) && d.planSeason).map((d) => d.planSeason!));
    const moves: { id: string; planSeason: string | null }[] = [];
    let stuck = 0;
    for (const d of items) {
      const options = [d.planSeason, d.bestSeason, d.secondSeason, ...SEASONS].filter((x): x is string => !!x);
      const pick = options.find((x) => !taken.has(x));
      if (pick) taken.add(pick); else stuck++;
      moves.push({ id: d.id, planSeason: pick ?? d.planSeason });
    }
    try {
      await api.post("/roadmap/split", moves);
      await load();
      setNote(stuck ? `Split, but ${stuck} card${stuck === 1 ? "" : "s"} stay${stuck === 1 ? "s" : ""} here: every season of ${year} is taken` : `Split ${items.length} cards into separate seasons`);
    } catch (e: any) { setError(e.message); }
    setTimeout(() => setNote(""), 5000);
  };
  const toggleRule = async (id: string, enabled: boolean) => {
    const cur = data?.settings.ruleDisabled ?? [];
    const next = enabled ? cur.filter((x) => x !== id) : [...new Set([...cur, id])];
    setData((d) => (d ? { ...d, settings: { ...d.settings, ruleDisabled: next } } : d));
    try { await api.patch("/roadmap/settings", { ruleDisabled: next }); } catch (e: any) { setError(e.message); load(); return; }
    await applyRules(order, next);
  };
  const reorderRules = async (ids: string[]) => {
    if (data?.settings.autoOrder) return;
    setData((cur) => (cur ? { ...cur, settings: { ...cur.settings, ruleOrder: ids } } : cur));
    try { await api.patch("/roadmap/settings", { ruleOrder: ids }); } catch (e: any) { setError(e.message); load(); return; }
    await applyRules(ids);
  };
  const openTrip = async (d: RoadmapDest) => {
    if (d.trips[0]) return nav(`/trips/${d.trips[0].id}`);
    const t = await api.post<{ id: string }>("/trips", { title: `Trip to ${d.name}`, destinationId: d.id, status: "PLANNING" });
    nav(`/trips/${t.id}`);
  };

  if (!data) return error ? <p className="text-sm text-red-600">{error}</p> : <Skeleton className="h-96 w-full rounded-xl" />;

  const s = data.settings;
  const years = summarize({ settings: s, pairings: data.pairings, destinations: dests });
  const conflicts = cardConflicts(dests, s, data.pairings);
  const empties = emptySlots(dests, s);
  const gapOn = !(s.ruleDisabled ?? []).includes("gaps");
  const movedCount = dests.filter((d) => isMoved(d) && !d.pinned).length;
  const pinnedCount = dests.filter((d) => d.pinned).length;
  const order = s.ruleOrder ?? [];
  const checks = ruleChecks(years, s, data.pairings, dests).sort((a, b) => {
    const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const dragging = dests.find((d) => d.id === dragId) ?? null;
  const sel = dests.find((d) => d.id === selected) ?? null;
  const backlog = cells.get(NONE) ?? [];

  if (!dests.length) {
    return (
      <Card className="p-10 text-center text-sm text-slate-500">
        <p className="mb-4">Nothing to plan yet. Import your portfolio summary to fill the board.</p>
        <input ref={fileRef} type="file" accept=".md,text/markdown,text/plain" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ""; }} />
        <Button onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4 mr-1.5" />Import markdown</Button>
        {error && <p className="mt-3 text-red-600">{error}</p>}
      </Card>
    );
  }

  return (
    <div>
      <WorldMapDefs />
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-display font-semibold">Dashboard</h1>
          <p className="text-sm text-slate-500 mt-1">Cards are placed by the prioritization rules — drag one anywhere to override.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant={showRules ? "primary" : "secondary"} onClick={() => setShowRules((v) => !v)}>
            <ScrollText className="h-4 w-4 mr-1.5" />Prioritization rules
          </Button>
          <Button variant="secondary" disabled={arranging} onClick={() => applyRules(order)}
            title={pinnedCount ? `Re-apply the rules; ${pinnedCount} pinned card(s) stay put` : "Re-apply the rules to every card"}>
            {arranging ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-1.5" />}Reset unpinned
          </Button>
          <Link to="/budget" className="inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700">
            <Wallet className="h-4 w-4 mr-1.5" />Budget &amp; guardrails
          </Link>
        </div>
      </div>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      <div aria-live="polite" className="h-5 mb-1 text-xs text-slate-500">{note}</div>

      <AnimatePresence initial={false}>
        {showRules && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <Card className="p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold">Prioritization rules</h2>
                <Link to="/budget" className="text-xs text-brand-600 hover:underline">Edit limits on Budget</Link>
              </div>
              <label className="flex items-center gap-2 mb-2 text-sm cursor-pointer w-fit">
                <button type="button" role="switch" aria-checked={!!s.autoOrder} disabled={arranging} onClick={() => toggleAuto(!s.autoOrder)}
                  className={`relative h-5 w-9 rounded-full transition-colors ${s.autoOrder ? "bg-brand-600" : "bg-slate-300 dark:bg-slate-600"}`}>
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${s.autoOrder ? "left-[18px]" : "left-0.5"}`} />
                </button>
                <span className="font-medium">Auto order</span>
                <span className="text-xs text-slate-500">finds the rule order with the fewest conflicts</span>
              </label>
              <p className="text-xs text-slate-500 mb-3">{s.autoOrder ? "Auto order is on: the list shows the best order found and re-runs when you pin a card or switch a rule. Switch it off to drag rules yourself." : "Drag the rules into the order that matters most — #1 wins conflicts. Unpinned cards re-arrange as soon as you drop."}</p>
              <RuleList checks={checks} locked={!!s.autoOrder} onReorder={reorderRules} onToggle={toggleRule} />
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      <DndContext sensors={sensors} collisionDetection={closestCorners}
        onDragStart={(e: DragStartEvent) => setDragId(String(e.active.id))} onDragEnd={onDragEnd} onDragCancel={() => setDragId(null)}>
        <div className="relative overflow-x-auto pb-2">
          <AnimatePresence>
            {arranging && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="absolute inset-0 z-20 flex items-start justify-center pt-24 bg-white/60 dark:bg-slate-950/60 backdrop-blur-[2px]">
                <div className="sticky top-24 flex items-center gap-2 rounded-full bg-white dark:bg-slate-900 px-4 py-2 text-sm font-medium shadow-lg ring-1 ring-slate-200 dark:ring-slate-700">
                  <Loader2 className="h-4 w-4 animate-spin text-brand-600" />Rearranging cards…
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="grid gap-2 min-w-[1260px]" style={{ gridTemplateColumns: "150px repeat(4, minmax(275px, 1fr))" }}>
            <div />
            {SEASONS.map((sn) => {
              const m = SEASON_META[sn];
              return (
                <div key={sn} className="sticky top-0 z-10 flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-white" style={{ background: m.color }}>
                  <m.Icon className="h-4 w-4" />{sn}
                </div>
              );
            })}
            {years.map((y) => (
              <React.Fragment key={y.year}>
                <RowHeader y={y} s={s} />
                {SEASONS.map((sn) => (
                  <Cell key={sn} id={`${y.year}|${sn}`} items={cells.get(`${y.year}|${sn}`) ?? []} ranks={ranks} season={sn} conflicts={conflicts} onCombine={combine} onSplit={split} onPinGroup={pinGroup} pairingName={pairingName} empty={gapOn && empties.has(`${y.year}|${sn}`)}
                    onOpen={(d) => setSelected(d.id)} onPin={togglePin} tint={`color-mix(in srgb, ${SEASON_META[sn].color} 6%, transparent)`} />
                ))}
              </React.Fragment>
            ))}
            <div className="py-2 text-sm font-semibold text-slate-600 dark:text-slate-300">Unscheduled<div className="text-xs font-normal text-slate-400">{backlog.length} cards</div></div>
            <div className="col-span-4">
              <Cell id={NONE} items={backlog} ranks={ranks} season={null} onOpen={(d) => setSelected(d.id)} onPin={togglePin} wide />
            </div>
          </div>
        </div>
        <DragOverlay dropAnimation={{ duration: 180 }}>
          {dragging && <div className="w-[275px]">{dragging.pairingId && dests.filter((d) => d.pairingId === dragging.pairingId && keyOf(d) === keyOf(dragging)).length > 1
            ? <GroupCard members={dests.filter((d) => d.pairingId === dragging.pairingId && keyOf(d) === keyOf(dragging))} name={pairingName(dragging.pairingId) ?? dragging.name} overlay />
            : <Card_ d={dragging} rank={ranks.get(dragging.id) ?? 0} cellSeason={null} overlay />}</div>}
        </DragOverlay>
      </DndContext>

      <AnimatePresence>
        {sel && <Drawer d={sel} s={s} onClose={() => setSelected(null)} patch={patch} openTrip={openTrip} />}
      </AnimatePresence>
    </div>
  );
}

function RowHeader({ y, s }: { y: ReturnType<typeof summarize>[number]; s: RoadmapSettings }) {
  const over = y.spend > s.annualCap;
  const pct = Math.min(100, (y.spend / s.annualCap) * 100);
  return (
    <div className={`rounded-lg bg-white dark:bg-slate-900 border p-3 text-xs self-start sticky left-0 ${y.warnings.length ? "border-red-300 dark:border-red-900 ring-1 ring-red-300/60 dark:ring-red-900/60" : "border-slate-200 dark:border-slate-800"}`}>
      <div className="flex items-baseline justify-between">
        <span className="text-lg font-display font-semibold">{y.year}</span>
        {y.warnings.length > 0 && <span title={y.warnings.join("\n")} className="flex items-center gap-0.5 rounded-full bg-red-50 dark:bg-red-950/50 px-1.5 py-0.5 text-red-600 font-medium"><AlertTriangle className="h-3.5 w-3.5" />{y.warnings.length}</span>}
      </div>
      <div className="text-slate-400 mb-2">{y.ageA != null ? `Ages ${y.ageA} & ${y.ageB}` : ""}</div>
      <dl className="space-y-0.5 tabular-nums">
        <div className="flex justify-between"><dt className="text-slate-500">Travel days</dt><dd className="font-semibold">{y.days}</dd></div>
        <div className="flex justify-between"><dt className="text-slate-500">Cost / day</dt><dd className="font-semibold">{y.days ? fmt(y.spend / y.days) : "—"}</dd></div>
        <div className="flex justify-between"><dt className="text-slate-500">Total</dt><dd className={`font-semibold ${over ? "text-red-600" : ""}`}>{fmt(y.spend)}</dd></div>
      </dl>
      <div className="mt-2 h-1 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden" title={`${Math.round((y.spend / s.annualCap) * 100)}% of annual cap`}>
        <motion.div className="h-full" style={{ background: over ? "var(--viz-bad)" : "var(--viz-bar)" }} animate={{ width: `${pct}%` }} transition={{ duration: 0.4 }} />
      </div>
    </div>
  );
}

function Drawer({ d, s, onClose, patch, openTrip }: {
  d: RoadmapDest; s: RoadmapSettings; onClose: () => void;
  patch: (id: string, b: Partial<RoadmapDest>) => void; openTrip: (d: RoadmapDest) => void;
}) {
  const years = Array.from({ length: s.endYear - s.startYear + 1 }, (_, i) => s.startYear + i);
  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <label className="block text-xs text-slate-500">{label}<div className="mt-1">{children}</div></label>
  );
  return (
    <>
      <motion.div className="fixed inset-0 bg-black/30 z-30" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.aside className="fixed right-0 top-0 bottom-0 w-96 max-w-full z-40 bg-white dark:bg-slate-900 shadow-2xl p-5 overflow-y-auto"
        initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ type: "spring", stiffness: 400, damping: 40 }}>
        <div className="flex items-start justify-between mb-4">
          <h2 className="text-lg font-display font-semibold">{d.name}</h2>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700"><X className="h-5 w-5" /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Year"><Select value={d.planYear ?? ""} onChange={(e) => patch(d.id, { planYear: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Unscheduled</option>{years.map((y) => <option key={y}>{y}</option>)}</Select></Field>
          <Field label="Planned season"><Select value={d.planSeason ?? ""} onChange={(e) => patch(d.id, { planSeason: e.target.value || null })}>
            <option value="">—</option>{SEASONS.map((x) => <option key={x}>{x}</option>)}</Select></Field>
          <Field label="Best season"><Select value={d.bestSeason ?? ""} onChange={(e) => patch(d.id, { bestSeason: e.target.value || null })}>
            <option value="">—</option>{SEASONS.map((x) => <option key={x}>{x}</option>)}</Select></Field>
          <Field label="2nd best season"><Select value={d.secondSeason ?? ""} onChange={(e) => patch(d.id, { secondSeason: e.target.value || null })}>
            <option value="">—</option>{SEASONS.map((x) => <option key={x}>{x}</option>)}</Select></Field>
          <Field label="Ideal duration (days)"><NumCell w="100%" value={d.days} onSave={(n) => patch(d.id, { days: n })} /></Field>
          <Field label="Cost per day"><NumCell w="100%" value={d.dailyCost} onSave={(n) => patch(d.id, { dailyCost: n })} /></Field>
          <Field label="Transit cost"><NumCell w="100%" value={d.transitCost} onSave={(n) => patch(d.id, { transitCost: n })} /></Field>
          <Field label="Difficulty"><Select value={d.mobility ?? ""} onChange={(e) => patch(d.id, { mobility: e.target.value || null })}>
            <option value="">—</option>{MOBILITY.map((x) => <option key={x}>{x}</option>)}</Select></Field>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={d.pinned} onChange={(e) => patch(d.id, { pinned: e.target.checked })} />Pin in place (reset leaves it alone)</label>
        <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={d.isFar} onChange={(e) => patch(d.id, { isFar: e.target.checked })} />Long-haul (counts toward the far-trip limit)</label>
        <div className="mt-4 rounded-md bg-slate-50 dark:bg-slate-800/60 p-3 text-sm">Total estimated cost <b className="float-right tabular-nums">{fmt(destCost(d))}</b></div>
        {d.notes && <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">{d.notes}</p>}
        <Button className="mt-5 w-full" onClick={() => openTrip(d)}>{d.trips[0] ? "Open trip" : "Plan trip"}</Button>
      </motion.aside>
    </>
  );
}

function RuleRow({ c, index, onToggle }: { c: RuleCheck; index: number; onToggle: (id: string, enabled: boolean) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: c.id });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : c.enabled ? 1 : 0.55 }}
      className="flex items-start gap-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 text-sm">
      <button type="button" aria-label={`Drag rule ${c.title}`} className="mt-0.5 cursor-grab touch-none text-slate-400 hover:text-slate-600 active:cursor-grabbing" {...attributes} {...listeners}>
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-100 dark:bg-brand-900/50 text-xs font-semibold text-brand-700 dark:text-brand-200">{index + 1}</span>
      <div className="min-w-0 flex-1">
        <div className="font-medium leading-snug">{c.title}</div>
        <div className="text-xs text-slate-500 mt-0.5">{c.detail}</div>
      </div>
      <div className={`flex shrink-0 items-center gap-1 text-xs font-semibold ${c.status === "warn" ? "text-amber-600" : c.status === "ok" ? "text-green-600" : "text-slate-400"}`}>
        {c.status === "ok" ? <CheckCircle2 className="h-4 w-4" /> : c.status === "warn" ? <AlertTriangle className="h-4 w-4" /> : <Info className="h-4 w-4" />}
        {c.result}
      </div>
      <button type="button" role="switch" aria-checked={c.enabled} aria-label={`${c.enabled ? "Turn off" : "Turn on"}: ${c.title}`}
        onClick={() => onToggle(c.id, !c.enabled)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${c.enabled ? "bg-brand-600" : "bg-slate-300 dark:bg-slate-700"}`}>
        <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${c.enabled ? "translate-x-4" : ""}`} />
      </button>
    </li>
  );
}

function RuleList({ checks, locked, onReorder, onToggle }: { checks: RuleCheck[]; locked?: boolean; onReorder: (ids: string[]) => void; onToggle: (id: string, enabled: boolean) => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const ids = checks.map((c) => c.id);
  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={(e: DragEndEvent) => {
      if (locked || !e.over || e.active.id === e.over.id) return;
      onReorder(arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))));
    }}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ol className="space-y-2">{checks.map((c, i) => <RuleRow key={c.id} c={c} index={i} onToggle={onToggle} />)}</ol>
      </SortableContext>
    </DndContext>
  );
}
