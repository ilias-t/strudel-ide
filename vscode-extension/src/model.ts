// Editor-side live state, driven by bridge messages (pure, no vscode).
// `handle()` returns what changed so the UI layer only redraws what it must.

import type {
  BridgeMessage,
  CommandMsg,
  HighlightMsg,
  PlayerError,
  SongInfo,
  StateMsg,
} from "../../src/live/protocol.ts";
import { songIdFromPath } from "./paths.ts";

export type BridgeStatus = "connecting" | "connected" | "offline";

export interface Changes {
  /** status bar / context keys */
  status: boolean;
  /** error diagnostics */
  error: boolean;
  /** CodeLens (playing song changed) */
  lens: boolean;
  /** files whose highlights changed */
  highlights: Set<string>;
}

const none = (): Changes => ({ status: false, error: false, lens: false, highlights: new Set() });

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
  readonly highlights = new Map<string, HighlightMsg>();

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
        ch.lens = prev?.playing !== msg.playing || prev?.file !== msg.file;
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

  private clearHighlights(ch: Changes) {
    for (const f of this.highlights.keys()) ch.highlights.add(f);
    this.highlights.clear();
  }

  private reset(): Changes {
    const ch = none();
    this.player = false;
    ch.error = !!this.state?.error;
    ch.lens = !!this.state;
    this.state = null;
    this.clearHighlights(ch);
    return ch;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command planning
// ─────────────────────────────────────────────────────────────────────────────

export type Action = { kind: "save" } | { kind: "send"; msg: CommandMsg };

const send = (msg: Omit<CommandMsg, "type">): Action => ({ kind: "send", msg: { type: "command", ...msg } });

/** select + play the song in `file` */
export function planPlayFile(model: LiveModel, file: string): Action[] {
  return [send({ command: "select", file, songId: model.songIdFor(file) }), send({ command: "play" })];
}

/**
 * Ctrl/Cmd+Enter, strudel.cc style "evaluate":
 *   - not in a song file            → toggle play/stop
 *   - dirty song file               → save (Vite HMR hot-swaps it); also select
 *                                     + play it unless it's already playing
 *   - saved file that's playing     → stop
 *   - saved file that isn't playing → select + play it
 */
export function planEvaluate(model: LiveModel, file: string | null, dirty: boolean): Action[] {
  if (!file) return [send({ command: "toggle" })];
  const playingThis = model.playing && model.isCurrent(file);
  if (dirty) return playingThis ? [{ kind: "save" }] : [{ kind: "save" }, ...planPlayFile(model, file)];
  return playingThis ? [send({ command: "stop" })] : planPlayFile(model, file);
}
