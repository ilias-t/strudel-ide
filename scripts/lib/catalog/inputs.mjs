// Everything the catalog is generated from, loaded in one place (generator + tests):
//   - the sample maps the app loads: names read from SAMPLE_MAPS / BANK_ALIASES in src/engine/strudel.ts,
//     JSON from node_modules/.cache/strudel-samples (the cache check-songs and gen-sound-types fill),
//     fetched from the CDN when missing unless offline
//   - superdough's built-in synths (registerSynthSounds/registerZZFXSounds, no AudioContext needed)
//   - src/strudel.generated.d.ts
//   - scripts/lib/catalog/usage.json: the committed usage counts behind `rank` and `after`
//     (refreshed by hand from the sources usageSources() lists: node scripts/gen-catalog.mjs --recount)
//   - scripts/lib/catalog/strudel-docs.json: the committed strudel.cc heading snapshot
//   - theory data: tonal's scale and chord types, @strudel/tonal's voicing dictionaries,
//     superdough's vowels (the same modules the app plays with)

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SNIPPETS } from "./snippets.mjs";

export const USAGE_FILE = "scripts/lib/catalog/usage.json";
export const DOCS_FILE = "scripts/lib/catalog/strudel-docs.json";

const CDN = "https://strudel.b-cdn.net";

/** SAMPLE_MAPS and BANK_ALIASES from the app's engine, so the catalog can't drift from what it loads */
export function appSampleMaps(root) {
  const src = readFileSync(join(root, "src/engine/strudel.ts"), "utf8");
  const list = src.match(/const SAMPLE_MAPS\s*=\s*\[([\s\S]*?)\];/);
  const alias = src.match(/const BANK_ALIASES\s*=\s*"([^"]+)"/);
  if (!list || !alias) throw new Error("SAMPLE_MAPS / BANK_ALIASES not found in src/engine/strudel.ts");
  const maps = [...list[1].replace(/\/\/.*$/gm, "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (!maps.length) throw new Error("SAMPLE_MAPS in src/engine/strudel.ts is empty");
  return { maps, bankAliases: alias[1] };
}

async function loadJson(cacheDir, name, offline) {
  const file = join(cacheDir, `${name}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  if (offline) throw new Error(`${name}.json is not cached in ${cacheDir} (run once without --offline)`);
  const res = await fetch(`${CDN}/${name}.json`);
  if (!res.ok) throw new Error(`fetch ${name}: ${res.status}`);
  const json = await res.json();
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(file, JSON.stringify(json));
  return json;
}

/** superdough's synth/noise/zzfx sound names, in registration order */
async function synthNames() {
  const webaudio = await import("@strudel/webaudio");
  webaudio.registerSynthSounds();
  webaudio.registerZZFXSounds();
  return Object.keys(webaudio.soundMap.get()).filter((name) => webaudio.soundMap.get()[name]?.data?.type === "synth");
}

/** Scale and chord types, voicing dictionaries and vowels, as plain data for theory.mjs */
export async function loadTheoryData() {
  const { ScaleType, ChordType } = await import("@tonaljs/tonal");
  const { voicingRegistry } = await import("@strudel/tonal");
  const { vowelFormant } = await import("superdough/vowel.mjs");
  const ireal = voicingRegistry.ireal?.dictionary;
  if (!ireal) throw new Error("@strudel/tonal's voicingRegistry has no ireal dictionary");
  return {
    scaleTypes: ScaleType.all().map((s) => ({ name: s.name, intervals: [...s.intervals] })),
    chordTypes: ChordType.all().map((c) => ({ name: c.name, aliases: [...c.aliases], intervals: [...c.intervals] })),
    ireal: Object.fromEntries(Object.entries(ireal).map(([k, v]) => [k, [...v]])),
    // own data properties only: the æ ø ɑ å ö ü ı aliases are getters
    vowels: Object.keys(vowelFormant).filter((k) => "value" in Object.getOwnPropertyDescriptor(vowelFormant, k)),
    voicingDicts: Object.keys(voicingRegistry),
  };
}

/**
 * The code usage.json counts (ranking.mjs's countUsage): songs and starters (src/songs/*.ts and
 * src/starters/*.ts but index.ts), the snippets' code and every function's examples (IDE form).
 * @param {string} root
 * @param {{ examples: string[] }[]} functions functions.mjs's entries
 * @returns {{ kind: string, code: string }[]}
 */
export function usageSources(root, functions) {
  const sources = [];
  for (const [dir, kind] of [
    ["src/songs", "songs"],
    ["src/starters", "starters"],
  ]) {
    for (const file of readdirSync(join(root, dir)).sort()) {
      if (file.endsWith(".ts") && file !== "index.ts") sources.push({ kind, code: readFileSync(join(root, dir, file), "utf8") });
    }
  }
  for (const s of SNIPPETS) sources.push({ kind: "snippets", code: s.code });
  for (const f of functions) for (const code of f.examples) sources.push({ kind: "examples", code });
  return sources;
}

/**
 * @param {{ root: string, offline?: boolean }} options
 * @returns {Promise<{ maps: Record<string, any>, aliasMap: Record<string, string | string[]>, synths: string[], dts: string,
 *   usage: { usage: Record<string, Record<string, number>>, after: Record<string, Record<string, Record<string, number>>> },
 *   docs: { base: string, pages: Record<string, { title: string, headings: { id: string, level: number, text: string }[] }> },
 *   theory: Awaited<ReturnType<typeof loadTheoryData>> }>}
 */
export async function loadCatalogInputs({ root, offline = false }) {
  const cacheDir = join(root, "node_modules/.cache/strudel-samples");
  const { maps: names, bankAliases } = appSampleMaps(root);
  const maps = {};
  for (const name of names) maps[name] = await loadJson(cacheDir, name, offline);
  const aliasMap = await loadJson(cacheDir, bankAliases, offline);
  const synths = await synthNames();
  const dts = readFileSync(join(root, "src/strudel.generated.d.ts"), "utf8");
  const usageFile = join(root, USAGE_FILE);
  if (!existsSync(usageFile)) throw new Error(`${USAGE_FILE} is missing: run node scripts/gen-catalog.mjs --recount`);
  const usage = JSON.parse(readFileSync(usageFile, "utf8"));
  const docs = JSON.parse(readFileSync(join(root, DOCS_FILE), "utf8"));
  const theory = await loadTheoryData();
  return { maps, aliasMap, synths, dts, usage, docs, theory };
}
