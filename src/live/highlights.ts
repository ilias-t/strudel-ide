// ═══════════════════════════════════════════════════════════════════════════
// Live highlights — which mini-notation characters are sounding right now
// ═══════════════════════════════════════════════════════════════════════════
//
// Integration (main.ts), after `const repl = await initStrudel()`:
//
//   const hl = createHighlighter({
//     ...fromScheduler(repl.scheduler),
//     onRanges: (ranges) => send({ type: "highlight", file, version, ranges }),
//     onOnsets: (ranges) => send({ type: "onsets", file, version, ranges }),
//   });
//   hl.start();            // once; it emits [] whenever nothing is playing
//
// `file`/`version` are the `__strudel_file`/`__strudel_version` exports of the
// playing song's module (see vite-plugins/strudel-locations.ts), captured when
// the pattern was built. Offsets come from `hap.context.locations`, which only
// transformed song literals carry (see stripImplicitLocations below).
// ═══════════════════════════════════════════════════════════════════════════

export type Range = [start: number, end: number];

export interface HighlighterOptions {
  /** The pattern that is playing now, or null/undefined when stopped */
  getPattern(): Pattern | null | undefined;
  /** Current scheduler position in cycles, e.g. `() => scheduler.now()` */
  getTime(): number;
  /** Cycles per second (to convert `latency`); defaults to 0.5 */
  getCps?(): number;
  /**
   * Seconds between `getTime()` and what is audible. Subtracted from the query
   * time so highlights line up with what you hear. Default: audio output latency.
   */
  latency?: number | (() => number);
  /** Called with sorted, deduped [start, end) offsets — only when they change */
  onRanges(ranges: Range[]): void;
  /**
   * Optional: called once per tick with the (sorted, deduped) ranges of the
   * notes that *started* since the previous tick, only when there are any.
   * "bd*4" stays in onRanges across its hits but shows up here on every hit.
   * Muted haps and backlogs after a pause (> half a cycle) are skipped.
   */
  onOnsets?(ranges: Range[]): void;
  /** Max update rate, default 30 */
  maxFps?: number;
  /**
   * Call stripImplicitLocations() on creation (default true). Without it,
   * strings that were not rewritten (variables, templates, mini(CONST), …) carry
   * offsets relative to the string itself, which show up as bogus highlights.
   */
  stripImplicitLocations?: boolean;
}

export interface Highlighter {
  start(): void;
  /** Stops polling and emits an empty range list */
  stop(): void;
  /** Runs one update immediately (also used by tests) */
  tick(): void;
}

/** The parts of strudel's Cyclist the highlighter reads */
export interface SchedulerLike {
  pattern?: Pattern | null;
  started?: boolean;
  cps: number;
  latency?: number;
  clock?: { duration?: number };
  now(): number;
}

const g = globalThis as any;

/** Audio output latency of strudel's AudioContext, in seconds (0 if unknown) */
export function audioOutputLatency(): number {
  try {
    const ctx = g.getAudioContext?.();
    return (ctx?.outputLatency || 0) + (ctx?.baseLatency || 0);
  } catch {
    return 0;
  }
}

/**
 * Getters for a strudel Cyclist (`repl.scheduler`).
 *
 * Cyclist.now() runs ahead of the audio: a hap at cycle c is scheduled at
 * `latency` seconds after its tick, while now() lags the tick by only one clock
 * `duration`, so audible = now() - (latency - duration) * cps. On top of that
 * comes the audio device's output latency.
 */
export function fromScheduler(scheduler: SchedulerLike) {
  return {
    getPattern: () => (scheduler.started ? scheduler.pattern : null),
    getTime: () => scheduler.now(),
    getCps: () => scheduler.cps,
    latency: () =>
      Math.max(0, (scheduler.latency ?? 0.1) - (scheduler.clock?.duration ?? 0.05)) + audioOutputLatency(),
  } satisfies Partial<HighlighterOptions>;
}

/**
 * Make every mini-notation parse that is NOT a rewritten song literal stop
 * attaching locations. Stock strudel tags each atom with offsets relative to
 * its own string (1:3 for "bd" in "bd sd"), which would light up the top of the
 * file. Covers all three entry points songs use:
 *   - the implicit string → pattern conversion (miniAllStrings → reify)
 *   - the global `mini(...)` (e.g. mini(CONST), mini(`…${x}…`))
 *   - the global `h(...)`
 * The plugin's `__strudel_m` calls the global `m(str, offset)` directly, so
 * only those patterns carry (absolute) offsets. Idempotent. Must run after
 * initStrudel() has put strudel's functions on globalThis.
 */
export function stripImplicitLocations(): boolean {
  const { setStringParser, sequence, m, patternifyAST, mini2ast } = g;
  if (typeof setStringParser !== "function" || typeof sequence !== "function" || typeof m !== "function") return false;
  // same as @strudel/mini's `mini`/`h`, but offset -1 = "skip location handling"
  const mini = (...strings: string[]) => sequence(...strings.map((str) => m(str, -1)));
  setStringParser(mini);
  g.mini = mini;
  if (typeof patternifyAST === "function" && typeof mini2ast === "function") {
    g.h = (str: string) => patternifyAST(mini2ast(str), str, null, -1);
  }
  return true;
}

