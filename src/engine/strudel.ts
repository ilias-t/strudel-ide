// ═══════════════════════════════════════════════════════════════════════════
// Engine typings + the Strudel runtime
// ═══════════════════════════════════════════════════════════════════════════
//
// src/strudel.d.ts describes Strudel for *song authors*. The player needs a few
// runtime internals it doesn't declare (the repl object, the Pattern
// constructor, `silence` as a value, aliasBank, the audio context, the log
// event key). They're typed here, in one place, against the real exports of
// the pre-bundled @strudel/web. Never import @strudel/core or @strudel/draw
// directly: that would load a second copy with its own Pattern class and its
// own animation-frame registry.

import * as strudelWeb from "@strudel/web";

/** A strudel TimeSpan (begin/end are Fractions; `valueOf()` gives numbers) */
export interface Span {
  begin: Frac;
  end: Frac;
  intersection(other: Span): Span | undefined;
}
export interface Frac {
  valueOf(): number;
}
export interface QueryState {
  span: Span;
  setSpan(span: Span): QueryState;
}
export interface HapContext {
  locations?: { start: number; end: number }[];
  /** Name of the song track this hap came from (set by the player) */
  track?: string;
  /** The track is muted: the hap is silent and carries no locations */
  muted?: boolean;
  [key: string]: unknown;
}
export interface Hap {
  whole?: Span;
  part: Span;
  value: any;
  context: HapContext;
  hasOnset(): boolean;
}
type QueryFn = (state: QueryState) => Hap[];

/** Pattern internals the player relies on (not part of the song-facing types) */
export interface PatternInternals {
  query: QueryFn;
  draw(fn: () => void, options: { id: number }): unknown;
  withHap(fn: (hap: Hap) => Hap): Pattern;
}
export const internals = (pattern: Pattern) => pattern as unknown as PatternInternals;

export interface Scheduler {
  started: boolean;
  cps: number;
  pattern?: Pattern;
  /** Cycle up to which the scheduler has already queried (and scheduled) haps */
  lastEnd: number;
  latency?: number;
  clock?: { duration?: number };
  now(): number;
}

export interface Repl {
  scheduler: Scheduler;
  setPattern(pattern: Pattern, autostart?: boolean): Promise<Pattern>;
  setCps(cps: number): void;
  start(): Promise<void>;
  stop(): void;
}

interface EngineApi {
  initStrudel(options?: { onToggle?: (started: boolean) => void }): Promise<Repl>;
  Pattern: new (query: QueryFn) => Pattern;
  silence: Pattern;
  pure(value: unknown): Pattern;
  samples(url: string): Promise<void>;
  aliasBank(map: string | Record<string, string | string[]>): Promise<void>;
  getAudioContext(): AudioContext;
  /** Resumes the AudioContext and loads superdough's AudioWorklets (cached after the first call) */
  initAudio(): Promise<void>;
  /** superdough(value, time, duration): play one event */
  superdough(value: Record<string, unknown>, time: number, duration: number): Promise<void>;
  logKey: string;
}

export const engine = strudelWeb as unknown as EngineApi;

/** Orbits 1…WARM_ORBITS are created up front (see warmOrbits) */
const WARM_ORBITS = 16;
let orbitsWarm = false;

/**
 * Create superdough's orbit busses before the first note. A `duckorbit(n)`
 * that fires before any sound has played on orbit n logs "duck target orbit n
 * does not exist": at a cold start the kick usually comes first in the stack,
 * and with the ducked track muted (or in a section where it rests) orbit n
 * would never exist. A rest ("~") still reaches getOrbit() and makes no sound,
 * so one rest per orbit creates them all (two idle GainNodes each). Orbits
 * live as long as the AudioContext, so this runs once.
 */
export function warmOrbits() {
  if (orbitsWarm) return;
  try {
    const ctx = engine.getAudioContext();
    if (ctx.state !== "running") return; // retried on the next play()
    const at = ctx.currentTime + 0.02;
    for (let orbit = 1; orbit <= WARM_ORBITS; orbit++) void engine.superdough({ s: "~", orbit }, at, 0.01);
    orbitsWarm = true;
  } catch {
    // not fatal: the worst case is the warning this prevents
  }
}

/** Make a TimeSpan like `like` (same class) from begin/end (numbers or Fractions) */
export function makeSpan(like: Span, begin: number | Frac, end: number | Frac): Span {
  const SpanClass = like.constructor as new (b: number | Frac, e: number | Frac) => Span;
  return new SpanClass(begin, end);
}

/** A copy of `hap` with a new value and context (one allocation) */
export function remakeHap(hap: Hap, value: unknown, context: HapContext): Hap {
  const HapClass = hap.constructor as new (w: Span | undefined, p: Span, v: unknown, c: HapContext) => Hap;
  return new HapClass(hap.whole, hap.part, value, context);
}

export function bpmToCps(bpm = 120) {
  return bpm / 4 / 60;
}

// ─────────────────────────────────────────────────────────────────────────────
// Samples
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_BASE = "https://strudel.b-cdn.net";
const SAMPLE_MAPS = [
  "tidal-drum-machines", // RolandTR808, RolandTR909, ...
  "piano",
  "vcsl", // Orchestral/acoustic instruments
  "uzu-drumkit",
  "uzu-wavetables", // Wavetable synths
  "mridangam", // Indian percussion
];
/** Bank alias map (RolandTR909 → TR909). Applied with aliasBank() *after* the banks are registered */
const BANK_ALIASES = "tidal-drum-machines-alias";

/**
 * Load all sample maps in parallel, then the bank aliases. Reports progress as
 * (loaded, total) and resolves with the names of the maps that failed.
 */
export async function loadSamples(onProgress: (loaded: number, total: number) => void): Promise<string[]> {
  let loaded = 0;
  const aliasMap = fetch(`${SAMPLE_BASE}/${BANK_ALIASES}.json`).then((r) => r.json());
  aliasMap.catch(() => {}); // handled below, after the banks are registered
  const results = await Promise.allSettled(
    SAMPLE_MAPS.map((name) =>
      engine.samples(`${SAMPLE_BASE}/${name}.json`).then(() => onProgress(++loaded, SAMPLE_MAPS.length))
    )
  );
  // aliasBank() aliases banks already in the sound map, so it must run after them
  const aliasResult = await Promise.allSettled([aliasMap.then((map) => engine.aliasBank(map))]);
  return [...results, ...aliasResult]
    .map((r, i) => (r.status === "rejected" ? [...SAMPLE_MAPS, BANK_ALIASES][i] : null))
    .filter((name): name is string => name !== null);
}
