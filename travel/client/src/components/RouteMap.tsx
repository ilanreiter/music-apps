import React, { useEffect } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { colorForDay, NO_DAY_COLOR } from "../lib/dayColors";

export interface MapPoint {
  id: string;
  title: string;
  lat: number;
  lng: number;
  day?: number | null;
}

function numberedIcon(n: number, color: string) {
  return L.divIcon({
    className: "",
    html: `<div style="background:${color};color:#fff;border-radius:9999px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.45)">${n}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function FitToPoints({ points }: { points: MapPoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lng], 13);
      return;
    }
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]));
    map.fitBounds(bounds, { padding: [32, 32] });
  }, [points, map]);
  return null;
}

// One 2-point <Polyline> per leg, colored by the day the leg starts in —
// a leg crossing from one day to the next is drawn in a neutral connector
// color instead of either day's color, since it isn't "that day's" route.
function RouteSegments({ points }: { points: MapPoint[] }) {
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const sameDay = a.day != null && a.day === b.day;
    segments.push(
      <Polyline
        key={`${a.id}-${b.id}`}
        positions={[
          [a.lat, a.lng],
          [b.lat, b.lng],
        ]}
        pathOptions={
          sameDay
            ? { color: colorForDay(a.day), weight: 3, opacity: 0.75 }
            : { color: NO_DAY_COLOR, weight: 2, opacity: 0.5, dashArray: "6 6" }
        }
      />
    );
  }
  return <>{segments}</>;
}

export default function RouteMap({ points, height = 420 }: { points: MapPoint[]; height?: number }) {
  if (points.length === 0) return null;
  const positions = points.map((p) => [p.lat, p.lng] as [number, number]);

  return (
    <div className="rounded-lg overflow-hidden border border-slate-200 dark:border-slate-800" style={{ height }}>
      <MapContainer center={positions[0]} zoom={12} scrollWheelZoom style={{ height: "100%", width: "100%" }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {points.length > 1 && <RouteSegments points={points} />}
        {points.map((p, i) => (
          <Marker key={p.id} position={[p.lat, p.lng]} icon={numberedIcon(i + 1, colorForDay(p.day))}>
            <Tooltip direction="top" offset={[0, -12]}>
              {p.title}
              {p.day != null ? ` · Day ${p.day}` : ""}
            </Tooltip>
          </Marker>
        ))}
        <FitToPoints points={points} />
      </MapContainer>
    </div>
  );
}
