import React, { useEffect, useState } from "react";
import { MapContainer, TileLayer, Marker, Polyline, CircleMarker, Tooltip, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { colorForDay, NO_DAY_COLOR } from "../lib/dayColors";

export interface MapPoint {
  id: string;
  title: string;
  lat: number;
  lng: number;
  day?: number | null;
  /** Where this step departs from (flights, drives): an arc is drawn from here to the step's own location. */
  from?: { lat: number; lng: number } | null;
}

const BADGE = 26;      // px, numbered step badge
const MIN_GAP = 34;    // px, minimum distance between badge centres (so numbers never touch)
const SAME_PLACE = 9;  // px, stops closer than this share one location dot

const badgeIcon = (n: number, color: string) => L.divIcon({
  className: "",
  html: `<div style="background:${color};color:#fff;border-radius:9999px;width:${BADGE}px;height:${BADGE}px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.45)">${n}</div>`,
  iconSize: [BADGE, BADGE], iconAnchor: [BADGE / 2, BADGE / 2],
});

// A small triangle, rotated to point along `deg` (0 = right).
const arrowIcon = (deg: number, color: string, size: number) => L.divIcon({
  className: "",
  html: `<div style="width:${size}px;height:${size}px;transform:rotate(${deg}deg)"><svg viewBox="0 0 10 10" width="${size}" height="${size}"><path d="M1 1 L9 5 L1 9 Z" fill="${color}" stroke="white" stroke-width="0.8" stroke-linejoin="round"/></svg></div>`,
  iconSize: [size, size], iconAnchor: [size / 2, size / 2],
});

function FitToPoints({ points }: { points: MapPoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) { map.setView([points[0].lat, points[0].lng], 13); return; }
    map.fitBounds(L.latLngBounds(points.flatMap((p) => [[p.lat, p.lng], ...(p.from ? [[p.from.lat, p.from.lng]] : [])] as [number, number][])), { padding: [56, 56] });
  }, [points, map]);
  return null;
}

type Pt = { x: number; y: number };
interface Place { key: number; at: Pt; members: number[] }

