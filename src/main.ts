import * as strudelWeb from "@strudel/web";
import { linkEditor } from "./live/editor-link";
import { createHighlighter, fromScheduler } from "./live/highlights";
import type {
  Song,
  SongSource,
  VisualizationType,
  VisualizationConfig,
} from "./songs";

// ═══════════════════════════════════════════════════════════════════════════
// 🎛️ STRUDEL IDE PLAYER
// ═══════════════════════════════════════════════════════════════════════════
//
// Live-coding playback engine. Edits to src/songs/*.ts arrive via Vite HMR and
// are hot-swapped into the *running* scheduler: the clock keeps its cycle
// position, nothing is hushed. A song that fails to build (or fails later at
// query time) never kills the music: the last good pattern keeps playing and
// the error is shown in the page.
//
// Public surface (for the UI, keyboard shortcuts, tests and editor bridges):
//   play() · stop() · togglePlay() · selectSong(id) · stepSong(±1)
//   getState() · onStateChange(cb) · window.__strudel
//
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// Engine typings
//
// src/strudel.d.ts describes Strudel for *song authors*. The player needs a few
// runtime internals it doesn't declare (the repl object, the Pattern
// constructor, `silence` as a value, aliasBank, the audio context, the log
// event key). They're typed here, in one place, against the real exports of
// the pre-bundled @strudel/web. Never import @strudel/core or @strudel/draw
// directly: that would load a second copy with its own Pattern class and its
// own animation-frame registry.
// ─────────────────────────────────────────────────────────────────────────────

type Hap = { value: Record<string, unknown> };
type State = unknown;
type QueryFn = (state: State) => Hap[];

/** Pattern internals the player relies on (not part of the song-facing types) */
interface PatternInternals {
  query: QueryFn;
  draw(fn: () => void, options: { id: number }): unknown;
}
const internals = (pattern: Pattern) => pattern as unknown as PatternInternals;

interface Scheduler {
  started: boolean;
  cps: number;
  pattern?: Pattern;
  now(): number;
}

interface Repl {
  scheduler: Scheduler;
  setPattern(pattern: Pattern, autostart?: boolean): Promise<Pattern>;
  setCps(cps: number): void;
  start(): Promise<void>;
  stop(): void;
}

interface EngineApi {
  initStrudel(options?: { onToggle?: (started: boolean) => void }): Promise<Repl>;
  Pattern: new (query: QueryFn) => Pattern;
  silence: Pattern;
  samples(url: string): Promise<void>;
  aliasBank(map: string | Record<string, string | string[]>): Promise<void>;
  getAudioContext(): AudioContext;
  /** Resumes the AudioContext and loads superdough's AudioWorklets (cached after the first call) */
  initAudio(): Promise<void>;
  logKey: string;
}

const engine = strudelWeb as unknown as EngineApi;

/** All Strudel visualizations default to animation-frame id 1 */
const DRAW_ID = 1;
/** Canvas id that @strudel/draw's getDrawContext() creates and reuses */
const DRAW_CANVAS_ID = "test-canvas";

const SAMPLE_BASE = "https://strudel.b-cdn.net";
const SAMPLE_MAPS = [
  "tidal-drum-machines", // RolandTR808, RolandTR909, ...
  "piano",
  "vcsl", // Orchestral/acoustic instruments
  "uzu-drumkit",
  "uzu-wavetables", // Wavetable synths
  "mridangam", // Indian percussion
];
/** Bank alias map (RolandTR909 → TR909). Applied with aliasBank() *after* the banks are registered */
const BANK_ALIASES = "tidal-drum-machines-alias";

const STORAGE = {
  song: "strudel-ide:song",
  follow: "strudel-ide:follow-edits",
};

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

type SongsModule = typeof import("./songs");

export interface PlayerError {
  /** build: createPattern()/viz threw · query: pattern threw while playing ·
   *  trigger: a sound failed to play (e.g. unknown sample) · load: startup */
  kind: "build" | "query" | "trigger" | "load";
  message: string;
  songId?: string;
  /** Song file, line and column (1-based, source-mapped to the .ts file) */
  file?: string;
  line?: number;
  column?: number;
  /** true when the music fell back to (or kept) the previous good pattern */
  keptPrevious: boolean;
}

