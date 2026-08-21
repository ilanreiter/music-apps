export interface RoutePoint {
  id: string;
  title: string;
  lat: number;
  lng: number;
}

function haversineKm(a: RoutePoint, b: RoutePoint) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Nearest-neighbor ordering starting from the first point. Good enough for
 * a handful of POIs per day; not a true TSP solve, but keeps backtracking
 * to a minimum without external routing APIs.
 */
export function optimizeRoute(points: RoutePoint[]): { order: RoutePoint[]; totalKm: number } {
  if (points.length <= 2) {
    const totalKm = points.length === 2 ? haversineKm(points[0], points[1]) : 0;
    return { order: points, totalKm };
  }

  const remaining = [...points];
  const order: RoutePoint[] = [remaining.shift()!];
  let totalKm = 0;

  while (remaining.length) {
    const current = order[order.length - 1];
    let nearestIdx = 0;
    let nearestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(current, remaining[i]);
      if (d < nearestDist) {
        nearestDist = d;
        nearestIdx = i;
      }
    }
    totalKm += nearestDist;
    order.push(remaining.splice(nearestIdx, 1)[0]);
  }

  return { order, totalKm: Math.round(totalKm * 10) / 10 };
}
