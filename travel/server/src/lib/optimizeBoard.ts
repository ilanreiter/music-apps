// Exact optimizer for the roadmap board: assigns every scheduled, unpinned trip to a (year, season)
// slot so the total number of rule conflicts is as small as possible. Solved as a mixed-integer
// program with HiGHS (WebAssembly). Conflicts are counted one per violation, like the Auto order mode.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const loadHighs = require("highs");

const SEASONS = ["Winter", "Spring", "Summer", "Fall"];
const MOBILITY = ["Easy", "Easy-Moderate", "Moderate", "Moderate-High", "High"];

export interface OptCard {
  id: string; name: string; planYear: number; planSeason: string | null; pinned: boolean; pairingId: string | null;
  isFar: boolean; days: number | null; dailyCost: number | null; transitCost: number | null; mobility: string | null;
  bestSeason: string | null; secondSeason: string | null; suggestedYear: number | null; priority: number;
  seasonFactors: Record<string, number> | null;
}
export interface OptSettings {
  startYear: number; autoFromYear: number | null; endYear: number; annualCap: number; maxFarPerYear: number; highMobilityUntil: number | null; ruleDisabled: string[];
}
export interface OptResult {
  status: string; optimal: boolean; objective: number;
  placements: { id: string; planYear: number; planSeason: string; priority: number }[];
}

const level = (m: string | null) => (m ? MOBILITY.indexOf(m) + 1 : 0);