export interface PlayerState {
  ready: boolean;
  loading: string | null;
  playing: boolean;
  songId: string;
  songName: string;
  bpm: number;
  cps: number;
  /** Current scheduler cycle position (0 when stopped) */
  cycle: number;
  visualization: VisualizationType;
  /** Track names when the song returns named tracks */
  tracks: string[] | null;
  followEdits: boolean;
  audio: AudioContextState | "uninitialized";
  /** Play was requested but the browser blocks audio until a user gesture */
  needsGesture: boolean;
  error: PlayerError | null;
  swapCount: number;
  lastSwapAt: number | null;
}

let songsModule: SongsModule = await import("./songs");
let repl: Repl | null = null;

let currentSongId = initialSongId();
let followEdits = readStorage(STORAGE.follow) !== "false";
let ready = false;
let loading: string | null = "Starting audio engine…";
let error: PlayerError | null = null;
let swapCount = 0;
let lastSwapAt: number | null = null;
let activeViz: VisualizationType = "none";
let activeTracks: string[] | null = null;
let needsGesture = false;
let playWhenReady = false;

/** The last bare (un-visualized, un-guarded) pattern known to work. Fallback for the next swap. */
let lastGood: Pattern | null = null;
/** File + text version the scheduler's pattern was built from (highlight offsets refer to it) */
let activeSource: SongSource | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// DOM
// ─────────────────────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const playBtn = $<HTMLButtonElement>("play");
const statusEl = $<HTMLElement>("current-pattern");
const songSelect = $<HTMLSelectElement>("song-select");
const followToggle = $<HTMLInputElement>("follow-edits");
const loadingEl = $<HTMLElement>("loading");
const errorPanel = $<HTMLElement>("error-panel");
const errorTitle = $<HTMLElement>("error-title");
const errorMessage = $<HTMLElement>("error-message");
const errorLocation = $<HTMLElement>("error-location");
const errorNote = $<HTMLElement>("error-note");
const errorDismiss = $<HTMLButtonElement>("error-dismiss");
const audioHint = $<HTMLElement>("audio-hint");

// ─────────────────────────────────────────────────────────────────────────────
// State access & change notifications
// ─────────────────────────────────────────────────────────────────────────────

function currentSong(): Song {
  return songsModule.getSong(currentSongId);
}

function audioState(): PlayerState["audio"] {
  if (!repl) return "uninitialized";
  try {
    return engine.getAudioContext().state;
  } catch {
    return "uninitialized";
  }
}

export function getState(): PlayerState {
  const song = currentSong();
  const scheduler = repl?.scheduler;
  return {
    ready,
    loading,
    playing: scheduler?.started ?? false,
    songId: currentSongId,
    songName: song?.name ?? currentSongId,
    bpm: song?.bpm ?? 120,
    cps: scheduler?.cps ?? bpmToCps(song?.bpm),
    cycle: scheduler?.now() ?? 0,
    visualization: activeViz,
    tracks: activeTracks,
    followEdits,
    audio: audioState(),
    needsGesture,
    error,
    swapCount,
    lastSwapAt,
  };
}

type Listener = (state: PlayerState) => void;
const listeners = new Set<Listener>();

