// Snapshot strudel.cc's documentation anchors into scripts/lib/catalog/strudel-docs.json, so the
// catalog can link a function (and a mini-notation operator) to the heading that documents it.
// strudel.cc has no per-function reference: functions live on topical pages under headings whose
// id is the lowercased name (/learn/effects/#lpf), sometimes with a collision suffix (#delay-1),
// sometimes with none at all. So links come from this crawl, never from a guess.
//
// Run by hand (it needs the network; `npm run check` never fetches): node scripts/fetch-strudel-docs.mjs
// then `npm run gen:catalog`. The snapshot is committed; links to headings strudel.cc has since
// renamed fall back to the page (see scripts/lib/catalog/ for how the generator uses it).
//
// Output: { base, pages: { "/learn/effects/": { title, anchors: ["audio-effects", "lpf", …] } } }
// Pages in path order, anchors in page order (each heading id once).

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "scripts/lib/catalog/strudel-docs.json");
const BASE = "https://strudel.cc";

/** The reference pages: where functions, sounds and mini-notation are documented */
const PAGES = [
  "/functions/intro/",
  "/functions/value-modifiers/",
  "/learn/accumulation/",
  "/learn/conditional-modifiers/",
  "/learn/effects/",
  "/learn/factories/",
  "/learn/input-output/",
  "/learn/lfo/",
  "/learn/mini-notation/",
  "/learn/random-modifiers/",
  "/learn/samples/",
  "/learn/signals/",
  "/learn/stepwise/",
  "/learn/synths/",
  "/learn/time-modifiers/",
  "/learn/tonal/",
  "/learn/visual-feedback/",
  "/understand/cycles/",
  "/understand/pitch/",
  "/understand/voicings/",
];

const decode = (s) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();

const pages = {};
for (const path of PAGES) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const html = await res.text();
  const title = decode(html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? path).replace(/\s*(?:[|·-]|🌀)\s*Strudel\s*$/u, "");
  const anchors = [];
  for (const m of html.matchAll(/<h[1-6][^>]*\bid="([^"]+)"/g)) if (!anchors.includes(m[1])) anchors.push(m[1]);
  if (!anchors.length) throw new Error(`${path}: no heading anchors (did the page layout change?)`);
  pages[path] = { title, anchors };
  console.log(`${path}: ${anchors.length} anchors`);
}

writeFileSync(out, JSON.stringify({ base: BASE, pages }, null, 2) + "\n");
console.log(`wrote ${out}`);
