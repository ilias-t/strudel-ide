// ═══════════════════════════════════════════════════════════════════════════
// Audition: hear a sound, a snippet or an example once, through the engine
// ═══════════════════════════════════════════════════════════════════════════
//
// Straight into superdough (the engine's output), next to the scheduler rather
// than through it, on an orbit of its own (./audition-bus.ts): the song keeps
// playing untouched (no swap, no mute layer, none of its orbit effects),
// and it works while stopped too, once the audio context runs. A click or a
// key press is a user gesture, so the first audition can unlock audio.
//
//   auditionSound(name, { bank, n, pitched })   one hit, a bounded one-shot
//   auditionSound(name, { preview: true, note }) a quiet short one, for
//       hearing sounds while browsing (./audition-values.ts has the numbers)
//   prefetchSound(name, opts)                   load its sample ahead of time
//   previewCode(code, { cycles })               a one-shot pattern: the
//       expression is evaluated with the song globals (s, note, …), then its
//       haps are fed to superdough a little ahead of time, cycle by cycle, at
//       the song's tempo. A new audition stops the previous one.
//
// Code that would touch the running engine (tempo, samples, hush, outputs,
// visuals) is refused by previewable(); so is code that doesn't evaluate to a
// pattern. Lazy: only the library, palette, track builder and the editor's
// suggestions import this.

import { bpmToCps, engine, warmOrbits, type SoundEntry } from "../../engine/strudel";
import * as player from "../../engine/player";
import { AuditionBus } from "./audition-bus";
import { LOAD_WAIT_MS, previewsAllowed, soundValue, type SoundOptions } from "./audition-values";
import { previewable } from "./previewable";

export type { SoundOptions };

export interface AuditionRecord {
  id: number;
  kind: "sound" | "pattern";
  label: string;
  /** The values handed to superdough, in order, each with the `duration` it was given */
  events: Record<string, unknown>[];
  /** A hear-while-browsing preview (auditionSound's `preview`) */
  preview?: boolean;
  /** "playing" until done; "error" with `error` when it couldn't play */
  status: "playing" | "done" | "stopped" | "error";
  error?: string;
}

const LOG_LIMIT = 50;
const log: AuditionRecord[] = [];
let nextId = 1;

/** Recent auditions, newest last (tests read them through window.__strudelDiscover) */
export function auditions(): AuditionRecord[] {
  return log.map((r) => ({ ...r, events: r.events.map((e) => ({ ...e })) }));
}

