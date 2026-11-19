// Parses places exported from Google Maps (Takeout "Saved Places" GeoJSON, My Maps KML, saved-list CSV)
// or pasted lines / links. No network access: coordinates come from the file or from map links.
export interface ImportedPlace { title: string; lat: number | null; lng: number | null; notes: string | null; url: string | null }

const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);
const valid = (lat: number | null, lng: number | null) => lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

/** Pulls coordinates out of a Google Maps link (…/@lat,lng,…, …!3dLAT!4dLNG…, ?q=lat,lng). */
export function coordsFromUrl(url: string): [number, number] | null {
  const pats = [/@(-?\d+\.\d+),(-?\d+\.\d+)/, /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /[?&](?:q|ll|query)=(-?\d+\.\d+),(-?\d+\.\d+)/];
  for (const p of pats) {
    const m = url.match(p);
    if (m && valid(+m[1], +m[2])) return [+m[1], +m[2]];
  }
  return null;
}

function parseGeoJson(text: string): ImportedPlace[] {
  const j = JSON.parse(text);
  const feats: any[] = Array.isArray(j.features) ? j.features : [];
  return feats.map((f) => {
    const p = f.properties ?? {};
    const loc = p.Location ?? p.location ?? {};
    const c = f.geometry?.coordinates;
    let lng = Array.isArray(c) ? num(c[0]) : null, lat = Array.isArray(c) ? num(c[1]) : null;
    const url: string | null = p["Google Maps URL"] ?? p.google_maps_url ?? p.url ?? null;
    if (!valid(lat, lng) && url) { const u = coordsFromUrl(url); if (u) [lat, lng] = u; }
    if (!valid(lat, lng)) { lat = null; lng = null; }
    const title = String(p.Title ?? p.title ?? p.name ?? loc["Business Name"] ?? loc.name ?? "").trim();
    const addr = loc.Address ?? loc.address ?? p.address ?? null;
    return { title, lat, lng, notes: [addr, p.Comment ?? p.comment ?? p.description].filter(Boolean).join(" — ") || null, url };
  }).filter((x) => x.title);
}

const unxml = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();

function parseKml(text: string): ImportedPlace[] {
  const out: ImportedPlace[] = [];
  for (const m of text.matchAll(/<Placemark[\s\S]*?<\/Placemark>/g)) {
    const blk = m[0];
    const name = unxml(blk.match(/<name>([\s\S]*?)<\/name>/)?.[1] ?? "");
    const desc = unxml(blk.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const co = blk.match(/<Point>[\s\S]*?<coordinates>\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/);
    if (!name) continue;
    const lng = co ? +co[1] : null, lat = co ? +co[2] : null;
    out.push({ title: name, lat: valid(lat, lng) ? lat : null, lng: valid(lat, lng) ? lng : null, notes: desc || null, url: null });
  }
  return out;
}

function csvRows(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cur); cur = ""; if (row.some((c) => c.trim())) rows.push(row); row = []; }
    else cur += ch;
  }
  row.push(cur); if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

function parseCsv(text: string): ImportedPlace[] {
  const rows = csvRows(text);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const iTitle = col("title", "name"), iNote = col("note", "notes", "description", "comment"), iUrl = col("url", "link", "google maps url");
  const iLat = col("latitude", "lat"), iLng = col("longitude", "lng", "lon");
  return rows.slice(1).map((r) => {
    const url = iUrl >= 0 ? r[iUrl]?.trim() || null : null;
    let lat = iLat >= 0 ? parseFloat(r[iLat]) : NaN, lng = iLng >= 0 ? parseFloat(r[iLng]) : NaN;
    if ((!isFinite(lat) || !isFinite(lng)) && url) { const u = coordsFromUrl(url); if (u) [lat, lng] = u; }
    const ok = isFinite(lat) && isFinite(lng) && valid(lat, lng);
    return { title: (iTitle >= 0 ? r[iTitle] : r[0] ?? "").trim(), lat: ok ? lat : null, lng: ok ? lng : null, notes: iNote >= 0 ? r[iNote]?.trim() || null : null, url };
  }).filter((x) => x.title);
}

function parseLines(text: string): ImportedPlace[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const url = l.match(/https?:\/\/\S+/)?.[0] ?? null;
    const c = url ? coordsFromUrl(url) : null;
    let title = l.replace(/https?:\/\/\S+/g, "").replace(/^[-*•\d.)\s]+/, "").trim();
    if (!title && url) { const m = url.match(/\/place\/([^/@?]+)/); if (m) title = decodeURIComponent(m[1].replace(/\+/g, " ")); }
    return { title, lat: c ? c[0] : null, lng: c ? c[1] : null, notes: null, url };
  }).filter((x) => x.title);
}

export function parsePlaces(filename: string, content: string): ImportedPlace[] {
  const text = content.replace(/^﻿/, "").trim();
  const name = filename.toLowerCase();
  let places: ImportedPlace[];
  if (name.endsWith(".kml") || /^<\?xml|^<kml/i.test(text)) places = parseKml(text);
  else if (name.endsWith(".json") || name.endsWith(".geojson") || text.startsWith("{")) places = parseGeoJson(text);
  else if (name.endsWith(".csv")) places = parseCsv(text);
  else places = parseLines(text);
  // de-duplicate by title+coords
  const seen = new Set<string>();
  return places.filter((p) => { const k = `${p.title.toLowerCase()}|${p.lat}|${p.lng}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 300);
}
