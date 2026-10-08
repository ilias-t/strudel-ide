// ═══════════════════════════════════════════════════════════════════════════
// Editor link: connects the player to the VS Code extension via the bridge
// ═══════════════════════════════════════════════════════════════════════════
//
// Commands from the editor drive the player; player state (song position,
// sections, mix) and the song list flow back so the editor can show status,
// errors, highlights and its mixer CodeLens. The other way round, reveal()
// opens a file position in the editor: through the bridge when an editor is
// attached, else as a `<scheme>://file/<abs path>:line:col` link (the dev
// server sends the project root and the scheme, e.g. "cursor").
//
// Knobs: the current song's knobs go to the editor (≤ ~30 Hz while one is
// turned) and the editor turns, resets, holds and writes them with commands.
// Live eval: a compiled editor buffer from the dev server (`live`) is handed
// to the player, and the outcome goes back to the editor (`evalResult`).

import { connectBridge, type BridgeClient } from "./bridge-client";
import { editorFileUrl, type CommandMsg, type KnobState, type LiveMsg, type PlayerError, type StateMsg } from "./protocol";
import type { PlayerState } from "../engine/types";

/** What the link needs of a knob (src/engine/knobs.ts KnobInfo) */
export type KnobLike = KnobState & { songId?: string };

export interface KnobWriteOutcome {
  ok: boolean;
  error?: string;
  changes?: { name: string; literal: string; line: number }[];
}

export interface EvalOutcomeLike {
  ok: boolean;
  applied: boolean;
  error?: PlayerError;
}

export interface PlayerApi {
  getState(): PlayerState;
  onStateChange(listener: (state: PlayerState) => void): () => void;
  play(): unknown;
  stop(): unknown;
  togglePlay(): unknown;
  selectSong(id: string): unknown;
  stepSong(direction: 1 | -1): unknown;
  songs(): { id: string; name: string }[];
  toggleTrack?(mode: "mute" | "solo", track: string): unknown;
  unmuteAll?(): unknown;
  muted?(): string[];
  soloed?(): string[];
  jumpToSection?(which: number | string): unknown;
  stepSection?(direction: 1 | -1): unknown;
  setLoop?(on: boolean): unknown;
  /** The current song's knobs */
  knobs?(): KnobLike[];
  onKnobsChange?(listener: (knobs: KnobLike[], songId: string) => void): unknown;
  setKnob?(name: string, value: number): unknown;
  resetKnob?(name: string): unknown;
  grabKnob?(name: string, on: boolean): unknown;
  writeKnobs?(names?: string[]): Promise<KnobWriteOutcome>;
  /** Hot-swap a compiled editor buffer (live eval) */
  evalLive?(buffer: { file: string; version: string; text: string; url: string }, opts: { play?: boolean }): Promise<EvalOutcomeLike>;
  /** An editor buffer that didn't compile: report it, keep playing */
  evalFailed?(error: PlayerError): unknown;
}

/** Minimum interval between knob updates to the editor (~30 Hz) */
const KNOBS_INTERVAL_MS = 33;

export const songFile = (id: string) => `src/songs/${id}.ts`;

/** "src/songs/jynx.ts" | "jynx.ts" | "/abs/…/src/songs/jynx.ts" → "jynx" */
export function songIdForFile(file: string | undefined): string | null {
  const match = file?.match(/([\w.-]+)\.ts$/);
  return match ? match[1] : null;
}

/**
 * offline: no bridge (production build, dev server down) · bridge: linked to
 * the dev server but no editor attached · editor: an editor is attached
 */
export type EditorLinkState = "offline" | "bridge" | "editor";

export interface EditorLinkStatus {
  state: EditorLinkState;
  /** Attached editors and their client names */
  editors: number;
  clients: string[];
  /** Scheme reveal() falls back to without an editor ("cursor", "vscode", …), null if unknown */
  scheme: string | null;
}