/** Lays the step badges out in pixel space: each sits beside its true location, never closer than MIN_GAP to another badge. */
function layout(points: MapPoint[], map: L.Map) {
  const pos = points.map((p) => map.latLngToLayerPoint([p.lat, p.lng]));
  const places: Place[] = [];
  const placeOf: number[] = [];
  pos.forEach((q, i) => {
    let pl = places.find((c) => Math.hypot(c.at.x - q.x, c.at.y - q.y) < SAME_PLACE);
    if (!pl) { pl = { key: places.length, at: { x: q.x, y: q.y }, members: [] }; places.push(pl); }
    pl.members.push(i); placeOf.push(pl.key);
  });
  // departure points of flights/drives get a dot too (joining an existing place when they coincide)
  const fromPlace: number[] = points.map((p) => {
    if (!p.from) return -1;
    const q = map.latLngToLayerPoint([p.from.lat, p.from.lng]);
    let pl = places.find((c) => Math.hypot(c.at.x - q.x, c.at.y - q.y) < SAME_PLACE);
    if (!pl) { pl = { key: places.length, at: { x: q.x, y: q.y }, members: [] }; places.push(pl); }
    return pl.key;
  });
  // start each place's badges on a ring around it, then push apart until nothing is too close
  const badge: Pt[] = pos.map((q) => ({ x: q.x, y: q.y }));
  const home: Pt[] = badge.map((b) => ({ ...b }));
  for (const pl of places) {
    const m = pl.members.length;
    const r = Math.max(30, (m * MIN_GAP) / (2 * Math.PI) + 8);
    pl.members.forEach((idx, k) => {
      const a = -Math.PI / 2 + (k * 2 * Math.PI) / m + (m === 1 ? Math.PI / 4 : 0);
      home[idx] = { x: pl.at.x + Math.cos(a) * r, y: pl.at.y + Math.sin(a) * r };
      badge[idx] = { ...home[idx] };
    });
  }
  for (let it = 0; it < 120; it++) {
    for (let i = 0; i < badge.length; i++) {
      for (let j = i + 1; j < badge.length; j++) {
        let dx = badge[j].x - badge[i].x, dy = badge[j].y - badge[i].y;
        let d = Math.hypot(dx, dy);
        if (d >= MIN_GAP) continue;
        if (d < 0.01) { dx = Math.cos(i * 2.4); dy = Math.sin(i * 2.4); d = 1; }
        const push = (MIN_GAP - d) / 2 + 0.3;
        badge[i].x -= (dx / d) * push; badge[i].y -= (dy / d) * push;
        badge[j].x += (dx / d) * push; badge[j].y += (dy / d) * push;
      }
      // keep clear of other places' location dots, and drift back toward the home position
      for (const pl of places) {
        if (pl.key === placeOf[i]) continue;
        const dx = badge[i].x - pl.at.x, dy = badge[i].y - pl.at.y, d = Math.hypot(dx, dy);
        if (d < 22 && d > 0.01) { badge[i].x += (dx / d) * (22 - d); badge[i].y += (dy / d) * (22 - d); }
      }
      badge[i].x += (home[i].x - badge[i].x) * 0.02; badge[i].y += (home[i].y - badge[i].y) * 0.02;
    }
  }
  // final passes with only the spacing rule, so the guarantee holds whatever the other forces did
  for (let it = 0; it < 300; it++) {
    let moved = false;
    for (let i = 0; i < badge.length; i++) {
      for (let j = i + 1; j < badge.length; j++) {
        let dx = badge[j].x - badge[i].x, dy = badge[j].y - badge[i].y, d = Math.hypot(dx, dy);
        if (d >= MIN_GAP) continue;
        if (d < 0.01) { dx = Math.cos(j * 2.4); dy = Math.sin(j * 2.4); d = 1; }
        const push = (MIN_GAP - d) / 2 + 0.5;
        badge[i].x -= (dx / d) * push; badge[i].y -= (dy / d) * push;
        badge[j].x += (dx / d) * push; badge[j].y += (dy / d) * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { places, placeOf, fromPlace, badge };
}

/** A curved leg from a to b, bending to the left of travel so the way back bends the other way. */
function arc(a: Pt, b: Pt, steps = 28): Pt[] {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  const bend = Math.min(len * 0.22, 90);
  const c = { x: (a.x + b.x) / 2 + (dy / len) * bend, y: (a.y + b.y) / 2 - (dx / len) * bend };
  const out: Pt[] = [];
  for (let t = 0; t <= steps; t++) {
    const u = t / steps, v = 1 - u;
    out.push({ x: v * v * a.x + 2 * v * u * c.x + u * u * b.x, y: v * v * a.y + 2 * v * u * c.y + u * u * b.y });
  }
  return out;
}

function MapLayers({ points }: { points: MapPoint[] }) {
  const map = useMap();
  const [, bump] = useState(0);
  useMapEvents({ zoomend: () => bump((v) => v + 1) });
  const ll = (p: Pt) => map.layerPointToLatLng([p.x, p.y]);
  const { places, placeOf, fromPlace, badge } = layout(points, map);

  // One arc per flight/drive, from where it departs to where it arrives. Steps are never joined to each other,
  // so no leg is drawn that isn't in the itinerary.
  const legs = points.flatMap((p, i) => (fromPlace[i] >= 0 && fromPlace[i] !== placeOf[i]
    ? [{ pts: arc(places[fromPlace[i]].at, places[placeOf[i]].at), day: p.day }] : []));

  return (
    <>
      {legs.map((l, n) => {
        const color = l.day != null ? colorForDay(l.day) : NO_DAY_COLOR;
        const mid = l.pts[Math.floor(l.pts.length / 2)], prev = l.pts[Math.floor(l.pts.length / 2) - 1];
        const deg = (Math.atan2(mid.y - prev.y, mid.x - prev.x) * 180) / Math.PI;
        return (
          <React.Fragment key={n}>
            <Polyline positions={l.pts.map((p) => ll(p))} pathOptions={{ color, weight: 3, opacity: 0.8, }} interactive={false} />
            <Marker position={ll(mid)} icon={arrowIcon(deg, color, 14)} interactive={false} keyboard={false} />
          </React.Fragment>
        );
      })}
      {places.map((pl) => (
        <CircleMarker key={`d${pl.key}`} center={ll(pl.at)} radius={5} pathOptions={{ color: "#fff", weight: 2, fillColor: colorForDay(points[pl.members[0]].day), fillOpacity: 1 }} interactive={false} />
      ))}
      {points.map((p, i) => {
        const pl = places[placeOf[i]];
        const dx = pl.at.x - badge[i].x, dy = pl.at.y - badge[i].y, d = Math.hypot(dx, dy) || 1;
        const color = colorForDay(p.day);
        const from = { x: badge[i].x + (dx / d) * (BADGE / 2), y: badge[i].y + (dy / d) * (BADGE / 2) };   // edge of the badge
        const to = { x: pl.at.x - (dx / d) * 7, y: pl.at.y - (dy / d) * 7 };                             // just short of the dot
        return (
          <React.Fragment key={p.id}>
            <Polyline positions={[ll(from), ll(to)]} pathOptions={{ color, weight: 2, opacity: 0.95 }} interactive={false} />
            <Marker position={ll(to)} icon={arrowIcon((Math.atan2(dy, dx) * 180) / Math.PI, color, 11)} interactive={false} keyboard={false} />
            <Marker position={ll(badge[i])} icon={badgeIcon(i + 1, color)} zIndexOffset={1000}>
              <Tooltip direction="top" offset={[0, -12]}>{i + 1}. {p.title}{p.day != null ? ` · Day ${p.day}` : ""}</Tooltip>
            </Marker>
          </React.Fragment>
        );
      })}
    </>
  );
}

export default function RouteMap({ points, height = 420 }: { points: MapPoint[]; height?: number }) {
  if (points.length === 0) return null;
  return (
    <div className="rounded-lg overflow-hidden border border-slate-200 dark:border-slate-800" style={{ height }}>
      <MapContainer center={[points[0].lat, points[0].lng]} zoom={12} scrollWheelZoom style={{ height: "100%", width: "100%" }}>
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <MapLayers points={points} />
        <FitToPoints points={points} />
      </MapContainer>
    </div>
  );
}
