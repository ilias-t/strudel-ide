// ═══════════════════════════════════════════════════════════════════════════
// 🎛️ PLAYER — playback state, hot-swap, mute/solo, section jumps and loops
// ═══════════════════════════════════════════════════════════════════════════
//
// Edits to src/songs/*.ts arrive via Vite HMR (main.ts hands the new songs
// module to setSongsModule) and are hot-swapped into the *running* scheduler:
// the clock keeps its cycle position, nothing is hushed. A song that fails to
// build (or fails later at query time) never kills the music: the last good
// pattern keeps playing and the error is shown in the page.
//
// What reaches the scheduler is layered, outermost last:
//
//   song.createPattern()          built once per edit / song change
//   → composeTracks(parts, mix)   per-track tags, colours, mute/solo (tracks.ts)
//   → guard(…, lastGood)          query-time errors fall back to the last good one
//   → timeMap.apply(…)            section jumps and loops (timemap.ts)
//   → applyVisualization(…)       pianoroll / scope
//
// Mute/solo and jumps only redo the cheap outer layers ("relink"), so they are
// seamless hot-swaps too.
//
// This module never imports ../songs at runtime (only main.ts does, so it can
// accept the HMR update); it works on the module main.ts hands it.
//
// Live eval (evalLive): an unsaved editor buffer, compiled by the dev server
// into its own module (vite-plugins/strudel-live-eval.ts), stands in for its
// song file until the file is saved. It hot-swaps exactly like a saved edit,
// and a broken buffer never replaces the last good pattern. Saving the same
// text afterwards keeps the build that is playing (no second swap).
//
// Browser eval (evalSource): the same, but the text is compiled in the page by
// src/compile/ (a lazily loaded worker running the very transforms the Vite
// plugins run), so it works on the static host too. `intent: "typing"` never
// sets the player error: its errors are returned for inline display, and while
// a typing build plays, its query/trigger errors only go to the console.
// User songs (addSong/removeSong) are compiled the same way and join the song
// list next to the built-in songs from src/songs/*.ts. A saved one that doesn't
// build is listed anyway (keepBroken): a silent placeholder holding its text,
// until an edit of it builds (songProblem()).

import { Mix } from "./mix";
import { errorFrom } from "./errors";
import { composeTracks } from "./tracks";
import { TimeMap, normalizeSections, sectionAt, songLength } from "./timemap";
import { KEYS, readJson, readStorage, writeJson, writeStorage } from "./storage";
import { KnobRegistry, installKnobGlobals, type KnobInfo, type SavedKnobs } from "./knobs";
import { bpmToCps, engine, internals, warmOrbits, type Repl } from "./strudel";
import { applyVisualization, clearVisualization } from "../ui/viz";
import { audioOutputLatency } from "../live/highlights";
import { MAX_EVAL_CHARS, contentVersion } from "../live/protocol";
import { songFileOf, songIdProblem } from "../compile/song-id";
import type { PlayerError, PlayerState, SectionInfo } from "./types";
import type { Song, SongSource, VisualizationConfig, VisualizationType } from "../songs";

type SongsModule = typeof import("../songs");

