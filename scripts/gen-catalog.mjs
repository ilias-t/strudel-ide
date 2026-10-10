// Generates the discovery catalog in src/catalog/ — data for the library panel, the ⌘K palette and
// the track builder. Lazy-load these files; they are generated, never edit them by hand.
//
// Usage: node scripts/gen-catalog.mjs [--check] [--offline] [--recount]
//   --check    regenerate in memory and exit 1 if a file in src/catalog differs (wired into `npm run check`)
//   --offline  never fetch sample maps; fail if node_modules/.cache/strudel-samples lacks one
//   --recount  first recount function usage into scripts/lib/catalog/usage.json (see below), then generate
//
// Inputs: the sample maps src/engine/strudel.ts loads (SAMPLE_MAPS + BANK_ALIASES, cached like
// check-songs/gen-sound-types), superdough's built-in synths, src/strudel.generated.d.ts (so
// `npm run gen:types` reruns this), the curated lists in scripts/lib/catalog/, the theory data the
// app plays with (tonal's scale/chord types, @strudel/tonal's voicingRegistry, superdough's vowels),
// and two committed snapshots, both refreshed by hand so that `check` never depends on them moving:
//   - scripts/lib/catalog/usage.json: how often each function is called in src/songs, src/starters,
//     the snippets and the JSDoc examples, per source kind, plus chain co-occurrence (ranking.mjs's
//     countUsage). Editing a song doesn't make the catalog stale; rerun with --recount when the
//     songs have moved on. test/catalog-data.test.mjs fails when it names a function that's gone.
//   - scripts/lib/catalog/strudel-docs.json: strudel.cc's headings (node scripts/fetch-strudel-docs.mjs).
// All lists are sorted by code point (or curated order); output is byte-identical across runs.
//
// ─── sounds.json ─────────────────────────────────────────────────────────────
// {
//   groups: [{ id, label, kinds: [{ id, label, sounds: string[] }] }]   // by kind, display order
//       groups/kinds: drums (kick snare clap rim hat openhat cymbal tom shaker perc break),
//       instruments (keys organ mallets plucked strings wind), synths (synth noise wavetable zzfx), fx (fx)
//   banks: { [bank]: { aliases: string[], parts: string[] } }           // by bank, e.g.
//       "RolandTR909": { aliases: ["TR909"], parts: ["bd", "cp", ...] }  → s("bd").bank("TR909")
//   sounds: { [name]: {
//       kind,            // one of the kind ids above
//       source?,         // where the unbanked sound comes from: a sample map name or "superdough"
//       count?,          // files in the unbanked entry (pick one with n() / "name:2"); absent if bank-only
//       pitched?: true,  // samples keyed by note: play them with note(), like a synth
//       banks?: { [bank]: count },  // drum parts: banks that have this part, with their file counts
//       aliasOf?,        // e.g. "saw" → "sawtooth"
//   } }
// }
// ─── functions.json ──────────────────────────────────────────────────────────
// {
//   categories: [{ id, label, count }],   // display order; see scripts/lib/catalog/function-categories.mjs
//   functions: [{                          // one per name, sorted
//     name, category,
//     kind: "method" | "function" | "both" | "value",   // Pattern method, global, both, or a const (sine, perlin…)
//     signatures: string[],    // ".lpf(frequency?: NumberInput): Pattern" (methods start with "."), "lpf(…)", "const sine: Pattern"
//     summary,                 // first sentence of description ("" when undocumented)
//     description,             // full JSDoc text, generated notes removed (markdown-ish)
//     params: [{ name, description }],
//     examples: string[],      // strudel.cc's examples in the IDE's form: "a b".fast(2) → mini("a b").fast(2),
//                              // ._scope() → .scope(). About 1 in 10 still won't type-check in a song
//                              // (.osc()/.midi() outputs, upstream signatures looser than the d.ts)
//     synonyms: string[],      // other names for the same thing
//     aliasOf?,                // this name is an alias of that one
//     superdirtOnly?: true,    // no effect with the built-in WebAudio output
//     deprecated?: string | true,
//     rank, availability, range?, docUrl?,   // the same values as completions.json (below)
//   }]
// }
// ─── snippets.json ───────────────────────────────────────────────────────────
// { snippets: [{ id, role, title, description, code, tags?, bpm? }] }
//   role is a TrackRole (src/engine/tracks.ts): name the track after it. code is one expression of
//   string literals (it lights up when pasted). Curated in scripts/lib/catalog/snippets.mjs.
// ─── completions.json ────────────────────────────────────────────────────────
// { functions: { [name]: { category, rank, availability, aliasOf?, synonyms?, range?, docUrl? } },
//   after: { [head]: string[] } }        // CompletionsCatalog in src/ui/discover/catalog.ts
//   The editor's method list reads this instead of functions.json (it loads with Monaco: compact JSON,
//   one entry per line). Every function has an entry; optional fields are left out when empty.
//   category      as in functions.json
//   rank          0 = most used, 0…n-1, unique. Score = calls in usage.json, weighted songs/starters/
//                 snippets 1, strudel.cc examples ¼; the curated CORE list (ranking.mjs) gets a floor
//                 falling linearly from just above the top count (CORE[0]) to the 20th-highest count
//                 (last CORE name). So the list opens s n note bank gain lpf hpf room delay pan speed fast…
//                 and well-used names (range, mask, orbit) interleave with the core's tail. Ties: code point.
//   availability  "ok" | "superdirt" (superdirtOnly) | "visual" | "io" | "internal" (the category, or a
//                 name audition.ts refuses to preview: UNSAFE_BUCKETS in completions.mjs). Never hides,
//                 only sinks with the reason. mini/m stay "ok" (io by category, but how songs write strings).
//   aliasOf, synonyms   as in functions.json
//   range         { min?, max?, unit?, log? }: curated in ranges.mjs from controls.mjs's prose and
//                 superdough's clamps; unit "Hz" | "s" | "cycles" | "semitones" | "bits" | "m"; log: true
//                 for frequencies. Aliases inherit their target's.
//   docUrl        "https://strudel.cc/<page>/#<anchor>" or just the page: from strudel-docs.json via
//                 doc-links.mjs (curated overrides, then the heading naming the function as code, then
//                 its category's page). Aliases link where their target does. Absent: internal/other.
//   after[head]   for a chain head (a call or value a chain starts from: s, note, n, chord, mini, stack,
//                 sine…) with ≥ 10 weighted method calls: its top 20 methods by weighted calls in chains
//                 starting there (after.s: gain bank hpf pan room lpf…). Ties: code point.
//   Built in scripts/lib/catalog/completions.mjs (+ ranking.mjs, ranges.mjs, doc-links.mjs).
// ─── theory.json ─────────────────────────────────────────────────────────────
// { scales: [{ name, intervals, common? }], chords: { [symbol]: intervals }, vowels, voicingDicts }
//   Theory in src/ui/complete/types.ts; built in scripts/lib/catalog/theory.mjs.
//   scales        tonal's 92 scale types (main names, intervals like "3m"): COMMON_SCALES first in
//                 that order with common: true, then the rest by name
//   chords        the 85 symbols of @strudel/tonal's default voicing dictionary (iReal: "", "-7", "^7",
//                 "m7", "7b9"…) → intervals from the root ("1P 3m 5P 7m"), via tonal's chord types
//   vowels        the 15 vowel() letters superdough has formants for (a e i o u ae aa oe ue y uh un en an on)
//   voicingDicts  voicingRegistry's dictionaries (lefthand triads guidetones legacy ireal ireal-ext)
// ─── intents.json ────────────────────────────────────────────────────────────
// { intents: [{ id, phrases, functions, recipe?, snippets?, tip?, role? }] }
//   Search by sound ("wetter" → room, size, delay). Curated in scripts/lib/catalog/intents.mjs.
//
// strudel.cc links come from scripts/lib/catalog/strudel-docs.json, a committed snapshot of the docs'
// headings (refresh it by hand: node scripts/fetch-strudel-docs.mjs).

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { loadCatalogInputs, usageSources, USAGE_FILE } from "./lib/catalog/inputs.mjs";
import { generateCatalog, CATALOG_FILES } from "./lib/catalog/generate.mjs";
import { buildFunctions } from "./lib/catalog/functions.mjs";
import { countUsage } from "./lib/catalog/ranking.mjs";
import { toJson } from "./lib/catalog/util.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src/catalog");
const check = process.argv.includes("--check");
const offline = process.argv.includes("--offline");
const recount = process.argv.includes("--recount");

