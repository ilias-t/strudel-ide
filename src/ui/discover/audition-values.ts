// ═══════════════════════════════════════════════════════════════════════════
// What a sound audition hands to superdough (./audition.ts)
// ═══════════════════════════════════════════════════════════════════════════
//
// Every one-shot is bounded. superdough's sampler plays a sample to its end
// when the value has none of clip, loop or release
// (node_modules/superdough/sampler.mjs, onTriggerSample: "if none of these
// controls is set, the duration of the sound will be set to the duration of
// the sample slice"), so ▶ on bassdrum2 rang for 26 s. With `release` set,
// the voice holds for the duration superdough is given (its third argument,
// which it copies into value.duration) and stops at t + duration + release.
// Synths and wavetables already end there.
//
//   ▶ (a click in the library or palette)   gain 0.8, 1.2 s + 0.2 s release
//   preview (hear while browsing)            −12 dB, −6 dB more while the
//                                            song plays, 0.6 s + 0.08 s
//
// Pitched samples and synths play a note (the caller's, e.g. the song's key
// root, else c3); drums never do. All sound auditions share one cut group, so
// a new one chokes a sample already sounding (the bus moves it to cut groups
// of the auditions' own: ./audition-bus.ts). superdough cuts only samples:
// ./audition-voices.ts silences synths (every voice) when the next one starts.
//
// Pure apart from the setting's storage: Node tests import it.

import { previewsEnabled } from "./preview-setting.ts";

export interface SoundOptions {
  /** Play the bank's version of a drum part: s("bd").bank("RolandTR909") */
  bank?: string;
  /** Which file of the sound (n) */
  n?: number;
  /** A pitched sample or a synth: play a note */
  pitched?: boolean;
  /** Hear-while-browsing: quieter and shorter, and only if the sample loads quickly */
  preview?: boolean;
  /** The note a pitched sound plays: midi (50) or a name ("d3", "Eb"); default c3 (48) */
  note?: number | string;
}

/** c3 */
export const DEFAULT_NOTE = 48;

/** A ▶ click: today's level, a one-shot of about 1.4 s */
export const PLAY = { gain: 0.8, duration: 1.2, release: 0.2 } as const;

/** A browse preview: about 0.7 s, well under a click */
export const PREVIEW = {
  /** vs a ▶ click */
  db: -12,
  /** more while the song plays */
  playingDb: -6,
  duration: 0.6,
  release: 0.08,
} as const;

/** How long an audition waits for its sample to load before giving up (ms) */
export const LOAD_WAIT_MS = { play: 8000, preview: 400 } as const;

/** The cut group every sound audition shares */
export const SOUND_CUT = "sound";

const dbToGain = (db: number) => 10 ** (db / 20);

/** A note name superdough's noteToMidi reads: c3, Eb, fs2 */
const NOTE_NAME = /^[a-gA-G][#bsf]*-?\d*$/;

function noteOf(note: number | string | undefined): number | string {
  if (typeof note === "number" && Number.isFinite(note)) return note;
  if (typeof note === "string" && NOTE_NAME.test(note.trim())) return note.trim();
  return DEFAULT_NOTE;
}

export interface SoundValue {
  /** The value for superdough (before the audition bus routes it) */
  value: Record<string, unknown>;
  /** The duration to hand superdough (seconds): the voice ends at + value.release */
  duration: number;
}

/** What auditioning `name` plays; `playing`: the song is playing */
export function soundValue(name: string, opts: SoundOptions, { playing }: { playing: boolean }): SoundValue {
  const preview = !!opts.preview;
  const gain = preview ? PLAY.gain * dbToGain(PREVIEW.db + (playing ? PREVIEW.playingDb : 0)) : PLAY.gain;
  const value: Record<string, unknown> = {
    s: name,
    gain,
    release: preview ? PREVIEW.release : PLAY.release,
    cut: SOUND_CUT,
  };
  if (opts.bank) value.bank = opts.bank;
  if (opts.n !== undefined) value.n = opts.n;
  if (opts.pitched) value.note = noteOf(opts.note);
  return { value, duration: preview ? PREVIEW.duration : PLAY.duration };
}

export interface PreviewEnv {
  /** The "hear sounds as you browse" setting */
  enabled: boolean;
  matchMedia: ((query: string) => { matches: boolean }) | undefined;
}

const pageEnv = (): PreviewEnv => ({
  enabled: previewsEnabled(),
  matchMedia: typeof globalThis.matchMedia === "function" ? (q) => globalThis.matchMedia(q) : undefined,
});

/**
 * Whether hear-while-browsing may play: the setting is on and the pointer
 * isn't coarse (touch has no arrow keys; ▶ buttons are the way there). The
 * editor adds its own screen-reader check.
 */
export function previewsAllowed(env: PreviewEnv = pageEnv()): boolean {
  if (!env.enabled) return false;
  return !env.matchMedia?.("(pointer: coarse)").matches;
}
