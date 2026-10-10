// ═══════════════════════════════════════════════════════════════════════════
// The discovery catalog (src/catalog/*.json), loaded on first use
// ═══════════════════════════════════════════════════════════════════════════
//
// The JSON is big (functions.json alone is ~460 KB), so each file is its own
// lazy chunk: a dynamic import, memoized. Nothing on the boot path may import
// this module statically except for its types. The shapes are documented in
// the header of scripts/gen-catalog.mjs.

import type { Availability, CompletionMeta, Theory } from "../complete/types";

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
  /** Global rank, 0 = most used (the same as completions.json) */
  rank?: number;
  /** Not "ok": it sinks in lists, with this reason */
  availability?: Availability;
  /** Curated range and unit for a control ("lpf": 20–20000 Hz) */
  range?: CompletionMeta["range"];
  /** strudel.cc page (and anchor) documenting it */
  docUrl?: string;
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

// ── completions, theory, intents (phase 3: src/ui/complete/, the cheat sheet, search by sound) ──

/** src/catalog/completions.json: what the editor's method list needs, without the 460 KB of docs */
export interface CompletionsCatalog {
  /** Every function by name */
  functions: Record<string, CompletionMeta>;
  /** Methods most used right after a call, by that call: { s: ["gain", "bank", …], note: […] } */
  after: Record<string, string[]>;
}

/** src/catalog/theory.json */
export type TheoryCatalog = Theory;

/** A way people describe a sound ("wetter", "wobble", "acid bass") → the functions and a recipe that get there */
export interface Intent {
  id: string;
  /** What people type: unique across intents, lowercase */
  phrases: string[];
  /** Real function names, the main one first */
  functions: string[];
  /** One expression of string literals that plays the idea (previewable) */
  recipe?: string;
  /** Snippet ids (snippets.json) that show it */
  snippets?: string[];
  /** One line: how to use it ("room 0–1 is the send; size grows the space") */
  tip?: string;
  /** A TrackRole when the recipe is a whole track (the track builder can take it) */
  role?: string;
}

/** src/catalog/intents.json */
export interface IntentsCatalog {
  intents: Intent[];
}

let completions: Promise<CompletionsCatalog> | null = null;
let theory: Promise<TheoryCatalog> | null = null;
let intents: Promise<IntentsCatalog> | null = null;

export function loadCompletions(): Promise<CompletionsCatalog> {
  return completions ?? memo(() => import("../../catalog/completions.json").then(json<CompletionsCatalog>), (p) => (completions = p));
}

export function loadTheory(): Promise<TheoryCatalog> {
  return theory ?? memo(() => import("../../catalog/theory.json").then(json<TheoryCatalog>), (p) => (theory = p));
}

export function loadIntents(): Promise<IntentsCatalog> {
  return intents ?? memo(() => import("../../catalog/intents.json").then(json<IntentsCatalog>), (p) => (intents = p));
}
