// A fake of superdough's live soundMap for the editor's registry (src/ui/complete/registry.ts) and
// everything built on it. sound-map.json is the stage's real map after loading, reduced to types and
// file counts (scripts/gen-complete-fixture.mjs); this expands it back into SoundEntry values, so the
// registry reads exactly the shape it gets in the browser.
//
//   fakeSoundMap()            every key, already loaded
//   fakeSoundMap({ empty })   nothing yet: load() fills it one setKey at a time, like superdough does
//   soundsCatalog()           src/catalog/sounds.json
//   fakeRegistry()            a ready registry over both (the usual starting point for a test)
import { readFileSync } from "node:fs";
import type { SoundEntry, SoundMapStore } from "../../../src/engine/strudel.ts";
import type { SoundsCatalog } from "../../../src/ui/discover/catalog.ts";
import { createRegistry, type LiveSoundRegistry } from "../../../src/ui/complete/registry.ts";

type Compact = Record<string, number | string | Record<string, number>>;

const compact = JSON.parse(readFileSync(new URL("./sound-map.json", import.meta.url), "utf8")) as Compact;

const files = (key: string, n: number) => Array.from({ length: n }, (_, i) => `${key}/${i}.wav`);

/** One SoundEntry from the compact form */
function entry(key: string, v: Compact[string]): SoundEntry {
  if (typeof v === "string") return { data: { type: v } };
  if (typeof v === "number") return { data: { type: "sample", samples: files(key, v) } };
  return { data: { type: "sample", samples: Object.fromEntries(Object.entries(v).map(([note, n]) => [note, files(`${key}/${note}`, n)])) } };
}

/** Every key of the live map (sorted, not in registration order) */
export const SOUND_KEYS: readonly string[] = Object.keys(compact);

export interface FakeSoundMap extends SoundMapStore {
  setKey(key: string, value: SoundEntry): void;
  set(value: Record<string, SoundEntry>): void;
  /** Register every (remaining) key, one setKey each, like superdough while samples load */
  load(): void;
  /** How many times listeners were called */
  readonly fired: number;
}

export function fakeSoundMap({ empty = false, omit }: { empty?: boolean; omit?: (key: string) => boolean } = {}): FakeSoundMap {
  let value: Record<string, SoundEntry> = {};
  const listeners = new Set<(v: Record<string, SoundEntry>) => void>();
  let fired = 0;
  const emit = () => {
    for (const fn of [...listeners]) {
      fired++;
      fn(value);
    }
  };
  const keys = SOUND_KEYS.filter((k) => !omit?.(k));
  const store: FakeSoundMap = {
    get: () => value,
    listen(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setKey(key, v) {
      value = { ...value, [key]: v };
      emit();
    },
    set(v) {
      value = v;
      emit();
    },
    load() {
      for (const k of keys) if (!(k in value)) store.setKey(k, entry(k, compact[k]));
    },
    get fired() {
      return fired;
    },
  };
  if (!empty) value = Object.fromEntries(keys.map((k) => [k, entry(k, compact[k])]));
  return store;
}

let catalog: SoundsCatalog | null = null;
export function soundsCatalog(): SoundsCatalog {
  catalog ??= JSON.parse(readFileSync(new URL("../../../src/catalog/sounds.json", import.meta.url), "utf8")) as SoundsCatalog;
  return catalog;
}

/** A registry over the full fake map and the real catalog; ready unless told otherwise */
export function fakeRegistry({ ready = true, omit, debounceMs = 0 }: { ready?: boolean; omit?: (key: string) => boolean; debounceMs?: number } = {}): LiveSoundRegistry {
  return createRegistry({ soundMap: fakeSoundMap({ omit }), catalog: soundsCatalog(), ready: () => ready, debounceMs });
}
