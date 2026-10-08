// ═══════════════════════════════════════════════════════════════════════════
// 🌱 GENRE STARTERS
// ═══════════════════════════════════════════════════════════════════════════
//
// Simple, editable songs to start from: one per genre. They use the same
// `Song` format as src/songs/ but live here so they don't crowd the song
// picker. The "new song" flow copies a starter's text into src/songs/<new>.ts
// (its `import type { Song } from "../songs"` resolves from both folders).
//
// Each starter default-exports its Song and exports a small `meta`:
//
//   export const meta = { id: "house", genre: "House", blurb: "…" };
//
// `npm run check` covers them (scripts/check-songs.mjs, test/starters.test.ts),
// and the audio tools take them as "starters/<id>":
//   npm run analyze -- starters/house
//
// Nothing here is imported eagerly: loading a starter module runs its
// top-level knob() calls, so the UI should only import the one it needs.
// ═══════════════════════════════════════════════════════════════════════════

import type { Song } from "../songs";

/** What the "new song" flow shows for a starter */
export interface StarterMeta {
  /** The file name without .ts (src/starters/<id>.ts) */
  id: string;
  /** Display name of the genre, e.g. "Drum & Bass" */
  genre: string;
  /** One sentence about the sound */
  blurb: string;
}

export interface StarterModule {
  default: Song;
  meta: StarterMeta;
}

/** Each starter module, loaded on demand: `await starterModules["./house.ts"]()` */
export const starterModules = import.meta.glob<StarterModule>(["./*.ts", "!./index.ts", "!./_*.ts"]);

/** Each starter's source text, loaded on demand (what "new song" copies into src/songs/) */
export const starterSources = import.meta.glob<string>(["./*.ts", "!./index.ts", "!./_*.ts"], {
  query: "?raw",
  import: "default",
});

/** "./house.ts" → "house" */
export const starterId = (path: string) => path.replace(/^\.\//, "").replace(/\.ts$/, "");