export interface LinkOptions {
  /** Called with true/false when the bridge socket opens/closes */
  onConnectionChange?: (connected: boolean) => void;
  /** Called whenever the bridge or the set of attached editors changes */
  onStatus?: (status: EditorLinkStatus) => void;
}

/** How reveal() opened the location: via the bridge, as a URL, or not at all */
export type RevealResult = "editor" | "url" | "none";

/**
 * Fired on `window` (cancelable) before reveal() opens a `<scheme>://file`
 * URL. Call preventDefault() to handle it yourself (tests do).
 */
export const OPEN_URL_EVENT = "strudel:open-url";

/** Optional per-browser override of the fallback scheme (localStorage) */
export const EDITOR_SCHEME_KEY = "strudel-ide:editor-scheme";

export interface EditorLink {
  readonly bridge: BridgeClient;
  readonly status: EditorLinkStatus;
  /** Open `file` (Vite-root-relative) at line/column (1-based) in the editor */
  reveal(file: string, line: number, column?: number): RevealResult;
}

export function linkEditor(player: PlayerApi, options: LinkOptions = {}): EditorLink {
  let status: EditorLinkStatus = { state: "offline", editors: 0, clients: [], scheme: null };
  const report = (next: Partial<EditorLinkStatus>) => {
    const merged = { ...status, ...next };
    merged.state = !bridge?.connected ? "offline" : merged.editors > 0 ? "editor" : "bridge";
    status = merged;
    options.onStatus?.(status);
  };

  const bridge: BridgeClient = connectBridge({
    client: "strudel-ide-player",
    onCommand: (cmd) => handleCommand(player, cmd, bridge),
    onLive: (msg) => void applyLive(player, msg, bridge),
    onConnectionChange: (connected) => {
      options.onConnectionChange?.(connected);
      report({});
    },
    onEditors: ({ count, clients }) => report({ editors: count, clients }),
    onServerInfo: ({ editorScheme }) => report({ scheme: schemeOverride() ?? editorScheme }),
  });

  let lastSongs = "";
  const publish = (state: PlayerState) => {
    const songs = player.songs().map(({ id, name }) => ({ id, name, file: songFile(id) }));
    const songsKey = JSON.stringify(songs);
    if (songsKey !== lastSongs) {
      lastSongs = songsKey;
      bridge.sendSongs(songs);
    }
    bridge.sendState(toStateMsg(player, state));
  };

  publish(player.getState());
  player.onStateChange(publish);

  // knobs → editor: at most every KNOBS_INTERVAL_MS, always with the latest values
  if (player.knobs && player.onKnobsChange) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSent = 0;
    let lastKnobs = "";
    const sendKnobs = () => {
      timer = null;
      lastSent = performance.now();
      const songId = player.getState().songId;
      const knobs = player.knobs!().map(toKnobState);
      const key = JSON.stringify([songId, knobs]);
      if (key === lastKnobs) return;
      lastKnobs = key;
      bridge.sendKnobs(songId, songFile(songId), knobs);
    };
    player.onKnobsChange(() => {
      if (timer) return;
      timer = setTimeout(sendKnobs, Math.max(0, KNOBS_INTERVAL_MS - (performance.now() - lastSent)));
    });
    sendKnobs();
  }

  return {
    bridge,
    get status() {
      return status;
    },
    reveal(file, line, column) {
      if (bridge.editors > 0 && bridge.sendReveal(file, line, column)) return "editor";
      const root = bridge.serverInfo?.root;
      const scheme = schemeOverride() ?? bridge.serverInfo?.editorScheme;
      if (!root || !scheme) return "none";
      openUrl(editorFileUrl(scheme, root, file, line, column));
      return "url";
    },
  };
}

