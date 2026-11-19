// Static travel facts for the roadmap destinations (location, second-best
// season, typical weather in the best / second-best season). General guidance,
// matched by destination name prefix; unknown names are simply left blank.
// [lat, lng, secondSeason, weatherBest, weatherSecond]
type Meta = [number, number, string, string, string];

const META: Record<string, Meta> = {
  "vietnam": [16, 106, "Spring", "Dry & mild, 60–77°F", "Warm & humid, 77–90°F"],
  "cambodia": [13.4, 103.9, "Fall", "Hot & dry, 75–90°F", "Rains ending, 75–88°F"],
  "colombia": [5, -74, "Winter", "Warm, some showers, 62–85°F", "Driest months, 62–85°F"],
  "botswana": [-19, 25, "Fall", "Dry, cool nights, 45–80°F", "Dry & warming, 55–90°F"],
  "new mexico": [35.7, -105.9, "Spring", "Crisp & sunny, 40–70°F", "Mild & windy, 45–72°F"],
  "new zealand": [-41, 173, "Fall", "Warm, long days, 60–75°F", "Mild & settled, 55–68°F"],
  "peru": [-13.5, -72, "Summer", "Post-rain & green, 45–70°F", "Dry, cold nights, 35–70°F"],
  "galápagos": [-0.7, -90.4, "Fall", "Warm, calm seas, 75–86°F", "Cooler, 68–78°F"],
  "badlands": [43.8, -102.5, "Summer", "Crisp, 35–68°F", "Hot with storms, 60–92°F"],
  "panama": [8.9, -79.5, "Spring", "Dry season, 75–89°F", "Drying out, 76–90°F"],
  "south africa": [-30, 25, "Summer", "Mild, wildflowers, 50–75°F", "Dry bush, 40–75°F"],
  "wyoming": [43.8, -110.7, "Fall", "Warm days, cool nights, 40–80°F", "Crisp, colors, 25–60°F"],
  "yellowstone": [44.6, -110.5, "Fall", "Warm & busy, 45–78°F", "Cool, elk rut, 28–58°F"],
  "greece": [39, 22.5, "Spring", "Warm sea, 62–80°F", "Mild, wildflowers, 58–75°F"],
  "thailand": [15, 101, "Fall", "Cool & dry, 68–90°F", "Rains ending, 72–90°F"],
  "laos": [19.9, 102.1, "Fall", "Cool & dry, 55–82°F", "Green, post-monsoon, 68–85°F"],
  "australia": [-25, 134, "Fall", "Mild, 60–80°F", "Warm, 65–85°F"],
  "arizona": [34.9, -111.7, "Spring", "Warm days, cool nights, 45–78°F", "Mild, 50–80°F"],
  "brazil": [-23, -45, "Spring", "Hot & humid, 73–93°F", "Warm & drier, 68–86°F"],
  "japan": [36, 138, "Spring", "Foliage, 50–72°F", "Cherry blossom, 45–68°F"],
  "china": [35, 105, "Spring", "Clear, 50–72°F", "Mild, 50–75°F"],
  "georgia": [32, -81.1, "Spring", "Mild, 50–72°F", "Warm, blooms, 55–80°F"],
  "spain": [40, -3.7, "Fall", "Mild, 55–75°F", "Warm, 55–78°F"],
  "portugal": [39.5, -8, "Fall", "Mild, 55–72°F", "Warm, 58–75°F"],
  "azores": [37.8, -25.5, "Summer", "Mild, showers, 55–66°F", "Warm, 64–76°F"],
  "norway": [61, 7, "Spring", "Long days, 52–68°F", "Cool & fresh, 40–58°F"],
  "faroe": [62, -6.9, "Summer", "Windy, 40–52°F", "Mild, long days, 45–58°F"],
  "croatia": [45.5, 15, "Fall", "Fresh, 52–70°F", "Warm sea, 55–75°F"],
  "england": [52.5, -1.5, "Fall", "Mild, 45–62°F", "Cool, 45–60°F"],
  "scotland": [56.8, -4.2, "Fall", "Long days, 50–66°F", "Cool, colors, 40–57°F"],
  "republic of ireland": [53.3, -7.9, "Fall", "Fresh, 45–60°F", "Mild, 45–60°F"],
  "taiwan": [23.7, 121, "Fall", "Warm, 62–78°F", "Dry, 70–85°F"],
  "italy": [42.5, 12.5, "Spring", "Warm, 55–75°F", "Mild, 55–72°F"],
  "switzerland": [46.8, 8.2, "Fall", "Warm, 55–78°F", "Crisp, 40–62°F"],
};

export function metaFor(name: string) {
  const n = name.toLowerCase();
  const key = Object.keys(META).find((k) => n.startsWith(k));
  if (!key) return null;
  const [lat, lng, secondSeason, weather, weatherAlt] = META[key];
  return { lat, lng, secondSeason, weather, weatherAlt };
}
