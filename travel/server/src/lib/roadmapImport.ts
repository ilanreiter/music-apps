// Parses a "retirement travel portfolio" markdown file (see the repo root for
// the expected shape) into roadmap destinations, pairings and settings.

export interface ParsedDest {
  name: string;
  rank: number | null;
  planYear: number | null;
  season: string;
  tier: string;
  days: number;
  dailyCost: number;
  transitCost: number;
  mobility: string;
  notes: string;
  visited: boolean;
}
export interface ParsedPairing { name: string; year: number | null; quarter: string | null; savings: number; text: string }
export interface ParsedSettings {
  startYear?: number; endYear?: number; annualCap?: number; maxFarPerYear?: number;
  ageA?: number; ageB?: number; highMobilityUntil?: number;
}
export interface ParsedRoadmap { destinations: ParsedDest[]; pairings: ParsedPairing[]; settings: ParsedSettings }

const money = (s: string) => Number(s.replace(/[^0-9.]/g, "")) || 0;
const clean = (s: string) => s.replace(/\*/g, "").trim();

function tableRows(md: string, headingRe: RegExp): string[][] {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start < 0) return [];
  const rows: string[][] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith("#") && rows.length) break;
    if (!l.startsWith("|")) { if (rows.length) break; continue; }
    if (/^\|[\s:|-]+\|$/.test(l)) continue;
    rows.push(l.slice(1, l.endsWith("|") ? -1 : undefined).split("|").map((c) => c.trim()));
  }
  return rows.slice(1); // drop header
}

export function parseRoadmap(md: string): ParsedRoadmap {
  const destinations: ParsedDest[] = [];

  for (const c of tableRows(md, /^###\s*Table B/i)) {
    if (c.length < 10) continue;
    const rank = parseInt(clean(c[0]), 10);
    const year = parseInt(clean(c[1]), 10);
    if (!rank || !year) continue;
    const [mobility, ...rest] = c[9].split(";");
    destinations.push({
      name: clean(c[3]), rank, planYear: year, season: clean(c[2]), tier: clean(c[4]),
      days: parseInt(clean(c[5]), 10) || 0, dailyCost: money(c[6]), transitCost: money(c[7]),
      mobility: clean(mobility), notes: rest.join(";").trim(), visited: false,
    });
  }

  for (const c of tableRows(md, /^###\s*Table C/i)) {
    if (c.length < 7 || /SUBTOTAL/i.test(c[0])) continue;
    destinations.push({
      name: clean(c[0]), rank: null, planYear: null, season: clean(c[1]), tier: "Visited",
      days: parseInt(clean(c[2]), 10) || 0, dailyCost: money(c[3]), transitCost: money(c[4]),
      mobility: "", notes: c[6].trim(), visited: true,
    });
  }

  const pairings: ParsedPairing[] = [];
  for (const m of md.matchAll(/^\s*\d+\.\s+\*\*(\d{4})\s+(Q\d)\s+—\s+([^:*]+):\*\*\s*(.+?)→\s*\*Saves\s+\$([\d,]+)/gm)) {
    pairings.push({ name: m[3].trim(), year: Number(m[1]), quarter: m[2], savings: money(m[5]), text: m[4] });
  }

  const settings: ParsedSettings = {};
  const years = destinations.map((d) => d.planYear).filter((y): y is number => !!y);
  if (years.length) { settings.startYear = Math.min(...years); settings.endYear = Math.max(...years); }
  const cap = md.match(/\$([\d,]+)\/year\*\*\s*target/i); if (cap) settings.annualCap = money(cap[1]);
  const far = md.match(/≤\s*(\d+)\s*Long-Haul/i); if (far) settings.maxFarPerYear = Number(far[1]);
  const ages = md.match(/Ages\s*(\d+)\s*&\s*(\d+)\s*\((\d{4})\)/i);
  if (ages) { settings.ageA = Number(ages[1]); settings.ageB = Number(ages[2]); settings.startYear = Number(ages[3]); }
  const hm = md.match(/prioritized in\s*\*\*(\d{4})[–-](\d{4})\*\*/i); if (hm) settings.highMobilityUntil = Number(hm[2]);

  return { destinations, pairings, settings };
}

/** Which of this year's destinations belong to a pairing line. */
export function pairingMembers(p: ParsedPairing, dests: ParsedDest[]): ParsedDest[] {
  const text = p.text.toLowerCase();
  return dests.filter((d) => {
    if (d.planYear !== p.year) return false;
    const base = d.name.replace(/\(.*?\)/g, "").trim().toLowerCase();
    const paren = (d.name.match(/\((.*?)\)/)?.[1] ?? "").toLowerCase();
    const first = base.split(/\s+/)[0];
    return text.includes(base) || (!!paren && text.includes(paren)) || (first.length >= 5 && text.includes(first));
  });
}