// tiny query window after `t`, to catch haps active at t
const EPSILON = 1 / 4096;
// offsets are packed as start * 2^22 + end (files up to 4M UTF-16 units)
const PACK = 2 ** 22;

const NO_HAPS: readonly any[] = [];
const num = (x: any): number => (typeof x === "number" ? x : x.valueOf());

export function createHighlighter(options: HighlighterOptions): Highlighter {
  const { getPattern, getTime, getCps, onRanges, onOnsets, latency = audioOutputLatency } = options;
  const interval = 1000 / (options.maxFps ?? 30);
  if (options.stripImplicitLocations !== false && !stripImplicitLocations()) {
    console.warn("[highlights] strudel globals missing — create the highlighter after initStrudel()");
  }

  // reused buffers: packed ranges of this frame and of the last emitted frame
  let cur = new Float64Array(256);
  let last = new Float64Array(256);
  let lastLen = -1; // -1 = nothing emitted yet
  // a new pattern (hot-swap, other song) always re-emits, so listeners can attach
  // the new file/version even when the offsets happen to be identical
  let lastPattern: Pattern | null | undefined = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  /** audible time of the previous tick (onsets are read from there on), -1 = none */
  let onsetFrom = -1;

  const emit = (len: number) => {
    const ranges: Range[] = new Array(len);
    for (let i = 0; i < len; i++) ranges[i] = [Math.floor(cur[i] / PACK), cur[i] % PACK];
    // swap buffers
    const tmp = last;
    last = cur;
    cur = tmp;
    lastLen = len;
    onRanges(ranges);
  };

  const tick = () => {
    let len = 0;
    const pattern = getPattern();
    if (pattern && pattern !== lastPattern) lastLen = -1;
    if (!pattern) onsetFrom = -1;
    lastPattern = pattern;
    if (pattern) {
      const cps = getCps?.() ?? 0.5;
      const lat = typeof latency === "function" ? latency() : latency;
      const t = getTime() - lat * cps;
      if (onOnsets) onsets(pattern, t);
      let haps: readonly any[] = NO_HAPS;
      if (t >= 0) {
        try {
          haps = pattern.queryArc(t, t + EPSILON);
        } catch {
          haps = NO_HAPS; // a broken pattern shouldn't kill the loop; the scheduler reports it
        }
      }
      for (const hap of haps) {
        const locs = hap.context?.locations;
        // need a whole (drops continuous signal fragments) that is active at t
        if (!locs || !hap.whole || num(hap.whole.begin) > t || num(hap.endClipped) <= t) continue;
        for (const loc of locs) {
          if (len === cur.length) {
            const grown = new Float64Array(len * 2);
            grown.set(cur);
            cur = grown;
            last = new Float64Array(len * 2); // buffers swap, so keep equal capacity
            lastLen = -1; // force a re-emit
          }
          cur[len++] = loc.start * PACK + loc.end;
        }
      }
      if (len > 1) {
        // insertion sort: n is small (a few dozen) and this allocates nothing
        for (let i = 1; i < len; i++) {
          const v = cur[i];
          let j = i - 1;
          while (j >= 0 && cur[j] > v) cur[j + 1] = cur[j--];
          cur[j + 1] = v;
        }
        let w = 1;
        for (let r = 1; r < len; r++) if (cur[r] !== cur[w - 1]) cur[w++] = cur[r];
        len = w;
      }
    }
    if (len === lastLen) {
      let same = true;
      for (let i = 0; i < len; i++) {
        if (cur[i] !== last[i]) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    emit(len);
  };

  /** Ranges of the haps that started in [onsetFrom, t) */
  const onsets = (pattern: Pattern, t: number) => {
    const from = onsetFrom;
    onsetFrom = t;
    // first tick, time went backwards, or a long gap (tab was hidden): no backlog
    if (from < 0 || t <= from || t - from > 0.5) return;
    let haps: readonly any[];
    try {
      haps = pattern.queryArc(from, t);
    } catch {
      return;
    }
    let packed: number[] | null = null;
    for (const hap of haps) {
      const locs = hap.context?.locations;
      if (!locs?.length || !hap.whole || hap.context.muted || !hap.hasOnset?.()) continue;
      for (const loc of locs) (packed ??= []).push(loc.start * PACK + loc.end);
    }
    if (!packed) return;
    packed.sort((a, b) => a - b);
    const ranges: Range[] = [];
    for (let i = 0; i < packed.length; i++) {
      if (i && packed[i] === packed[i - 1]) continue;
      ranges.push([Math.floor(packed[i] / PACK), packed[i] % PACK]);
    }
    onOnsets!(ranges);
  };

  return {
    tick,
    start() {
      // A timer rather than requestAnimationFrame: the highlights are drawn in
      // VS Code, and rAF pauses whenever the browser tab is hidden (timers in
      // tabs that play audio are not throttled).
      if (timer === undefined) timer = setInterval(tick, interval);
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      if (lastLen !== 0) emit(0);
    },
  };
}