export async function optimizeBoard(allCards: OptCard[], s0: OptSettings, timeLimitSec = 30): Promise<OptResult> {
  // Rows before autoFromYear (e.g. the current year) stay manual: the optimizer neither uses nor moves them.
  const from = s0.autoFromYear ?? s0.startYear;
  const s = { ...s0, startYear: from };
  const cards = allCards.filter((c) => c.planYear >= from);
  const off = new Set(s.ruleDisabled);
  const on = (r: string) => !off.has(r);
  const years: number[] = [];
  for (let y = s.startYear; y <= s.endYear; y++) years.push(y);
  const R = Math.max(1, years.length - 1);
  const slots = years.flatMap((y) => SEASONS.map((sn) => ({ y, sn })));
  const T = slots.length;

  // Units: a combined trip (pairing) moves as one; a unit with a pinned member is fixed in place.
  const groups = new Map<string, OptCard[]>();
  for (const c of cards) groups.set(c.pairingId ?? c.id, [...(groups.get(c.pairingId ?? c.id) ?? []), c]);
  const units = [...groups.values()].map((members) => {
    const pin = members.find((m) => m.pinned);
    const fixedSlot = pin ? slots.findIndex((sl) => sl.y === pin.planYear && sl.sn === (pin.planSeason ?? "Winter")) : -1;
    return { members, fixed: pin ? Math.max(0, fixedSlot) : -1 };
  });
  const U = units.length;
  const cost = (members: OptCard[], sn: string) => members.reduce((t, m) => t + ((m.days ?? 0) * (m.dailyCost ?? 0) + (m.transitCost ?? 0)) * (m.seasonFactors?.[sn] || 1), 0);

  const x = (u: number, t: number) => `x_${u}_${t}`;
  // One coefficient per variable (HiGHS' LP reader keeps only the last duplicate), so accumulate here.
  const objCoef = new Map<string, number>();
  const cons: string[] = [];
  const bin: string[] = [];
  const bounds: string[] = [];
  const add = (coef: number, v: string) => objCoef.set(v, (objCoef.get(v) ?? 0) + coef);
  const sum = (terms: string[]) => terms.join(" + ");
  let n = 0;
  // LP files must keep lines short; wrap long expressions every few tokens.
  const wrap = (s: string) => s.split(" ").reduce((acc, tok, i) => acc + (i === 0 ? "" : i % 8 === 0 ? "\n   " : " ") + tok, "");
  const row = (expr: string, op: string, rhs: number) => cons.push(` c${n++}: ${wrap(expr)} ${op} ${rhs}`);

  for (let u = 0; u < U; u++) for (let t = 0; t < T; t++) bin.push(x(u, t));
  for (let u = 0; u < U; u++) {
    row(sum(slots.map((_, t) => x(u, t))), "=", 1);
    if (units[u].fixed >= 0) for (let t = 0; t < T; t++) bounds.push(` ${t === units[u].fixed ? "1 <= " : "0 <= "}${x(u, t)} <= ${t === units[u].fixed ? 1 : 0}`);
  }

  const yearSlots = (yi: number) => SEASONS.map((_, k) => yi * 4 + k);

  // far: departures above the yearly limit
  if (on("far")) for (let yi = 0; yi < years.length; yi++) {
    const far = units.flatMap((un, u) => (un.members.some((m) => m.isFar) ? yearSlots(yi).map((t) => x(u, t)) : []));
    if (!far.length) continue;
    row(`f_${yi} - ${far.join(" - ")}`, ">=", -s.maxFarPerYear);
    add(1, `f_${yi}`);
  }

  // cap: years whose spend exceeds the annual cap
  if (on("cap")) {
    const M = Math.ceil(units.reduce((t, un) => t + cost(un.members, "Summer") * 1.7, 0));
    for (let yi = 0; yi < years.length; yi++) {
      const terms = units.flatMap((un, u) => yearSlots(yi).map((t) => `${cost(un.members, slots[t].sn).toFixed(2)} ${x(u, t)}`));
      row(`${terms.join(" + ")} - ${M} o_${yi}`, "<=", s.annualCap);
      bin.push(`o_${yi}`); add(1, `o_${yi}`);
    }
  }

  // season: trips outside their best / 2nd-best season
  if (on("season")) for (let u = 0; u < U; u++) for (let t = 0; t < T; t++) {
    const bad = units[u].members.filter((m) => m.bestSeason && slots[t].sn !== m.bestSeason && slots[t].sn !== m.secondSeason).length;
    if (bad) add(bad, x(u, t));
  }

  // quarter: more than one departure in a season of a year
  if (on("quarter")) for (let t = 0; t < T; t++) {
    row(`q_${t} - ${Array.from({ length: U }, (_, u) => x(u, t)).join(" - ")}`, ">=", -1);
    add(1, `q_${t}`);
  }

  // gaps: empty seasons before the last scheduled trip
  if (on("gaps")) {
    for (let t = 0; t < T; t++) {
      row(`${U} uu_${t} - ${Array.from({ length: U }, (_, u) => x(u, t)).join(" - ")}`, ">=", 0);
      row(`uu_${t} - ${Array.from({ length: U }, (_, u) => x(u, t)).join(" - ")}`, "<=", 0);
      bin.push(`uu_${t}`);
    }
    for (let t = 0; t < T - 1; t++) {
      for (let t2 = t + 1; t2 < T; t2++) row(`e_${t} + uu_${t} - uu_${t2}`, ">=", 0);
      add(1, `e_${t}`);
    }
  }

  // mobility: harder trips earlier (a trip is "out of order" if an easier trip is in an earlier year), no demanding trips after the cutoff
  if (on("mobility")) {
    const cs = units.flatMap((un, u) => un.members.map((m) => ({ u, lv: level(m.mobility), m }))).filter((c) => c.lv > 0);
    // year(c) - year(d) written term by term (the LP format has no parentheses): + y*x_c,t - y*x_d,t
    const diff = (a: number, b: number) => [
      ...Array.from({ length: T }, (_, t) => `+ ${slots[t].y - s.startYear} ${x(a, t)}`),
      ...Array.from({ length: T }, (_, t) => `- ${slots[t].y - s.startYear} ${x(b, t)}`),
    ].join(" ");
    cs.forEach((c, i) => {
      let linked = false;
      cs.forEach((d, j) => {
        if (d.lv < c.lv && d.u !== c.u) { row(`${diff(c.u, d.u)} - ${R} w_${i}`, "<=", 0); linked = true; }
      });
      const late = s.highMobilityUntil != null && c.lv >= 4;
      if (linked || late) {
        bin.push(`m_${i}`); add(1, `m_${i}`);
        if (linked) { bin.push(`w_${i}`); row(`m_${i} - w_${i}`, ">=", 0); }
        if (late) row(`m_${i} - ${slots.map((sl, t) => (sl.y > s.highMobilityUntil! ? x(c.u, t) : null)).filter(Boolean).join(" - ") || "0 x_0_0"}`, ">=", 0);
      }
    });
  }

  // gentle pull toward the plan's suggested year so ties keep trips where they were
  for (let u = 0; u < U; u++) {
    const sy = units[u].members[0].suggestedYear ?? units[u].members[0].planYear;
    for (let t = 0; t < T; t++) add(0.0005 * Math.abs(slots[t].y - sy), x(u, t));
  }

  const objExpr = [...objCoef].filter(([, c]) => Math.abs(c) > 1e-12).map(([v, c]) => `${c >= 0 ? "+" : "-"} ${Math.abs(c).toFixed(6)} ${v}`).join(" ") || "0 x_0_0";
  const lp = `Minimize\n obj: ${wrap(objExpr)}\nSubject To\n${cons.join("\n")}\nBounds\n${bounds.join("\n")}\nBinary\n ${wrap([...new Set(bin)].join(" "))}\nEnd\n`;
  const highs = await loadHighs();
  const sol = highs.solve(lp, { output_flag: false, time_limit: timeLimitSec, mip_rel_gap: 0 });
  const ok = sol.Status === "Optimal" || sol.Status === "Time limit reached";
  const placements: OptResult["placements"] = [];
  if (!ok || !sol.Columns || Object.keys(sol.Columns).length === 0) return { status: String(sol.Status), optimal: false, objective: 0, placements };
  for (let u = 0; u < U; u++) {
    let pick = -1, best = 0.5;
    for (let t = 0; t < T; t++) { const v = sol.Columns[x(u, t)]?.Primal ?? 0; if (v > best) { best = v; pick = t; } }
    if (pick < 0) continue;
    for (const m of units[u].members) placements.push({ id: m.id, planYear: slots[pick].y, planSeason: slots[pick].sn, priority: m.priority });
  }
  return { status: String(sol.Status), optimal: sol.Status === "Optimal", objective: Number(sol.ObjectiveValue), placements };
}
