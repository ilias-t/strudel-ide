// ═══════════════════════════════════════════════════════════════════════════
// The discovery catalog (src/catalog/*.json), loaded on first use
// ═══════════════════════════════════════════════════════════════════════════
//
// The JSON is big (functions.json alone is ~460 KB), so each file is its own
// lazy chunk: a dynamic import, memoized. Nothing on the boot path may import
// this module statically except for its types. The shapes are documented in
// the header of scripts/gen-catalog.mjs.

/** A kind of sound inside a group, e.g. drums → kick */
export interface SoundKind {
  id: string;
  label: string;
  sounds: string[];
}

export interface SoundGroup {
  /** "drums" | "instruments" | "synths" | "fx" */
  id: string;
  label: string;
  kinds: SoundKind[];
}

export interface SoundInfo {
  /** One of the kind ids (kick, snare, …, synth, fx) */
  kind: string;
  /** A sample map name, or "superdough" for the built-in synths */
  source?: string;
  /** Files in the unbanked entry (pick one with n() / "name:2"); absent if bank-only */
  count?: number;
  /** Samples keyed by note: play them with note(), like a synth */
  pitched?: true;
  /** Drum parts: the banks that have this part, with their file counts */
  banks?: Record<string, number>;
  /** e.g. "saw" → "sawtooth" */
  aliasOf?: string;
}

export interface BankInfo {
  aliases: string[];
  /** Drum parts the bank has: bd, sd, hh, … */
  parts: string[];
}

export interface SoundsCatalog {
  groups: SoundGroup[];
  banks: Record<string, BankInfo>;
  sounds: Record<string, SoundInfo>;
}

export interface FunctionCategory {
  id: string;
  label: string;
  count: number;
}

export type FunctionKind = "method" | "function" | "both" | "value";

export interface FunctionInfo {
  name: string;
  category: string;
  kind: FunctionKind;
  /** ".lpf(frequency?: NumberInput): Pattern" (methods start with "."), "lpf(…)", "const sine: Pattern" */
  signatures: string[];
  summary: string;
  description: string;
  params: { name: string; description: string }[];
  /** In this IDE's form (mini("a b").fast(2), not "a b".fast(2)) */
  examples: string[];
  synonyms: string[];
  aliasOf?: string;
  /** No effect with the built-in WebAudio output */
  superdirtOnly?: true;
  deprecated?: string | true;
}

export interface FunctionsCatalog {
  categories: FunctionCategory[];
  functions: FunctionInfo[];
}

export interface Snippet {
  id: string;
  /** A TrackRole (src/engine/tracks.ts): name the track after it */
  role: string;
  title: string;
  description: string;
  /** One expression of string literals */
  code: string;
  tags?: string[];
  bpm?: number;
}

export interface SnippetsCatalog {
  snippets: Snippet[];
}

const json = <T>(mod: unknown) => ((mod as { default?: T }).default ?? mod) as T;

let sounds: Promise<SoundsCatalog> | null = null;
let functions: Promise<FunctionsCatalog> | null = null;
let snippets: Promise<SnippetsCatalog> | null = null;

/** A failed load is retried on the next call (e.g. the network came back) */
function memo<T>(get: () => Promise<T>, set: (p: Promise<T> | null) => void): Promise<T> {
  const p = get();
  p.catch(() => set(null));
  set(p);
  return p;
}

export function loadSounds(): Promise<SoundsCatalog> {
  return sounds ?? memo(() => import("../../catalog/sounds.json").then(json<SoundsCatalog>), (p) => (sounds = p));
}

export function loadFunctions(): Promise<FunctionsCatalog> {
  return functions ?? memo(() => import("../../catalog/functions.json").then(json<FunctionsCatalog>), (p) => (functions = p));
}

export function loadSnippets(): Promise<SnippetsCatalog> {
  return snippets ?? memo(() => import("../../catalog/snippets.json").then(json<SnippetsCatalog>), (p) => (snippets = p));
}
