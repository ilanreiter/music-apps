import React from "react";
import {
  Anchor, Bird, Building2, Castle, Coffee, Crown, Fish, Flame, Landmark, MapPin, Mountain, PawPrint,
  Palmtree, Sailboat, Ship, Sun, Sunrise, Tent, TrainFront, TreePine, Utensils, Waves, Wine, Clover, Binoculars,
} from "lucide-react";

type Icon = React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
interface Meta { icon: Icon; countries: string[]; states?: string[]; flags?: string[] }

// Matched by lower-cased name prefix. `countries` are Natural Earth names.
const META: Record<string, Meta> = {
  vietnam: { icon: Sailboat, countries: ["Vietnam"], flags: ["VN"] },
  cambodia: { icon: Landmark, countries: ["Cambodia"], flags: ["KH"] },
  colombia: { icon: Coffee, countries: ["Colombia"], flags: ["CO"] },
  botswana: { icon: PawPrint, countries: ["Botswana", "Zimbabwe"], flags: ["BW", "ZW"] },
  "new mexico": { icon: Sunrise, countries: [], states: ["New Mexico"], flags: ["US"] },
  "new zealand": { icon: TreePine, countries: ["New Zealand"], flags: ["NZ"] },
  peru: { icon: Mountain, countries: ["Peru"], flags: ["PE"] },
  galápagos: { icon: Bird, countries: ["Ecuador"], flags: ["EC"] },
  badlands: { icon: Tent, countries: [], states: ["South Dakota"], flags: ["US"] },
  panama: { icon: Anchor, countries: ["Panama"], flags: ["PA"] },
  "south africa": { icon: Binoculars, countries: ["South Africa"], flags: ["ZA"] },
  wyoming: { icon: Mountain, countries: [], states: ["Wyoming"], flags: ["US"] },
  yellowstone: { icon: Flame, countries: [], states: ["Wyoming"], flags: ["US"] },
  greece: { icon: Ship, countries: ["Greece"], flags: ["GR"] },
  thailand: { icon: Palmtree, countries: ["Thailand"], flags: ["TH"] },
  laos: { icon: Waves, countries: ["Laos"], flags: ["LA"] },
  australia: { icon: Fish, countries: ["Australia"], flags: ["AU"] },
  arizona: { icon: Sun, countries: [], states: ["Arizona"], flags: ["US"] },
  brazil: { icon: Palmtree, countries: ["Brazil"], flags: ["BR"] },
  japan: { icon: TrainFront, countries: ["Japan"], flags: ["JP"] },
  china: { icon: Landmark, countries: ["China"], flags: ["CN"] },
  georgia: { icon: Building2, countries: [], states: ["Georgia"], flags: ["US"] },
  spain: { icon: Sun, countries: ["Spain"], flags: ["ES"] },
  portugal: { icon: Wine, countries: ["Portugal"], flags: ["PT"] },
  azores: { icon: Waves, countries: ["Portugal"], flags: ["PT"] },
  norway: { icon: Mountain, countries: ["Norway"], flags: ["NO"] },
  faroe: { icon: Waves, countries: ["Denmark"], flags: ["FO"] },
  croatia: { icon: Anchor, countries: ["Croatia", "Slovenia"], flags: ["HR", "SI"] },
  england: { icon: Crown, countries: ["United Kingdom"], flags: ["GB"] },
  scotland: { icon: Castle, countries: ["United Kingdom"], flags: ["GB"] },
  "republic of ireland": { icon: Clover, countries: ["Ireland"], flags: ["IE"] },
  taiwan: { icon: Building2, countries: ["Taiwan"], flags: ["TW"] },
  italy: { icon: Utensils, countries: ["Italy"], flags: ["IT"] },
  switzerland: { icon: TrainFront, countries: ["Switzerland"], flags: ["CH"] },
};

export function destMeta(name: string): Meta {
  const n = name.toLowerCase();
  const k = Object.keys(META).find((x) => n.startsWith(x));
  return k ? META[k] : { icon: MapPin, countries: [] };
}
