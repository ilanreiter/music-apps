import { Pairing, RoadmapDest, RoadmapSettings } from "../types";

export const SEASONS = ["Winter", "Spring", "Summer", "Fall"];

/** Empty season slots that sit before the last scheduled trip (gaps in the calendar). */
export function seasonGaps(cells: { year: number; season: string | null }[], startYear: number) {
  const idx = new Set<number>();
  for (const c of cells) {
    const si = c.season ? SEASONS.indexOf(c.season) : -1;
    if (si >= 0) idx.add((c.year - startYear) * 4 + si);
  }
  if (!idx.size) return 0;
  return Math.max(...idx) + 1 - idx.size;
}
export const MOBILITY = ["Easy", "Easy-Moderate", "Moderate", "Moderate-High", "High"];

/** Cost multiplier for the season a trip is planned in (1 = the listed best-season cost). */
export const seasonFactor = (d: Pick<RoadmapDest, "planSeason" | "seasonFactors">) => (d.planSeason && d.seasonFactors?.[d.planSeason]) || 1;
/** Trip cost: (days × cost per day + airfare), adjusted for the planned season. */
export const destCost = (d: RoadmapDest) => ((d.days ?? 0) * (d.dailyCost ?? 0) + (d.transitCost ?? 0)) * seasonFactor(d);
export const dailyRate = (d: RoadmapDest) => (d.dailyCost ?? 0) * seasonFactor(d);
export const difficultyLevel = (m: string | null) => (m ? MOBILITY.indexOf(m) + 1 : 0);

/**
 * Cards of year-ordered `{ level, year }` where an easier trip is scheduled in an
 * EARLIER year than a harder one (harder trips should come first). Returns the
 * number of out-of-order pairs and how many distinct trips are involved.
 */
export function difficultyInversions(items: { id: string; level: number; year: number }[]) {
  const byYear = new Map<number, { id: string; level: number }[]>();
  for (const c of items) if (c.level > 0) byYear.set(c.year, [...(byYear.get(c.year) ?? []), c]);
  const seen = [0, 0, 0, 0, 0, 0];
  let pairs = 0;
  const bad = new Set<string>();
  for (const y of [...byYear.keys()].sort((a, b) => a - b)) {
    const group = byYear.get(y)!;
    for (const c of group) {
      let n = 0;
      for (let l = 1; l < c.level; l++) n += seen[l];
      if (n) { pairs += n; bad.add(c.id); }
    }
    for (const c of group) seen[c.level]++;
  }
  return { pairs, trips: bad.size, ids: bad };
}

export const isHighMobility = (d: RoadmapDest) => d.mobility === "High" || d.mobility === "Moderate-High";

export interface YearSummary {
  year: number;
  ageA: number | null;
  ageB: number | null;
  dests: RoadmapDest[];
  departures: number;
  far: number;
  days: number;
  spend: number;
  cumulative: number;
  warnings: string[];
}

/** A "departure" is a standalone destination or one whole pairing. */
function departures(dests: RoadmapDest[]) {
  const keys = new Set(dests.map((d) => d.pairingId ?? d.id));
  return keys.size;
}

