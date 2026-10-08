// ═══════════════════════════════════════════════════════════════════════════
// 🎛️ STRUDEL IDE PLAYER — startup
// ═══════════════════════════════════════════════════════════════════════════
//
// Live-coding stage: songs are edited in your editor and hot-swapped into the
// running scheduler (src/engine/player.ts); the page shows the song's code with
// the sounding tokens lit, a mixer, and a section timeline (src/ui/).
//
//   src/engine/   player state, hot-swap, mute/solo, jumps/loops, live signals
//   src/ui/       stage layout, code view, mixer, timeline, visualization
//   src/live/     editor bridge + highlight ranges (shared with VS Code)
//
// This is the only module that imports ./songs at runtime: it accepts the HMR
// update and hands the new module to the player, so saving a song never
// reloads the page.
//
// Public surface (for tests, devtools and editor bridges): window.__strudel
//
// ═══════════════════════════════════════════════════════════════════════════

import { linkEditor } from "./live/editor-link";
import * as player from "./engine/player";
import { startLive } from "./engine/live";
import { engine, loadSamples, type Repl, type Scheduler } from "./engine/strudel";
import { mountStage } from "./ui/stage";

export type { PlayerState, PlayerError } from "./engine/types";

type SongsModule = typeof import("./songs");

player.setSongsModule(await import("./songs"));
player.initSong();

const stage = mountStage();

// ─────────────────────────────────────────────────────────────────────────────
// HMR - song edits hot-swap into the running scheduler
// ─────────────────────────────────────────────────────────────────────────────

if (import.meta.hot) {
  import.meta.hot.accept("./songs/index.ts", (mod) => {
    player.songsUpdated(mod as unknown as SongsModule | undefined);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup: audio engine + samples (in parallel)
// ─────────────────────────────────────────────────────────────────────────────

const repl = await engine.initStrudel({ onToggle: () => player.changed() });
player.attachRepl(repl);

// Debug hook (tests, devtools, editor bridges); usable while samples load
// (play() requests are queued until ready). Typed at the end of this file.
window.__strudel = {
  repl,
  scheduler: repl.scheduler,
  getState: player.getState,
  onStateChange: player.onStateChange,
  play: player.play,
  stop: player.stop,
  togglePlay: player.togglePlay,
  selectSong: player.selectSong,
  stepSong: player.stepSong,
  songs: player.songsRecord,
  setFollowEdits: player.setFollowEdits,
  toggleTrack: player.toggleTrack,
  unmuteAll: player.unmuteAll,
  muted: player.muted,
  soloed: player.soloed,
  jumpToSection: player.jumpToSection,
  setLoop: player.setLoop,
  positionAt: player.positionAt,
  knobs: player.knobs,
  setKnob: player.setKnob,
  resetKnob: player.resetKnob,
  grabKnob: player.grabKnob,
  writeKnobs: player.writeKnobs,
  onKnobsChange: player.onKnobsChange,
  toggleCodeView: stage.toggleCodeView,
  highlights: stage.highlights,
};

// VS Code extension link (dev only; no-op without the bridge)
const bridge = linkEditor(
  {
    getState: player.getState,
    onStateChange: player.onStateChange,
    play: player.play,
    stop: player.stop,
    togglePlay: player.togglePlay,
    selectSong: player.selectSong,
    stepSong: player.stepSong,
    songs: () => player.allSongs().map(({ id, song }) => ({ id, name: song.name })),
    toggleTrack: player.toggleTrack,
    unmuteAll: player.unmuteAll,
    muted: player.muted,
    soloed: player.soloed,
  },
  { onConnectionChange: stage.setEditorConnected }
);

// Live highlights → editor + code view. Created after initStrudel() (it swaps
// in location-free string parsing so only song literals carry offsets) and
// before the first build, so no pattern is built with implicit locations.
stage.attachLive(startLive(repl, bridge));

// Build the current song once so the mixer and timeline know it before play
void player.validateCurrent();

player.setLoading("Loading samples…");

engine.getAudioContext().addEventListener("statechange", () => player.audioRunning());

const failedLoads = await loadSamples((loaded, total) => player.setLoading(`Loading samples ${loaded}/${total}…`));
if (failedLoads.length) {
  player.setError({
    kind: "load",
    message: `Could not load sample maps: ${failedLoads.join(", ")}. Synths still work.`,
    keptPrevious: false,
  });
}
player.setReady();

// ─────────────────────────────────────────────────────────────────────────────
// Debug hook (tests, devtools, editor bridges)
// ─────────────────────────────────────────────────────────────────────────────

declare global {
  interface Window {
    __strudel?: {
      repl: Repl;
      scheduler: Scheduler;
      getState: typeof player.getState;
      onStateChange: typeof player.onStateChange;
      play: typeof player.play;
      stop: typeof player.stop;
      togglePlay: typeof player.togglePlay;
      selectSong: typeof player.selectSong;
      stepSong: typeof player.stepSong;
      songs: () => SongsModule["songs"];
      setFollowEdits: typeof player.setFollowEdits;
      toggleTrack: typeof player.toggleTrack;
      unmuteAll: typeof player.unmuteAll;
      muted: typeof player.muted;
      soloed: typeof player.soloed;
      jumpToSection: typeof player.jumpToSection;
      setLoop: typeof player.setLoop;
      positionAt: typeof player.positionAt;
      /** The current song's knob() controls (live value, file default, range, dirty) */
      knobs: typeof player.knobs;
      /** Turn a knob (no rebuild, no swap) */
      setKnob: typeof player.setKnob;
      resetKnob: typeof player.resetKnob;
      /** Hold a knob (an editor-side drag): file edits don't reset it meanwhile */
      grabKnob: typeof player.grabKnob;
      /** Write live values into the song file (dev server); all dirty knobs by default */
      writeKnobs: typeof player.writeKnobs;
      onKnobsChange: typeof player.onKnobsChange;
      toggleCodeView: () => void;
      highlights: () => [number, number][];
    };
  }
}

console.log("🎵 Strudel IDE ready!");
