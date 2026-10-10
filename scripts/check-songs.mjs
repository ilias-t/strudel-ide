// Smoke-test every song in src/songs/ and every genre starter in src/starters/ without a browser:
//   1. createPattern() must not throw
//   2. querying the first N cycles must not throw and must produce events
//   3. every sound (s + bank) must exist: the sounds src/catalog/sounds.json lists, which are the
//      sounds the stage registers (e2e/sound-registry.spec.ts) and the editor completes
//   4. starters also export a `meta` ({ id, genre, blurb }) whose id matches the file
//
// Usage: node scripts/check-songs.mjs [song-id | starters/<id> ...] [--cycles 16]

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as core from "@strudel/core";
import * as mini from "@strudel/mini";
import * as tonal from "@strudel/tonal";
import { KnobRegistry, installKnobGlobals } from "../src/engine/knobs.ts";
import { knownSoundsFromCatalog, soundKey } from "./lib/catalog/known-sounds.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const songsDir = join(root, "src/songs");
const startersDir = join(root, "src/starters");

const args = process.argv.slice(2);
const cyclesIdx = args.indexOf("--cycles");
const cycles = cyclesIdx >= 0 ? Number(args[cyclesIdx + 1]) : 16;
const only = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--cycles");

// ─────────────────────────────────────────────────────────────────────────────
// Strudel globals (same scope initStrudel() sets up, minus audio)
// ─────────────────────────────────────────────────────────────────────────────

await core.evalScope(core, mini, tonal);
mini.miniAllStrings();

// Browser-only methods songs may call: make them no-ops returning the pattern
for (const m of ["pianoroll", "punchcard", "scope", "tscope", "fscope", "spectrum", "spiral", "wordfall", "color", "markcss"]) {
  if (!core.Pattern.prototype[m]) core.Pattern.prototype[m] = function () { return this; };
}
for (const fn of ["samples", "initStrudel", "aliasBank", "soundAlias"]) {
  globalThis[fn] ??= async () => {};
}
// The app's knob() (src/engine/knobs.ts): plays its default here
installKnobGlobals(new KnobRegistry(), core.pure);

// ─────────────────────────────────────────────────────────────────────────────
// Known sounds: the generated catalog (npm run gen:catalog), so this check, the
// library and the editor's completions agree on one list
// ─────────────────────────────────────────────────────────────────────────────

const known = knownSoundsFromCatalog(JSON.parse(readFileSync(join(root, "src/catalog/sounds.json"), "utf8")));

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

const songFiles = (dir, prefix) =>
  (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => f.endsWith(".ts") && f !== "index.ts" && !f.startsWith("_"))
    .map((f) => ({ path: join(dir, f), name: f.replace(/\.ts$/, ""), id: prefix + f.replace(/\.ts$/, ""), starter: !!prefix }));

// Songs by id ("jynx"), starters as "starters/<id>" (a plain "<id>" also selects a starter)
const files = [...songFiles(songsDir, ""), ...songFiles(startersDir, "starters/")].filter(
  (f) => only.length === 0 || only.includes(f.id) || (f.starter && only.includes(f.name)),
);
if (only.length && files.length === 0) {
  console.log(`❌ no song or starter matches ${only.join(", ")}`);
  process.exit(1);
}

/** What the "new song" flow needs from a starter's `export const meta` */
function metaProblems(meta, name) {
  if (!meta || typeof meta !== "object") return ["starter has no `export const meta = { id, genre, blurb }`"];
  const out = [];
  if (meta.id !== name) out.push(`meta.id should be "${name}" (the file name), got ${JSON.stringify(meta.id)}`);
  for (const key of ["genre", "blurb"]) {
    if (typeof meta[key] !== "string" || !meta[key].trim()) out.push(`meta.${key} must be a non-empty string`);
  }
  return out;
}

let failed = 0;

for (const { path, id, name, starter } of files) {
  const problems = [];
  let events = 0;
  try {
    const mod = await import(pathToFileURL(path).href);
    const song = mod.default;
    if (!song || typeof song.createPattern !== "function") throw new Error("default export is not a Song");
    if (!song.name) problems.push("missing name");
    if (starter) problems.push(...metaProblems(mod.meta, name));
    const result = song.createPattern();
    const isPattern = (v) => typeof v?.queryArc === "function";
    let pattern;
    if (isPattern(result)) pattern = result;
    else if (result && typeof result === "object" && Object.values(result).length && Object.values(result).every(isPattern))
      pattern = core.stack(...Object.values(result));
    else throw new Error("createPattern() must return a Pattern or a record of named Patterns");

    const unknown = new Map();
    for (let c = 0; c < cycles; c++) {
      const haps = pattern.queryArc(c, c + 1);
      events += haps.length;
      for (const hap of haps) {
        const key = soundKey(hap.value);
        if (key && !known.has(key)) unknown.set(key, (unknown.get(key) ?? 0) + 1);
      }
    }
    if (events === 0) problems.push(`no events in first ${cycles} cycles`);
    for (const [key, n] of unknown) problems.push(`unknown sound "${key}" (${n} events)`);
  } catch (e) {
    problems.push(`threw: ${e?.stack ?? e}`);
  }

  if (problems.length) {
    failed++;
    console.log(`❌ ${id}`);
    for (const p of problems) console.log(`   - ${p}`);
  } else {
    console.log(`✅ ${id} — ${events} events / ${cycles} cycles`);
  }
}

process.exit(failed ? 1 : 0);
