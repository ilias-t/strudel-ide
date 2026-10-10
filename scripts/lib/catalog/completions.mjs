// completions.json: the slim per-function data the editor's method list needs (category, rank,
// availability, alias, synonyms, range, doc link), so the editor never loads functions.json.
// Pure. The ranking (ranking.mjs), ranges (ranges.mjs) and doc links (doc-links.mjs) join here.

import { sortKeys } from "./util.mjs";

/**
 * Names src/ui/discover/audition.ts refuses to preview (its UNSAFE pattern) that the category table
 * files elsewhere, with the bucket they sink to. test/catalog-data.test.mjs reads UNSAFE from
 * audition.ts and fails if one of its names that is a function stays "ok" without being listed here.
 * `ok` lists the ones that are fine in a song even though a preview won't run them.
 */
export const UNSAFE_BUCKETS = {
  visual: ["scope", "tscope", "fscope", "pianoroll", "punchcard", "spiral", "pitchwheel", "spectrum", "wordfall", "markcss", "draw", "animate", "onPaint", "onFrame"],
  io: ["osc", "midi", "midin", "serial", "csound", "mqtt", "dough", "onTrigger", "samples", "soundAlias", "aliasBank", "register", "hush", "setcps", "setcpm", "setCps", "setCpm", "evalScope", "initAudio", "initStrudel", "loadOrc", "loadCsound"],
  internal: ["log", "logValues"],
  ok: [],
};

/** In io by category, but the way songs write mini-notation: never demoted */
const SONG_CARRIERS = new Set(["mini", "m"]);

const BUCKET_OF = new Map(Object.entries(UNSAFE_BUCKETS).flatMap(([bucket, names]) => names.map((n) => [n, bucket])));

/** Why a function sinks in lists ("ok": it doesn't) */
export function availabilityOf(fn) {
  if (fn.superdirtOnly) return "superdirt";
  if (SONG_CARRIERS.has(fn.name)) return "ok";
  if (fn.category === "visual" || fn.category === "io" || fn.category === "internal") return fn.category;
  return BUCKET_OF.get(fn.name) ?? "ok";
}

/**
 * @param {{ name: string, category: string, aliasOf?: string, synonyms: string[], superdirtOnly?: true }[]} functions
 * @param {{ rank: Record<string, number>, after: Record<string, string[]>, ranges: Record<string, object>, docUrls: Record<string, string> }} extra
 */
export function buildCompletions(functions, { rank, after, ranges, docUrls }) {
  const out = {};
  for (const fn of functions) {
    out[fn.name] = {
      category: fn.category,
      rank: rank[fn.name],
      availability: availabilityOf(fn),
      ...(fn.aliasOf ? { aliasOf: fn.aliasOf } : {}),
      ...(fn.synonyms.length ? { synonyms: fn.synonyms } : {}),
      ...(ranges[fn.name] ? { range: ranges[fn.name] } : {}),
      ...(docUrls[fn.name] ? { docUrl: docUrls[fn.name] } : {}),
    };
  }
  return { functions: sortKeys(out), after: sortKeys(after) };
}

/**
 * completions.json's text: compact, one entry per line. The editor loads it with Monaco, so it
 * skips the 2-space indent the other catalog files use (a third of the size), but stays diffable.
 * @param {{ functions: Record<string, object>, after: Record<string, string[]> }} completions
 */
export function completionsJson({ functions, after }) {
  const block = (obj) => Object.entries(obj).map(([k, v]) => JSON.stringify(k) + ":" + JSON.stringify(v)).join(",\n");
  return `{"functions":{\n${block(functions)}\n},\n"after":{\n${block(after)}\n}}\n`;
}
