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
// that join late, tells editors whether a player is connected (`player`) and
// tells browsers how many editors are attached (`editors`) and where the
// project lives on disk (`server`).
//
//   browser ── state · songs · highlight · onsets · reveal ──▶ editors
//              knobs · knobWrite · evalResult
//   editor  ── command ─────────────────────────────────────▶ browsers
//   editor  ── eval ──▶ server ── live ─────────────────────▶ browsers
//   server  ── player ──▶ editors     server ── server · editors ──▶ browsers
//
// Live eval (strudel.cc's Ctrl+Enter without saving): the editor sends the
// unsaved buffer of a song file (`eval`). The dev server keeps it in memory,
// compiles it through Vite's normal transform pipeline as the module
// `/src/songs/<id>.ts?live=<version>` (TS stripped, mini-notation located,
// knob() routed) and tells the browsers to import it (`live`), or hands them
// the compile error. The player hot-swaps it like a saved edit and answers the
// editors with `evalResult`. Nothing is written to disk.
//
// Offsets/positions:
//   - HighlightMsg.ranges are [start, end) UTF-16 offsets into the source text
//     identified by `version` (same unit as JS string indices and VS Code
//     offsets): the file as Vite read it from disk, or, after a live eval, the
//     evaluated editor buffer.
//   - StateMsg.error.line / column and RevealMsg.line / column are 1-based
//     (like JS stack traces and `vscode://file/…:line:col` URLs).
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
  /** Free-form client name, e.g. "strudel-live (Cursor)" */
  client?: string;
  /**
   * Editors: their URI scheme ("vscode", "cursor", "vscode-insiders", …, i.e.
   * `vscode.env.uriScheme`). The server hands the latest one to browsers as
   * the fallback scheme for opening files when no editor is attached.
   */
  scheme?: string;
}

export interface PlayerError {
  message: string;
  file?: string;
  /** 1-based */
  line?: number;
  /** 1-based */
  column?: number;
}

/** A section of the current song, positioned in bars (= cycles) from the song start */
export interface SectionMsgInfo {
  name: string;
  /** First bar, 0-based (= cycle) */
  start: number;
  bars: number;
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
  /**
   * Song position you hear at send time, in cycles (= bars), with section
   * jumps and loops applied. Unlike `cycle` it can go backwards (a jump) and
   * is not wrapped to the song length. null while stopped.
   */
  position?: number | null;
  /** The song's sections (absent/null when it has none) */
  sections?: SectionMsgInfo[] | null;
  /** Index into `sections` of the section playing at `position` */
  section?: number | null;
  /** Looping the current section */
  loop?: boolean;
  /** A jump to section `index` waiting for the next bar line */
  pendingJump?: { index: number } | null;
  /**
   * The current song is an evaluated, unsaved editor buffer (live eval):
   * its file and contentVersion. null/absent: the file on disk.
   */
  live?: { file: string; version: string } | null;
  error: PlayerError | null;
}

/**
 * A knob() control of the current song (see src/engine/knobs.ts KnobInfo).
 * `def` is the value written in the source (the file, or an evaluated buffer).
 */
