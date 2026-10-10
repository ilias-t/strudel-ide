// Builds the catalog files (file name → exact JSON text) from loaded inputs. Pure.

import { buildSounds } from "./sounds.mjs";
import { buildFunctions } from "./functions.mjs";
import { CATEGORIES, categorize } from "./function-categories.mjs";
import { SNIPPETS } from "./snippets.mjs";
import { availabilityOf, buildCompletions, completionsJson } from "./completions.mjs";
import { buildRanking } from "./ranking.mjs";
import { buildRanges } from "./ranges.mjs";
import { docUrls } from "./doc-links.mjs";
import { buildTheory } from "./theory.mjs";
import { INTENTS } from "./intents.mjs";
import { toJson } from "./util.mjs";

export const CATALOG_FILES = ["sounds.json", "functions.json", "snippets.json", "completions.json", "theory.json", "intents.json"];

/** @param {Awaited<ReturnType<typeof import("./inputs.mjs").loadCatalogInputs>>} inputs */
export function generateCatalog({ maps, aliasMap, synths, dts, usage, docs, theory }) {
  const base = categorize(buildFunctions(dts));
  const { rank, after } = buildRanking(usage, base);
  const ranges = buildRanges(base);
  const urls = docUrls(base, docs);
  const functions = base.map((f) => ({
    ...f,
    rank: rank[f.name],
    availability: availabilityOf(f),
    ...(ranges[f.name] ? { range: ranges[f.name] } : {}),
    ...(urls[f.name] ? { docUrl: urls[f.name] } : {}),
  }));
  const categories = CATEGORIES.map((c) => ({ ...c, count: functions.filter((f) => f.category === c.id).length }));
  return {
    "sounds.json": toJson(buildSounds({ maps, aliasMap, synths })),
    "functions.json": toJson({ categories, functions }),
    "snippets.json": toJson({ snippets: SNIPPETS }),
    "completions.json": completionsJson(buildCompletions(base, { rank, after, ranges, docUrls: urls })),
    "theory.json": toJson(buildTheory(theory)),
    "intents.json": toJson({ intents: INTENTS }),
  };
}
