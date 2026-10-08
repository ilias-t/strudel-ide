// Editor-side live state, driven by bridge messages (pure, no vscode).
// `handle()` returns what changed so the UI layer only redraws what it must.

import {
  isEvalResult,
  isKnobWrite,
  isKnobs,
  isReveal,
  type BridgeMessage,
  type CommandMsg,
  type EvalResultMsg,
  type HighlightMsg,
  type KnobsMsg,
  type KnobWriteMsg,
  type PlayerError,
  type RevealMsg,
  type SongInfo,
  type StateMsg,
} from "../../src/live/protocol.ts";
import { dirtyKey } from "./knobs.ts";
import { songIdFromPath } from "./paths.ts";
import { Pulses } from "./pulses.ts";

export type BridgeStatus = "connecting" | "connected" | "offline";

export interface Changes {
  /** status bar / context keys */
  status: boolean;
  /** error diagnostics */
  error: boolean;
  /** CodeLens (playing song or mix changed) */
  lens: boolean;
  /** mixer state (tracks / mute / solo / current song): lenses + dimming */
  mix: boolean;
  /** files whose highlights changed */
  highlights: Set<string>;
  /** files whose hit pulses changed */
  pulses: Set<string>;
  /** the player asked to open a file position */
  reveal: RevealMsg | null;
  /** knob values / list changed: inline hints */
  knobs: boolean;
  /** outcome of a writeKnobs command */
  knobWrite: KnobWriteMsg | null;
  /** outcome of a live eval */
  evalResult: EvalResultMsg | null;
}

const none = (): Changes => ({
  status: false,
  error: false,
  lens: false,
  mix: false,
  highlights: new Set(),
  pulses: new Set(),
  reveal: null,
  knobs: false,
  knobWrite: null,
  evalResult: null,
});

function mixKey(s: StateMsg | null): string {
  return s ? JSON.stringify([s.file, s.songId, s.tracks ?? null, s.muted ?? [], s.soloed ?? []]) : "";
}
function errorKey(e: PlayerError | null | undefined): string {
  return e ? JSON.stringify([e.message, e.file, e.line, e.column]) : "";
}

export class LiveModel {
  bridge: BridgeStatus = "connecting";
  player = false;
  state: StateMsg | null = null;
  /** Date.now() when `state` arrived (for bar extrapolation) */
  stateAt = 0;
  songs: SongInfo[] = [];
  /** The current song's knobs (latest `knobs` message) */
  knobs: KnobsMsg | null = null;
  readonly highlights = new Map<string, HighlightMsg>();
  readonly pulses = new Pulses();

  setBridge(status: BridgeStatus): Changes {
    if (status === this.bridge) return none();
    this.bridge = status;
    const ch = status === "connected" ? none() : this.reset();
    ch.status = true;
    return ch;
  }

  handle(msg: BridgeMessage, now = Date.now()): Changes {
    switch (msg.type) {
      case "player": {
        if (msg.connected === this.player) return none();
        const ch = msg.connected ? none() : this.reset();
        this.player = msg.connected;
        ch.status = true;
        return ch;
      }
      case "state": {
        const prev = this.state;
        this.state = msg;
        this.stateAt = now;
        this.player = true;
        const ch = none();
        ch.status = true;
        ch.error = errorKey(prev?.error) !== errorKey(msg.error);
        ch.mix = mixKey(prev) !== mixKey(msg);
        ch.lens = prev?.playing !== msg.playing || prev?.file !== msg.file || ch.mix;
        ch.status ||= prev?.live?.version !== msg.live?.version;
        if (!msg.playing) this.clearHighlights(ch);
        return ch;
      }
      case "songs":
        this.songs = Array.isArray(msg.songs) ? msg.songs : [];
        return none();
      case "highlight": {
        const ch = none();
        const stopped = this.state !== null && !this.state.playing;
        const had = this.highlights.has(msg.file);
        if (stopped || !Array.isArray(msg.ranges) || msg.ranges.length === 0) {
          if (had) {
            this.highlights.delete(msg.file);
            ch.highlights.add(msg.file);
          }
        } else {
          this.highlights.set(msg.file, msg);
          ch.highlights.add(msg.file);
        }
        return ch;
      }
      case "onsets": {
        const ch = none();
        if (this.playing && this.pulses.add(msg.file, msg.ranges, msg.version, now)) ch.pulses.add(msg.file);
        return ch;
      }
      case "reveal": {
        const ch = none();
        if (isReveal(msg) && msg.line >= 1) ch.reveal = msg;
        return ch;
      }
      case "knobs": {
        const ch = none();
        if (!isKnobs(msg)) return ch;
        const prev = this.knobs;
        this.knobs = msg;
        ch.knobs = true;
        // lenses show which knobs are dirty, not their values: refresh on that only
        ch.lens = prev?.file !== msg.file || dirtyKey(prev?.knobs ?? []) !== dirtyKey(msg.knobs);
        return ch;
      }
      case "knobWrite": {
        const ch = none();
        if (isKnobWrite(msg)) ch.knobWrite = msg;
        return ch;
      }
      case "evalResult": {
        const ch = none();
        if (isEvalResult(msg)) ch.evalResult = msg;
        return ch;
      }
      default:
        return none();
    }
  }

