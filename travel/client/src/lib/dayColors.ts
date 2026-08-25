// Shared by RouteMap (map markers/lines) and TripDetail (day-filter chips)
// so day N always gets the same color across the UI. Kept out of
// RouteMap.tsx, which is lazy-loaded (it pulls in Leaflet) — importing this
// from TripDetail.tsx must not force that heavier chunk to load eagerly.

// Cycles by day number so a multi-week trip still gets distinct colors
// (repeats every 10 days rather than fading to a single "overflow" color).
const DAY_COLORS = [
  "#2563eb", // blue
  "#dc2626", // red
  "#16a34a", // green
  "#d97706", // amber
  "#9333ea", // purple
  "#0891b2", // cyan
  "#db2777", // pink
  "#65a30d", // lime
  "#ea580c", // orange
  "#4f46e5", // indigo
];
export const NO_DAY_COLOR = "#64748b"; // slate — for items with no resolved day #

export function colorForDay(day: number | null | undefined): string {
  if (day == null) return NO_DAY_COLOR;
  return DAY_COLORS[(day - 1) % DAY_COLORS.length];
}
