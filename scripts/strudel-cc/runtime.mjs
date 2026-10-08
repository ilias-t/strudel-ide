// Strudel in Node, two ways:
//   - as Strudel IDE runs songs: core + mini + tonal globals, miniAllStrings()
//     on, browser-only methods as no-ops (the same scope scripts/check-songs.mjs
//     sets up)
//   - as strudel.cc runs REPL code: the same globals, but code goes through
//     @strudel/transpiler and core's repl() (labels → .p(), "…" → m(…),
//     slider → sliderWithID, setcpm), and plain strings are NOT mini-parsed
//
// Shared by export.mjs / import.mjs (to read a song's bpm/sections and check
// results) and scripts/test-strudel-cc.mjs (to compare haps).

import "./quiet.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as core from "@strudel/core";
import * as mini from "@strudel/mini";
import * as tonal from "@strudel/tonal";
import { transpiler } from "@strudel/transpiler";

export const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

// Methods that draw in the browser; songs may call them (strudel.cc too)
const DRAW_METHODS = [
  "pianoroll", "punchcard", "scope", "tscope", "fscope", "spectrum", "spiral", "wordfall", "color", "markcss",
  "pitchwheel",
];

let ready;
let installKnobs = () => {};

/**
 * Drawing methods are no-ops in Node. Re-applied before every use: importing
 * @strudel/draw (scripts/lib/strudel-runtime.mjs does) installs the real ones,
 * which need `window`.
 */
function stubDrawMethods() {
  for (const m of DRAW_METHODS) {
    // core's own (color is a control) stays; anything @strudel/draw adds is stubbed
    if (CORE_METHODS[m]) core.Pattern.prototype[m] = CORE_METHODS[m];
    else if (!core.Pattern.prototype[m]?.__stub) {
      const stub = function () { return this; };
      stub.__stub = true;
      core.Pattern.prototype[m] = stub;
    }
  }
}
// captured before anything can import @strudel/draw (this module imports only core)
const CORE_METHODS = Object.fromEntries(DRAW_METHODS.map((m) => [m, core.Pattern.prototype[m]]));

/** Install the Strudel IDE globals (idempotent). */
export async function setupGlobals() {
  stubDrawMethods();
  return setupOnce();
}

function setupOnce() {
  ready ??= (async () => {
    // core's logger prints "[eval] code updated" on every repl evaluation
    const quiet = console.log;
    console.log = (...args) => (String(args[0]).includes("@strudel/core loaded") ? undefined : quiet(...args));
    await core.evalScope(core, mini, tonal);
    console.log = quiet;
    mini.miniAllStrings();
    for (const fn of ["samples", "initStrudel", "aliasBank", "soundAlias"]) {
      globalThis[fn] ??= async () => {};
    }
    // knob(name, value, min, max, step?): the app's live control. In Node it
    // plays its default, installed exactly as scripts/check-songs.mjs does
    try {
      const { KnobRegistry, installKnobGlobals } = await import("../../src/engine/knobs.ts");
      installKnobs = () => installKnobGlobals(new KnobRegistry(), core.pure);
    } catch {
      installKnobs = () => (globalThis.knob = (_name, value) => core.pure(value));
    }
  })();
  return ready;
}

// ─────────────────────────────────────────────────────────────────────────────
// strudel.cc emulation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * strudel.cc's `.piano()`: defined by the website's prebake.mjs, not by any
 * package (copied from website/src/repl/prebake.mjs, AGPL-3.0).
 */
function installPiano() {
  if (core.Pattern.prototype.piano) return;
  const maxPan = core.noteToMidi("C8");
  const panwidth = (pan, width) => pan * width + (1 - width) / 2;
  core.Pattern.prototype.piano = function () {
    return this.fmap((v) => ({ ...v, clip: v.clip ?? 1 }))
      .s("piano")
      .release(0.1)
      .fmap((value) => {
        const midi = core.valueToMidi(value);
        const pan = panwidth(Math.min(Math.round(midi) / maxPan, 1), 0.5);
        return { ...value, pan: (value.pan || 1) * pan };
      });
  };
}

/**
 * Evaluate code the way the strudel.cc REPL does and return the pattern it
 * would play plus the tempo it set. Plain strings are not mini-parsed during
 * the evaluation (strudel.cc never calls miniAllStrings), unless the code
 * calls miniAllStrings() itself.
 */