  get playing(): boolean {
    return this.player && !!this.state?.playing;
  }

  /** Song id for a root-relative file: from the player's song list, else derived. */
  songIdFor(file: string): string {
    return this.songs.find((s) => s.file === file)?.id ?? songIdFromPath(file);
  }

  /** Is `file` the player's current song? */
  isCurrent(file: string): boolean {
    const s = this.state;
    if (!s) return false;
    return s.file === file || (s.file === null && s.songId === this.songIdFor(file));
  }

  /** The current song's knobs when it's `file`, else [] */
  knobsOf(file: string): KnobsMsg["knobs"] {
    const k = this.knobs;
    return k && this.player && k.file === file && this.isCurrent(file) ? k.knobs : [];
  }

  /** Tracks of the current song when it's `file` (mixer lenses/dimming), else null */
  tracksOf(file: string): { tracks: string[]; muted: string[]; soloed: string[] } | null {
    const s = this.state;
    if (!s || !this.player || !Array.isArray(s.tracks) || !this.isCurrent(file)) return null;
    return { tracks: s.tracks, muted: s.muted ?? [], soloed: s.soloed ?? [] };
  }

  private clearHighlights(ch: Changes) {
    for (const f of this.highlights.keys()) ch.highlights.add(f);
    this.highlights.clear();
    for (const f of this.pulses.clear()) ch.pulses.add(f);
  }

  private reset(): Changes {
    const ch = none();
    this.player = false;
    ch.error = !!this.state?.error;
    ch.lens = !!this.state;
    ch.mix = !!this.state;
    ch.knobs = !!this.knobs;
    this.state = null;
    this.knobs = null;
    this.clearHighlights(ch);
    return ch;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command planning
// ─────────────────────────────────────────────────────────────────────────────

export type Action =
  | { kind: "save" }
  | { kind: "send"; msg: CommandMsg }
  /** send the document's text for live eval (`play`: also select and start its song) */
  | { kind: "eval"; play: boolean };

const send = (msg: Omit<CommandMsg, "type">): Action => ({ kind: "send", msg: { type: "command", ...msg } });

/** select + play the song in `file` */
export function planPlayFile(model: LiveModel, file: string): Action[] {
  return [send({ command: "select", file, songId: model.songIdFor(file) }), send({ command: "play" })];
}

export interface EvaluateOptions {
  /** Live eval is on (strudel.liveEval ≠ "off"): unsaved text is evaluated, not saved */
  live?: boolean;
  /** contentVersion of the document's text */
  version?: string;
}

/**
 * Ctrl/Cmd+Enter, strudel.cc style "evaluate":
 *   - not in a song file            → toggle play/stop
 *   - unsaved changes, live eval on → evaluate the buffer (no save); it also
 *                                     selects + plays the song unless it's
 *                                     already playing. Also when the player
 *                                     plays another buffer of this file than
 *                                     the text now (e.g. undone to the saved text)
 *   - unsaved changes, live eval off→ save (Vite HMR hot-swaps it); also select
 *                                     + play it unless it's already playing
 *   - saved file that's playing     → stop
 *   - saved file that isn't playing → select + play it
 */
export function planEvaluate(model: LiveModel, file: string | null, dirty: boolean, opts: EvaluateOptions = {}): Action[] {
  if (!file) return [send({ command: "toggle" })];
  const playingThis = model.playing && model.isCurrent(file);
  const live = model.state?.live;
  const behind =
    !!opts.live && opts.version !== undefined && model.isCurrent(file) && live?.file === file && live.version !== opts.version;
  if (opts.live && (dirty || behind)) return [{ kind: "eval", play: !playingThis }];
  if (dirty) return playingThis ? [{ kind: "save" }] : [{ kind: "save" }, ...planPlayFile(model, file)];
  return playingThis ? [send({ command: "stop" })] : planPlayFile(model, file);
}
