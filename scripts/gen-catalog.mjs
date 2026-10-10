// Generates the discovery catalog in src/catalog/ — data for the library panel, the ⌘K palette and
// the track builder. Lazy-load these files; they are generated, never edit them by hand.
//
// Usage: node scripts/gen-catalog.mjs [--check] [--offline]
//   --check    regenerate in memory and exit 1 if a file in src/catalog differs (wired into `npm run check`)
//   --offline  never fetch sample maps; fail if node_modules/.cache/strudel-samples lacks one
//
// Inputs: the sample maps src/engine/strudel.ts loads (SAMPLE_MAPS + BANK_ALIASES, cached like
// check-songs/gen-sound-types), superdough's built-in synths, src/strudel.generated.d.ts (so
// `npm run gen:types` reruns this), and the curated lists in scripts/lib/catalog/.
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
//   }]
// }
// ─── snippets.json ───────────────────────────────────────────────────────────
// { snippets: [{ id, role, title, description, code, tags?, bpm? }] }
//   role is a TrackRole (src/engine/tracks.ts): name the track after it. code is one expression of
//   string literals (it lights up when pasted). Curated in scripts/lib/catalog/snippets.mjs.
// ─── completions.json ────────────────────────────────────────────────────────
// { functions: { [name]: { category, rank, availability, aliasOf?, synonyms?, range?, docUrl? } },
//   after: { [call]: string[] } }        // CompletionsCatalog in src/ui/discover/catalog.ts
//   The editor's method list reads this instead of functions.json. rank: 0 = most used (usage in songs,
//   starters, snippets and examples, blended with a core list); availability: "ok" | "superdirt" |
//   "visual" | "io" | "internal" (sinks in lists, with the reason); after.s: methods most used right
//   after s(…). Built in scripts/lib/catalog/completions.mjs.
// ─── theory.json ─────────────────────────────────────────────────────────────
// { scales: [{ name, intervals, common? }], chords: { [symbol]: intervals }, vowels, voicingDicts }
//   Theory in src/ui/complete/types.ts; built in scripts/lib/catalog/theory.mjs.
// ─── intents.json ────────────────────────────────────────────────────────────
// { intents: [{ id, phrases, functions, recipe?, snippets?, tip?, role? }] }
//   Search by sound ("wetter" → room, size, delay). Curated in scripts/lib/catalog/intents.mjs.
//
// strudel.cc links come from scripts/lib/catalog/strudel-docs.json, a committed snapshot of the docs'
// heading anchors (refresh it by hand: node scripts/fetch-strudel-docs.mjs).

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { loadCatalogInputs } from "./lib/catalog/inputs.mjs";
import { generateCatalog, CATALOG_FILES } from "./lib/catalog/generate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src/catalog");
const check = process.argv.includes("--check");
const offline = process.argv.includes("--offline");

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