export async function evalStrudelCc(code) {
  await setupGlobals();
  installPiano();
  // slider(v, min, max) is transpiled to sliderWithID(id, v, min, max);
  // @strudel/codemirror's version is ref(() => sliderValues[id])
  globalThis.sliderWithID = (_id, value) => core.ref(() => value);
  globalThis.slider = (value) => core.pure(value);
  // inline widgets (._pianoroll() …) are registered by @strudel/codemirror
  for (const m of ["_pianoroll", "_punchcard", "_scope", "_spiral", "_pitchwheel", "_spectrum", "_tscope", "_fscope"]) {
    core.Pattern.prototype[m] ??= function () { return this; };
  }
  core.setStringParser(undefined);
  const quiet = console.log;
  console.log = () => {};
  try {
    let error;
    const { evaluate, scheduler } = core.repl({
      defaultOutput: () => {},
      getTime: () => 0,
      transpiler,
      onEvalError: (e) => (error = e),
    });
    const pattern = await evaluate(code, false);
    if (error) throw error;
    return { pattern, cps: scheduler.cps };
  } finally {
    console.log = quiet;
    core.setStringParser(mini.mini);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Songs
// ─────────────────────────────────────────────────────────────────────────────

let importCounter = 0;

/** Import a song module (a .ts file; Node strips the types) fresh, not cached. */
export async function loadSong(file) {
  await setupGlobals();
  // a fresh knob registry per song: knobs are per song, and a registry hands an
  // existing name its current value (another song's "swing" would leak in)
  installKnobs();
  const mod = await import(`${pathToFileURL(file).href}?v=${++importCounter}`);
  const song = mod.default;
  if (!song || typeof song.createPattern !== "function") throw new Error(`${file}: default export is not a Song`);
  return song;
}

export const isPattern = (v) => typeof v?.queryArc === "function";

/** A song's createPattern() result as [name, pattern] tracks (one "$" track for a single Pattern). */
export function songTracks(song) {
  const result = song.createPattern();
  if (isPattern(result)) return [["$", result]];
  if (!result || typeof result !== "object") throw new Error("createPattern() returned neither a Pattern nor tracks");
  return Object.entries(result);
}

export function songPattern(song) {
  return core.stack(...songTracks(song).map(([, p]) => p));
}

// ─────────────────────────────────────────────────────────────────────────────
// Hap comparison
// ─────────────────────────────────────────────────────────────────────────────

const frac = (f) => (f === undefined ? "-" : f.toFraction?.() ?? String(f));

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${k}:${stable(value[k])}`).join(",")}}`;
}

/** The haps of `pattern` over [0, cycles) as sorted, comparable strings (time + value). */
export function hapKeys(pattern, cycles = 16) {
  const keys = [];
  for (let c = 0; c < cycles; c++) {
    for (const hap of pattern.queryArc(c, c + 1)) {
      const whole = hap.whole ? `${frac(hap.whole.begin)}-${frac(hap.whole.end)}` : "~";
      keys.push(`${frac(hap.part.begin)}-${frac(hap.part.end)} ${whole} ${stable(hap.value)}`);
    }
  }
  return keys.sort();
}

/** Compare two hap lists; null when equal, otherwise a short description of the first differences. */
export function diffHaps(expected, actual, limit = 4) {
  if (expected.length === actual.length && expected.every((k, i) => k === actual[i])) return null;
  const a = new Map();
  for (const k of expected) a.set(k, (a.get(k) ?? 0) + 1);
  const b = new Map();
  for (const k of actual) b.set(k, (b.get(k) ?? 0) + 1);
  const missing = [...a].filter(([k, n]) => (b.get(k) ?? 0) < n).map(([k]) => k);
  const extra = [...b].filter(([k, n]) => (a.get(k) ?? 0) < n).map(([k]) => k);
  const lines = [`expected ${expected.length} haps, got ${actual.length}`];
  for (const k of missing.slice(0, limit)) lines.push(`  missing: ${k}`);
  for (const k of extra.slice(0, limit)) lines.push(`  extra:   ${k}`);
  return lines.join("\n");
}

export { core, mini };
