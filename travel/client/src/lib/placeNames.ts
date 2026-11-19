import countries110 from "world-atlas/countries-110m.json";
import usStates from "us-atlas/states-10m.json";

export interface Place { name: string; kind: "Country" | "US state" | "Region" | "City" | "Park" }

const FRIENDLY: Record<string, string> = {
  "United States of America": "United States", "Dem. Rep. Congo": "DR Congo", "Bosnia and Herz.": "Bosnia and Herzegovina",
  "Dominican Rep.": "Dominican Republic", "Central African Rep.": "Central African Republic", "Eq. Guinea": "Equatorial Guinea",
  "W. Sahara": "Western Sahara", "S. Sudan": "South Sudan", "Solomon Is.": "Solomon Islands", "Falkland Is.": "Falkland Islands",
  "N. Cyprus": "Northern Cyprus", "eSwatini": "Eswatini", "Czechia": "Czechia", "Macedonia": "North Macedonia", "Côte d'Ivoire": "Ivory Coast",
};
const SKIP = new Set(["Antarctica", "Fr. S. Antarctic Lands", "Somaliland", "Palestine", "N. Cyprus", "W. Sahara", "Falkland Islands", "Falkland Is."]);

const EXTRA: [string, Place["kind"]][] = [
  ["Patagonia", "Region"], ["Tuscany", "Region"], ["Provence", "Region"], ["Amalfi Coast", "Region"], ["Scottish Highlands", "Region"],
  ["Dolomites", "Region"], ["Lake District", "Region"], ["Normandy", "Region"], ["Bavaria", "Region"], ["Andalusia", "Region"],
  ["Sicily", "Region"], ["Sardinia", "Region"], ["Crete", "Region"], ["Santorini", "Region"], ["Canary Islands", "Region"], ["Madeira", "Region"],
  ["Balearic Islands", "Region"], ["Lofoten Islands", "Region"], ["Svalbard", "Region"], ["Bali", "Region"], ["Borneo", "Region"],
  ["Hokkaido", "Region"], ["Kyoto", "City"], ["Tokyo", "City"], ["Hanoi", "City"], ["Kerala", "Region"], ["Rajasthan", "Region"],
  ["Tasmania", "Region"], ["Great Barrier Reef", "Region"], ["Fiji", "Country"], ["Tahiti", "Region"], ["Hawaii", "Region"], ["Maui", "Region"],
  ["Yukon", "Region"], ["Banff & Canadian Rockies", "Park"], ["Nova Scotia", "Region"], ["Newfoundland", "Region"], ["Québec City", "City"],
  ["Badlands National Park", "Park"], ["Grand Teton National Park", "Park"], ["Arches National Park", "Park"], ["Canyonlands National Park", "Park"],
  ["Great Smoky Mountains National Park", "Park"], ["Rocky Mountain National Park", "Park"], ["Denali National Park", "Park"], ["Everglades National Park", "Park"],
  ["Death Valley National Park", "Park"], ["Joshua Tree National Park", "Park"], ["Sequoia & Kings Canyon", "Park"], ["Mount Rainier National Park", "Park"],
  ["Big Bend National Park", "Park"], ["Shenandoah National Park", "Park"], ["Bryce Canyon National Park", "Park"], ["Capitol Reef National Park", "Park"],
  ["Mesa Verde National Park", "Park"], ["Carlsbad Caverns National Park", "Park"], ["Theodore Roosevelt National Park", "Park"], ["Great Basin National Park", "Park"],
  ["Yellowstone National Park", "Park"], ["Grand Canyon", "Park"], ["Yosemite National Park", "Park"], ["Zion & Bryce Canyon", "Park"],
  ["Glacier National Park", "Park"], ["Acadia National Park", "Park"], ["Olympic National Park", "Park"], ["Alaska", "Region"],
  ["Machu Picchu", "Park"], ["Amazon Rainforest", "Region"], ["Atacama Desert", "Region"], ["Easter Island", "Region"], ["Torres del Paine", "Park"],
  ["Serengeti & Ngorongoro", "Park"], ["Kruger National Park", "Park"], ["Victoria Falls", "Region"], ["Okavango Delta", "Region"], ["Zanzibar", "Region"],
  ["Marrakech", "City"], ["Cappadocia", "Region"], ["Istanbul", "City"], ["Petra & Wadi Rum", "Region"], ["Cinque Terre", "Region"],
  ["Prague", "City"], ["Vienna", "City"], ["Budapest", "City"], ["Paris", "City"], ["London", "City"], ["Rome", "City"], ["Barcelona", "City"],
  ["Lisbon", "City"], ["Amsterdam", "City"], ["Copenhagen", "City"], ["Edinburgh", "City"], ["Dublin", "City"], ["Singapore", "City"],
  ["Hong Kong", "City"], ["Seoul", "City"], ["Buenos Aires", "City"], ["Mexico City", "City"], ["Cusco & Sacred Valley", "Region"],
];

let cache: Place[] | null = null;
export function allPlaces(): Place[] {
  if (cache) return cache;
  const seen = new Set<string>();
  const out: Place[] = [];
  const add = (name: string, kind: Place["kind"]) => { const k = name.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push({ name, kind }); } };
  const geo = (t: any, obj: string) => ((t.objects[obj].geometries ?? []) as any[]).map((g) => g.properties?.name as string).filter(Boolean);
  for (const n of geo(countries110, "countries")) if (!SKIP.has(n)) add(FRIENDLY[n] ?? n, "Country");
  for (const n of geo(usStates, "states")) add(`${n} (USA)`, "US state");
  for (const [n, k] of EXTRA) add(n, k);
  cache = out.sort((a, b) => a.name.localeCompare(b.name));
  return cache;
}

/** Rank: names starting with the query first, then word-prefix matches, then substrings. */
export function searchPlaces(query: string, limit = 8): Place[] {
  // Expand common abbreviations: "badlands np" → "badlands national park".
  const q = query.trim().toLowerCase().replace(/\bnat'?l\.?\b/g, "national").replace(/\bnp\b/g, "national park").replace(/\bn\.p\.?/g, "national park").replace(/\bnm\b/g, "national monument");
  if (!q) return [];
  const scored: [number, Place][] = [];
  for (const p of allPlaces()) {
    const n = p.name.toLowerCase();
    const i = n.indexOf(q);
    if (i < 0) continue;
    scored.push([i === 0 ? 0 : n.includes(` ${q}`) ? 1 : 2, p]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).slice(0, limit).map((s) => s[1]);
}
