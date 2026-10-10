// Search by sound: how people describe what they want ("wetter", "wobble", "acid bass", "lo-fi drums")
// → the functions and a recipe that get there. Curated; copied into src/catalog/intents.json.
// Shape: Intent in src/ui/discover/catalog.ts. Rules (test/catalog-intents.test.mjs): ids and phrases
// unique and lowercase, functions real, recipes evaluate headlessly and play only known sounds at
// gain ≤ 1, snippet ids real, roles are TrackRoles.

export const INTENTS = [];
