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

import { connectBridge, type BridgeClient } from "./bridge-client";
import { editorFileUrl, type CommandMsg, type StateMsg } from "./protocol";
import type { PlayerState } from "../engine/types";

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
}

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
    onCommand: (cmd) => handleCommand(player, cmd),
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

function handleCommand(player: PlayerApi, cmd: CommandMsg) {
  switch (cmd.command) {
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
