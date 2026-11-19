import { Pairing, RoadmapDest, RoadmapSettings } from "../types";
import { destCost, difficultyInversions, difficultyLevel, isHighMobility, seasonGaps } from "./roadmap";

export const DEFAULT_RULE_ORDER = ["far", "cap", "mobility", "season", "quarter", "gaps", "pair", "rank"];

export interface Placement { id: string; planYear: number | null; planSeason: string | null; priority: number }

/** Weighted violation score: a higher-ranked rule always outweighs every lower one. */
function score(
  cards: { d: RoadmapDest; year: number }[], s: RoadmapSettings, pairings: Pairing[],
  order: string[], disabled: string[], suggested: Map<string, number>,
): number[] {
  const years = new Map<number, { d: RoadmapDest; year: number }[]>();
  for (const c of cards) years.set(c.year, [...(years.get(c.year) ?? []), c]);
  let far = 0, cap = 0;
  for (const list of years.values()) {
    const farKeys = new Set(list.filter((c) => c.d.isFar).map((c) => c.d.pairingId ?? c.d.id));
    far += Math.max(0, farKeys.size - s.maxFarPerYear);
    const spend = list.reduce((t, c) => t + destCost(c.d), 0);
    if (spend > s.annualCap) cap += 1 + (spend - s.annualCap) / s.annualCap; // count + gradient
  }
  // Harder trips earlier: count easier-before-harder pairs, plus any demanding trip past the cutoff year.
  const cutoff = s.highMobilityUntil == null ? 0 : cards.filter((c) => isHighMobility(c.d) && c.year > s.highMobilityUntil!).length;
  const mobility = cutoff + difficultyInversions(cards.map((c) => ({ id: c.d.id, level: difficultyLevel(c.d.mobility), year: c.year }))).pairs;
  const season = cards.filter((c) => c.d.planSeason && c.d.bestSeason && c.d.planSeason !== c.d.bestSeason && c.d.planSeason !== c.d.secondSeason).length;
  const pair = pairings.filter((p) => new Set(cards.filter((c) => c.d.pairingId === p.id).map((c) => c.year)).size > 1).length;
  const quarters = new Map<string, Set<string>>();
  for (const c of cards) {
    const k = `${c.year}|${c.d.planSeason}`;
    quarters.set(k, (quarters.get(k) ?? new Set()).add(c.d.pairingId ?? c.d.id));
  }
  const quarter = [...quarters.values()].reduce((t, v) => t + Math.max(0, v.size - 1), 0);
  const gaps = seasonGaps(cards.map((c) => ({ year: c.year, season: c.d.planSeason })), s.startYear);
  let drift = 0;
  for (const c of cards) drift += Math.abs(c.year - (suggested.get(c.d.id) ?? c.year));
  const vals: Record<string, number> = { far, cap, mobility, season, quarter, gaps, pair, rank: 0 };
  // Lexicographic vector: rule 1's violations, then rule 2's, ... then drift from the plan.
  return [...order.map((id) => (disabled.includes(id) ? 0 : vals[id] ?? 0)), drift];
}

/**
 * Re-arranges every UNPINNED card: start from the plan's suggested slot, then
 * move/swap whole units (a pairing moves as one) between years while that lowers
 * the weighted rule violations. Pinned cards never move.
 */
export function arrange(dests: RoadmapDest[], s: RoadmapSettings, pairings: Pairing[], ruleOrder: string[], disabled: string[] = []): Placement[] {
  const order = [...ruleOrder, ...DEFAULT_RULE_ORDER.filter((r) => !ruleOrder.includes(r))];

  const cards = dests.filter((d) => d.status !== "VISITED" && d.suggestedYear != null);
  const suggested = new Map(cards.map((d) => [d.id, d.suggestedYear!]));
  const year = new Map<string, number>();
  for (const d of cards) year.set(d.id, d.pinned ? d.planYear ?? d.suggestedYear! : d.suggestedYear!);

  // Pairing members follow a pinned member; a group with a pinned member is fixed.
  const groups = new Map<string, RoadmapDest[]>();
  for (const d of cards) groups.set(d.pairingId ?? d.id, [...(groups.get(d.pairingId ?? d.id) ?? []), d]);
  const units: RoadmapDest[][] = [];
  for (const g of groups.values()) {
    const pinned = g.find((d) => d.pinned);
    if (pinned) { for (const d of g) if (!d.pinned) year.set(d.id, year.get(pinned.id)!); }
    else units.push(g);
  }
  units.sort((a, b) => Math.max(...b.map((d) => d.priority)) - Math.max(...a.map((d) => d.priority)));

  const seasonOf = new Map(cards.map((d) => [d.id, d.pinned ? d.planSeason : d.suggestedSeason ?? d.planSeason]));
  const suggestedSeason = new Map(cards.map((d) => [d.id, d.suggestedSeason ?? d.planSeason]));
  const view = () => cards.map((d) => ({ d: { ...d, planSeason: d.pinned ? d.planSeason : seasonOf.get(d.id) ?? d.planSeason }, year: year.get(d.id)! }));
  const total = () => score(view(), s, pairings, order, disabled, suggested);
  // True when vector a is lexicographically smaller than b (higher-ranked rules always win).
  const less = (a: number[], b: number[]) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i] - 1e-9) return true; if (a[i] > b[i] + 1e-9) return false; } return false; };
  const yearsRange = Array.from({ length: s.endYear - s.startYear + 1 }, (_, i) => s.startYear + i);
  const setUnit = (u: RoadmapDest[], y: number) => u.forEach((d) => year.set(d.id, y));

  let best = total();
  for (let iter = 0; iter < 150; iter++) {
    let move: (() => void) | null = null;
    let bestScore = best;
    for (const u of units) {
      const from = year.get(u[0].id)!;
      const fromSeason = seasonOf.get(u[0].id) ?? null;
      // A lone card may also switch between its best and 2nd-best season.
      const seasons = u.length === 1 ? [...new Set([u[0].bestSeason, u[0].secondSeason, fromSeason].filter(Boolean))] as string[] : [fromSeason];
      for (const y of yearsRange) for (const sn of seasons) {
        if (y === from && sn === fromSeason) continue;
        setUnit(u, y); if (u.length === 1) seasonOf.set(u[0].id, sn);
        const sc = total();
        setUnit(u, from); if (u.length === 1) seasonOf.set(u[0].id, fromSeason);
        if (less(sc, bestScore)) { bestScore = sc; move = () => { setUnit(u, y); if (u.length === 1) seasonOf.set(u[0].id, sn); }; }
      }
    }
    for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
      const a = units[i], b = units[j], ya = year.get(a[0].id)!, yb = year.get(b[0].id)!;
      if (ya === yb) continue;
      setUnit(a, yb); setUnit(b, ya); const sc = total(); setUnit(a, ya); setUnit(b, yb);
      if (less(sc, bestScore)) { bestScore = sc; move = () => { setUnit(a, yb); setUnit(b, ya); }; }
    }
    if (!move) break;
    move(); best = bestScore;
  }

  const out: Placement[] = [];
  for (const d of cards) {
    if (d.pinned) continue;
    const p: Placement = { id: d.id, planYear: year.get(d.id)!, planSeason: seasonOf.get(d.id) ?? null, priority: disabled.includes("rank") ? d.priority : d.suggestedPriority ?? d.priority };
    if (p.planYear !== d.planYear || p.planSeason !== d.planSeason || p.priority !== d.priority) out.push(p);
  }
  return out;
}
