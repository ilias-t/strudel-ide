// Everything the catalog is generated from, loaded in one place (generator + tests):
//   - the sample maps the app loads: names read from SAMPLE_MAPS / BANK_ALIASES in src/engine/strudel.ts,
//     JSON from node_modules/.cache/strudel-samples (the cache check-songs and gen-sound-types fill),
//     fetched from the CDN when missing unless offline
//   - superdough's built-in synths (registerSynthSounds/registerZZFXSounds, no AudioContext needed)
//   - src/strudel.generated.d.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

/**
 * @param {{ root: string, offline?: boolean }} options
 * @returns {Promise<{ maps: Record<string, any>, aliasMap: Record<string, string | string[]>, synths: string[], dts: string }>}
 */
export async function loadCatalogInputs({ root, offline = false }) {
  const cacheDir = join(root, "node_modules/.cache/strudel-samples");
  const { maps: names, bankAliases } = appSampleMaps(root);
  const maps = {};
  for (const name of names) maps[name] = await loadJson(cacheDir, name, offline);
  const aliasMap = await loadJson(cacheDir, bankAliases, offline);
  const synths = await synthNames();
  const dts = readFileSync(join(root, "src/strudel.generated.d.ts"), "utf8");
  return { maps, aliasMap, synths, dts };
}
