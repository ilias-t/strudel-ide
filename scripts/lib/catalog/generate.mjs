// Builds the catalog files (file name → exact JSON text) from loaded inputs. Pure.

import { buildSounds } from "./sounds.mjs";
import { buildFunctions } from "./functions.mjs";
import { CATEGORIES, categorize } from "./function-categories.mjs";
import { SNIPPETS } from "./snippets.mjs";
import { buildCompletions } from "./completions.mjs";
import { buildTheory } from "./theory.mjs";
import { INTENTS } from "./intents.mjs";
import { toJson } from "./util.mjs";

export const CATALOG_FILES = ["sounds.json", "functions.json", "snippets.json", "completions.json", "theory.json", "intents.json"];

/** @param {{ maps: Record<string, any>, aliasMap: Record<string, string | string[]>, synths: string[], dts: string }} inputs */
export function generateCatalog({ maps, aliasMap, synths, dts }) {
  const functions = categorize(buildFunctions(dts));
  const categories = CATEGORIES.map((c) => ({ ...c, count: functions.filter((f) => f.category === c.id).length }));
  return {
    "sounds.json": toJson(buildSounds({ maps, aliasMap, synths })),
    "functions.json": toJson({ categories, functions }),
    "snippets.json": toJson({ snippets: SNIPPETS }),
    "completions.json": toJson(buildCompletions(functions)),
    "theory.json": toJson(buildTheory()),
    "intents.json": toJson({ intents: INTENTS }),
  };
}
