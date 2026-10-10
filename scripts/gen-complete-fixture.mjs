// Writes test/fixtures/complete/sound-map.json: superdough's live sound map, reduced to what the
// editor's registry reads (type, file counts), built the way the stage builds it: the sample maps the
// app loads (src/engine/strudel.ts SAMPLE_MAPS, via the catalog's cache), the bank aliases, the
// synths and zzfx. Rerun when the sample maps change: node scripts/gen-complete-fixture.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCatalogInputs } from "./lib/catalog/inputs.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const { maps, aliasMap } = await loadCatalogInputs({ root });

const webaudio = await import("@strudel/webaudio");
webaudio.registerSynthSounds();
webaudio.registerZZFXSounds();
for (const map of Object.values(maps)) await webaudio.samples(map, map._base ?? "");
await webaudio.aliasBank(aliasMap);

/** key → "synth" | "wavetable" | number (files of an unpitched sample) | { note: files } (pitched) */
const out = {};
const entries = webaudio.soundMap.get();
for (const key of Object.keys(entries).sort()) {
  const data = entries[key]?.data ?? {};
  const s = data.samples;
  if (data.type === "sample") {
    if (Array.isArray(s)) out[key] = s.length;
    else out[key] = Object.fromEntries(Object.entries(s ?? {}).map(([note, files]) => [note, [files].flat().length]));
  } else out[key] = data.type ?? "synth";
}
const dir = new URL("../test/fixtures/complete/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("sound-map.json", dir), JSON.stringify(out, null, 0).replace(/,"/g, ',\n"') + "\n");
console.log(`${Object.keys(out).length} keys`);
