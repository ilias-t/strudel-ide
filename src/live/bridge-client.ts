// ═══════════════════════════════════════════════════════════════════════════
// Browser side of the live bridge (protocol: ./protocol.ts)
// ═══════════════════════════════════════════════════════════════════════════
//
// Connects the player page to the Vite dev server relay (/__strudel) so the
// VS Code extension can show state, highlights and errors, and send commands.
// It auto-reconnects with backoff, re-sends the latest state/songs after each
// reconnect, and turns into a silent no-op in production builds or where
// WebSocket is unavailable.
//
// ── Integration (for src/main.ts) ─────────────────────────────────────────────
//
//   import { connectBridge } from "./live/bridge-client";
//
//   const bridge = connectBridge({
//     onCommand: (cmd) => {
//       switch (cmd.command) {
//         case "play": play(); break;
//         case "stop": stop(); break;
//         case "toggle": isPlaying ? stop() : play(); break;
//         case "select": selectSong(cmd.songId ?? songIdForFile(cmd.file)); break;
//         case "next": case "prev": stepSong(cmd.command === "next" ? 1 : -1); break;
//         case "mute": case "solo": toggleTrack(cmd.command, cmd.track!); break;
//         case "unmuteAll": unmuteAll(); break;
//       }
//     },
//   });
//   // Whenever any of these change (play/stop/select/HMR reload/error/mute):
//   bridge.sendState({ playing, songId, songName, file: `src/songs/${songId}.ts`,
//     bpm, cycle: getScheduler()?.now?.() ?? null, cps, tracks, muted, soloed, error });
//   // After songs load / HMR:
//   bridge.sendSongs(songs.map(({ id, song }) => ({ id, name: song.name, file: `src/songs/${id}.ts` })));
//   // From the highlight collector (≤ 30 Hz, only on change):
//   bridge.sendHighlight(file, ranges, version);
//   // Tokens hit since the last frame (≤ 30 Hz, only when non-empty):
//   bridge.sendOnsets(file, ranges, version);
//   // Open a file position in the editor (when bridge.editors > 0):
//   bridge.sendReveal(file, line, column);
//   // The current song's knobs (cached and re-sent after a reconnect):
//   bridge.sendKnobs(songId, file, knobs);
//   // Outcomes of the editor's writeKnobs / eval:
//   bridge.send({ type: "knobWrite", … }); bridge.send({ type: "evalResult", … });
//
// Live eval: the server's `live` message (a compiled editor buffer, or its
// compile error) arrives at onLive.
//
// The server tells the page how many editors are attached (onEditors) and the
// project root + editor URI scheme (onServerInfo), for vscode://file links
// when none is.
//
// Notes: `file` is relative to the Vite root with "/" separators. Error
// line/column are 1-based. Commands arrive without a user gesture, so audio can
// only start once the page has been clicked at least once.

import {
  BRIDGE_PATH,
  isCommand,
  isEditors,
  isLive,
  isServerInfo,
  parseMessage,
  type CommandMsg,
  type EditorsMsg,
  type EvalResultMsg,
  type HighlightMsg,
  type KnobState,
  type KnobWriteMsg,
  type KnobsMsg,
  type LiveMsg,
  type OnsetsMsg,
  type RevealMsg,
  type ServerInfoMsg,
  type SongInfo,
  type SongsMsg,
  type StateMsg,
} from "./protocol.ts";

export interface BridgeClientOptions {
  onCommand: (cmd: CommandMsg) => void;
  /** Called with true/false whenever the socket opens/closes. */
  onConnectionChange?: (connected: boolean) => void;
  /** Editors attached to the relay (count 0 while disconnected). */
  onEditors?: (editors: Omit<EditorsMsg, "type">) => void;
  /** Project root and fallback editor scheme, on every (re)connect. */
  onServerInfo?: (info: Omit<ServerInfoMsg, "type">) => void;
  /** A compiled editor buffer to hot-swap, or its compile error (live eval). */
  onLive?: (msg: LiveMsg) => void;
  /** Override the bridge URL (default: same host as the page, /__strudel). */
  url?: string;
  /** Force-enable/disable (default: only in Vite dev with WebSocket available). */
  enabled?: boolean;
  /** Client name sent in hello. */
  client?: string;
  /** Backoff bounds in ms (default 500 → 10000). */
  minDelay?: number;
  maxDelay?: number;
}

export interface BridgeClient {
  sendState(state: Omit<StateMsg, "type">): void;
  sendSongs(songs: SongInfo[]): void;
  sendHighlight(file: string, ranges: [number, number][], version?: string): void;
  /** Tokens hit since the last frame. Dropped while disconnected or backed up. */
  sendOnsets(file: string, ranges: [number, number][], version?: string): void;
  /** Ask the editor(s) to open file:line:column (1-based). False when not sent. */
  sendReveal(file: string, line: number, column?: number): boolean;
  /** The current song's knobs (the latest is re-sent after a reconnect) */
  sendKnobs(songId: string, file: string, knobs: KnobState[]): void;
  /** Outcome of an editor's writeKnobs / eval */
  send(msg: KnobWriteMsg | EvalResultMsg): void;
  readonly connected: boolean;
  /** Editors attached right now (0 while disconnected) */
  readonly editors: number;
  /** Latest server info (kept across disconnects), null before the first */
  readonly serverInfo: Omit<ServerInfoMsg, "type"> | null;
  close(): void;
}

