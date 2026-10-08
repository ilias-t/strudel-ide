// ═══════════════════════════════════════════════════════════════════════════
// 🎛️ KNOBS — live controls declared in song files (strudel.cc's slider())
// ═══════════════════════════════════════════════════════════════════════════
//
//   const cutoff = knob("cutoff", 2200, 200, 8000, { log: true });
//   … .lpf(cutoff)
//
// knob() returns a Pattern that behaves exactly like the number literal it
// replaces (`pure(2200)`: one event per cycle, so `.lpf(knob(…))`,
// `sine.range(200, knob(…))` and even `n(knob(…).round())` work as they would
// with `2200`), except that its value is read when the pattern is *queried*.
// Turning the knob therefore changes the sound on the scheduler's next query
// (~100 ms) without rebuilding, re-evaluating or hot-swapping anything.
//
// The registry holds one entry per (song, knob name). An entry keeps its live
// value across rebuilds and HMR; the value written in the file is its default:
//   • the file default changed (an IDE/agent edit, or Write to file)
//       → the live value resets to it, unless the knob is being dragged
//   • unchanged → the live value is kept
// A knob is "dirty" when its live value differs from its file default.
//
// Song identity: vite-plugins/strudel-knobs.ts rewrites `knob(` in song files
// to a helper that passes the file, and announces each module evaluation, so
// top-level knobs (the KNOBS block) and knobs inside createPattern() both know
// their song. Without the plugin (Node scripts) knob() still works and simply
// plays its default.
//
// No runtime imports: scripts/check-songs.mjs and test-locations.mjs load this
// file directly in Node (type stripping), with @strudel/core's `pure`.
// ═══════════════════════════════════════════════════════════════════════════

/** Options for knob()'s fifth argument */
export interface KnobOptions {
  /** Value step (default: a round step giving ~100–1000 positions) */
  step?: number;
  /** Logarithmic travel (for frequencies, times): equal turns = equal ratios. Needs min > 0. */
  log?: boolean;
}

export interface KnobSpec {
  name: string;
  /** The value written in the file */
  def: number;
  min: number;
  max: number;
  step: number;
  log: boolean;
}

/** A knob as the UI / bridge sees it */
export interface KnobInfo extends KnobSpec {
  songId: string;
  /** The live value (what is playing) */
  value: number;
  /** value differs from the file default */
  dirty: boolean;
}

interface Entry extends KnobSpec {
  songId: string;
  value: number;
  grabbed: boolean;
}

/** What is persisted per song: the live value and the file default it was set against */
export type SavedKnobs = Record<string, { value: number; base: number }>;

export interface KnobRegistryOptions {
  load?(songId: string): SavedKnobs | null;
  save?(songId: string, saved: SavedKnobs): void;
  /** A song's knobs changed (list, value or default) */
  onChange?(songId: string): void;
}

/** Decimal places of a step (0.01 → 2, 10 → 0) */
export function stepDecimals(step: number): number {
  if (!(step > 0) || step >= 1) return 0;
  const s = String(step);
  const e = /e-(\d+)$/.exec(s);
  if (e) return Number(e[1]);
  return s.split(".")[1]?.length ?? 0;
}

/** A round step for a range: 10^floor(log10(range / 100)) */
export function defaultStep(min: number, max: number): number {
  const range = Math.abs(max - min);
  if (!(range > 0)) return 1;
  return 10 ** Math.floor(Math.log10(range / 100));
}

/** Clamp to [min, max] and snap to the step grid (relative to min), with no float noise */
export function snapKnob(spec: Pick<KnobSpec, "min" | "max" | "step">, value: number): number {
  const { min, max, step } = spec;
  let v = Math.min(max, Math.max(min, value));
  if (step > 0) v = min + Math.round((v - min) / step) * step;
  v = Math.min(max, Math.max(min, v));
  return Number(v.toFixed(Math.min(12, stepDecimals(step) + decimalsOf(min))));
}

function decimalsOf(n: number): number {
  const s = String(n);
  return s.includes("e-") ? Number(s.split("e-")[1]) : (s.split(".")[1]?.length ?? 0);
}

const useLog = (spec: Pick<KnobSpec, "min" | "max" | "log">) => spec.log && spec.min > 0 && spec.max > spec.min;

/** Knob travel 0…1 for a value (log knobs: equal ratios per turn) */
export function knobPosition(spec: Pick<KnobSpec, "min" | "max" | "log">, value: number): number {
  const { min, max } = spec;
  if (max === min) return 0;
  const p = useLog(spec) ? Math.log(value / min) / Math.log(max / min) : (value - min) / (max - min);
  return Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0));
}

