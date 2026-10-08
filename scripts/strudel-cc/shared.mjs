// What Strudel IDE and strudel.cc have in common (and don't), and the
// strudel.cc share-link format.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { code2hash, hash2code } from "@strudel/core";
import { root } from "./runtime.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Share links
// ─────────────────────────────────────────────────────────────────────────────
//
// strudel.cc keeps the whole program in the URL fragment:
//   https://strudel.cc/#<encodeURIComponent(base64(utf8(code)))>
// Writing: website/src/repl/util.mjs shareCode() and useReplContext.jsx
//   ('#' + code2hash(code)); reading: util.mjs initCode() takes
//   href.split('#')[1] and calls hash2code(). code2hash/hash2code live in
//   @strudel/core util.mjs, so we use those very functions.
// `https://strudel.cc/?abc123` links are short ids stored in strudel.cc's
// database and can't be decoded offline.

export const STRUDEL_CC = "https://strudel.cc/";

export function codeToUrl(code) {
  return `${STRUDEL_CC}#${code2hash(code)}`;
}

/** Decode a strudel.cc link (or a bare fragment) exactly like strudel.cc's initCode(). */
export function urlToCode(url) {
  const fragment = url.includes("#") ? url.split("#")[1] : "";
  if (!fragment) {
    if (/[?&][A-Za-z0-9_-]{6,}/.test(url)) {
      throw new Error(
        "This is a short strudel.cc link (?id): its code lives in strudel.cc's database. " +
          "Open it, press 'share' (or copy the code) and import the long #… link or a .js file instead."
      );
    }
    throw new Error("No #code fragment in this URL");
  }
  return hash2code(fragment);
}

export const isStrudelUrl = (s) => /^https?:\/\/([a-z0-9-]+\.)*strudel\.cc\b/i.test(s) || /^https?:\/\/[^ ]*#/.test(s);

// ─────────────────────────────────────────────────────────────────────────────
// Sample packs
// ─────────────────────────────────────────────────────────────────────────────

export const SAMPLE_BASE = "https://strudel.b-cdn.net";

/**
 * Packs strudel.cc loads before running any code (website/src/repl/prebake.mjs,
 * checked 2026-10): these plus soundfonts (gm_*), a Dirt-Samples subset and
 * the tidal-drum-machines bank aliases.
 */
export const STRUDEL_CC_PREBAKED = [
  "piano",
  "vcsl",
  "tidal-drum-machines",
  "uzu-drumkit",
  "uzu-wavetables",
  "mridangam",
];

/** Sounds strudel.cc has by default that Strudel IDE doesn't load. */
export const STRUDEL_CC_ONLY_SOUNDS = [
  "casio", "crow", "insect", "wind", "jazz", "metal", "east", "space", "numbers", "num",
];
export const STRUDEL_CC_ONLY_PREFIXES = ["gm_"];

/** The sample maps Strudel IDE loads, read from src/engine/strudel.ts (SAMPLE_MAPS). */
export function appSampleMaps() {
  const text = readFileSync(join(root, "src/engine/strudel.ts"), "utf8");
  const m = text.match(/const SAMPLE_MAPS\s*=\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error("SAMPLE_MAPS not found in src/engine/strudel.ts");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** Does a samples() argument point at a pack the app loads? */
export function isAppSamplePack(arg) {
  if (typeof arg !== "string") return false;
  const maps = appSampleMaps();
  const m = arg.match(/^https?:\/\/strudel\.b-cdn\.net\/([^/]+)\.json$/);
  return !!m && maps.includes(m[1]);
}
