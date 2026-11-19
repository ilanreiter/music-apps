import { prisma } from "../db";
import { getHomeLocations, formatTravelerProfilesBlock } from "./itineraryAi";

// Traveler profiles + shared preferences, used to steer every AI estimate.
export async function travelerContext() {
  const [travelers, prefs] = await Promise.all([
    prisma.traveler.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.preferences.findUnique({ where: { id: "default" } }),
  ]);
  const home = getHomeLocations(travelers)[0];
  const lines = [
    formatTravelerProfilesBlock(travelers),
    prefs?.pace ? `Preferred pace: ${prefs.pace}.` : "",
    prefs?.budgetStyle ? `Budget style: ${prefs.budgetStyle}.` : "",
    prefs?.interests?.length ? `Interests: ${prefs.interests.join(", ")}.` : "",
    prefs?.notes ? `Household notes: ${prefs.notes}` : "",
    home ? `They fly round-trip from ${home}.` : "They fly round-trip from the US East Coast.",
    "Let the profiles shape the numbers: ages and mobility notes (slower pace, fewer long days), stay/food/transport preferences (e.g. higher-end hotels or direct flights raise cost), and the budget style.",
  ].filter(Boolean);
  return { travelers: travelers.length, text: lines.join("\n") };
}

