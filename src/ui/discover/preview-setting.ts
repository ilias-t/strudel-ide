// ═══════════════════════════════════════════════════════════════════════════
// "Hear sounds as you browse": the setting
// ═══════════════════════════════════════════════════════════════════════════
//
// Arrowing through a sound list in the editor's suggestions can play each row
// (src/ui/complete/browse.ts). Off by default; ⌥P toggles it, so does the
// palette, and the choice is remembered in this browser. Tiny and pure apart
// from storage, so the editor, the palette and the cheat sheet can share it
// without loading each other.

import { readStorage, writeStorage } from "../../engine/storage.ts";

const KEY = "previews";

let enabled: boolean | null = null;
const listeners = new Set<(on: boolean) => void>();

export function previewsEnabled(): boolean {
  if (enabled === null) enabled = readStorage(KEY) === "on";
  return enabled;
}

export function setPreviewsEnabled(on: boolean) {
  enabled = on;
  writeStorage(KEY, on ? "on" : "off");
  for (const fn of [...listeners]) fn(on);
}

/** Flip it; returns the new state */
export function togglePreviews(): boolean {
  setPreviewsEnabled(!previewsEnabled());
  return previewsEnabled();
}

/** Called with the new state on every change; returns the unsubscribe */
export function onPreviewsChange(fn: (on: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Forget the cached value, so the next read comes from storage (tests) */
export function resetForTests() {
  enabled = null;
}