export interface KnobState {
  name: string;
  /** Live value (what is playing) */
  value: number;
  def: number;
  min: number;
  max: number;
  step: number;
  log: boolean;
  /** value differs from def */
  dirty: boolean;
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

/**
 * Note onsets since the previous frame: the tokens that were just *hit*
 * (`bd*4` sends its range four times per cycle while `highlight` keeps it lit
 * throughout). Batched per frame, at most ~30 Hz, never empty. Muted tracks
 * send nothing. Same offsets/version rules as HighlightMsg.
 */
export interface OnsetsMsg {
  type: "onsets";
  file: string;
  ranges: [number, number][];
  version?: string;
}

/** Open `file` at line/column (1-based) in the editor, e.g. a click in the stage's code view */
export interface RevealMsg {
  type: "reveal";
  file: string;
  line: number;
  column?: number;
}

/**
 * The current song's knobs: on song change, on every value/default change
 * (throttled to ~30 Hz) and to editors that connect later.
 */
export interface KnobsMsg {
  type: "knobs";
  songId: string;
  file: string;
  knobs: KnobState[];
}

/** Outcome of a `writeKnobs` command */
export interface KnobWriteMsg {
  type: "knobWrite";
  file: string;
  ok: boolean;
  error?: string;
  /** What was written: the literal now in the file, per knob (1-based line) */
  changes?: { name: string; literal: string; line: number }[];
}

/**
 * Outcome of an `eval` (from the player; from the server when no player is
 * connected). `applied`: hot-swapped into the current song (false: the buffer
 * belongs to another song and follow-edits is off, so it is kept for when that
 * song is selected). On failure the player keeps the last good pattern and
 * also reports the error in `state.error`.
 */
export interface EvalResultMsg {
  type: "evalResult";
  file: string;
  version: string;
  ok: boolean;
  applied?: boolean;
  error?: PlayerError;
}

// editor → server
/**
 * Evaluate an unsaved buffer of a song file (dev server only). `file` must be
 * a song module (src/songs/<name>.ts, not index.ts or _*.ts) that exists on
 * disk; `text` is capped at MAX_EVAL_CHARS. `version` is informational: the
 * server recomputes contentVersion(text).
 */
export interface EvalMsg {
  type: "eval";
  file: string;
  text: string;
  version?: string;
  /** Also select the song and start playback once it is applied (Ctrl+Enter on a song that isn't playing) */
  play?: boolean;
}

// server → browsers
/**
 * A compiled buffer to hot-swap: import `url` (a Vite module, through the
 * normal transform pipeline). With `error` instead of `url`, the buffer did
 * not compile; keep playing and report it.
 */
export interface LiveMsg {
  type: "live";
  file: string;
  version: string;
  /** The buffer text (what the stage shows; highlight offsets index into it) */
  text: string;
  url?: string;
  error?: PlayerError;
  play?: boolean;
}

/** Largest buffer `eval` accepts, in UTF-16 code units (songs are ~25k) */
export const MAX_EVAL_CHARS = 512 * 1024;

/** Query parameter of live-eval module URLs: `/src/songs/x.ts?live=<version>` */
export const LIVE_QUERY = "live";

// server → editors
export interface PlayerMsg {
  type: "player";
  connected: boolean;
}

// server → browsers
/** How many editors are attached (on hello and whenever it changes) */
export interface EditorsMsg {
  type: "editors";
  count: number;
  /** Their hello `client` names, e.g. ["cursor"] */
  clients: string[];
}

/** Sent to each browser on hello */
export interface ServerInfoMsg {
  type: "server";
  /** Absolute path of the Vite root, with the OS's separators */
  root: string;
  /**
   * URI scheme for `<scheme>://file/<abs path>:line:col` links when no editor
   * is attached: "cursor", "vscode", … (the last editor that connected, else
   * configured or detected by the dev server; see strudel-bridge.ts).
   */
  editorScheme: string;
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
  | "unmuteAll"
  | "jump"
  | "loop"
  | "nextSection"
  | "prevSection"
  | "setKnob"
  | "resetKnob"
  | "grabKnob"
  | "writeKnobs";

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
  /** for jump: section index or name */
  section?: number | string;
  /** for loop: on/off; toggles when absent. for grabKnob: held or released */
  on?: boolean;
  /** for setKnob/resetKnob/grabKnob: the knob's name (of the current song) */
  knob?: string;
  /** for setKnob: the new value (clamped and snapped by the player) */
  value?: number;
  /** for writeKnobs: which knobs (default: every dirty one) */
  knobs?: string[];
}

export type BrowserMessage =
  | StateMsg
  | SongsMsg
  | HighlightMsg
  | OnsetsMsg
  | RevealMsg
  | KnobsMsg
  | KnobWriteMsg
  | EvalResultMsg;
export type EditorMessage = CommandMsg | EvalMsg;
export type ServerMessage = PlayerMsg | EditorsMsg | ServerInfoMsg | LiveMsg;
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
  "jump",
  "loop",
  "nextSection",
  "prevSection",
  "setKnob",
  "resetKnob",
  "grabKnob",
  "writeKnobs",
];

/** Message types only the server may send; the relay drops them from clients */
export const SERVER_ONLY_TYPES: readonly string[] = ["player", "editors", "server", "live"];

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

export function isOnsets(m: unknown): m is OnsetsMsg {
  return isObject(m) && m.type === "onsets" && typeof m.file === "string" && Array.isArray(m.ranges);
}

export function isReveal(m: unknown): m is RevealMsg {
  return isObject(m) && m.type === "reveal" && typeof m.file === "string" && typeof m.line === "number";
}

export function isEditors(m: unknown): m is EditorsMsg {
  return isObject(m) && m.type === "editors" && typeof m.count === "number";
}

export function isServerInfo(m: unknown): m is ServerInfoMsg {
  return isObject(m) && m.type === "server" && typeof m.root === "string" && typeof m.editorScheme === "string";
}

export function isPlayer(m: unknown): m is PlayerMsg {
  return isObject(m) && m.type === "player" && typeof m.connected === "boolean";
}

export function isKnobs(m: unknown): m is KnobsMsg {
  return isObject(m) && m.type === "knobs" && typeof m.file === "string" && Array.isArray(m.knobs);
}

export function isKnobWrite(m: unknown): m is KnobWriteMsg {
  return isObject(m) && m.type === "knobWrite" && typeof m.file === "string" && typeof m.ok === "boolean";
}

export function isEvalResult(m: unknown): m is EvalResultMsg {
  return (
    isObject(m) && m.type === "evalResult" && typeof m.file === "string" && typeof m.version === "string" && typeof m.ok === "boolean"
  );
}

export function isEval(m: unknown): m is EvalMsg {
  return isObject(m) && m.type === "eval" && typeof m.file === "string" && typeof m.text === "string";
}

export function isLive(m: unknown): m is LiveMsg {
  return (
    isObject(m) && m.type === "live" && typeof m.file === "string" && typeof m.version === "string" && typeof m.text === "string"
  );
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

/**
 * `<scheme>://file/<abs path>:line:col`, the link VS Code-family editors
 * (vscode, vscode-insiders, cursor, windsurf, …) open a file at a position
 * with. `root` is absolute (POSIX or Windows), `file` root-relative with "/".
 */
export function editorFileUrl(scheme: string, root: string, file: string, line?: number, column?: number): string {
  let abs = `${root.replace(/\\/g, "/").replace(/\/+$/, "")}/${file}`;
  if (!abs.startsWith("/")) abs = `/${abs}`; // C:/x → /C:/x
  const path = abs.split("/").map(encodeURIComponent).join("/").replace(/%3A/gi, ":");
  const pos = line ? `:${line}${column ? `:${column}` : ""}` : "";
  return `${scheme}://file${path}${pos}`;
}
