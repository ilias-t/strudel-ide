// Status bar text (pure, no vscode).

import type { StateMsg } from "../../src/live/protocol.ts";
import type { LiveModel } from "./model.ts";

export type StatusKind = "offline" | "connecting" | "noPlayer" | "stopped" | "playing" | "error";

export interface StatusView {
  kind: StatusKind;
  text: string;
  tooltip: string;
  /** which command a click runs */
  command: "strudel.toggle" | "strudel.openPlayer" | "strudel.startDevServer" | "strudel.showError";
}

/** Cycles per second: the player's `cps`, else bpm / 4 / 60 (one cycle = one 4/4 bar). */
export function cyclesPerSecond(state: Pick<StateMsg, "cps" | "bpm">): number | null {
  if (typeof state.cps === "number" && state.cps > 0) return state.cps;
  if (typeof state.bpm === "number" && state.bpm > 0) return state.bpm / 240;
  return null;
}

/** Cycle now, extrapolated from the last state message while playing. */
export function currentCycle(state: StateMsg, stateAt: number, now: number): number | null {
  if (typeof state.cycle !== "number" || !Number.isFinite(state.cycle)) return null;
  if (!state.playing) return state.cycle;
  const cps = cyclesPerSecond(state);
  return cps ? state.cycle + (Math.max(0, now - stateAt) / 1000) * cps : state.cycle;
}

/** 1-based bar number for a cycle (cycle 0 → bar 1). */
export function barNumber(cycle: number): number {
  return Math.max(0, Math.floor(cycle + 1e-9)) + 1;
}

export function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function formatError(e: NonNullable<StateMsg["error"]>): string {
  const where = e.file ? ` (${e.file}${e.line ? `:${e.line}${e.column ? `:${e.column}` : ""}` : ""})` : "";
  return `${e.message}${where}`;
}

export function formatStatus(model: LiveModel, now = Date.now(), playerUrl = "http://localhost:3000"): StatusView {
  if (model.bridge === "offline")
    return {
      kind: "offline",
      text: "$(debug-disconnect) Strudel: dev server not running",
      tooltip: `No Strudel dev server at ${playerUrl}. Click to run \`npm run dev\`.`,
      command: "strudel.startDevServer",
    };
  if (model.bridge === "connecting")
    return {
      kind: "connecting",
      text: "$(sync~spin) Strudel: connecting…",
      tooltip: `Connecting to ${playerUrl}`,
      command: "strudel.openPlayer",
    };
  if (!model.player || !model.state)
    return {
      kind: "noPlayer",
      text: "$(debug-disconnect) Strudel: player not connected",
      tooltip: `Click to open the player (${playerUrl}) in your browser`,
      command: "strudel.openPlayer",
    };

  const s = model.state;
  const name = s.songName ?? s.songId ?? "Strudel";
  if (s.error)
    return {
      kind: "error",
      text: `$(error) ${name}: ${truncate(s.error.message, 60)}`,
      tooltip: `${formatError(s.error)}\n\nClick to show the error.`,
      command: "strudel.showError",
    };

  const parts = [`${s.playing ? "▶" : "■"} ${name}`];
  if (typeof s.bpm === "number") parts.push(`${Math.round(s.bpm)} BPM`);
  if (s.playing) {
    const c = currentCycle(s, model.stateAt, now);
    if (c !== null) parts.push(`bar ${barNumber(c)}`);
  }
  return {
    kind: s.playing ? "playing" : "stopped",
    text: parts.join(" · "),
    tooltip: s.playing ? "Click to stop (Ctrl+.)" : "Click to play",
    command: "strudel.toggle",
  };
}