/** Subscribe to state changes (play/stop, song, swap, error, loading). Returns an unsubscribe function. */
export function onStateChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let renderQueued = false;
/** Re-render the UI and notify listeners (batched to one microtask) */
function changed() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    const state = getState();
    render(state);
    for (const listener of listeners) {
      try {
        listener(state);
      } catch (e) {
        console.error("onStateChange listener failed", e);
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function render(state: PlayerState) {
  playBtn.disabled = !state.ready;
  playBtn.textContent = !state.ready ? "Loading…" : state.playing ? "■ Stop" : "▶ Play";
  playBtn.classList.toggle("playing", state.playing);

  if (songSelect.value !== state.songId) songSelect.value = state.songId;
  followToggle.checked = state.followEdits;

  statusEl.textContent = state.songName;
  statusEl.classList.toggle("idle", !state.playing);

  loadingEl.hidden = state.loading === null;
  loadingEl.querySelector(".loading-text")!.textContent = state.loading ?? "";

  audioHint.hidden = !(state.needsGesture && state.audio !== "running");

  renderError(state.error);
}

function renderError(err: PlayerError | null) {
  errorPanel.hidden = err === null;
  if (!err) return;
  errorPanel.dataset.kind = err.kind;
  const song = err.songId ? songsModule.songs[err.songId]?.name ?? err.songId : null;
  errorTitle.textContent =
    {
      build: "Song failed to build",
      query: "Pattern crashed while playing",
      trigger: "Sound error",
      load: "Loading problem",
    }[err.kind] + (song ? ` · ${song}` : "");
  errorMessage.textContent = err.message;
  errorLocation.textContent = err.file
    ? `${err.file}${err.line ? `:${err.line}` : ""}${err.column ? `:${err.column}` : ""}`
    : "";
  errorLocation.hidden = !err.file;
  errorNote.textContent = err.keptPrevious
    ? "Still playing the last good version. Fix and save to hot-swap."
    : err.kind === "trigger"
    ? "Playback continues; the failing sound is skipped."
    : "";
  errorNote.hidden = !errorNote.textContent;
}

function renderSongSelector() {
  songSelect.replaceChildren(
    ...songsModule.getAllSongs().map(({ id, song }) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = song.name;
      return option;
    })
  );
  songSelect.value = currentSongId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

function setError(next: PlayerError | null) {
  error = next;
  if (next) console.warn(`[strudel-ide] ${next.kind} error:`, next.message);
  changed();
}

function errorFrom(
  kind: PlayerError["kind"],
  err: unknown,
  songId: string | undefined,
  keptPrevious: boolean
): PlayerError {
  const e = err instanceof Error ? err : new Error(String(err));
  const result: PlayerError = { kind, message: e.message || String(err), songId, keptPrevious };
  // Resolve the song-file location asynchronously (needs the module's source map)
  void locateInSongFile(e.stack).then((loc) => {
    if (loc && error === result) {
      Object.assign(result, loc);
      changed();
    }
  });
  return result;
}

// Stack frames look like `.../src/songs/jynx.ts?t=1712:14:9`. Vite's dev transform
// shifts lines, so map the generated position back through the module's inline
// source map to the line/column you see in the editor.
const SONG_FRAME = /(https?:\/\/[^\s()]+\/src\/songs\/([\w.-]+\.ts)(?:\?[^\s():]*)?):(\d+):(\d+)/;

async function locateInSongFile(
  stack: string | undefined
): Promise<Pick<PlayerError, "file" | "line" | "column"> | null> {
  const match = stack?.match(SONG_FRAME);
  if (!match) return null;
  const [, url, file, lineStr, colStr] = match;
  const generated = { line: Number(lineStr), column: Number(colStr) };
  try {
    const code = await (await fetch(url)).text();
    const map = code.match(/sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)/);
    if (!map) return { file, ...generated };
    const { mappings } = JSON.parse(atob(map[1])) as { mappings: string };
    const pos = mapPosition(mappings, generated.line - 1, generated.column - 1);
    return pos ? { file, line: pos.line + 1, column: pos.column + 1 } : { file, ...generated };
  } catch {
    return { file, ...generated };
  }
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeVlq(segment: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const ch of segment) {
    const digit = B64.indexOf(ch);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      out.push(value & 1 ? -(value >> 1) : value >> 1);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

/** Map a 0-based generated position to a 0-based source position using source-map v3 mappings */
function mapPosition(mappings: string, line: number, column: number) {
  let srcLine = 0;
  let srcCol = 0;
  let best: { line: number; column: number } | null = null;
  const lines = mappings.split(";");
  for (let l = 0; l <= line && l < lines.length; l++) {
    let genCol = 0;
    for (const segment of lines[l].split(",")) {
      if (!segment) continue;
      const fields = decodeVlq(segment);
      genCol += fields[0];
      if (fields.length < 4) continue;
      srcLine += fields[2];
      srcCol += fields[3];
      if (l === line && (genCol <= column || best === null)) best = { line: srcLine, column: srcCol };
    }
  }
  return best;
}

// Trigger-time errors (e.g. "sound foo not found") are caught by Strudel's
// getTrigger and only reported through its logger event.
document.addEventListener(engine.logKey ?? "strudel.log", (event) => {
  const { message } = (event as CustomEvent<{ message: string }>).detail ?? {};
  if (typeof message !== "string" || !/error/i.test(message)) return;
  // Don't overwrite a more important build/query error
  if (error && error.kind !== "trigger") return;
  setError({
    kind: "trigger",
    message: message.replace(/^\[\w+\] error: /, ""),
    songId: currentSongId,
    keptPrevious: false,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pattern building
// ─────────────────────────────────────────────────────────────────────────────

function bpmToCps(bpm = 120) {
  return bpm / 4 / 60;
}

function resolveViz(viz: Song["visualization"]): VisualizationConfig {
  if (viz === undefined) return songsModule.defaultVisualization;
  return typeof viz === "string" ? { type: viz } : viz;
}

function applyVisualization(pattern: Pattern, config: VisualizationConfig): Pattern {
  const defaultOptions: PianorollOptions = { cycles: 4, playhead: 0.5, autorange: true };
  switch (config.type) {
    case "pianoroll":
      return pattern.pianoroll({ ...defaultOptions, ...config.options });
    case "scope":
      return pattern.scope();
    case "none":
    default:
      clearVisualization();
      return pattern;
  }
}

/**
 * Stop any running visualization loop and clear its canvas.
 * pianoroll()/scope() run a requestAnimationFrame loop keyed by id 1; a new
 * pianoroll()/scope() call replaces it. To stop it, register a no-op draw on
 * the same id. The shared canvas is kept (never removed): pianoroll() captures
 * its 2d context when called, so a removed canvas would keep being drawn to.
 */
function clearVisualization() {
  internals(engine.silence).draw(() => {}, { id: DRAW_ID });
  const canvas = document.getElementById(DRAW_CANVAS_ID) as HTMLCanvasElement | null;
  canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
}

/**
 * Wrap a freshly built pattern so a query-time exception (errors that only
 * happen at certain cycles, bad values in callbacks, ...) can't kill the
 * scheduler: on the first throw, report it and permanently delegate to the
 * previous good pattern.
 */
function guard(fresh: Pattern, fallback: Pattern | null, songId: string): Pattern {
  const freshQuery = internals(fresh).query.bind(fresh);
  const fallbackQuery = fallback ? internals(fallback).query.bind(fallback) : null;
  let failed = false;
  let fallbackFailed = false;

  return new engine.Pattern((state) => {
    if (!failed) {
      try {
        return freshQuery(state);
      } catch (err) {
        failed = true;
        if (lastGood === fresh) lastGood = fallback;
        queueMicrotask(() => setError(errorFrom("query", err, songId, fallback !== null)));
      }
    }
    if (!fallbackQuery || fallbackFailed) return [];
    try {
      return fallbackQuery(state);
    } catch (err) {
      fallbackFailed = true;
      queueMicrotask(() => setError(errorFrom("query", err, songId, false)));
      return [];
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Playback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the current song and hand it to the scheduler. While playing this is a
 * seamless hot-swap (no hush, the cycle position is kept); with `start` it
 * also starts the clock. On any build error the previous pattern keeps playing.
 */
async function swap({ start = false } = {}): Promise<boolean> {
  if (!repl) return false;
  const songId = currentSongId;
  const song = currentSong();
  const scheduler = repl.scheduler;

  let bare: Pattern;
  let tracks: string[] | null;
  try {
    ({ pattern: bare, tracks } = songsModule.buildPattern(song));
    // Preflight: query the next cycle so most query-time errors are caught
    // here, before the pattern reaches the scheduler.
    const from = scheduler.started ? scheduler.now() : 0;
    bare.queryArc(from, from + 1);
  } catch (err) {
    setError(errorFrom("build", err, songId, scheduler.started));
    return false;
  }

  if (!start && !scheduler.started) {
    // Stopped: the edit was only validated (errors show up before you press play)
    if (error?.kind !== "load") setError(null);
    return true;
  }

  const fallback = lastGood;
  const guarded = guard(bare, fallback, songId);
  const viz = resolveViz(song.visualization);
  let playable: Pattern;
  try {
    playable = applyVisualization(guarded, viz);
  } catch (err) {
    setError(errorFrom("build", err, songId, scheduler.started));
    return false;
  }

  lastGood = bare;
  activeViz = viz.type;
  activeTracks = tracks;
  activeSource = songsModule.songSources[songId] ?? null;
  repl.setCps(bpmToCps(song.bpm));
  await repl.setPattern(playable, true);
  swapCount++;
  lastSwapAt = performance.now();
  // Any earlier error is resolved by this successful swap
  setError(null);
  return true;
}

/** Start playing the current song (no-op if already playing). */
export async function play(): Promise<boolean> {
  if (!repl || !ready) {
    playWhenReady = true; // e.g. an editor command during startup
    return false;
  }
  if (repl.scheduler.started) return true;
  requireAudio();
  // Worklet-based sounds (supersaw, shape, ladder filter…) fail on the first
  // note if playback starts before the worklets are registered. initAudio()
  // waits on resume(), which hangs without a user gesture — so cap the wait.
  await Promise.race([engine.initAudio().catch(() => {}), sleep(1500)]);
  if (repl.scheduler.started) return true;
  return swap({ start: true });
}

/** Stop playback and visualization. */
export function stop() {
  playWhenReady = false;
  if (!repl) return;
  repl.stop();
  clearVisualization();
  needsGesture = false;
  changed();
}

export function togglePlay() {
  return repl?.scheduler.started ? stop() : play();
}

/** Make `id` the current song; hot-swaps it in if playing. Unknown ids are ignored. */
export async function selectSong(id: string): Promise<boolean> {
  if (!(id in songsModule.songs)) return false;
  if (id !== currentSongId) {
    currentSongId = id;
    writeStorage(STORAGE.song, id);
    changed();
  }
  return swap(); // hot-swap while playing; validate-only while stopped
}

/** Select the next (+1) or previous (-1) song in the list */
export function stepSong(direction: 1 | -1) {
  const ids = songsModule.getAllSongs().map(({ id }) => id);
  const index = ids.indexOf(currentSongId);
  return selectSong(ids[(index + direction + ids.length) % ids.length]);
}

export function setFollowEdits(on: boolean) {
  followEdits = on;
  writeStorage(STORAGE.follow, String(on));
  changed();
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Browsers keep the AudioContext suspended until a user gesture; flag it so the UI can ask for a click. */
function requireAudio() {
  const ctx = engine.getAudioContext();
  if (ctx.state === "running") return;
  void ctx.resume().catch(() => {});
  needsGesture = true;
  changed();
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode etc.): not persisted
  }
}

function initialSongId(): string {
  const saved = readStorage(STORAGE.song);
  if (saved && saved in songsModule.songs) return saved;
  if ("untitled" in songsModule.songs) return "untitled";
  return songsModule.getAllSongs()[0]?.id ?? "untitled";
}

// ─────────────────────────────────────────────────────────────────────────────
// UI wiring
// ─────────────────────────────────────────────────────────────────────────────

renderSongSelector();
changed();

songSelect.addEventListener("change", () => void selectSong(songSelect.value));
playBtn.addEventListener("click", () => void togglePlay());
followToggle.addEventListener("change", () => setFollowEdits(followToggle.checked));
errorDismiss.addEventListener("click", () => setError(null));
audioHint.addEventListener("click", () => void engine.getAudioContext().resume());

const isFormControl = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName));

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || isFormControl(e.target)) return;
  if (e.code === "Space") {
    e.preventDefault();
    if (ready) void togglePlay();
  } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    e.preventDefault();
    void stepSong(e.key === "ArrowRight" ? 1 : -1);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HMR - song edits hot-swap into the running scheduler
// ─────────────────────────────────────────────────────────────────────────────

if (import.meta.hot) {
  import.meta.hot.accept("./songs/index.ts", (mod) => {
    if (!mod) {
      // Vite passes undefined when re-importing failed at runtime, e.g. a song
      // file that throws at module top level (syntax errors get Vite's overlay).
      setError({
        kind: "build",
        message: "A song file failed to load (it threw while being imported). See the browser console for details.",
        keptPrevious: repl?.scheduler.started ?? false,
      });
      return;
    }
    const newModule = mod as unknown as SongsModule;
    const previous = songsModule;
    songsModule = newModule;

    // Only edited song modules are re-instantiated by Vite; unchanged ones come
    // back as the very same objects. That identifies which file(s) you edited.
    const edited = Object.keys(newModule.songs).filter(
      (id) => newModule.songs[id] !== previous.songs[id]
    );

    if (!(currentSongId in newModule.songs)) currentSongId = initialSongId();
    if (followEdits && edited.length && !edited.includes(currentSongId)) {
      currentSongId = edited[0];
      writeStorage(STORAGE.song, currentSongId);
    }
    renderSongSelector();
    changed();

    if (edited.includes(currentSongId) || previous.getSong(currentSongId) !== currentSong()) {
      void swap(); // hot-swap while playing; validate-only while stopped
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup: audio engine + samples (in parallel)
// ─────────────────────────────────────────────────────────────────────────────

repl = await engine.initStrudel({ onToggle: () => changed() });

// Debug hook (tests, devtools, editor bridges); usable while samples load
// (play() requests are queued until ready). Typed at the end of this file.
window.__strudel = {
  repl,
  scheduler: repl.scheduler,
  getState,
  onStateChange,
  play,
  stop,
  selectSong,
  songs: () => songsModule.songs,
};

// VS Code extension link (dev only; no-op without the bridge)
const bridge = linkEditor({
  getState,
  onStateChange,
  play,
  stop,
  togglePlay,
  selectSong,
  stepSong,
  songs: () => songsModule.getAllSongs().map(({ id, song }) => ({ id, name: song.name })),
});

// Live highlights: the mini-notation tokens sounding now → the editor (≤ 30 Hz,
// only on change, [] when stopped). Created after initStrudel(): it swaps in
// location-free string parsing so only song literals carry offsets.
let highlightedFile: string | null = null;
createHighlighter({
  ...fromScheduler(repl.scheduler),
  onRanges: (ranges) => {
    const source = activeSource;
    if (highlightedFile && highlightedFile !== source?.file) bridge.sendHighlight(highlightedFile, []);
    highlightedFile = source?.file ?? null;
    if (source) bridge.sendHighlight(source.file, ranges, source.version);
  },
}).start();

loading = "Loading samples…";
changed();

engine.getAudioContext().addEventListener("statechange", () => {
  if (engine.getAudioContext().state === "running") needsGesture = false;
  changed();
});

let loaded = 0;
const aliasMap = fetch(`${SAMPLE_BASE}/${BANK_ALIASES}.json`).then((r) => r.json());
aliasMap.catch(() => {}); // handled below, after the banks are registered
const results = await Promise.allSettled(
  SAMPLE_MAPS.map((name) =>
    engine.samples(`${SAMPLE_BASE}/${name}.json`).then(() => {
      loading = `Loading samples ${++loaded}/${SAMPLE_MAPS.length}…`;
      changed();
    })
  )
);
// aliasBank() aliases banks already in the sound map, so it must run after them
const aliasResult = await Promise.allSettled([aliasMap.then((map) => engine.aliasBank(map))]);

const failedLoads = [...results, ...aliasResult]
  .map((r, i) => (r.status === "rejected" ? [...SAMPLE_MAPS, BANK_ALIASES][i] : null))
  .filter(Boolean);
loading = null;
ready = true;
if (failedLoads.length) {
  setError({
    kind: "load",
    message: `Could not load sample maps: ${failedLoads.join(", ")}. Synths still work.`,
    keptPrevious: false,
  });
}
changed();
if (playWhenReady) void play();

// ─────────────────────────────────────────────────────────────────────────────
// Debug hook (tests, devtools, editor bridges)
// ─────────────────────────────────────────────────────────────────────────────

declare global {
  interface Window {
    __strudel?: {
      repl: Repl;
      scheduler: Scheduler;
      getState: typeof getState;
      onStateChange: typeof onStateChange;
      play: typeof play;
      stop: typeof stop;
      selectSong: typeof selectSong;
      songs: () => SongsModule["songs"];
    };
  }
}

console.log("🎵 Strudel IDE ready!");