export function summarize(data: { settings: RoadmapSettings; pairings: Pairing[]; destinations: RoadmapDest[] }): YearSummary[] {
  const { settings: s, pairings } = data;
  const planned = data.destinations.filter((d) => d.planYear != null && d.status !== "VISITED");
  const out: YearSummary[] = [];
  const off = new Set(s.ruleDisabled ?? []);
  const on = (id: string) => !off.has(id);
  let cumulative = 0;
  for (let year = s.startYear; year <= s.endYear; year++) {
    const dests = planned.filter((d) => d.planYear === year).sort((a, b) => a.priority - b.priority);
    // A pairing is a single long-haul departure, however many members are far.
    const farKeys = new Set(dests.filter((d) => d.isFar).map((d) => d.pairingId ?? d.id));
    const spend = dests.reduce((t, d) => t + destCost(d), 0);
    cumulative += spend;
    const warnings: string[] = [];
    if (on("far") && farKeys.size > s.maxFarPerYear) warnings.push(`${farKeys.size} far trips (max ${s.maxFarPerYear})`);
    if (on("cap") && spend > s.annualCap) warnings.push(`Over annual cap by ${Math.round(((spend - s.annualCap) / s.annualCap) * 100)}%`);
    if (on("mobility") && s.highMobilityUntil != null && year > s.highMobilityUntil) {
      const hm = dests.filter(isHighMobility).map((d) => d.name);
      if (hm.length) warnings.push(`Demanding trip after ${s.highMobilityUntil}: ${hm.join(", ")}`);
    }
    const perSeason = new Map<string, Set<string>>();
    for (const d of dests) perSeason.set(d.planSeason ?? "", (perSeason.get(d.planSeason ?? "") ?? new Set()).add(d.pairingId ?? d.id));
    if (on("quarter")) for (const [sn, v] of perSeason) if (sn && v.size > 1) warnings.push(`${v.size} trips in ${sn}`);
    for (const d of on("season") ? dests : []) {
      if (d.bestSeason && d.planSeason && d.bestSeason !== d.planSeason && d.secondSeason !== d.planSeason)
        warnings.push(`${d.name}: planned ${d.planSeason}, best in ${d.bestSeason}`);
    }
    for (const p of on("pair") ? pairings : []) {
      const members = dests.filter((d) => d.pairingId === p.id);
      const all = planned.filter((d) => d.pairingId === p.id);
      if (members.length && members.length < all.length) warnings.push(`Pairing "${p.name}" is split across years`);
    }
    out.push({
      year, dests, departures: departures(dests), far: farKeys.size,
      days: dests.reduce((t, d) => t + (d.days ?? 0), 0), spend, cumulative, warnings,
      ageA: s.ageA != null ? s.ageA + (year - s.startYear) : null,
      ageB: s.ageB != null ? s.ageB + (year - s.startYear) : null,
    });
  }
  return out;
}

export const fmt = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export interface RuleCheck { id: string; title: string; detail: string; status: "ok" | "warn" | "info" | "off"; result: string; enabled: boolean }

/** Live status of each prioritization rule against the current board. */
export function ruleChecks(years: YearSummary[], s: RoadmapSettings, pairings: Pairing[], dests: RoadmapDest[]): RuleCheck[] {
  const placed = dests.filter((d) => d.planYear != null && d.status !== "VISITED");
  const farBad = years.filter((y) => y.far > s.maxFarPerYear).length;
  const overBad = years.filter((y) => y.spend > s.annualCap).length;
  const late = s.highMobilityUntil == null ? [] : placed.filter((d) => isHighMobility(d) && d.planYear! > s.highMobilityUntil!);
  const inv = difficultyInversions(placed.map((d) => ({ id: d.id, level: difficultyLevel(d.mobility), year: d.planYear! })));
  const mobBad = Math.max(late.length, inv.trips);
  const off = placed.filter((d) => d.planSeason && d.bestSeason && d.planSeason !== d.bestSeason && d.planSeason !== d.secondSeason);
  const split = pairings.filter((p) => new Set(placed.filter((d) => d.pairingId === p.id).map((d) => d.planYear)).size > 1);
  const cells = new Map<string, Set<string>>();
  for (const d of placed) {
    const k = `${d.planYear}|${d.planSeason}`;
    cells.set(k, (cells.get(k) ?? new Set()).add(d.pairingId ?? d.id));
  }
  const crowded = [...cells.values()].filter((v) => v.size > 1).length;
  const gaps = seasonGaps(placed.map((d) => ({ year: d.planYear!, season: d.planSeason })), s.startYear);
  const n = (c: number, unit: string) => (c === 0 ? "All good" : `${c} ${unit}`);
  const disabled = new Set(s.ruleDisabled ?? []);
  const raw: Omit<RuleCheck, "enabled">[] = [
    { id: "far", title: `At most ${s.maxFarPerYear} long-haul trips a year`, detail: "Prevents jet-lag burnout; a pairing counts as one departure.", status: farBad ? "warn" : "ok", result: n(farBad, farBad === 1 ? "year over" : "years over") },
    { id: "cap", title: "Stay under the annual spend cap", detail: "Each year's total stays beneath the yearly ceiling.", status: overBad ? "warn" : "ok", result: n(overBad, overBad === 1 ? "year over" : "years over") },
    { id: "mobility", title: s.highMobilityUntil ? `Demanding trips first (through ${s.highMobilityUntil})` : "Demanding trips first", detail: "Harder trips (altitude, bush, self-drive) go earliest while energy is highest, easing off year by year toward rail and slow travel.", status: mobBad ? "warn" : "ok", result: n(mobBad, mobBad === 1 ? "trip out of difficulty order" : "trips out of difficulty order") },
    { id: "season", title: "Travel in the best or 2nd-best season", detail: "Escape New England winters; use shoulder seasons in Europe.", status: off.length ? "warn" : "ok", result: n(off.length, off.length === 1 ? "off-season trip" : "off-season trips") },
    { id: "quarter", title: "One trip per season", detail: "No more than one departure in any season of a year; a pairing counts as one trip.", status: crowded ? "warn" : "ok", result: n(crowded, crowded === 1 ? "crowded season" : "crowded seasons") },
    { id: "gaps", title: "No empty seasons", detail: "Fill every season from the first year onward before leaving gaps; empty seasons after the last trip are fine.", status: gaps ? "warn" : "ok", result: n(gaps, gaps === 1 ? "empty season" : "empty seasons") },
    { id: "pair", title: "Keep regional pairings together", detail: "Paired destinations share one departure and save airfare.", status: split.length ? "warn" : "ok", result: n(split.length, split.length === 1 ? "pairing split" : "pairings split") },
    { id: "rank", title: "Rank order sets the sequence", detail: "Cards start in rank order (#1, #2…). Dragging overrides; pinned cards never move when you reset.", status: "info", result: "Info" },
  ];
  return raw.map((r) => (disabled.has(r.id) ? { ...r, status: "off" as const, result: "Off", enabled: false } : { ...r, enabled: true }));
}

