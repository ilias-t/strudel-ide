// completions.json: the slim per-function data the editor's method list needs (category, rank,
// availability, alias, synonyms, range, doc link), so the editor never loads functions.json.
// Pure. The ranking (ranking.mjs), ranges (ranges.mjs) and doc links (strudel-docs.json) join here.

import { sortKeys } from "./util.mjs";

/** Why a function sinks in lists ("ok": it doesn't) */
export function availabilityOf(fn) {
  if (fn.superdirtOnly) return "superdirt";
  if (fn.category === "visual" || fn.category === "io" || fn.category === "internal") return fn.category;
  return "ok";
}

/**
 * @param {{ name: string, category: string, aliasOf?: string, synonyms: string[], superdirtOnly?: true }[]} functions
 * @param {{ rank?: (name: string) => number, after?: Record<string, string[]> }} [extra]
 */
export function buildCompletions(functions, { rank = () => functions.length, after = {} } = {}) {
  const out = {};
  for (const fn of functions) {
    out[fn.name] = {
      category: fn.category,
      rank: rank(fn.name),
      availability: availabilityOf(fn),
      ...(fn.aliasOf ? { aliasOf: fn.aliasOf } : {}),
      ...(fn.synonyms.length ? { synonyms: fn.synonyms } : {}),
    };
  }
  return { functions: sortKeys(out), after: sortKeys(after) };
}