function schemeOverride(): string | null {
  try {
    const s = localStorage.getItem(EDITOR_SCHEME_KEY)?.trim();
    return s && /^[a-z][a-z0-9+.-]*$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

function openUrl(url: string) {
  const event = new CustomEvent(OPEN_URL_EVENT, { detail: { url }, cancelable: true });
  if (!window.dispatchEvent(event)) return;
  // An anchor click hands custom schemes to the OS (the browser asks first)
  // without navigating the page away.
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  a.click();
}

function toKnobState(k: KnobLike): KnobState {
  return { name: k.name, value: k.value, def: k.def, min: k.min, max: k.max, step: k.step, log: k.log, dirty: k.dirty };
}

async function applyLive(player: PlayerApi, msg: LiveMsg, bridge: BridgeClient) {
  if (!player.evalLive) return;
  let outcome: EvalOutcomeLike;
  if (msg.url && !msg.error) {
    outcome = await player.evalLive({ file: msg.file, version: msg.version, text: msg.text, url: msg.url }, { play: !!msg.play });
  } else {
    const error = msg.error ?? { message: `${msg.file} did not compile` };
    player.evalFailed?.(error);
    outcome = { ok: false, applied: false, error };
  }
  bridge.send({ type: "evalResult", file: msg.file, version: msg.version, ...outcome });
}

async function writeKnobs(player: PlayerApi, names: string[] | undefined, bridge: BridgeClient) {
  const result = await player.writeKnobs!(names);
  bridge.send({ type: "knobWrite", file: songFile(player.getState().songId), ...result });
}

const KNOB_COMMANDS = new Set(["setKnob", "resetKnob", "grabKnob", "writeKnobs"]);

function handleCommand(player: PlayerApi, cmd: CommandMsg, bridge: BridgeClient) {
  if (KNOB_COMMANDS.has(cmd.command)) {
    // knobs belong to the current song: ignore commands meant for another one
    const target = cmd.songId ?? songIdForFile(cmd.file);
    if (target && target !== player.getState().songId) return;
  }
  switch (cmd.command) {
    case "setKnob":
      return cmd.knob && typeof cmd.value === "number" && player.setKnob?.(cmd.knob, cmd.value);
    case "resetKnob":
      return cmd.knob && player.resetKnob?.(cmd.knob);
    case "grabKnob":
      return cmd.knob && player.grabKnob?.(cmd.knob, cmd.on !== false);
    case "writeKnobs":
      return player.writeKnobs && writeKnobs(player, Array.isArray(cmd.knobs) ? cmd.knobs : undefined, bridge);
    case "play":
      return player.play();
    case "stop":
      return player.stop();
    case "toggle":
      return player.togglePlay();
    case "select": {
      const id = cmd.songId ?? songIdForFile(cmd.file);
      return id && player.selectSong(id);
    }
    case "next":
      return player.stepSong(1);
    case "prev":
      return player.stepSong(-1);
    case "mute":
    case "solo":
      return cmd.track && player.toggleTrack?.(cmd.command, cmd.track);
    case "unmuteAll":
      return player.unmuteAll?.();
    case "jump":
      return cmd.section !== undefined && player.jumpToSection?.(cmd.section);
    case "nextSection":
      return player.stepSection?.(1);
    case "prevSection":
      return player.stepSection?.(-1);
    case "loop":
      return player.setLoop?.(typeof cmd.on === "boolean" ? cmd.on : !player.getState().loop);
  }
}

function toStateMsg(player: PlayerApi, state: PlayerState): Omit<StateMsg, "type"> {
  const err = state.error;
  return {
    playing: state.playing,
    songId: state.songId,
    songName: state.songName,
    file: songFile(state.songId),
    bpm: state.bpm,
    cycle: state.playing ? state.cycle : null,
    cps: state.cps,
    tracks: state.tracks ?? undefined,
    muted: player.muted?.(),
    soloed: player.soloed?.(),
    position: state.playing ? state.position : null,
    sections: state.sections?.map(({ name, start, bars }) => ({ name, start, bars })) ?? null,
    section: state.section?.index ?? null,
    loop: state.loop,
    pendingJump: state.pendingJump ? { index: state.pendingJump.index } : null,
    live: state.live,
    error: err
      ? {
          message: err.message,
          file: err.file ? songFile(songIdForFile(err.file) ?? err.file) : undefined,
          line: err.line,
          column: err.column,
        }
      : null,
  };
}
