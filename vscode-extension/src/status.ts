// Status bar text (pure, no vscode).

import type { SectionMsgInfo, StateMsg } from "../../src/live/protocol.ts";
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

const mod = (a: number, n: number) => ((a % n) + n) % n;

export interface SongPosition {
  /** Song position now, in cycles (wrapped to the song when it has sections) */
  position: number;
  /** 1-based bar of the song (wrapped like `position`) */
  bar: number;
  /** 1-based beat in the bar (4/4) */
  beat: number;
  section: (SectionMsgInfo & { index: number }) | null;
  /** 1-based bar within the section */
  sectionBar: number | null;
  loop: boolean;
  /** Section a pending jump goes to */
  next: string | null;
}

/**
 * Where the song is now: the player's `position` at send time, extrapolated
 * with cps and kept inside the looped section (or wrapped to the song length).
 * Falls back to the scheduler `cycle` for players that don't send `position`.
 * null when not playing.
 */
export function songPosition(state: StateMsg, stateAt: number, now: number): SongPosition | null {
  if (!state.playing) return null;
  const sections = Array.isArray(state.sections) && state.sections.length ? state.sections : null;
  const base = typeof state.position === "number" && Number.isFinite(state.position) ? state.position : null;
  const cps = cyclesPerSecond(state) ?? 0;
  const dt = (Math.max(0, now - stateAt) / 1000) * cps;
  let p: number;
  if (base === null) {
    const c = currentCycle(state, stateAt, now);
    if (c === null) return null;
    p = c;
  } else p = base + dt;

  let section: SongPosition["section"] = null;
  if (sections && base !== null) {
    const total = sections.reduce((end, s) => Math.max(end, s.start + s.bars), 0);
    const looped = state.loop && typeof state.section === "number" ? sections[state.section] : undefined;
    const b = mod(base, total);
    if (looped && b >= looped.start && b < looped.start + looped.bars) {
      p = looped.start + mod(b + dt - looped.start, looped.bars);
    } else p = mod(p, total);
    const i = sections.findIndex((s) => p >= s.start && p < s.start + s.bars);
    if (i >= 0) section = { ...sections[i], index: i };
  }
  const bar = Math.floor(Math.max(0, p) + 1e-9);
  const next =
    sections && state.pendingJump && sections[state.pendingJump.index] ? sections[state.pendingJump.index].name : null;
  return {
    position: p,
    bar: bar + 1,
    beat: Math.min(4, Math.floor((Math.max(0, p) - bar) * 4) + 1),
    section,
    sectionBar: section ? bar - section.start + 1 : null,
    loop: !!state.loop && !!section,
    next,
  };
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

  // ▶ Neon Drive · $(sync) chorus · bar 3/16 · 104 BPM
  const parts = [`${s.playing ? "▶" : "■"} ${name}`];
  const pos = songPosition(s, model.stateAt, now);
  const tips = [s.playing ? "Click to stop (Ctrl+.)" : "Click to play"];
  if (pos?.section) {
    const loop = pos.loop ? "$(sync) " : "";
    parts.push(`${loop}${pos.section.name}${pos.next ? ` → ${pos.next}` : ""}`);
    parts.push(`bar ${pos.sectionBar}/${pos.section.bars}`);
    tips.unshift(
      `Section ${pos.section.index + 1}/${s.sections!.length}: ${pos.section.name}, bar ${pos.sectionBar} of ${pos.section.bars}` +
        ` (song bar ${pos.bar})${pos.loop ? ", looping" : ""}${pos.next ? `, jumping to ${pos.next}` : ""}`,
    );
  } else if (pos) {
    parts.push(`bar ${pos.bar}`);
  }
  if (typeof s.bpm === "number") parts.push(`${Math.round(s.bpm)} BPM`);
  return {
    kind: s.playing ? "playing" : "stopped",
    text: parts.join(" · "),
    tooltip: tips.join("\n"),
    command: "strudel.toggle",
  };
}
