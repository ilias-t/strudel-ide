// ═══════════════════════════════════════════════════════════════════════════
// Audition: hear a sound, a snippet or an example once, through the engine
// ═══════════════════════════════════════════════════════════════════════════
//
// Straight into superdough (the engine's output), next to the scheduler rather
// than through it: the song keeps playing untouched (no swap, no mute layer),
// and it works while stopped too, once the audio context runs. A click or a
// key press is a user gesture, so the first audition can unlock audio.
//
//   auditionSound(name, { bank, n, pitched })   one hit, ~half a second
//   previewCode(code, { cycles })               a one-shot pattern: the
//       expression is evaluated with the song globals (s, note, …), then its
//       haps are fed to superdough a little ahead of time, cycle by cycle, at
//       the song's tempo. A new audition stops the previous one.
//
// Code that would touch the running engine (tempo, samples, hush, outputs,
// visuals) is refused by previewable(); so is code that doesn't evaluate to a
// pattern. Lazy: only the library, palette and track builder import this.

import { bpmToCps, engine, warmOrbits } from "../../engine/strudel";
import * as player from "../../engine/player";

export interface AuditionRecord {
  id: number;
  kind: "sound" | "pattern";
  label: string;
  /** The values handed to superdough, in order */
  events: Record<string, unknown>[];
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

function play(rec: AuditionRecord, value: Record<string, unknown>, at: number, duration: number, cps: number) {
  rec.events.push({ ...value });
  // superdough writes `duration` into the value: give it a copy
  superdough({ ...value }, at, duration, cps).catch((err: unknown) => {
    rec.status = "error";
    rec.error = err instanceof Error ? err.message : String(err);
  });
}

export interface SoundOptions {
  /** Play the bank's version of a drum part: s("bd").bank("RolandTR909") */
  bank?: string;
  /** Which file of the sound (n) */
  n?: number;
  /** A pitched sample or a synth: play a note */
  pitched?: boolean;
}

/** One hit of `name`. Resolves with the record (status "error" when audio is locked) */
export async function auditionSound(name: string, opts: SoundOptions = {}): Promise<AuditionRecord> {
  stopAudition();
  const label = opts.bank ? `${name} · ${opts.bank}` : name;
  const rec = record("sound", label);
  const turn = take(rec);
  if (!(await unlock())) return fail(rec, "audio is locked: click the page first");
  if (turn.stopped) return rec; // stopped, or a newer audition started, while audio unlocked
  current = null;
  const ctx = engine.getAudioContext();
  const value: Record<string, unknown> = { s: name, gain: 0.8 };
  if (opts.bank) value.bank = opts.bank;
  if (opts.n !== undefined) value.n = opts.n;
  if (opts.pitched) value.note = 48; // c3
  play(rec, value, ctx.currentTime + 0.03, opts.pitched ? 0.6 : 0.5, currentCps());
  setTimeout(() => {
    if (rec.status === "playing") rec.status = "done";
  }, 600);
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

/** Calls a preview must never make: they reach past the pattern into the running engine or the page */
const UNSAFE =
  /\b(setcps|setcpm|setCps|setCpm|hush|samples|soundAlias|aliasBank|register|evalScope|initAudio|initStrudel|loadOrc|loadCsound|fetch|import|await|document|window|globalThis|eval|Function|localStorage)\b|\.(osc|midi|midin|serial|csound|mqtt|dough|scope|tscope|fscope|pianoroll|punchcard|spiral|pitchwheel|spectrum|wordfall|markcss|draw|animate|onPaint|onFrame|onTrigger|log|logValues)\s*\(|\$:|_\w+\s*\(/;

/** Whether previewCode() will try `code` (the library greys out ▶ otherwise) */
export function previewable(code: string): boolean {
  return code.trim().length > 0 && !UNSAFE.test(code);
}

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