if (recount && check) {
  console.error("--recount rewrites usage.json; it can't be combined with --check");
  process.exit(2);
}
if (recount) {
  const functions = buildFunctions(readFileSync(join(root, "src/strudel.generated.d.ts"), "utf8"));
  const sources = usageSources(root, functions);
  const about =
    "Usage counts behind completions.json's rank and after (scripts/lib/catalog/ranking.mjs). " +
    "Generated by `node scripts/gen-catalog.mjs --recount` from src/songs, src/starters, the snippets and the JSDoc examples; never edit by hand.";
  writeFileSync(join(root, USAGE_FILE), toJson({ about, ...countUsage(sources, functions) }));
  console.log(`wrote ${USAGE_FILE} (${sources.length} sources)`);
}

const catalog = generateCatalog(await loadCatalogInputs({ root, offline }));

if (check) {
  const stale = CATALOG_FILES.filter((f) => {
    const path = join(outDir, f);
    return !existsSync(path) || readFileSync(path, "utf8") !== catalog[f];
  });
  if (stale.length) {
    console.error(`❌ src/catalog is stale: ${stale.join(", ")} — run \`npm run gen:catalog\``);
    process.exit(1);
  }
  console.log(`✅ src/catalog is up to date (${CATALOG_FILES.join(", ")})`);
} else {
  mkdirSync(outDir, { recursive: true });
  for (const f of CATALOG_FILES) {
    writeFileSync(join(outDir, f), catalog[f]);
    const bytes = Buffer.byteLength(catalog[f]);
    console.log(`wrote src/catalog/${f}: ${(bytes / 1024).toFixed(1)} kB (${(gzipSync(catalog[f]).length / 1024).toFixed(1)} kB gzip)`);
  }
}
