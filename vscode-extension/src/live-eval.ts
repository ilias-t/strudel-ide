// Live eval scheduling (pure, no vscode): when to send a song file's unsaved
// buffer to the player.
//
//   strudel.liveEval = "onPause"   (default) after you stop typing for
//                                  strudel.liveEvalDelay ms, in the song that's
//                                  playing; plus Ctrl/Cmd+Enter
//                      "onCommand" only Ctrl/Cmd+Enter (strudel.cc's behavior)
//                      "off"       Ctrl/Cmd+Enter saves instead (Vite HMR)
//
// A pause only evaluates the song the player has loaded: typing in another
// song never switches the music (Ctrl/Cmd+Enter does). Identical text is
// never sent twice, and a clean document that was never evaluated is the file
// on disk, which the player already has.

import { contentVersion } from "../../src/live/protocol.ts";

export type LiveEvalMode = "off" | "onPause" | "onCommand";

export const DEFAULT_DELAY_MS = 600;
export const MIN_DELAY_MS = 150;

export function liveEvalMode(value: unknown): LiveEvalMode {
  return value === "off" || value === "onCommand" ? value : "onPause";
}

export interface PauseDoc {
  file: string;
  text(): string;
  dirty(): boolean;
}

export interface LiveEvalOptions {
  mode(): LiveEvalMode;
  delay(): number;
  /** May this file be evaluated on a pause now (player connected, it's the current song)? */
  eligible(file: string): boolean;
  /** Send the buffer (`play`: also select and start its song); false when it couldn't be sent */
  send(file: string, text: string, version: string, play: boolean): boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export class LiveEvaluator {
  /** file → version last sent (cleared when the file is saved) */
  private sent = new Map<string, string>();
  private timers = new Map<string, unknown>();
  private readonly o: LiveEvalOptions;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(options: LiveEvalOptions) {
    this.o = options;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** The document changed: (re)start its pause timer */
  changed(doc: PauseDoc): void {
    if (this.o.mode() !== "onPause") return;
    this.cancel(doc.file);
    const ms = Math.max(MIN_DELAY_MS, this.o.delay() || DEFAULT_DELAY_MS);
    this.timers.set(
      doc.file,
      this.setTimer(() => {
        this.timers.delete(doc.file);
        this.pause(doc);
      }, ms),
    );
  }

  /** The pause timer fired */
  private pause(doc: PauseDoc): void {
    if (this.o.mode() !== "onPause" || !this.o.eligible(doc.file)) return;
    const dirty = doc.dirty();
    if (!dirty && !this.sent.has(doc.file)) return; // the file on disk is what plays
    const text = doc.text();
    const version = contentVersion(text);
    if (this.sent.get(doc.file) === version) return;
    if (this.o.send(doc.file, text, version, false)) this.sent.set(doc.file, version);
  }

  /** Ctrl/Cmd+Enter: send now (cancels a pending pause) */
  evaluate(file: string, text: string, play = false): string | null {
    this.cancel(file);
    const version = contentVersion(text);
    if (!this.o.send(file, text, version, play)) return null;
    this.sent.set(file, version);
    return version;
  }

  /** The version last sent for `file`, if it wasn't saved since */
  lastSent(file: string): string | undefined {
    return this.sent.get(file);
  }

  /** The file was saved: Vite HMR takes it from here */
  saved(file: string): void {
    this.cancel(file);
    this.sent.delete(file);
  }

  pending(file: string): boolean {
    return this.timers.has(file);
  }

  cancel(file: string): void {
    const t = this.timers.get(file);
    if (t !== undefined) this.clearTimer(t);
    this.timers.delete(file);
  }

  dispose(): void {
    for (const t of this.timers.values()) this.clearTimer(t);
    this.timers.clear();
  }
}
