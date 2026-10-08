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
//
// Notes: `file` is relative to the Vite root with "/" separators. Error
// line/column are 1-based. Commands arrive without a user gesture, so audio can
// only start once the page has been clicked at least once.

import {
  BRIDGE_PATH,
  isCommand,
  parseMessage,
  type CommandMsg,
  type HighlightMsg,
  type SongInfo,
  type SongsMsg,
  type StateMsg,
} from "./protocol.ts";

export interface BridgeClientOptions {
  onCommand: (cmd: CommandMsg) => void;
  /** Called with true/false whenever the socket opens/closes. */
  onConnectionChange?: (connected: boolean) => void;
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
  readonly connected: boolean;
  close(): void;
}

/** Highlights are dropped while this much is still queued on the socket. */
const HIGHLIGHT_BACKPRESSURE_BYTES = 64 * 1024;

const noop: BridgeClient = {
  sendState() {},
  sendSongs() {},
  sendHighlight() {},
  connected: false,
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
      lastHighlight = null; // editors may have cleared; resend the next frame
      options.onConnectionChange?.(true);
    };
    socket.onmessage = (ev) => {
      const msg = parseMessage(ev.data);
      if (!isCommand(msg)) return;
      try {
        options.onCommand(msg);
      } catch (e) {
        console.error("[strudel-bridge] command handler failed", e);
      }
    };
    socket.onclose = () => {
      const wasOpen = ws === socket;
      if (wasOpen) ws = null;
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
    get connected() {
      return isOpen();
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
