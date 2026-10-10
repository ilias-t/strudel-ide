// ═══════════════════════════════════════════════════════════════════════════
// The live sound registry: what can actually play right now
// ═══════════════════════════════════════════════════════════════════════════
//
// The truth is superdough's soundMap (engine.soundMap): every sound that is
// registered, by lowercased key, "<bank>_<part>" for drum machines (bank
// aliases are real keys too: tr909_bd). sounds.json adds what the map can't
// say: each sound's kind, which keys are banks and their canonical names.
//
// Pure: the map, the catalog and the readiness are injected (index.ts passes
// the engine's; the tests a fake), so Node covers all of it.
//
//   - The map fires once per sound while samples load (~850 times): reads are
//     always live, but onChange is debounced and version() bumps once per burst.
//   - Keys starting or ending with "_" are junk (a sample map's "_base" field,
//     a stray "oberheimdmx_") and don't exist here.
//   - degraded(): ready, yet sounds the catalog lists are missing, so a sample
//     map failed to load. Warnings then trust the catalog too (catalogHas).

import type { SoundEntry, SoundMapStore } from "../../engine/strudel.ts";
import type { SoundsCatalog } from "../discover/catalog.ts";
import type { SoundRegistry } from "./types.ts";

export interface RegistryOptions {
  soundMap: SoundMapStore;
  /** sounds.json; null until it loads (setCatalog) */
  catalog?: SoundsCatalog | null;
  /** Samples finished loading (the player's ready state) */
  ready: () => boolean;
  /** onChange settles this long after the last change (ms) */
  debounceMs?: number;
}

export interface LiveSoundRegistry extends SoundRegistry {
  /** The catalog arrived (or changed): kinds and banks follow, listeners hear about it */
  setCatalog(catalog: SoundsCatalog): void;
  /** Something outside the map changed (readiness): notify listeners (debounced) */
  refresh(): void;
  /** Ready, yet sounds the catalog lists are missing: a sample map didn't load */
  degraded(): boolean;
  /** The catalog lists this key (a sound that plays without a bank, or "<bank or alias>_<part>"), any case */
  catalogHas(key: string): boolean;
  /** The catalog knows this drum machine (canonical name or alias), any case */
  catalogHasBank(name: string): boolean;
  /** The drum machines (canonical names) that have this part, live */
  banksWith(part: string): string[];
  dispose(): void;
}

const isJunk = (key: string) => key.startsWith("_") || key.endsWith("_");

/** Files of a sample entry; 0 for synths and wavetables */
function fileCount(entry: SoundEntry): number {
  const d = entry.data;
  if (!d || d.type !== "sample") return 0;
  const s = d.samples;
  if (Array.isArray(s)) return s.length;
  if (!s || typeof s !== "object") return 0;
  let n = 0;
  for (const files of Object.values(s)) n += Array.isArray(files) ? files.length : 1;
  return n;
}

interface Index {
  /** lowercased bank (any prefix before the first "_") → its parts */
  parts: Map<string, string[]>;
  unbanked: string[];
}

interface CatalogIndex {
  /** lowercased bank name or alias → canonical name */
  canonical: Map<string, string>;
  known: Set<string>;
}

function indexCatalog(catalog: SoundsCatalog): CatalogIndex {
  const canonical = new Map<string, string>();
  const known = new Set<string>();
  for (const [name, info] of Object.entries(catalog.sounds)) {
    if (info.count !== undefined || info.source === "superdough") known.add(name.toLowerCase());
  }
  for (const [bank, info] of Object.entries(catalog.banks)) {
    for (const b of [bank, ...info.aliases]) {
      canonical.set(b.toLowerCase(), bank);
      for (const part of info.parts) known.add(`${b}_${part}`.toLowerCase());
    }
  }
  return { canonical, known };
}

