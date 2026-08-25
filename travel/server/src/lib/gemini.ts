export function getGeminiApiKey(): string | null {
  return process.env.GEMINI_API_KEY || null;
}

// "gemini-flash-latest" and "gemini-3.7-flash" both hit persistent 503
// (overloaded) errors in testing on a real itinerary-sized prompt; the
// lighter "flash-lite" alias was reliably fast. If it starts erroring, try
// setting GEMINI_MODEL to another current model from the ListModels API.
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
