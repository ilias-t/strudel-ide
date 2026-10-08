// Song metadata for the render/analyze tools, read in Node (no browser):
//   - name, bpm and track names, by importing the song module (like check-songs.mjs)
//   - the arrangement (section names + bars): the song's `sections`, or else parsed from
//     its source (an ARRANGEMENT / SECTIONS / FORM / BARS constant)

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as core from "@strudel/core";
import * as mini from "@strudel/mini";
import * as tonal from "@strudel/tonal";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const SONGS_DIR = join(ROOT, "src/songs");
/** Genre starter songs (same Song format; copied into src/songs by the "new song" flow) */
export const STARTERS_DIR = join(ROOT, "src/starters");

let scopeReady = null;
function strudelScope() {
  scopeReady ??= (async () => {
    await core.evalScope(core, mini, tonal);
    mini.miniAllStrings();
    // Browser-only methods songs may call: no-ops here
    for (const m of ["pianoroll", "punchcard", "scope", "tscope", "fscope", "spectrum", "spiral", "wordfall", "color", "markcss"]) {
      if (!core.Pattern.prototype[m]) core.Pattern.prototype[m] = function () { return this; };
    }
    // The app's knob() (as in check-songs.mjs): songs with top-level knobs need it to import
    const { KnobRegistry, installKnobGlobals } = await import("../../src/engine/knobs.ts");
    installKnobGlobals(new KnobRegistry(), core.pure);
  })();
  return scopeReady;
}

const songFilesIn = (dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".ts") && f !== "index.ts" && !f.startsWith("_"))
        .map((f) => f.replace(/\.ts$/, ""))
    : [];

/** Song ids (src/songs) followed by starter ids ("starters/<id>", src/starters) */
export function listSongIds() {
  return [...songFilesIn(SONGS_DIR), ...listStarterIds().map((id) => `starters/${id}`)];
}

/** Ids of the genre starters in src/starters */
export function listStarterIds() {
  return songFilesIn(STARTERS_DIR);
}

/**
 * Where a song id lives: "jynx" → src/songs/jynx.ts; "starters/house" (or plain "house"
 * when no song has that id) → src/starters/house.ts.
 * @returns {{ id: string, file: string, starter: boolean, module: string } | null}
 *   id = the canonical id ("starters/house" for a starter), module = the URL path Vite serves it at
 */
export function resolveSong(id) {
  const name = id.replace(/^starters\//, "");
  const candidates = id.startsWith("starters/") ? [[STARTERS_DIR, true]] : [[SONGS_DIR, false], [STARTERS_DIR, true]];
  for (const [dir, starter] of candidates) {
    const file = join(dir, `${name}.ts`);
    if (existsSync(file)) {
      return { id: starter ? `starters/${name}` : name, file, starter, module: `/src/${starter ? "starters" : "songs"}/${name}.ts` };
    }
  }
  return null;
}

/**
 * Parse the arrangement out of a song's source.
 * Supports `const ARRANGEMENT|SECTIONS|FORM = [["intro", 8], ...]` and
 * `const BARS = { intro: 16, ... }` (object order = play order, as `arrange` uses it).
 * @returns {{name: string, bars: number, start: number}[] | null} start = first bar (0-based)
 */
export function parseSections(source) {
  let pairs = null;
  const arr = source.match(/const\s+(?:ARRANGEMENT|SECTIONS|FORM|STRUCTURE)\b[^=]*=\s*\[([\s\S]*?)\]\s*(?:as\s+const\s*)?;/);
  if (arr) {
    pairs = [...arr[1].matchAll(/\[\s*["'](\w+)["']\s*,\s*(\d+)\s*\]/g)].map((m) => [m[1], Number(m[2])]);
  }
  if (!pairs?.length) {
    const obj = source.match(/const\s+BARS\s*=\s*\{([\s\S]*?)\}/);
    if (obj) pairs = [...obj[1].matchAll(/(\w+)\s*:\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]);
  }
  if (!pairs?.length) return null;
  let start = 0;
  return pairs.map(([name, bars]) => {
    const s = { name, bars, start };
    start += bars;
    return s;
  });
}

/** A song's own `sections` ([name, bars] tuples or { name, bars } objects) → with start bars */
function normalizeSections(list) {
  if (!Array.isArray(list) || !list.length) return null;
  let start = 0;
  return list.map((s) => {
    const [name, bars] = Array.isArray(s) ? s : [s.name, s.bars];
    const out = { name: String(name), bars: Number(bars), start };
    start += out.bars;
    return out;
  });
}

/**
 * @returns {Promise<{id, name, bpm, tracks: string[] | null, sections, totalBars: number | null, starter: boolean, module: string}>}
 *   id is canonical ("starters/house" for a starter); module is the path the dev server serves the file at
 */
export async function songInfo(requested) {
  const where = resolveSong(requested);
  if (!where) {
    throw new Error(`Unknown song "${requested}". Songs: ${listSongIds().join(", ")}`);
  }
  const { id, file, starter, module } = where;
  await strudelScope();
  const mod = await import(pathToFileURL(file).href);
  const song = mod.default;
  const result = song.createPattern();
  const isPattern = typeof result?.queryArc === "function";
  const sections = normalizeSections(song.sections) ?? parseSections(readFileSync(file, "utf8"));
  return {
    id,
    name: song.name ?? id,
    bpm: song.bpm ?? 120,
    tracks: isPattern ? null : Object.keys(result),
    sections,
    totalBars: sections ? sections.reduce((n, s) => n + s.bars, 0) : null,
    starter,
    module,
  };
}