export function createRegistry({ soundMap, catalog = null, ready, debounceMs = 150 }: RegistryOptions): LiveSoundRegistry {
  let cat = catalog;
  let catIndex: CatalogIndex | null = cat ? indexCatalog(cat) : null;
  let index: Index | null = null;
  let degradedCache: boolean | null = null;
  let version = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  const entryOf = (key: string): SoundEntry | undefined => {
    const k = key.toLowerCase();
    if (isJunk(k)) return undefined;
    const map = soundMap.get();
    return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : undefined;
  };

  const settle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      version++;
      for (const fn of [...listeners]) {
        try {
          fn();
        } catch (e) {
          console.error("sound registry listener failed", e);
        }
      }
    }, debounceMs);
  };

  const invalidate = () => {
    index = null;
    degradedCache = null;
  };

  const unlisten = soundMap.listen(() => {
    invalidate();
    settle();
  });

  const indexOf = (): Index => {
    if (index) return index;
    const parts = new Map<string, string[]>();
    const unbanked: string[] = [];
    for (const key of Object.keys(soundMap.get())) {
      if (isJunk(key)) continue;
      const cut = key.indexOf("_");
      if (cut > 0) {
        const prefix = key.slice(0, cut);
        let list = parts.get(prefix);
        if (!list) parts.set(prefix, (list = []));
        list.push(key.slice(cut + 1));
        // a bank's key ("rolandtr909_bd") doesn't play without its bank
        if (catIndex?.canonical.has(prefix)) continue;
      }
      unbanked.push(key);
    }
    index = { parts, unbanked };
    return index;
  };

  const bankParts = (bank: string) => indexOf().parts.get(bank.toLowerCase()) ?? [];

  const registry: LiveSoundRegistry = {
    ready: () => ready(),
    version: () => version,
    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    has: (key) => entryOf(key) !== undefined,
    variants(key) {
      const e = entryOf(key);
      return e ? fileCount(e) : null;
    },
    kind(name) {
      if (!cat) return undefined;
      const k = name.toLowerCase();
      const own = cat.sounds[name] ?? cat.sounds[k];
      if (own) return own.kind;
      // a bank key: its part's kind ("rolandtr909_bd" → kick)
      const cut = k.indexOf("_");
      if (cut > 0 && catIndex?.canonical.has(k.slice(0, cut))) return cat.sounds[k.slice(cut + 1)]?.kind;
      return undefined;
    },
    type(key) {
      const t = entryOf(key)?.data?.type;
      return t === "sample" || t === "synth" || t === "wavetable" ? t : undefined;
    },
    pitched(key) {
      const d = entryOf(key)?.data;
      return !!d && (d.type !== "sample" || !Array.isArray(d.samples));
    },
    unbanked: () => indexOf().unbanked,
    banks() {
      if (!cat) return [];
      const out: { name: string; canonical: string; parts: string[] }[] = [];
      for (const [name, info] of Object.entries(cat.banks)) {
        const parts = bankParts(name);
        if (!parts.length) continue;
        out.push({ name, canonical: name, parts });
        for (const alias of info.aliases) out.push({ name: alias, canonical: name, parts });
      }
      return out;
    },
    bankParts,
    setCatalog(next) {
      cat = next;
      catIndex = indexCatalog(next);
      invalidate();
      settle();
    },
    refresh() {
      degradedCache = null;
      settle();
    },
    degraded() {
      if (!ready() || !catIndex) return false;
      if (degradedCache !== null) return degradedCache;
      const live = soundMap.get();
      degradedCache = false;
      for (const key of catIndex.known) {
        if (!Object.prototype.hasOwnProperty.call(live, key)) {
          degradedCache = true;
          break;
        }
      }
      return degradedCache;
    },
    catalogHas: (key) => !!catIndex?.known.has(key.toLowerCase()),
    catalogHasBank: (name) => !!catIndex?.canonical.has(name.toLowerCase()),
    banksWith(part) {
      if (!cat) return [];
      const p = part.toLowerCase();
      return Object.keys(cat.banks).filter((bank) => bankParts(bank).includes(p));
    },
    dispose() {
      unlisten();
      clearTimeout(timer);
      listeners.clear();
    },
  };
  return registry;
}
