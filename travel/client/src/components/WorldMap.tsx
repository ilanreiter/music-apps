import React, { useMemo } from "react";
import { geoPath } from "d3-geo";
import { feature } from "topojson-client";
import land110 from "world-atlas/land-110m.json";
import countries110 from "world-atlas/countries-110m.json";
import usStates from "us-atlas/states-10m.json";

// Equirectangular projection, 200 units wide, cropped to ~80°N … 58°S.
const SCALE = 200 / (2 * Math.PI);
const project = (lat: number, lng: number): [number, number] => [100 + SCALE * ((lng * Math.PI) / 180), 50 - SCALE * ((lat * Math.PI) / 180)];
const projection: any = { stream: (s: any) => ({
  point: (x: number, y: number) => { const [px, py] = project(y, x); s.point(px, py); },
  sphere: () => s.sphere?.(), lineStart: () => s.lineStart(), lineEnd: () => s.lineEnd(),
  polygonStart: () => s.polygonStart(), polygonEnd: () => s.polygonEnd(),
}) };

const slug = (n: string) => n.replace(/[^a-z0-9]/gi, "");
let cache: { land: string; countries: [string, string][]; states: [string, string][] } | null = null;
function getPaths() {
  if (!cache) {
    const gen = geoPath(projection);
    const land = gen(feature(land110 as any, (land110 as any).objects.land) as any) ?? "";
    const fc: any = feature(countries110 as any, (countries110 as any).objects.countries);
    const sc: any = feature(usStates as any, (usStates as any).objects.states);
    cache = {
      land,
      countries: fc.features.map((f: any) => [f.properties.name as string, gen(f) ?? ""] as [string, string]),
      states: sc.features.map((f: any) => [f.properties.name as string, gen(f) ?? ""] as [string, string]),
    };
  }
  return cache;
}

/** Render once per page: defines the land and country shapes every <MiniMap> reuses. */
export function WorldMapDefs() {
  const p = useMemo(getPaths, []);
  return (
    <svg width="0" height="0" className="absolute" aria-hidden>
      <defs>
        <path id="wander-land" d={p.land} />
        {p.countries.map(([n, d]) => <path key={n} id={`wc-${slug(n)}`} d={d} />)}
        {p.states.map(([n, d]) => <path key={n} id={`ws-${slug(n)}`} d={d} />)}
      </defs>
    </svg>
  );
}

const BIG = new Set(["United States of America", "China", "Australia", "Brazil"]);
const VB_W = 62, VB_H = 88; // narrow and tall: a window onto the world around the pin
export function MiniMap({ lat, lng, name, countries = [], states = [] }: { lat: number | null; lng: number | null; name: string; countries?: string[]; states?: string[] }) {
  const pin = lat != null && lng != null ? project(lat, lng) : null;
  // Zoom in tight on small countries, stay wider for continent-sized ones.
  const big = countries.some((c) => BIG.has(c));
  const zoom = big ? 1.4 : states.length ? 2.2 : 3;
  const w = VB_W / zoom, h = VB_H / zoom;
  const x0 = pin ? Math.max(0, Math.min(200 - w, pin[0] - w / 2)) : 73;
  const y0 = pin ? Math.max(-6, Math.min(82 - h, pin[1] - h / 2)) : -6;
  return (
    <svg viewBox={`${x0} ${y0} ${w} ${h}`} className="absolute inset-0 w-full h-full rounded-l-md bg-sky-50 dark:bg-slate-800/70" preserveAspectRatio="xMidYMid slice"
      role="img" aria-label={pin ? `${name} on the world map` : "Location unknown"}>
      <use href="#wander-land" className="fill-slate-300 dark:fill-slate-600" />
      {states.map((c) => <use key={c} href={`#ws-${slug(c)}`} fill="#0e9fa8" fillOpacity="0.8" stroke="#0b6f76" strokeWidth="0.25" />)}
      {countries.map((c) => <use key={c} href={`#wc-${slug(c)}`} fill="#0e9fa8" fillOpacity="0.8" stroke="#0b6f76" strokeWidth="0.25" />)}
    </svg>
  );
}