/** A song's source as the player has it: SongSource plus who evaluated it */
export interface PlayerSource extends SongSource {
  /** Set for evaluated text: the browser editor/runtime (evalSource) or the VS Code editor */
  origin?: "browser" | "editor";
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let songsModule: SongsModule;
let repl: Repl | null = null;

let currentSongId = "";
let followEdits = readStorage(KEYS.follow) !== "false";
let codeView = readStorage(KEYS.codeView) !== "false";
let ready = false;
let loading: string | null = "Starting audio engine…";
let error: PlayerError | null = null;
let swapCount = 0;
let lastSwapAt: number | null = null;
let activeViz: VisualizationType = "none";
let needsGesture = false;
let playWhenReady = false;

const mix = new Mix();
const timeMap = new TimeMap();

/** Live knob values (see knobs.ts). Installed now: song modules call knob() when imported. */
const knobRegistry = new KnobRegistry({
  load: (songId) => readJson<SavedKnobs>(KEYS.knobs(songId)),
  save: (songId, saved) => writeJson(KEYS.knobs(songId), saved),
  onChange: (songId) => {
    if (songId === currentSongId) knobsChanged();
  },
});
installKnobGlobals(knobRegistry, engine.pure);

/** The current song's last successful build (also while stopped, for the mixer) */
interface Build {
  songId: string;
  song: Song;
  /** Named tracks, or null when createPattern() returned one Pattern */
  parts: [string, Pattern][] | null;
  single: Pattern | null;
  tracks: string[] | null;
  viz: VisualizationConfig;
  source: PlayerSource | null;
  /** Built from a typing-intent eval: its later query/trigger errors stay out of the error panel */
  quiet: boolean;
}
let build: Build | null = null;
/** The build that is in the scheduler now */
let playing: Build | null = null;

/** An evaluated buffer standing in for its song's source (until the file is saved or it is reverted) */
interface LiveSong {
  song: Song;
  source: PlayerSource;
  /** Set on a user song that didn't build (addSong's keepBroken): a silent placeholder holding its text */
  problem?: EvalSourceError;
}
const liveSongs = new Map<string, LiveSong>();

/** Songs added at runtime (addSong), compiled in the browser; listed after the built-in songs */
const userSongs = new Map<string, LiveSong>();

/** The last bare (un-visualized, un-guarded) pattern known to work. Fallback for the next swap. */
let lastGood: Pattern | null = null;

/** Section the next play() starts at (set by clicking a section while stopped) */
let startSection = 0;
let loopOn = false;
let pendingJump: { index: number; atCycle: number } | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Setup (called by main.ts)
// ─────────────────────────────────────────────────────────────────────────────

export function setSongsModule(mod: SongsModule) {
  songsModule = mod;
  exposeSongsIndex(mod);
}

/**
 * Browser-compiled songs read value imports from "." (the songs index) from
 * this global (src/compile/compile.ts rewrites them), since a compiled module
 * can't import the bundled index by URL.
 */
function exposeSongsIndex(mod: SongsModule) {
  (globalThis as { __strudelSongsIndex?: SongsModule }).__strudelSongsIndex = mod;
}

export function attachRepl(r: Repl) {
  repl = r;
}

export function getRepl() {
  return repl;
}

export function setLoading(text: string | null) {
  loading = text;
  changed();
}

export function setReady() {
  loading = null;
  ready = true;
  changed();
  if (playWhenReady) void play();
}

// ─────────────────────────────────────────────────────────────────────────────
// State access & change notifications
// ─────────────────────────────────────────────────────────────────────────────

export function currentSong(): Song {
  return liveSongs.get(currentSongId)?.song ?? userSongs.get(currentSongId)?.song ?? songsModule.getSong(currentSongId);
}

export function currentSongId_(): string {
  return currentSongId;
}

/** A song from src/songs/*.ts (not one added at runtime) */
export function isBuiltInSong(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(songsModule.songs, id);
}

/** A song in the list: built-in or added with addSong() */
export function hasSong(id: string): boolean {
  return isBuiltInSong(id) || userSongs.has(id);
}

/** All songs in list order: the built-in songs, then the user songs (in the order they were added) */
export function allSongs(): { id: string; song: Song }[] {
  return [...songsModule.getAllSongs(), ...[...userSongs].map(([id, { song }]) => ({ id, song }))];
}

/** The song as it plays now: an evaluated buffer, else the user song / file (the picker shows its name) */
export function playingSongOf(id: string): Song | undefined {
  return liveSongs.get(id)?.song ?? userSongs.get(id)?.song ?? songsModule.songs[id];
}

/** A built-in song's file on disk (null for user songs): what "revert" brings back */
export function fileSource(id: string): PlayerSource | null {
  return isBuiltInSong(id) ? songsModule.songSources[id] ?? null : null;
}

export function songsRecord(): Record<string, Song> {
  if (!userSongs.size) return songsModule.songs;
  return { ...songsModule.songs, ...Object.fromEntries([...userSongs].map(([id, { song }]) => [id, song])) };
}

/** A song's own source: the file on disk (built-in) or the text it was added with (user song) */
function baseSource(id: string): PlayerSource | null {
  return userSongs.get(id)?.source ?? songsModule.songSources[id] ?? null;
}

/** File, version and text of a song: its file on disk / added text, or an evaluated buffer (`live`) */
export function sourceOf(id: string): PlayerSource | null {
  return liveSongs.get(id)?.source ?? baseSource(id);
}

/** File, version and text of the current song: the file on disk, or an evaluated buffer (`live`) */
export function currentSource(): PlayerSource | null {
  return sourceOf(currentSongId);
}

/** File/version the scheduler's pattern was built from (highlight offsets refer to it) */
export function playingSource(): PlayerSource | null {
  return playing?.source ?? null;
}

let sectionsCache: { song: Song; sections: SectionInfo[] | null } | null = null;
export function currentSections(): SectionInfo[] | null {
  const song = currentSong();
  if (sectionsCache?.song !== song) sectionsCache = { song, sections: normalizeSections(song?.sections) };
  return sectionsCache.sections;
}

function audioState(): PlayerState["audio"] {
  if (!repl) return "uninitialized";
  try {
    return engine.getAudioContext().state;
  } catch {
    return "uninitialized";
  }
}

/** Seconds between the scheduler's now() and what you hear (see live/highlights.ts) */
function latencySeconds(): number {
  const s = repl?.scheduler;
  if (!s) return 0;
  return Math.max(0, (s.latency ?? 0.1) - (s.clock?.duration ?? 0.05)) + audioOutputLatency();
}

/** The scheduler cycle you are hearing now (0 when stopped) */
export function audibleCycle(): number {
  const s = repl?.scheduler;
  if (!s?.started) return 0;
  return Math.max(0, s.now() - latencySeconds() * s.cps);
}

/** Song position (pattern cycle) you are hearing now */
export function songPosition(): number {
  return timeMap.position(audibleCycle());
}

/** Song position the time map gives scheduler cycle `cycle` (jumps/loops applied) */
export function positionAt(cycle: number): number {
  return timeMap.position(cycle);
}

/** 1-based bar/beat for a song position (wrapped to the song when it has sections) */
export function barBeat(position: number, sections = currentSections()): { bar: number; beat: number } {
  const total = songLength(sections);
  const p = total ? ((position % total) + total) % total : Math.max(0, position);
  const bar = Math.floor(p);
  return { bar: bar + 1, beat: Math.min(4, Math.floor((p - bar) * 4) + 1) };
}

export function getState(): PlayerState {
  const song = currentSong();
  const scheduler = repl?.scheduler;
  const sections = currentSections();
  const position = songPosition();
  const { bar, beat } = barBeat(position, sections);
  return {
    ready,
    loading,
    playing: scheduler?.started ?? false,
    songId: currentSongId,
    songName: song?.name ?? currentSongId,
    bpm: song?.bpm ?? 120,
    cps: scheduler?.cps ?? bpmToCps(song?.bpm),
    cycle: scheduler?.now() ?? 0,
    position,
    bar,
    beat,
    visualization: activeViz,
    tracks: build?.songId === currentSongId ? build.tracks : null,
    live: liveOf(currentSongId),
    muted: mix.mutedList(),
    soloed: mix.soloedList(),
    sections,
    section: sectionAt(sections, position),
    loop: loopOn,
    pendingJump,
    followEdits,
    codeView,
    audio: audioState(),
    needsGesture,
    error,
    swapCount,
    lastSwapAt,
  };
}

type Listener = (state: PlayerState) => void;
const listeners = new Set<Listener>();

/** Subscribe to state changes (play/stop, song, swap, error, loading, mix, section). Returns an unsubscribe function. */
export function onStateChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let notifyQueued = false;
/** Notify listeners (batched to one microtask) */
export function changed() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    const state = getState();
    for (const listener of listeners) {
      try {
        listener(state);
      } catch (e) {
        console.error("onStateChange listener failed", e);
      }
    }
  });
}

