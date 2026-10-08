// Smoke-test every song in src/songs/ without a browser:
//   1. createPattern() must not throw
//   2. querying the first N cycles must not throw and must produce events
//   3. every sound (s + bank) must exist in the sample maps main.ts loads
//
// Usage: node scripts/check-songs.mjs [song-id ...] [--cycles 16] [--offline]

import { readdirSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as core from "@strudel/core";
import * as mini from "@strudel/mini";
import * as tonal from "@strudel/tonal";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const songsDir = join(root, "src/songs");
const cacheDir = join(root, "node_modules/.cache/strudel-samples");

const args = process.argv.slice(2);
const cyclesIdx = args.indexOf("--cycles");
const cycles = cyclesIdx >= 0 ? Number(args[cyclesIdx + 1]) : 16;
const offline = args.includes("--offline");
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

// ─────────────────────────────────────────────────────────────────────────────
// Known sounds
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_MAPS = [
  "tidal-drum-machines",
  "piano",
  "vcsl",
  "uzu-drumkit",
  "uzu-wavetables",
  "mridangam",
];

const SYNTHS = [
  "sine", "square", "triangle", "sawtooth", "saw", "tri", "sqr", "sin",
  "supersaw", "pulse", "sbd", "bytebeat",
  "white", "pink", "brown", "crackle",
  "zzfx", "z_sine", "z_sawtooth", "z_triangle", "z_square", "z_tan", "z_noise",
];

async function loadJson(name) {
  const file = join(cacheDir, `${name}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  if (offline) return null;
  const res = await fetch(`https://strudel.b-cdn.net/${name}.json`);
  if (!res.ok) throw new Error(`fetch ${name}: ${res.status}`);
  const json = await res.json();
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(file, JSON.stringify(json));
  return json;
}

const known = new Set(SYNTHS);
let soundCheck = true;
try {
  for (const name of SAMPLE_MAPS) {
    const map = await loadJson(name);
    if (!map) { soundCheck = false; break; }
    for (const key of Object.keys(map)) if (key !== "_base") known.add(key.toLowerCase());
  }
  // Short bank aliases (e.g. "TR808" → "RolandTR808")
  const aliases = await loadJson("tidal-drum-machines-alias");
  if (aliases) {
    for (const key of [...known]) {
      const [bank, suffix] = key.split("_");
      if (!suffix) continue;
      for (const [long, short] of Object.entries(aliases)) {
        if (long.toLowerCase() !== bank) continue;
        for (const s of [short].flat()) known.add(`${s}_${suffix}`.toLowerCase());
      }
    }
  }
} catch (e) {
  console.warn(`⚠️  Sound-name check disabled: ${e.message}`);
  soundCheck = false;
}

function soundKey(value) {
  if (!value || typeof value !== "object") return null;
  let s = value.s;
  if (s === undefined) return value.note !== undefined || value.n !== undefined || value.freq !== undefined ? "triangle" : null;
  s = String(s).split(":")[0];
  return (value.bank ? `${value.bank}_${s}` : s).toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

const files = readdirSync(songsDir)
  .filter((f) => f.endsWith(".ts") && f !== "index.ts" && !f.startsWith("_"))
  .filter((f) => only.length === 0 || only.includes(f.replace(/\.ts$/, "")));

let failed = 0;

for (const file of files) {
  const id = file.replace(/\.ts$/, "");
  const problems = [];
  let events = 0;
  try {
    const mod = await import(pathToFileURL(join(songsDir, file)).href);
    const song = mod.default;
    if (!song || typeof song.createPattern !== "function") throw new Error("default export is not a Song");
    if (!song.name) problems.push("missing name");
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
      if (!soundCheck) continue;
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

if (!soundCheck) console.log("(sound names not verified)");
process.exit(failed ? 1 : 0);