/** The (unsnapped) value at travel position 0…1 */
export function knobValueAt(spec: Pick<KnobSpec, "min" | "max" | "log">, position: number): number {
  const p = Math.min(1, Math.max(0, position));
  const { min, max } = spec;
  return useLog(spec) ? min * (max / min) ** p : min + (max - min) * p;
}

/** Display text for a value at the knob's precision, without trailing zeros (0.350 → 0.35) */
export function formatKnob(spec: Pick<KnobSpec, "step">, value: number): string {
  const text = value.toFixed(stepDecimals(spec.step));
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

/** Widest text a knob can show, in characters (for fixed-width labels) */
export function knobTextWidth(spec: Pick<KnobSpec, "step" | "min" | "max">): number {
  const d = stepDecimals(spec.step);
  return Math.max(spec.min.toFixed(d).length, spec.max.toFixed(d).length);
}

/** Validate knob()'s arguments (throws a helpful error, which the player shows with its line) */
export function parseKnobArgs(args: unknown[]): KnobSpec {
  const [name, value, min, max, opts] = args;
  const where = typeof name === "string" ? `knob("${name}", …)` : "knob(…)";
  if (typeof name !== "string" || !name.trim()) throw new Error(`knob(name, value, min, max): name must be a non-empty string`);
  for (const [label, v] of [["value", value], ["min", min], ["max", max]] as const) {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${where}: ${label} must be a number, got ${String(v)}`);
  }
  const lo = Math.min(min as number, max as number);
  const hi = Math.max(min as number, max as number);
  const options: KnobOptions = typeof opts === "number" ? { step: opts } : ((opts as KnobOptions | undefined) ?? {});
  const step = options.step ?? defaultStep(lo, hi);
  if (!(step > 0)) throw new Error(`${where}: step must be > 0`);
  return { name, def: value as number, min: lo, max: hi, step, log: !!options.log };
}

export class KnobRegistry {
  private songs = new Map<string, Map<string, Entry>>();
  /** Knob names a song's module declared at its last evaluation (top-level knobs) */
  private moduleNames = new Map<string, string[]>();
  /** The specs behind moduleNames, as that evaluation declared them (see moduleSpecs) */
  private moduleSpecList = new Map<string, KnobSpec[]>();
  /** Knob names a song's last build declared (knobs inside createPattern) */
  private buildNames = new Map<string, string[]>();
  /** The song being built right now (attributes knobs called without a file) */
  private building: string | null = null;
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private opts: KnobRegistryOptions;

  constructor(opts: KnobRegistryOptions = {}) {
    this.opts = opts;
  }

  /** A song module is being (re-)evaluated: its top-level knobs are declared anew */
  beginModule(songId: string) {
    this.moduleNames.set(songId, []);
    this.moduleSpecList.set(songId, []);
  }

  /**
   * The top-level knobs a song's module declared at its last evaluation, to
   * hand back to restoreModule() when that module is the song again (a revert,
   * or an evaluated edit that didn't land). A module object can't re-run its
   * top level, and the patterns it built read the same entries a later
   * evaluation redeclared.
   */
  moduleSpecs(songId: string): KnobSpec[] {
    return (this.moduleSpecList.get(songId) ?? []).map((spec) => ({ ...spec }));
  }

  /** Declare a module's top-level knobs again, as if it had just been evaluated (from moduleSpecs()) */
  restoreModule(songId: string, specs: KnobSpec[]) {
    this.beginModule(songId);
    for (const spec of specs) this.define(songId, spec);
    this.opts.onChange?.(songId);
  }

  /** Run a song's build (createPattern) with knob() attributed to it */
  build<T>(songId: string, run: () => T): T {
    const previous = this.building;
    const names = this.buildNames.get(songId);
    this.building = songId;
    this.buildNames.set(songId, []);
    try {
      return run();
    } catch (err) {
      // a failed build keeps the previous build's knobs
      if (names) this.buildNames.set(songId, names);
      throw err;
    } finally {
      this.building = previous;
      this.opts.onChange?.(songId);
    }
  }

  /** knob() was called. `songId` comes from the plugin; null = unknown (attributed to the build) */
  define(songId: string | null, spec: KnobSpec): Entry {
    const id = songId ?? this.building ?? "";
    const knobs = this.knobsOf(id);
    const listed = id === this.building ? this.buildNames : this.moduleNames;
    const names = listed.get(id) ?? [];
    listed.set(id, names);
    const repeated = names.includes(spec.name);
    if (!repeated) {
      names.push(spec.name);
      if (listed === this.moduleNames) this.moduleSpecList.get(id)?.push({ ...spec });
    }

    let entry = knobs.get(spec.name);
    if (!entry) {
      const saved = this.opts.load?.(id)?.[spec.name];
      entry = { ...spec, songId: id, value: spec.def, grabbed: false };
      // restore a live value only if the file still says what it said then
      if (saved && saved.base === spec.def && Number.isFinite(saved.value)) entry.value = saved.value;
      knobs.set(spec.name, entry);
      return entry;
    }
    // the same name twice in one evaluation (e.g. a helper called per track): the first call wins
    if (repeated) return entry;
    const defChanged = entry.def !== spec.def;
    Object.assign(entry, { min: spec.min, max: spec.max, step: spec.step, log: spec.log, def: spec.def });
    if (defChanged && !entry.grabbed) entry.value = spec.def;
    if (defChanged) this.persist(id);
    return entry;
  }

  /** The knobs a song currently declares, in declaration order */
  list(songId: string): KnobInfo[] {
    const knobs = this.songs.get(songId);
    if (!knobs) return [];
    const names = [...new Set([...(this.moduleNames.get(songId) ?? []), ...(this.buildNames.get(songId) ?? [])])];
    return names.flatMap((name) => {
      const e = knobs.get(name);
      return e ? [info(e)] : [];
    });
  }

  get(songId: string, name: string): KnobInfo | null {
    const e = this.songs.get(songId)?.get(name);
    return e ? info(e) : null;
  }

  /** Set the live value (clamped and snapped). Returns the value set, or null for an unknown knob. */
  set(songId: string, name: string, value: number): number | null {
    const e = this.songs.get(songId)?.get(name);
    if (!e || typeof value !== "number" || !Number.isFinite(value)) return null;
    const v = snapKnob(e, value);
    if (v !== e.value) {
      e.value = v;
      this.persist(songId);
      this.opts.onChange?.(songId);
    }
    return v;
  }

  /** The user holds the knob (mid-drag): file edits don't reset it meanwhile */
  grab(songId: string, name: string, on: boolean) {
    const e = this.songs.get(songId)?.get(name);
    if (e) e.grabbed = on;
  }

  /** The live value reader the knob's pattern uses */
  reader(entry: Entry): () => number {
    return () => entry.value;
  }

  private knobsOf(songId: string) {
    let knobs = this.songs.get(songId);
    if (!knobs) this.songs.set(songId, (knobs = new Map()));
    return knobs;
  }

  /** Persist a song's live values (debounced: drags write at most every 250 ms) */
  private persist(songId: string) {
    if (!this.opts.save || this.saveTimers.has(songId)) return;
    this.saveTimers.set(
      songId,
      setTimeout(() => {
        this.saveTimers.delete(songId);
        this.flush(songId);
      }, 250)
    );
  }

  flush(songId: string) {
    const knobs = this.songs.get(songId);
    if (!knobs || !this.opts.save) return;
    const saved: SavedKnobs = {};
    for (const e of knobs.values()) if (e.value !== e.def) saved[e.name] = { value: e.value, base: e.def };
    this.opts.save(songId, saved);
  }
}

function info(e: Entry): KnobInfo {
  return {
    songId: e.songId,
    name: e.name,
    value: e.value,
    def: e.def,
    min: e.min,
    max: e.max,
    step: e.step,
    log: e.log,
    dirty: Math.abs(e.value - e.def) > e.step / 1000,
  };
}

/** Song id of a song file path ("src/songs/untitled.ts" → "untitled") */
export function songIdOfFile(file: string): string {
  return file.replace(/^.*\//, "").replace(/\.ts$/, "");
}

interface PatternLike {
  withValue(fn: (value: unknown) => unknown): unknown;
}

/**
 * Install the song-facing globals:
 *   knob(name, value, min, max, step | options?)   what songs call
 *   __strudelKnob(file, …args)                      what the plugin rewrites knob( to
 *   __strudelKnobModule(file)                       the plugin's "module evaluates now"
 * `pure` must be the runtime's own (the bundled @strudel/web one in the browser).
 */
export function installKnobGlobals(registry: KnobRegistry, pure: (value: unknown) => PatternLike) {
  const make = (songId: string | null, args: unknown[]) => {
    const spec = parseKnobArgs(args);
    const entry = registry.define(songId, spec);
    const read = registry.reader(entry);
    // pure(def): one event per cycle, like the literal; the value is read per query
    return pure(spec.def).withValue(read);
  };
  const g = globalThis as Record<string, unknown>;
  g.knob = (...args: unknown[]) => make(null, args);
  g.__strudelKnob = (file: string, ...args: unknown[]) => make(songIdOfFile(file), args);
  g.__strudelKnobModule = (file: string) => registry.beginModule(songIdOfFile(file));
}