/**
 * Called by the UI frame loop: notices when a pending jump lands or the
 * section changes, so listeners hear about it without polling getState().
 */
let lastSectionKey = "";
export function tick() {
  if (pendingJump && audibleCycle() >= pendingJump.atCycle) {
    pendingJump = null;
    changed();
  }
  const sections = currentSections();
  if (!sections) return;
  const key = `${currentSongId}:${sectionAt(sections, songPosition())?.index}`;
  if (key !== lastSectionKey) {
    lastSectionKey = key;
    changed();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export function setError(next: PlayerError | null) {
  error = next;
  if (next) console.warn(`[strudel-ide] ${next.kind} error:`, next.message);
  changed();
}

function makeError(kind: PlayerError["kind"], err: unknown, songId: string | undefined, keptPrevious: boolean) {
  return errorFrom(kind, err, songId, keptPrevious, (located) => {
    if (error === located) changed();
    locateWaiters.get(located)?.();
  });
}

// Trigger-time errors (e.g. "sound foo not found") are caught by Strudel's
// getTrigger and only reported through its logger event.
document.addEventListener(engine.logKey ?? "strudel.log", (event) => {
  const { message } = (event as CustomEvent<{ message: string }>).detail ?? {};
  if (typeof message !== "string" || !/error/i.test(message)) return;
  // Half-typed code (typing intent) never pops the error panel
  if (playing?.quiet) return;
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

function resolveViz(viz: Song["visualization"]): VisualizationConfig {
  if (viz === undefined) return songsModule.defaultVisualization;
  return typeof viz === "string" ? { type: viz } : viz;
}

/**
 * Wrap a freshly built pattern so a query-time exception (errors that only
 * happen at certain cycles, bad values in callbacks, ...) can't kill the
 * scheduler: on the first throw, report it and permanently delegate to the
 * previous good pattern.
 */
function guard(fresh: Pattern, fallback: Pattern | null, songId: string, quiet = false): Pattern {
  const report = (err: unknown, keptPrevious: boolean) => {
    if (quiet) console.warn("[strudel-ide] query error (typing, not shown):", err);
    else setError(makeError("query", err, songId, keptPrevious));
  };
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
        queueMicrotask(() => report(err, fallback !== null));
      }
    }
    if (!fallbackQuery || fallbackFailed) return [];
    try {
      return fallbackQuery(state);
    } catch (err) {
      fallbackFailed = true;
      queueMicrotask(() => report(err, false));
      return [];
    }
  });
}

/** The current build's pattern for the current mix (no guard / time map / viz) */
function bareOf(b: Build): Pattern {
  return b.parts ? composeTracks(b.parts, mix.isAudible) : b.single!;
}

/** Build the current song. Throws what createPattern() throws. */
function buildCurrent(quiet = false): Build {
  const songId = currentSongId;
  const song = currentSong();
  const { pattern, tracks, parts } = knobRegistry.build(songId, () => songsModule.buildPattern(song));
  return {
    songId,
    song,
    parts,
    single: parts ? null : pattern,
    tracks,
    viz: resolveViz(song.visualization),
    source: currentSource(),
    quiet,
  };
}

/**
 * Hand `b` (with the current mix and time map) to the scheduler. Synchronous up
 * to setPattern, so a jump computed from the scheduler's position lands exactly.
 */
async function install(b: Build, { start = false, out }: { start?: boolean; out?: SwapOutcome } = {}): Promise<boolean> {
  if (!repl) return false;
  const scheduler = repl.scheduler;
  const bare = bareOf(b);
  const guarded = guard(bare, lastGood, b.songId, b.quiet);
  let playable: Pattern;
  try {
    playable = applyVisualization(timeMap.apply(guarded), b.viz);
  } catch (err) {
    const e = makeError("build", err, b.songId, scheduler.started);
    if (out) out.error = e;
    if (!b.quiet) setError(e);
    return false;
  }
  lastGood = bare;
  playing = b;
  activeViz = b.viz.type;
  repl.setCps(bpmToCps(b.song.bpm));
  await repl.setPattern(playable, start);
  return true;
}

/** Rebuild the outer layers (mix, time map) of what's playing: a seamless hot-swap */
function relink() {
  changed();
  if (!repl?.scheduler.started || !playing || playing.songId !== currentSongId) return;
  void install(playing);
}

/** Why a swap() failed (also when quiet), for evalSource's result */
interface SwapOutcome {
  error: PlayerError | null;
}

/**
 * Build the current song and hand it to the scheduler. While playing this is a
 * seamless hot-swap (no hush, the cycle position is kept); with `start` it
 * also starts the clock. On any build error the previous pattern keeps playing.
 */