/** Highlights are dropped while this much is still queued on the socket. */
const HIGHLIGHT_BACKPRESSURE_BYTES = 64 * 1024;

const noop: BridgeClient = {
  sendState() {},
  sendSongs() {},
  sendHighlight() {},
  sendOnsets() {},
  sendReveal: () => false,
  sendKnobs() {},
  send() {},
  connected: false,
  editors: 0,
  serverInfo: null,
  close() {},
};

function defaultEnabled(): boolean {
  // Vite replaces import.meta.env.DEV statically; under plain Node it's undefined.
  const dev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV;
  return dev !== false && typeof WebSocket !== "undefined" && typeof location !== "undefined";
}

function defaultUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${BRIDGE_PATH}`;
}

export function connectBridge(options: BridgeClientOptions): BridgeClient {
  const enabled = options.enabled ?? defaultEnabled();
  if (!enabled || typeof WebSocket === "undefined") return noop;

  const url = options.url ?? defaultUrl();
  const minDelay = options.minDelay ?? 500;
  const maxDelay = options.maxDelay ?? 10_000;

  let ws: WebSocket | null = null;
  let closed = false;
  let delay = minDelay;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastState: string | null = null;
  let lastSongs: string | null = null;
  let lastHighlight: string | null = null;
  let lastKnobs: string | null = null;
  let editors = 0;
  let serverInfo: Omit<ServerInfoMsg, "type"> | null = null;

  const isOpen = () => ws !== null && ws.readyState === WebSocket.OPEN;

  function rawSend(data: string) {
    if (isOpen()) ws!.send(data);
  }

  function open() {
    if (closed) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      delay = minDelay;
      socket.send(JSON.stringify({ type: "hello", role: "browser", client: options.client ?? "player" }));
      if (lastSongs) socket.send(lastSongs);
      if (lastState) socket.send(lastState);
      if (lastKnobs) socket.send(lastKnobs);
      lastHighlight = null; // editors may have cleared; resend the next frame
      options.onConnectionChange?.(true);
    };
    socket.onmessage = (ev) => {
      const msg = parseMessage(ev.data);
      try {
        if (isCommand(msg)) options.onCommand(msg);
        else if (isLive(msg)) options.onLive?.(msg);
        else if (isEditors(msg)) {
          editors = msg.count;
          options.onEditors?.({ count: msg.count, clients: Array.isArray(msg.clients) ? msg.clients : [] });
        } else if (isServerInfo(msg)) {
          serverInfo = { root: msg.root, editorScheme: msg.editorScheme };
          options.onServerInfo?.(serverInfo);
        }
      } catch (e) {
        console.error("[strudel-bridge] message handler failed", e);
      }
    };
    socket.onclose = () => {
      const wasOpen = ws === socket;
      if (wasOpen) ws = null;
      if (editors !== 0) {
        editors = 0;
        options.onEditors?.({ count: 0, clients: [] });
      }
      if (opened) options.onConnectionChange?.(false);
      if (wasOpen) scheduleReconnect();
    };
    socket.onerror = () => {
      // onclose follows; nothing else to do
    };
  }

  function scheduleReconnect() {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      open();
    }, delay);
    delay = Math.min(maxDelay, Math.round(delay * 1.7));
  }

  open();

  return {
    sendState(state) {
      lastState = JSON.stringify({ type: "state", ...state } satisfies StateMsg);
      rawSend(lastState);
    },
    sendSongs(songs) {
      lastSongs = JSON.stringify({ type: "songs", songs } satisfies SongsMsg);
      rawSend(lastSongs);
    },
    sendHighlight(file, ranges, version) {
      if (!isOpen()) return;
      const msg: HighlightMsg = { type: "highlight", file, ranges };
      if (version !== undefined) msg.version = version;
      const data = JSON.stringify(msg);
      if (data === lastHighlight) return;
      if (ws!.bufferedAmount > HIGHLIGHT_BACKPRESSURE_BYTES) return;
      lastHighlight = data;
      ws!.send(data);
    },
    sendOnsets(file, ranges, version) {
      if (!isOpen() || ranges.length === 0) return;
      if (ws!.bufferedAmount > HIGHLIGHT_BACKPRESSURE_BYTES) return;
      const msg: OnsetsMsg = { type: "onsets", file, ranges };
      if (version !== undefined) msg.version = version;
      ws!.send(JSON.stringify(msg));
    },
    sendReveal(file, line, column) {
      if (!isOpen()) return false;
      const msg: RevealMsg = { type: "reveal", file, line };
      if (column !== undefined) msg.column = column;
      ws!.send(JSON.stringify(msg));
      return true;
    },
    sendKnobs(songId, file, knobs) {
      lastKnobs = JSON.stringify({ type: "knobs", songId, file, knobs } satisfies KnobsMsg);
      rawSend(lastKnobs);
    },
    send(msg) {
      rawSend(JSON.stringify(msg));
    },
    get connected() {
      return isOpen();
    },
    get editors() {
      return editors;
    },
    get serverInfo() {
      return serverInfo;
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      const socket = ws;
      ws = null;
      socket?.close();
    },
  };
}