function record(kind: AuditionRecord["kind"], label: string): AuditionRecord {
  const r: AuditionRecord = { id: nextId++, kind, label, events: [], status: "playing" };
  log.push(r);
  if (log.length > LOG_LIMIT) log.shift();
  return r;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Resume the context and load the worklets; false if audio stays locked (no gesture yet) */
async function unlock(): Promise<boolean> {
  const ctx = engine.getAudioContext();
  // initAudio() waits on resume(), which hangs without a gesture: cap the wait (like player.play)
  await Promise.race([engine.initAudio().catch(() => {}), sleep(1500)]);
  if (ctx.state !== "running") return false;
  warmOrbits();
  return true;
}

type Superdough = (value: Record<string, unknown>, time: number, duration: number, cps?: number, cycle?: number) => Promise<void>;
const superdough = engine.superdough as unknown as Superdough;

/** The tempo to preview at: the scheduler's while playing, else the current song's */
function currentCps(): number {
  const state = player.getState();
  const cps = state.playing ? player.getRepl()?.scheduler.cps : undefined;
  return cps && Number.isFinite(cps) && cps > 0 ? cps : bpmToCps(state.bpm || 120);
}

let current: { stop(): void } | null = null;

/** Stop the audition that's playing (notes already handed to the engine still ring out) */
export function stopAudition() {
  current?.stop();
  current = null;
}

/** Auditions' own orbit, so their orbit effects never reach the song (./audition-bus.ts) */
const bus = new AuditionBus();

function play(rec: AuditionRecord, value: Record<string, unknown>, at: number, duration: number, cps: number) {
  const routed = bus.route(value);
  // with the duration superdough is given (it bounds a voice: ./audition-values.ts)
  rec.events.push({ ...routed, duration });
  // superdough writes `duration` into the value: give it a copy
  superdough({ ...routed }, at, duration, cps).catch((err: unknown) => {
    rec.status = "error";
    rec.error = err instanceof Error ? err.message : String(err);
  });
}

/** What a failed sample load says (the editor's details pane shows it) */
export const LOAD_FAILED = "couldn't load this sample";

/** The part of superdough's sampler that loads a sound's file (re-exported by @strudel/web) */
interface SampleLoader {
  /** Picks the file for value's n / note, fetches and decodes it once (cached by URL) */
  getSampleBuffer(value: Record<string, unknown>, samples: SampleFiles): Promise<{ buffer: AudioBuffer }>;
}
type SampleFiles = NonNullable<NonNullable<SoundEntry["data"]>["samples"]>;
const sampler = engine as unknown as SampleLoader;

/** How loading a sound's file went: "none" for a sound without one (a synth) or one superdough doesn't know */
type Load = "ready" | "failed" | "none";

/** Load the sample file `value` plays (the one superdough will pick) */
function loadSample(value: Record<string, unknown>): Promise<Load> {
  // superdough plays `${bank}_${s}` and looks sounds up lowercased (superdough.mjs, registerSound)
  const key = (value.bank ? `${String(value.bank)}_${String(value.s)}` : String(value.s)).toLowerCase().replace(/\s+/g, "_");
  const data = engine.soundMap.get()[key]?.data;
  if (data?.type !== "sample" || !data.samples) return Promise.resolve("none");
  let loading: Promise<unknown>;
  try {
    loading = sampler.getSampleBuffer(value, data.samples);
  } catch {
    return Promise.resolve("failed");
  }
  return loading.then(
    () => "ready" as const,
    () => "failed" as const
  );
}

/**
 * Load `name`'s sample ahead of an audition (the editor calls it when a row
 * gets focus): the audition that follows then plays at once. Resolves true
 * once it's loaded (or the sound has no file to load), false if it can't load.
 */
export async function prefetchSound(name: string, opts: SoundOptions = {}): Promise<boolean> {
  const { value } = soundValue(name, opts, { playing: false });
  return (await loadSample(value)) !== "failed";
}

/** Whether hear-while-browsing may play: the setting is on, the pointer isn't coarse (./audition-values.ts) */
export { previewsAllowed };

/**
 * One hit of `name`, bounded (./audition-values.ts): ▶ by default, or a quiet
 * short `preview`. Waits for the sample to load (a preview only briefly: it
 * gives up silently, status "stopped", if the file isn't in within 400 ms),
 * and plays only if no newer audition started meanwhile. Resolves with the
 * record: status "error" when audio is locked or the file won't load.
 */
export async function auditionSound(name: string, opts: SoundOptions = {}): Promise<AuditionRecord> {
  const deadline = performance.now() + (opts.preview ? LOAD_WAIT_MS.preview : LOAD_WAIT_MS.play);
  stopAudition();
  const label = opts.bank ? `${name} · ${opts.bank}` : name;
  const rec = record("sound", label);
  if (opts.preview) rec.preview = true;
  const turn = take(rec);
  const release = () => {
    if (current === turn) current = null;
  };
  const { value: wanted } = soundValue(name, opts, { playing: false });
  const loaded = loadSample(wanted); // alongside unlocking
  if (!(await unlock())) {
    release();
    return fail(rec, "audio is locked: click the page first");
  }
  if (turn.stopped) return rec; // stopped, or a newer audition started, while audio unlocked
  const load = await Promise.race([loaded, sleep(Math.max(0, deadline - performance.now())).then(() => "slow" as const)]);
  if (turn.stopped) return rec; // a newer audition took over while this one loaded
  if (load === "failed") {
    release();
    return fail(rec, LOAD_FAILED);
  }
  if (load === "slow") {
    release();
    if (!opts.preview) return fail(rec, "the sample took too long to load");
    turn.stop(); // a preview gives up silently; the load carries on, so the next one plays at once
    return rec;
  }
  // the level depends on whether the song plays now; scheduled from now, after any wait
  const { value, duration } = soundValue(name, opts, { playing: player.getState().playing });
  const ctx = engine.getAudioContext();
  play(rec, value, ctx.currentTime + 0.03, duration, currentCps());
  setTimeout(
    () => {
      if (rec.status === "playing") rec.status = "done";
      release();
    },
    (duration + Number(value.release)) * 1000 + 100
  );
  return rec;
}

/**
 * The audition's turn, taken before anything is awaited: stopAudition() or a
 * newer audition ends it, and an audition whose turn ended never starts
 */
function take(rec: AuditionRecord): { stopped: boolean; stop(): void } {
  const turn = {
    stopped: false,
    stop() {
      turn.stopped = true;
      if (rec.status === "playing") rec.status = "stopped";
    },
  };
  current = turn;
  return turn;
}

function fail(rec: AuditionRecord, error: string): AuditionRecord {
  rec.status = "error";
  rec.error = error;
  return rec;
}

// previewable(): which code may run here (pure, in its own module for Node tests)
export { previewable } from "./previewable";

interface QueryHap {
  whole?: { begin: { valueOf(): number }; end: { valueOf(): number } };
  value: unknown;
  hasOnset(): boolean;
}
interface Queryable {
  queryArc(begin: number, end: number): QueryHap[];
}

/** Evaluate an expression of song code to a pattern, or throw */
function evaluate(code: string): Queryable {
  // the song globals (s, note, stack, …) live on globalThis, as for a compiled song
  const fn = new Function(`"use strict";\nreturn (\n${code}\n);`) as () => unknown;
  const value = fn();
  if (!value || typeof (value as Queryable).queryArc !== "function") throw new Error("this doesn't make a pattern");
  return value as Queryable;
}

export interface PreviewOptions {
  /** How many cycles (bars) to play (default 1) */
  cycles?: number;
  /** For the record and the test hook */
  label?: string;
}

const LOOKAHEAD = 0.25; // seconds of haps handed over ahead of time
const TICK_MS = 50;

/**
 * Play `code` (one expression) once for `cycles` bars at the song's tempo.
 * Resolves when it has started (or failed): the record says which.
 */
export async function previewCode(code: string, { cycles = 1, label = code }: PreviewOptions = {}): Promise<AuditionRecord> {
  stopAudition();
  const rec = record("pattern", label);
  if (!previewable(code)) return fail(rec, "this example can't be previewed here");
  let pattern: Queryable;
  try {
    pattern = evaluate(code);
    pattern.queryArc(0, Math.min(cycles, 1)); // fail now, not in the loop
  } catch (err) {
    return fail(rec, err instanceof Error ? err.message : String(err));
  }
  const turn = take(rec);
  if (!(await unlock())) {
    if (current === turn) current = null;
    return fail(rec, "audio is locked: click the page first");
  }
  if (turn.stopped) return rec; // stopped, or a newer audition started, while audio unlocked

  const ctx = engine.getAudioContext();
  const cps = currentCps();
  const t0 = ctx.currentTime + 0.06;
  let done = 0; // cycles handed over so far
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = (status: AuditionRecord["status"]) => {
    clearInterval(timer);
    turn.stopped = true;
    if (rec.status === "playing") rec.status = status;
    if (current === handle) current = null;
  };
  const handle = { stop: () => stop("stopped") };
  const tick = () => {
    if (turn.stopped) return stop("stopped");
    const until = Math.min(cycles, (ctx.currentTime + LOOKAHEAD - t0) * cps);
    if (until <= done) return;
    try {
      for (const hap of pattern.queryArc(done, until)) {
        if (!hap.whole || !hap.hasOnset()) continue;
        const v = hap.value;
        if (!v || typeof v !== "object" || Array.isArray(v)) continue;
        const begin = hap.whole.begin.valueOf();
        const length = hap.whole.end.valueOf() - begin;
        play(rec, v as Record<string, unknown>, t0 + begin / cps, length / cps, cps);
      }
    } catch (err) {
      fail(rec, err instanceof Error ? err.message : String(err));
      stop("error");
      return;
    }
    done = until;
    if (done >= cycles) stop("done");
  };
  current = handle;
  tick();
  if (rec.status === "playing") timer = setInterval(tick, TICK_MS);
  return rec;
}
