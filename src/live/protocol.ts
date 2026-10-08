// ═══════════════════════════════════════════════════════════════════════════
// Live bridge protocol: browser player ⇄ Vite dev server relay ⇄ editor(s)
// ═══════════════════════════════════════════════════════════════════════════
//
// Shared by the browser (src/live/bridge-client.ts), the Vite plugin
// (vite-plugins/strudel-bridge.ts) and the VS Code extension
// (vscode-extension/). Keep this file dependency-free and runtime-agnostic:
// no DOM, no Node APIs, no enums/namespaces (Node's type stripping runs it).
//
// Transport: WebSocket at ws://<vite host:port>/__strudel. Every client first
// sends `hello` with its role. The server relays browser → editors and
// editors → browsers, caches the latest browser `state`/`songs` for editors
// that join late, and tells editors whether a player is connected (`player`).
//
// Offsets/positions:
//   - HighlightMsg.ranges are [start, end) UTF-16 offsets into the file as Vite
//     read it from disk (same unit as JS string indices and VS Code offsets).
//   - StateMsg.error.line / column are 1-based (like JS stack traces).
//   - `file` fields are paths relative to the Vite root, with "/" separators,
//     e.g. "src/songs/jynx.ts".

export const BRIDGE_PATH = "/__strudel";

/**
 * Discovery file the dev server writes (relative to the Vite root) so editors
 * can find the port when it isn't 3000. Removed when the server closes.
 */
export const DISCOVERY_FILE = "node_modules/.strudel/server.json";

export interface DiscoveryInfo {
  /** http(s) URL of the dev server, e.g. "http://localhost:3000" */
  url: string;
  port: number;
  /** WebSocket URL of the bridge, e.g. "ws://localhost:3000/__strudel" */
  bridgeUrl: string;
  /** Absolute path of the Vite root; `file` fields are relative to it. */
  root: string;
  pid: number;
  startedAt: string;
}

export type Role = "browser" | "editor";

// any → server
export interface HelloMsg {
  type: "hello";
  role: Role;
  client?: string;
}

export interface PlayerError {
  message: string;
  file?: string;
  /** 1-based */
  line?: number;
  /** 1-based */
  column?: number;
}

// browser → editors
export interface StateMsg {
  type: "state";
  playing: boolean;
  songId: string | null;
  songName: string | null;
  file: string | null;
  bpm: number | null;
  /** Scheduler cycle (float) at send time. Cycle 0 = bar 1. */
  cycle: number | null;
  /**
   * Cycles per second. Optional; editors extrapolate the bar position between
   * state messages with it and fall back to bpm / 4 / 60 (one cycle = one 4/4
   * bar, which is how the player sets cpm) when it is absent.
   */
  cps?: number | null;
  tracks?: string[];
  muted?: string[];
  soloed?: string[];
  error: PlayerError | null;
}

export interface SongInfo {
  id: string;
  name: string;
  file: string;
}

export interface SongsMsg {
  type: "songs";
  songs: SongInfo[];
}

/**
 * Sent at most ~30 Hz and only when ranges changed. An empty `ranges` array
 * clears highlights for `file`.
 */
export interface HighlightMsg {
  type: "highlight";
  file: string;
  ranges: [number, number][];
  /**
   * Optional content version of the file the offsets refer to. When present
   * it must be `contentVersion(fileText)` (below) so editors can compare it
   * against their own copy and skip stale offsets.
   */
  version?: string;
}

// server → editors
export interface PlayerMsg {
  type: "player";
  connected: boolean;
}

export type CommandName =
  | "play"
  | "stop"
  | "toggle"
  | "select"
  | "next"
  | "prev"
  | "mute"
  | "solo"
  | "unmuteAll";

// editor → browsers
export interface CommandMsg {
  type: "command";
  command: CommandName;
  /** for select */
  songId?: string;
  /** for select: Vite-root-relative path; the browser maps it to a song id */
  file?: string;
  /** for mute/solo (toggle semantics) */
  track?: string;
}

export type BrowserMessage = StateMsg | SongsMsg | HighlightMsg;
export type EditorMessage = CommandMsg;
export type ServerMessage = PlayerMsg;
export type BridgeMessage = HelloMsg | BrowserMessage | EditorMessage | ServerMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const COMMANDS: readonly string[] = [
  "play",
  "stop",
  "toggle",
  "select",
  "next",
  "prev",
  "mute",
  "solo",
  "unmuteAll",
];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isHello(m: unknown): m is HelloMsg {
  return isObject(m) && m.type === "hello" && (m.role === "browser" || m.role === "editor");
}

export function isState(m: unknown): m is StateMsg {
  return isObject(m) && m.type === "state" && typeof m.playing === "boolean";
}

export function isSongs(m: unknown): m is SongsMsg {
  return isObject(m) && m.type === "songs" && Array.isArray(m.songs);
}

export function isHighlight(m: unknown): m is HighlightMsg {
  return (
    isObject(m) && m.type === "highlight" && typeof m.file === "string" && Array.isArray(m.ranges)
  );
}

export function isPlayer(m: unknown): m is PlayerMsg {
  return isObject(m) && m.type === "player" && typeof m.connected === "boolean";
}

export function isCommand(m: unknown): m is CommandMsg {
  return isObject(m) && m.type === "command" && COMMANDS.includes(m.command as string);
}

/** Parse a raw frame; returns null for invalid JSON or objects without a string `type`. */
export function parseMessage(raw: unknown): BridgeMessage | null {
  if (typeof raw !== "string") return null;
  try {
    const m: unknown = JSON.parse(raw);
    return isObject(m) && typeof m.type === "string" ? (m as unknown as BridgeMessage) : null;
  } catch {
    return null;
  }
}

/**
 * Content version for HighlightMsg.version: FNV-1a (32-bit) over the UTF-16
 * code units of the file text, as 8 hex chars. Cheap enough to compute per
 * file per save on either side.
 */
export function contentVersion(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