async function swap({ start = false, quiet = false, out }: { start?: boolean; quiet?: boolean; out?: SwapOutcome } = {}): Promise<boolean> {
  if (!repl) return false;
  const scheduler = repl.scheduler;
  let next: Build;
  try {
    next = buildCurrent(quiet);
    // Preflight: query the next cycle (as the time map will) so most
    // query-time errors are caught before the pattern reaches the scheduler.
    const from = timeMap.position(scheduler.started ? scheduler.now() : 0);
    bareOf(next).queryArc(from, from + 1);
  } catch (err) {
    const e = makeError("build", err, currentSongId, scheduler.started);
    if (out) out.error = e;
    // typing intent: returned to the caller, never shown in the error panel
    if (!quiet) setError(e);
    return false;
  }
  build = next;

  if (!start && !scheduler.started) {
    // Stopped: the edit was only validated (errors show up before you press play)
    if (error?.kind !== "load") setError(null);
    else changed();
    return true;
  }

  const installed = install(next, { start, out });
  // counted synchronously with setPattern (mute/solo/jump relinks don't count)
  if (playing === next) {
    swapCount++;
    lastSwapAt = performance.now();
  }
  if (!(await installed)) return false;
  // Any earlier error is resolved by this successful swap
  setError(null);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Playback
// ─────────────────────────────────────────────────────────────────────────────

/** Start playing the current song (no-op if already playing). */
export async function play(): Promise<boolean> {
  if (!repl || !ready) {
    playWhenReady = true; // e.g. an editor command during startup
    return false;
  }
  if (repl.scheduler.started) return true;
  // a stored edit of this song is still compiling (boot): play it, not the built-in
  const pending = pendingEvals.get(currentSongId);
  if (pending) await Promise.race([pending, sleep(10_000)]);
  if (repl.scheduler.started) return true;
  requireAudio();
  // Worklet-based sounds (supersaw, shape, ladder filter…) fail on the first
  // note if playback starts before the worklets are registered. initAudio()
  // waits on resume(), which hangs without a user gesture — so cap the wait.
  await Promise.race([engine.initAudio().catch(() => {}), sleep(1500)]);
  if (repl.scheduler.started) return true;
  warmOrbits();
  resetTimeMap();
  return swap({ start: true });
}

/** Stop playback and visualization. */
export function stop() {
  playWhenReady = false;
  if (!repl) return;
  // next play starts where a loop was, otherwise from the top
  const sections = currentSections();
  startSection = loopOn ? sectionAt(sections, songPosition())?.index ?? 0 : 0;
  repl.stop();
  clearVisualization();
  pendingJump = null;
  needsGesture = false;
  resetTimeMap();
  changed();
}

export function togglePlay() {
  return repl?.scheduler.started ? stop() : play();
}

/** Make `id` the current song; hot-swaps it in if playing. Unknown ids are ignored. */
export async function selectSong(id: string): Promise<boolean> {
  if (!hasSong(id)) return false;
  bootSongId = null; // an explicit choice: a user song registered later doesn't take over
  if (id !== currentSongId) switchTo(id);
  return swap(); // hot-swap while playing; validate-only while stopped
}

function switchTo(id: string) {
  currentSongId = id;
  knobsChanged();
  writeStorage(KEYS.song, id);
  mix.load(id);
  startSection = 0;
  loopOn = false;
  pendingJump = null;
  timeMap.reset();
  changed();
}

/** Select the next (+1) or previous (-1) song in the list */
export function stepSong(direction: 1 | -1) {
  const ids = allSongs().map(({ id }) => id);
  const index = ids.indexOf(currentSongId);
  return selectSong(ids[(index + direction + ids.length) % ids.length]);
}

export function setFollowEdits(on: boolean) {
  followEdits = on;
  writeStorage(KEYS.follow, String(on));
  changed();
}

export function setCodeView(on: boolean) {
  codeView = on;
  writeStorage(KEYS.codeView, String(on));
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

export function audioRunning() {
  if (engine.getAudioContext().state === "running") {
    needsGesture = false;
    warmOrbits();
  }
  changed();
}

// ─────────────────────────────────────────────────────────────────────────────
// Mixer: mute / solo (persisted per song)
// ─────────────────────────────────────────────────────────────────────────────

/** Toggle mute or solo of a track (by name). Seamless while playing. */
export function toggleTrack(mode: "mute" | "solo", track: string) {
  mix.toggle(mode, track);
  relink();
}

export function unmuteAll() {
  mix.clear();
  relink();
}

export const muted = () => mix.mutedList();
export const soloed = () => mix.soloedList();
export const isAudible = (track: string) => mix.isAudible(track);

// ─────────────────────────────────────────────────────────────────────────────
// Sections: jump and loop
// ─────────────────────────────────────────────────────────────────────────────

/** The first bar line the scheduler hasn't queried yet: the earliest exact change point */
function nextBarLine(): number {
  const s = repl!.scheduler;
  return Math.ceil(Math.max(s.lastEnd ?? 0, s.now()) + 1e-9);
}

function resetTimeMap() {
  const sections = currentSections();
  const section = sections?.[startSection] ?? null;
  timeMap.reset(section?.start ?? 0, section && loopOn ? { start: section.start, len: section.bars } : undefined);
}

function findSection(which: number | string): SectionInfo | null {
  const sections = currentSections();
  if (!sections) return null;
  return (typeof which === "number" ? sections[which] : sections.find((s) => s.name === which)) ?? null;
}

/**
 * Jump to a section (index or name). While playing it lands on the next bar
 * line, seamlessly; while stopped it sets where play() starts.
 */
export function jumpToSection(which: number | string): boolean {
  const section = findSection(which);
  if (!section) return false;
  if (!repl?.scheduler.started) {
    startSection = section.index;
    resetTimeMap();
    changed();
    return true;
  }
  const at = nextBarLine();
  // stay in the same pass through the song (patterns outside `arrange` keep counting)
  const total = songLength(currentSections());
  const pass = Math.floor(timeMap.position(at) / total);
  const target = pass * total + section.start;
  timeMap.set(at, target, loopOn ? { start: target, len: section.bars } : undefined, audibleCycle() - 16);
  pendingJump = { index: section.index, atCycle: at };
  relink();
  return true;
}

/** Step to the previous (-1) or next (+1) section */
export function stepSection(direction: 1 | -1): boolean {
  const sections = currentSections();
  if (!sections) return false;
  const current = pendingJump?.index ?? sectionAt(sections, songPosition())?.index ?? 0;
  return jumpToSection((current + direction + sections.length) % sections.length);
}

/** Loop the section that's playing (on), or carry on through the song (off) */
export function setLoop(on: boolean): boolean {
  const sections = currentSections();
  if (!sections || on === loopOn) return false;
  loopOn = on;
  if (!repl?.scheduler.started) {
    resetTimeMap();
    changed();
    return true;
  }
  const at = nextBarLine();
  const keep = audibleCycle() - 16;
  if (on) {
    // the section you hear (or the one a pending jump is heading to)
    const heard = songPosition();
    const total = songLength(sections);
    const index = pendingJump?.index ?? sectionAt(sections, heard)!.index;
    const section = sections[index];
    const pos = timeMap.position(at);
    const start = Math.floor((pendingJump ? pos : heard) / total) * total + section.start;
    // continuous: keeps playing to the end of the section, then wraps
    timeMap.set(at, pos, { start, len: section.bars }, keep);
  } else {
    timeMap.set(at, timeMap.position(at), undefined, keep);
  }
  relink();
  return true;
}

export const toggleLoop = () => setLoop(!loopOn);

// ─────────────────────────────────────────────────────────────────────────────
// HMR (main.ts accepts ./songs/index.ts and calls this)
// ─────────────────────────────────────────────────────────────────────────────

export function songsUpdated(newModule: SongsModule | undefined) {
  if (!newModule) {
    // Vite passes undefined when re-importing failed at runtime, e.g. a song
    // file that throws at module top level (syntax errors get Vite's overlay).
    setError({
      kind: "build",
      message: "A song file failed to load (it threw while being imported). See the browser console for details.",
      keptPrevious: repl?.scheduler.started ?? false,
    });
    return;
  }
  const previous = songsModule;
  const before = currentSong();
  songsModule = newModule;
  exposeSongsIndex(newModule);

  // Only edited song modules are re-instantiated by Vite; unchanged ones come
  // back as the very same objects. That identifies which file(s) you edited.
  const edited = Object.keys(newModule.songs).filter((id) => newModule.songs[id] !== previous.songs[id]);

  // A saved file is the truth again: its evaluated buffer steps down. When the
  // file now says exactly what the buffer said, the build that is playing
  // already is this file: point it at the file instead of swapping again.
  // A user song saved as a file (src/songs/<id>.ts, a new module) steps down
  // the same way: the built-in song of that id replaces it.
  let alreadyPlaying = false;
  for (const id of edited) {
    // an eval/add of this song still compiling started before the save: it must not land on top of it
    nextSeq(id);
    const live = liveSongs.get(id) ?? userSongs.get(id);
    if (!live) continue;
    liveSongs.delete(id);
    userSongs.delete(id);
    const disk = newModule.songSources[id];
    if (id === currentSongId && build?.songId === id && build.song === live.song && disk?.version === live.source.version) {
      for (const b of new Set([build, playing])) {
        if (b?.song !== live.song) continue;
        b.song = newModule.songs[id];
        b.source = disk;
      }
      alreadyPlaying = true;
    }
  }

  if (!hasSong(currentSongId)) switchTo(initialSongId());
  else if (followEdits && edited.length && !edited.includes(currentSongId)) switchTo(edited[0]);
  changed();

  if (alreadyPlaying) return;
  if (edited.includes(currentSongId) || before !== currentSong() || previous.getSong(currentSongId) !== currentSong()) {
    void swap(); // hot-swap while playing; validate-only while stopped
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Live eval: an unsaved editor buffer, compiled by the dev server (evalLive),
// or source text compiled in the browser (evalSource, addSong)
// ─────────────────────────────────────────────────────────────────────────────

/** A compiled buffer to apply (the bridge's `live` message) */
export interface LiveBuffer {
  file: string;
  version: string;
  text: string;
  /** Module URL to import (the dev server's `…/src/songs/x.ts?live=<version>`) */
  url: string;
}

export interface EvalOutcome {
  ok: boolean;
  /** Hot-swapped into the current song (false: kept for when its song is selected) */
  applied: boolean;
  error?: { message: string; file?: string; line?: number; column?: number };
}

/** The current song's evaluated buffer, if it is playing one */
function liveOf(songId: string): { file: string; version: string } | null {
  const live = liveSongs.get(songId);
  return live?.source.live && live.source.version ? { file: live.source.file, version: live.source.version } : null;
}

/** "src/songs/jynx.ts" → "jynx" */
const songIdOf = (file: string) => file.replace(/^.*\//, "").replace(/\.ts$/, "");

/** Per song: bumped by every eval/add/revert, so a slower, older one can't land after a newer one */
const evalSeq = new Map<string, number>();
function nextSeq(songId: string): number {
  const seq = (evalSeq.get(songId) ?? 0) + 1;
  evalSeq.set(songId, seq);
  return seq;
}

/** Browser evals/adds still compiling, per song (play() waits for the current song's) */
const pendingEvals = new Map<string, Promise<unknown>>();
/** A browser eval/add of this song is still compiling (e.g. a saved edit replayed at boot) */
export function evalPending(songId: string): boolean {
  return pendingEvals.has(songId);
}

function trackPending<T>(songId: string, run: Promise<T>): Promise<T> {
  pendingEvals.set(songId, run);
  void run.finally(() => {
    if (pendingEvals.get(songId) === run) pendingEvals.delete(songId);
  });
  return run;
}

type ApplyResult = { ok: true; applied: boolean } | { ok: false; error: PlayerError | null };

/**
 * Put an evaluated song in place of its song's source and hot-swap it in:
 * select its song if follow-edits is on (or `start`), and swap. A song that
 * fails to build never replaces the last good pattern: the song keeps playing
 * what it played, and the error is reported (unless `quiet`).
 */
async function applyLiveSong(
  songId: string,
  song: Song,
  source: PlayerSource,
  { start = false, quiet = false } = {}
): Promise<ApplyResult> {
  const previous = liveSongs.get(songId);
  liveSongs.set(songId, { song, source });
  if (songId !== currentSongId) {
    if (!followEdits && !start) {
      changed();
      return { ok: true, applied: false };
    }
    switchTo(songId);
  }
  const out: SwapOutcome = { error: null };
  if (!(await swap({ quiet, out }))) {
    // never keep a broken buffer: the song stays what it was
    if (liveSongs.get(songId)?.song === song) {
      if (previous) liveSongs.set(songId, previous);
      else liveSongs.delete(songId);
    }
    changed();
    return { ok: false, error: out.error };
  }
  if (start) await play();
  return { ok: true, applied: true };
}

/**
 * Hot-swap an evaluated buffer in place of its song file: import the module,
 * select its song if follow-edits is on (or `play`), and swap. A buffer that
 * fails to load or build never replaces the last good pattern: the error is
 * reported and the song keeps playing what it played. `play` also starts
 * playback (Ctrl+Enter on a song that isn't playing).
 */
export async function evalLive(buffer: LiveBuffer, { play: start = false } = {}): Promise<EvalOutcome> {
  const songId = songIdOf(buffer.file);
  const started = !!repl?.scheduler.started;
  const fail = (err: unknown): EvalOutcome => {
    const e = makeError("build", err, songId, started);
    setError(e);
    return { ok: false, applied: false, error: { message: e.message } };
  };
  if (!isBuiltInSong(songId)) {
    return fail(new Error(`${buffer.file} is not in the player's song list yet (a new file? reload the player)`));
  }
  const seq = nextSeq(songId);
  let mod: { default?: Song; __strudel_file?: string; __strudel_version?: string };
  try {
    mod = await import(/* @vite-ignore */ buffer.url);
  } catch (err) {
    return fail(err);
  }
  // imports can finish out of order: only the newest buffer of a song counts
  if (evalSeq.get(songId) !== seq) return { ok: false, applied: false, error: { message: "superseded by a newer buffer" } };
  const song = mod.default;
  if (!song || typeof song.createPattern !== "function") {
    return fail(new Error(`${buffer.file} must \`export default\` a song with createPattern()`));
  }
  const outcome = await applyLiveSong(
    songId,
    song,
    {
      file: mod.__strudel_file ?? buffer.file,
      version: mod.__strudel_version ?? buffer.version,
      text: buffer.text,
      // a buffer that says what the file says (e.g. undone back to it) isn't "unsaved"
      live: buffer.version !== songsModule.songSources[songId]?.version,
      origin: "editor",
    },
    { start }
  );
  if (!outcome.ok) return { ok: false, applied: false, error: { message: outcome.error?.message ?? "build failed" } };
  return outcome;
}

/** A buffer that didn't compile (the dev server's error): report it, keep playing */
export function evalFailed(err: { message: string; file?: string; line?: number; column?: number }) {
  setError({
    kind: "build",
    message: err.message,
    songId: err.file ? songIdOf(err.file) : currentSongId,
    file: err.file,
    line: err.line,
    column: err.column,
    keptPrevious: !!repl?.scheduler.started,
  });
}

// ── Browser compile ──────────────────────────────────────────────────────────

export interface EvalSourceOptions {
  /** typing: errors are only returned (inline display), never set as the player error · commit: like a save */
  intent: "typing" | "commit";
  /** Who evaluated the text (reported back in currentSource().origin) */
  origin: "browser" | "editor";
}

export interface EvalSourceError {
  message: string;
  /** 1-based, in the evaluated text */
  line?: number;
  column?: number;
  /** A newer eval (or a revert) of the same song came first: this one was dropped, nothing changed */
  superseded?: true;
}

export type EvalSourceResult = { ok: true; version: string } | { ok: false; error: EvalSourceError };

type Compiler = typeof import("../compile/client");
let compilerModule: Promise<Compiler> | null = null;

/** The browser compiler (src/compile/client.ts), loaded on first use. Never at boot: it brings TypeScript. */
function loadCompiler(): Promise<Compiler> {
  return (compilerModule ??= import("../compile/client").catch((err) => {
    compilerModule = null; // retry next time (e.g. offline)
    throw err;
  }));
}

async function compileSource(text: string, file: string) {
  try {
    return await (await loadCompiler()).compileAndEvaluate(text, file);
  } catch (err) {
    return { ok: false as const, error: { message: `The compiler failed to load: ${err instanceof Error ? err.message : String(err)}` } };
  }
}

const superseded = (): EvalSourceResult => ({ ok: false, error: { message: "superseded by a newer edit", superseded: true } });

/** Wait (briefly) until errors.ts has located a runtime error in the song text */
const locateWaiters = new WeakMap<PlayerError, () => void>();
function whenLocated(e: PlayerError, ms = 500): Promise<void> {
  if (e.line !== undefined) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    locateWaiters.set(e, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function toEvalError(e: PlayerError | null): EvalSourceError {
  if (!e) return { message: "build failed" };
  const out: EvalSourceError = { message: e.message };
  if (e.line !== undefined) out.line = e.line;
  if (e.column !== undefined) out.column = e.column;
  return out;
}

function checkText(text: unknown): string | null {
  if (typeof text !== "string") return "the song text must be a string";
  if (text.length > MAX_EVAL_CHARS) return `the song is too large (${text.length} > ${MAX_EVAL_CHARS} characters)`;
  return null;
}

/**
 * Compile `text` in the browser and hot-swap it in as song `songId` (built-in
 * or user song), exactly like a live eval: seamless while playing, the last
 * good pattern kept on any error. currentSource() then returns
 * `{ file, text, version: contentVersion(text), live, origin }` (live: the text
 * differs from the song's own source) and highlights index into `text`.
 *
 * intent "typing" never sets the player error (no error panel): errors are
 * returned for inline display only, and while that build plays its later
 * query/trigger errors only go to the console. "commit" reports like a save.
 * Of several evals of one song in flight, only the newest lands.
 */
export function evalSource(songId: string, text: string, opts: EvalSourceOptions): Promise<EvalSourceResult> {
  return trackPending(songId, evalSourceNow(songId, text, opts));
}

async function evalSourceNow(songId: string, text: string, { intent, origin }: EvalSourceOptions): Promise<EvalSourceResult> {
  const quiet = intent !== "commit";
  const file = baseSource(songId)?.file ?? songFileOf(songId);
  const fail = (e: EvalSourceError): EvalSourceResult => {
    if (!quiet) {
      setError({ kind: "build", ...e, songId, file, keptPrevious: !!repl?.scheduler.started });
    }
    return { ok: false, error: e };
  };
  if (!hasSong(songId)) return fail({ message: `There is no song "${songId}" (addSong() adds new songs)` });
  const problem = checkText(text);
  if (problem) return fail({ message: problem });

  const seq = nextSeq(songId);
  const compiled = await compileSource(text, file);
  if (evalSeq.get(songId) !== seq) return superseded();
  if (!hasSong(songId)) return { ok: false, error: { message: `"${songId}" was removed` } };
  if (!compiled.ok) return fail(compiled.error);

  const version = contentVersion(text);
  const outcome = await applyLiveSong(songId, compiled.song, {
    file,
    version,
    text,
    // a text that says what the song's own source says isn't "unsaved"
    live: version !== baseSource(songId)?.version,
    origin,
  }, { quiet });
  if (outcome.ok) {
    promotePlaceholder(songId, compiled.song);
    return { ok: true, version };
  }
  // swap() already reported it (unless quiet); wait for its line in the text
  if (outcome.error) await whenLocated(outcome.error);
  return { ok: false, error: toEvalError(outcome.error) };
}

/** Drop a song's evaluated text: it plays its own source again (the file / the added text). False if it had none. */
export function revertSource(songId: string): boolean {
  nextSeq(songId); // an eval still compiling must not land afterwards
  if (!liveSongs.delete(songId)) return false;
  if (songId === currentSongId) void swap();
  changed();
  return true;
}

/** The last song played (saved id) isn't registered yet at boot: it may be a user song that addSong() brings */
let bootSongId: string | null = null;

export interface AddSongOptions {
  /**
   * A text that doesn't build (compile error, a module that throws, or a
   * createPattern() that throws when selected) still registers, as a silent
   * placeholder holding the text, so the song can be opened, fixed, shared or
   * downloaded (songProblem() says why). Never replaces a working song. The
   * result is still the error. Used for songs the user already has (the store's
   * boot replay, share links).
   */
  keepBroken?: boolean;
}

/**
 * Register a user song compiled from `text` (browser compile) under `id`, or
 * replace the one with that id. It joins the song list (picker, next/prev,
 * window.__strudel.songs()) and plays like a built-in song, as file
 * `src/songs/<id>.ts`. Built-in ids are refused: evalSource() changes those.
 */
export function addSong(id: string, text: string, opts: AddSongOptions = {}): Promise<EvalSourceResult> {
  const problem = songIdProblem(id) ?? checkText(text);
  if (problem) return Promise.resolve({ ok: false, error: { message: problem } });
  if (isBuiltInSong(id)) {
    return Promise.resolve({ ok: false, error: { message: `"${id}" is a built-in song (src/songs/${id}.ts): use evalSource() to change it` } });
  }
  return trackPending(id, addSongNow(id, text, !!opts.keepBroken));
}

async function addSongNow(id: string, text: string, keepBroken: boolean): Promise<EvalSourceResult> {
  const file = songFileOf(id);
  const seq = nextSeq(id);
  const compiled = await compileSource(text, file);
  if (evalSeq.get(id) !== seq) return superseded();
  const version = contentVersion(text);
  const source: PlayerSource = { file, version, text, live: false, origin: "browser" };
  const previous = userSongs.get(id);
  // only a missing song or another placeholder makes way for a placeholder
  const holdBroken = keepBroken && (!previous || !!previous.problem);
  if (!compiled.ok) {
    if (holdBroken && !isBuiltInSong(id)) await registerUserSong(id, placeholderOf(id, source, compiled.error));
    return { ok: false, error: compiled.error };
  }
  if (isBuiltInSong(id)) return { ok: false, error: { message: `"${id}" became a built-in song meanwhile` } };
  const previousLive = liveSongs.get(id);
  const out: SwapOutcome = { error: null };
  if (!(await registerUserSong(id, { song: compiled.song, source }, out))) {
    // replacing the song that is selected: it must build, or the old one stays
    const placeholder = holdBroken ? placeholderOf(id, source, toEvalError(out.error)) : null;
    if (userSongs.get(id)?.song === compiled.song) {
      if (placeholder) await registerUserSong(id, placeholder);
      else if (previous) userSongs.set(id, previous);
      else userSongs.delete(id);
      if (previousLive && !placeholder) liveSongs.set(id, previousLive);
    }
    changed();
    if (out.error) await whenLocated(out.error);
    const error = toEvalError(out.error);
    if (placeholder && userSongs.get(id) === placeholder) {
      placeholder.problem = error; // now with its line in the text
      changed();
    }
    return { ok: false, error };
  }
  return { ok: true, version };
}

/** Put `entry` in the song list as `id` (selecting it if it was the last song played) and swap it in if it is selected. False: that swap failed. */
async function registerUserSong(id: string, entry: LiveSong, out?: SwapOutcome): Promise<boolean> {
  userSongs.set(id, entry);
  liveSongs.delete(id);
  if (bootSongId === id && !repl?.scheduler.started) {
    bootSongId = null;
    switchTo(id);
  }
  changed();
  return id !== currentSongId || swap({ out });
}

const NAME_RE = /\bname\s*:\s*"([^"\\\n]*)"/;

/** A user song that didn't build: plays silence, keeps its text as its source (see AddSongOptions.keepBroken) */
function placeholderOf(id: string, source: PlayerSource, problem: EvalSourceError): LiveSong {
  const name = NAME_RE.exec(source.text ?? "")?.[1] || id;
  return { song: { name, createPattern: () => engine.silence }, source, problem };
}

/** Why a user song is a "didn't build" placeholder (null: it built, or isn't a user song) */
export function songProblem(id: string): EvalSourceError | null {
  return userSongs.get(id)?.problem ?? null;
}

/** An evaluated text of a placeholder built: it becomes the song itself (its own source, no longer "unsaved") */
function promotePlaceholder(id: string, song: Song) {
  const live = liveSongs.get(id);
  if (!userSongs.get(id)?.problem || live?.song !== song) return;
  const source: PlayerSource = { ...live.source, live: false };
  userSongs.set(id, { song, source });
  liveSongs.delete(id);
  for (const b of new Set([build, playing])) if (b?.song === song) b.source = source;
  changed();
}

/** Unregister a user song (built-in songs can't be removed). The current song moves on if it was this one. */
export function removeSong(id: string): boolean {
  if (!userSongs.has(id)) {
    // not listed yet, but maybe still compiling (boot): cancel that
    if (!pendingEvals.has(id) || isBuiltInSong(id)) return false;
    nextSeq(id);
    return true;
  }
  nextSeq(id);
  userSongs.delete(id);
  liveSongs.delete(id);
  if (id === currentSongId) {
    switchTo(initialSongId());
    void swap();
  }
  changed();
  return true;
}

export function initialSongId(): string {
  const saved = readStorage(KEYS.song);
  if (saved && hasSong(saved)) return saved;
  if ("untitled" in songsModule.songs) return "untitled";
  return allSongs()[0]?.id ?? "untitled";
}

/** Pick the initial song and validate it (so the mixer knows its tracks before play) */
export function initSong() {
  currentSongId = initialSongId();
  // the last song played was a user song: it is selected once addSong() registers it
  const saved = readStorage(KEYS.song);
  bootSongId = saved && saved !== currentSongId ? saved : null;
  knobsChanged();
  mix.load(currentSongId);
}

export function validateCurrent() {
  return swap();
}

// ─────────────────────────────────────────────────────────────────────────────
// Knobs: live values for the current song's knob() calls (see knobs.ts)
// ─────────────────────────────────────────────────────────────────────────────
//
// Turning a knob changes what its pattern returns at the next query: no
// rebuild, no hot-swap (swapCount stays put). Writing it to the file is an
// ordinary edit: the HMR swap brings a default equal to the live value.

export type { KnobInfo };

/** The current song's knobs, in declaration order */
export function knobs(): KnobInfo[] {
  return knobRegistry.list(currentSongId);
}

/** Set a knob's live value (clamped to its range, snapped to its step). Returns the value set, or null. */
export function setKnob(name: string, value: number): number | null {
  return knobRegistry.set(currentSongId, name, value);
}

/** Back to the value written in the file */
export function resetKnob(name: string): number | null {
  const knob = knobRegistry.get(currentSongId, name);
  return knob ? setKnob(name, knob.def) : null;
}

/** The user holds a knob (mid-drag): a file edit meanwhile doesn't reset it */
export function grabKnob(name: string, on: boolean) {
  knobRegistry.grab(currentSongId, name, on);
}

type KnobsListener = (knobs: KnobInfo[], songId: string) => void;
const knobListeners = new Set<KnobsListener>();

/** Subscribe to the current song's knobs (values, defaults, list), batched per frame. Returns an unsubscribe function. */
export function onKnobsChange(listener: KnobsListener): () => void {
  knobListeners.add(listener);
  return () => knobListeners.delete(listener);
}

let knobsQueued = false;
function knobsChanged() {
  if (knobsQueued) return;
  knobsQueued = true;
  const flush = () => {
    if (!knobsQueued) return;
    knobsQueued = false;
    const list = knobs();
    for (const listener of knobListeners) {
      try {
        listener(list, currentSongId);
      } catch (e) {
        console.error("onKnobsChange listener failed", e);
      }
    }
  };
  // next frame while visible (drags), or a timer when the tab is hidden
  requestAnimationFrame(flush);
  setTimeout(flush, 50);
}

export interface KnobWriteResult {
  ok: boolean;
  error?: string;
  /** What was written: the literal now in the file, per knob */
  changes?: { name: string; literal: string; line: number }[];
}

/**
 * Write knobs' live values into the song file as their new defaults (every
 * dirty knob of the current song when `names` is omitted), in one edit. The
 * dev server rewrites the literals (vite-plugins/strudel-knobs.ts); the HMR
 * update then hot-swaps seamlessly and the knobs are no longer dirty.
 */
export async function writeKnobs(names?: string[]): Promise<KnobWriteResult> {
  const source = currentSource();
  const file = source?.file;
  if (!file) return { ok: false, error: "no song file" };
  if (userSongs.has(currentSongId)) {
    return { ok: false, error: `${file} isn't a file yet (a song made in the browser): save it to a file first` };
  }
  if (source.live && source.origin === "browser") {
    // the dev server only knows about editor buffers (its 409); this text only exists in the page
    return { ok: false, error: `${file} plays unsaved edits made in the browser: save them first, then write the knob` };
  }
  const list = knobs().filter((k) => (names ? names.includes(k.name) : k.dirty));
  if (!list.length) return { ok: true, changes: [] };
  try {
    const res = await fetch("/__strudel/knob", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file, knobs: list.map((k) => ({ name: k.name, value: k.value })) }),
    });
    const body = (await res.json().catch(() => null)) as KnobWriteResult | null;
    if (!res.ok || !body?.ok) return { ok: false, error: body?.error ?? `HTTP ${res.status}` };
    return body;
  } catch (err) {
    return { ok: false, error: `writing needs the dev server (${err instanceof Error ? err.message : String(err)})` };
  }
}
