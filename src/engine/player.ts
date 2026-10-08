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

import { Mix } from "./mix";
import { errorFrom } from "./errors";
import { composeTracks } from "./tracks";
import { TimeMap, normalizeSections, sectionAt, songLength } from "./timemap";
import { KEYS, readJson, readStorage, writeJson, writeStorage } from "./storage";
import { KnobRegistry, installKnobGlobals, type KnobInfo, type SavedKnobs } from "./knobs";
import { bpmToCps, engine, internals, warmOrbits, type Repl } from "./strudel";
import { applyVisualization, clearVisualization } from "../ui/viz";
import { audioOutputLatency } from "../live/highlights";
import type { PlayerError, PlayerState, SectionInfo } from "./types";
import type { Song, SongSource, VisualizationConfig, VisualizationType } from "../songs";

type SongsModule = typeof import("../songs");

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
  source: SongSource | null;
}
let build: Build | null = null;
/** The build that is in the scheduler now */
let playing: Build | null = null;

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
  return songsModule.getSong(currentSongId);
}

export function currentSongId_(): string {
  return currentSongId;
}

export function allSongs(): { id: string; song: Song }[] {
  return songsModule.getAllSongs();
}

export function songsRecord(): Record<string, Song> {
  return songsModule.songs;
}

/** File, version and on-disk text of the current song (what the code view shows) */
export function currentSource(): SongSource | null {
  return songsModule.songSources[currentSongId] ?? null;
}

/** File/version the scheduler's pattern was built from (highlight offsets refer to it) */
export function playingSource(): SongSource | null {
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
  });
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
        queueMicrotask(() => setError(makeError("query", err, songId, fallback !== null)));
      }
    }
    if (!fallbackQuery || fallbackFailed) return [];
    try {
      return fallbackQuery(state);
    } catch (err) {
      fallbackFailed = true;
      queueMicrotask(() => setError(makeError("query", err, songId, false)));
      return [];
    }
  });
}

/** The current build's pattern for the current mix (no guard / time map / viz) */
function bareOf(b: Build): Pattern {
  return b.parts ? composeTracks(b.parts, mix.isAudible) : b.single!;
}

/** Build the current song. Throws what createPattern() throws. */
function buildCurrent(): Build {
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
    source: songsModule.songSources[songId] ?? null,
  };
}

/**
 * Hand `b` (with the current mix and time map) to the scheduler. Synchronous up
 * to setPattern, so a jump computed from the scheduler's position lands exactly.
 */
async function install(b: Build, { start = false } = {}): Promise<boolean> {
  if (!repl) return false;
  const scheduler = repl.scheduler;
  const bare = bareOf(b);
  const guarded = guard(bare, lastGood, b.songId);
  let playable: Pattern;
  try {
    playable = applyVisualization(timeMap.apply(guarded), b.viz);
  } catch (err) {
    setError(makeError("build", err, b.songId, scheduler.started));
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

/**
 * Build the current song and hand it to the scheduler. While playing this is a
 * seamless hot-swap (no hush, the cycle position is kept); with `start` it
 * also starts the clock. On any build error the previous pattern keeps playing.
 */
async function swap({ start = false } = {}): Promise<boolean> {
  if (!repl) return false;
  const scheduler = repl.scheduler;
  let next: Build;
  try {
    next = buildCurrent();
    // Preflight: query the next cycle (as the time map will) so most
    // query-time errors are caught before the pattern reaches the scheduler.
    const from = timeMap.position(scheduler.started ? scheduler.now() : 0);
    bareOf(next).queryArc(from, from + 1);
  } catch (err) {
    setError(makeError("build", err, currentSongId, scheduler.started));
    return false;
  }
  build = next;

  if (!start && !scheduler.started) {
    // Stopped: the edit was only validated (errors show up before you press play)
    if (error?.kind !== "load") setError(null);
    else changed();
    return true;
  }

  const installed = install(next, { start });
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
  if (!(id in songsModule.songs)) return false;
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
  const ids = songsModule.getAllSongs().map(({ id }) => id);
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
  songsModule = newModule;

  // Only edited song modules are re-instantiated by Vite; unchanged ones come
  // back as the very same objects. That identifies which file(s) you edited.
  const edited = Object.keys(newModule.songs).filter((id) => newModule.songs[id] !== previous.songs[id]);

  if (!(currentSongId in newModule.songs)) switchTo(initialSongId());
  else if (followEdits && edited.length && !edited.includes(currentSongId)) switchTo(edited[0]);
  changed();

  if (edited.includes(currentSongId) || previous.getSong(currentSongId) !== currentSong()) {
    void swap(); // hot-swap while playing; validate-only while stopped
  }
}

export function initialSongId(): string {
  const saved = readStorage(KEYS.song);
  if (saved && saved in songsModule.songs) return saved;
  if ("untitled" in songsModule.songs) return "untitled";
  return songsModule.getAllSongs()[0]?.id ?? "untitled";
}

/** Pick the initial song and validate it (so the mixer knows its tracks before play) */
export function initSong() {
  currentSongId = initialSongId();
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
  const file = currentSource()?.file;
  if (!file) return { ok: false, error: "no song file" };
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