/** Per-card list of the enabled rules each placed card currently breaks (for highlighting). */
export function cardConflicts(dests: RoadmapDest[], s: RoadmapSettings, pairings: Pairing[]): Map<string, string[]> {
  const placed = dests.filter((d) => d.planYear != null && d.status !== "VISITED");
  const off = new Set(s.ruleDisabled ?? []);
  const on = (id: string) => !off.has(id);
  const out = new Map<string, string[]>();
  const add = (d: RoadmapDest, msg: string) => out.set(d.id, [...(out.get(d.id) ?? []), msg]);
  const byYear = new Map<number, RoadmapDest[]>();
  for (const d of placed) byYear.set(d.planYear!, [...(byYear.get(d.planYear!) ?? []), d]);
  if (on("far")) for (const [y, list] of byYear) {
    const keys = new Set(list.filter((d) => d.isFar).map((d) => d.pairingId ?? d.id));
    if (keys.size > s.maxFarPerYear) for (const d of list) if (d.isFar) add(d, `Long-haul: ${keys.size} far trips in ${y} (max ${s.maxFarPerYear})`);
  }
  if (on("mobility")) {
    const inv = difficultyInversions(placed.map((d) => ({ id: d.id, level: difficultyLevel(d.mobility), year: d.planYear! })));
    for (const d of placed) {
      if (s.highMobilityUntil != null && isHighMobility(d) && d.planYear! > s.highMobilityUntil) add(d, `Demanding trip after ${s.highMobilityUntil}`);
      else if (inv.ids.has(d.id)) add(d, "Easier trips are scheduled before this harder one");
    }
  }
  for (const d of placed) {
    if (!d.planSeason || !d.bestSeason) continue;
    if (on("season") && d.planSeason !== d.bestSeason && d.planSeason !== d.secondSeason) add(d, `Off-season: best in ${d.bestSeason}`);
  }
  if (on("quarter")) {
    const cells = new Map<string, RoadmapDest[]>();
    for (const d of placed) cells.set(`${d.planYear}|${d.planSeason}`, [...(cells.get(`${d.planYear}|${d.planSeason}`) ?? []), d]);
    for (const list of cells.values()) if (new Set(list.map((d) => d.pairingId ?? d.id)).size > 1) for (const d of list) add(d, "More than one trip in this season");
  }
  if (on("pair")) for (const p of pairings) {
    const m = placed.filter((d) => d.pairingId === p.id);
    if (new Set(m.map((d) => d.planYear)).size > 1) for (const d of m) add(d, `Pairing "${p.name}" is split across years`);
  }
  return out;
}

/** Season slots ("year|Season") left empty before the last scheduled trip. */
export function emptySlots(dests: RoadmapDest[], s: RoadmapSettings): Set<string> {
  const used = new Set<number>();
  for (const d of dests) {
    if (d.planYear == null || d.status === "VISITED") continue;
    const si = d.planSeason ? SEASONS.indexOf(d.planSeason) : -1;
    if (si >= 0) used.add((d.planYear - s.startYear) * 4 + si);
  }
  const out = new Set<string>();
  if (!used.size) return out;
  const last = Math.max(...used);
  for (let i = 0; i < last; i++) if (!used.has(i)) out.add(`${s.startYear + Math.floor(i / 4)}|${SEASONS[i % 4]}`);
  return out;
}
