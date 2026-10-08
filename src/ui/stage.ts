// ═══════════════════════════════════════════════════════════════════════════
// Stage: wires the page (top bar, code view, mixer, timeline, help) to the
// player, and runs the one animation-frame loop that drives everything that
// moves (bar counter, playhead, LEDs, code highlights).
// ═══════════════════════════════════════════════════════════════════════════

import * as player from "../engine/player";
import { trackColor } from "../engine/tracks";
import { engine } from "../engine/strudel";
import type { Live } from "../engine/live";
import type { PlayerError, PlayerState } from "../engine/types";
import { contentVersion } from "../live/protocol";
import { CodeView } from "./code-view";
import { Mixer } from "./mixer";
import { Timeline } from "./timeline";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface Stage {
  attachLive(live: Live): void;
  setEditorConnected(connected: boolean): void;
  toggleCodeView(): void;
  /** Ranges lit in the code view now */
  highlights(): [number, number][];
}

export function mountStage(): Stage {
  const stage = $("stage");
  const playBtn = $<HTMLButtonElement>("play");
  const playLabel = playBtn.querySelector(".transport-label")!;
  const songSelect = $<HTMLSelectElement>("song-select");
  const followToggle = $<HTMLInputElement>("follow-edits");
  const loadingEl = $("loading");
  const loadingText = loadingEl.querySelector(".loading-text")!;
  const audioHint = $("audio-hint");
  const bpmEl = $("bpm");
  const barEl = $("bar");
  const beatEl = $("beat");
  const linkEl = $("editor-link");
  const codeFile = $("code-file");
  const codeStale = $("code-stale");
  const help = $("help-overlay");

  const codeView = new CodeView({
    scroller: $("code-scroll"),
    content: $("code-content"),
    lines: $("code-lines"),
    overlay: $("code-highlights"),
    followChip: $("follow-chip"),
  });

  const mixer = new Mixer($("strips"), $("mixer-empty"), $<HTMLButtonElement>("unmute-all"), {
    toggleTrack: player.toggleTrack,
    unmuteAll: player.unmuteAll,
  });

  const timeline = new Timeline(
    {
      segments: $("tl-segments"),
      track: $("tl-track"),
      playhead: $("tl-playhead"),
      section: $("tl-section"),
      sub: $("tl-sub"),
      loop: $<HTMLButtonElement>("loop-toggle"),
    },
    { jumpToSection: (i) => player.jumpToSection(i), toggleLoop: () => player.toggleLoop() }
  );

  // ── colours: which track plays a code range (learned from onsets) ─────────
  const rangeTrack = new Map<number, string>();
  let trackIndex = new Map<string, number>();
  const colorOfTrack = (track: string | undefined) => {
    const i = track === undefined ? undefined : trackIndex.get(track);
    return i === undefined ? undefined : trackColor(i);
  };
  codeView.setColorResolver((start, end) => colorOfTrack(rangeTrack.get(start * 2 ** 22 + end)));

  // ── state → DOM ───────────────────────────────────────────────────────────
  let shownSongId = "";
  let shownSource: { text?: string; version?: string } | null = null;
  let lastError: PlayerError | null = null;
  let lastState: PlayerState | null = null;

  function render(state: PlayerState) {
    lastState = state;
    playBtn.disabled = !state.ready;
    playBtn.classList.toggle("playing", state.playing);
    playLabel.textContent = !state.ready ? "Loading…" : state.playing ? "Stop" : "Play";
    playBtn.setAttribute("aria-label", state.playing ? "Stop" : "Play");

    if (songSelect.options.length !== player.allSongs().length) renderSongSelector();
    if (songSelect.value !== state.songId) songSelect.value = state.songId;
    followToggle.checked = state.followEdits;

    loadingEl.hidden = state.loading === null;
    loadingText.textContent = state.loading ?? "";
    audioHint.hidden = !(state.needsGesture && state.audio !== "running");
    bpmEl.textContent = String(Math.round(state.bpm));

    stage.dataset.code = state.codeView ? "on" : "off";
    codeView.setEnabled(state.codeView);

    // the code: the current song's on-disk text
    const source = player.currentSource();
    if (source?.text !== undefined && (state.songId !== shownSongId || source.text !== shownSource?.text)) {
      if (source.version && contentVersion(source.text) !== source.version) {
        console.warn(`[code-view] ${source.file}: text does not match the version the highlights refer to`);
      }
      shownSongId = state.songId;
      shownSource = source;
      codeView.setSource(source.text, source.version);
      codeFile.textContent = source.file;
      rangeTrack.clear();
    }
    const playing = player.playingSource();
    codeStale.hidden = !(state.playing && playing && source && playing.version !== source.version);

    trackIndex = new Map((state.tracks ?? []).map((t, i) => [t, i]));
    mixer.render(state);
    timeline.render(state);
    renderError(state.error);
  }

  function renderSongSelector() {
    songSelect.replaceChildren(
      ...player.allSongs().map(({ id, song }) => {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = song.name;
        return option;
      })
    );
    songSelect.value = player.currentSongId_();
  }

  // ── error panel ───────────────────────────────────────────────────────────
  const errorPanel = $("error-panel");
  const errorTitle = $("error-title");
  const errorMessage = $("error-message");
  const errorLocation = $<HTMLButtonElement>("error-location");
  const errorNote = $("error-note");

  function renderError(err: PlayerError | null) {
    errorPanel.hidden = err === null;
    const inThisFile = err?.file && player.currentSource()?.file.endsWith(err.file);
    codeView.setErrorLine(err && inThisFile && err.line ? err.line : null);
    if (err && err !== lastError && inThisFile && err.line) codeView.revealLine(err.line);
    lastError = err;
    if (!err) return;
    errorPanel.dataset.kind = err.kind;
    const song = err.songId ? player.songsRecord()[err.songId]?.name ?? err.songId : null;
    errorTitle.textContent =
      {
        build: "Song failed to build",
        query: "Pattern crashed while playing",
        trigger: "Sound error",
        load: "Loading problem",
      }[err.kind] + (song ? ` in ${song}` : "");
    errorMessage.textContent = err.message;
    errorLocation.textContent = err.file
      ? `${err.file}${err.line ? `:${err.line}` : ""}${err.column ? `:${err.column}` : ""}`
      : "";
    errorLocation.hidden = !err.file;
    errorNote.textContent = err.keptPrevious
      ? "Still playing the last good version. Fix it and save to hot-swap."
      : err.kind === "trigger"
        ? "Playback continues; the failing sound is skipped."
        : "";
    errorNote.hidden = !errorNote.textContent;
  }

  errorLocation.addEventListener("click", () => {
    if (lastError?.line) {
      codeView.revealLine(lastError.line);
      codeView.setFollowing(false);
    }
  });
  $("error-dismiss").addEventListener("click", () => player.setError(null));

  // ── controls ──────────────────────────────────────────────────────────────
  renderSongSelector();
  songSelect.addEventListener("change", () => {
    void player.selectSong(songSelect.value);
    songSelect.blur(); // give the keyboard back to the shortcuts
  });
  playBtn.addEventListener("click", () => void player.togglePlay());
  followToggle.addEventListener("change", () => player.setFollowEdits(followToggle.checked));
  audioHint.addEventListener("click", () => void engine.getAudioContext().resume());

  const showHelp = (on: boolean) => {
    help.hidden = !on;
    if (on) $("help-close").focus();
  };
  $("help-button").addEventListener("click", () => showHelp(help.hidden));
  $("help-close").addEventListener("click", () => showHelp(false));
  help.addEventListener("click", (e) => {
    if (e.target === help) showHelp(false);
  });

  const toggleCodeView = () => player.setCodeView(!player.getState().codeView);

  // ── keyboard ──────────────────────────────────────────────────────────────
  const isFormControl = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !help.hidden) {
      showHelp(false);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || isFormControl(e.target)) return;
    const digit = /^Digit([0-9])$/.exec(e.code)?.[1];
    if (e.code === "Space") {
      e.preventDefault();
      if (player.getState().ready) void player.togglePlay();
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      void player.stepSong(e.key === "ArrowRight" ? 1 : -1);
    } else if (digit === "0") {
      player.unmuteAll();
    } else if (digit) {
      const track = player.getState().tracks?.[Number(digit) - 1];
      if (track) player.toggleTrack(e.shiftKey ? "solo" : "mute", track);
    } else if (e.key === "?") {
      showHelp(help.hidden);
    } else if (e.key === "c" || e.key === "C") {
      toggleCodeView();
    } else if (e.key === "l" || e.key === "L") {
      player.toggleLoop();
    } else if (e.key === "f" || e.key === "F") {
      codeView.setFollowing(true);
    } else if (e.key === "[" || e.key === "]") {
      player.stepSection(e.key === "]" ? 1 : -1);
    } else {
      return;
    }
  });

  player.onStateChange(render);
  render(player.getState());

  // ── the frame loop ────────────────────────────────────────────────────────
  let live: Live | null = null;
  let lastBar = "";
  let lastBeat = "";

  const onHap = (hap: { context: { track?: string; locations?: { start: number; end: number }[] } }) => {
    const track = hap.context.track;
    if (track !== undefined) mixer.hit(track);
    const locs = hap.context.locations;
    if (!locs?.length) return;
    const color = colorOfTrack(track) ?? "";
    for (const loc of locs) {
      if (track !== undefined) rangeTrack.set(loc.start * 2 ** 22 + loc.end, track);
      codeView.flash(loc.start, loc.end, color);
    }
  };

  function frame(now: number) {
    requestAnimationFrame(frame);
    player.tick();
    const state = lastState;
    const position = player.songPosition();
    const sections = state?.sections ?? null;
    const { bar, beat } = player.barBeat(position, sections);
    const barText = String(bar);
    const beatText = String(beat);
    if (barText !== lastBar) barEl.textContent = lastBar = barText;
    if (beatText !== lastBeat) beatEl.textContent = lastBeat = beatText;
    timeline.frame(position, state?.section ?? null, bar, beat);

    if (live && state?.playing) {
      const sourceOk = sameSource();
      live.pollOnsets((hap) => {
        if (!sourceOk) {
          if (hap.context.track !== undefined) mixer.hit(hap.context.track);
          return;
        }
        onHap(hap);
      });
    }
    mixer.frame();
    codeView.frame(now);
  }
  requestAnimationFrame(frame);

  /** Highlights only make sense when the code shown is the code playing */
  function sameSource() {
    const playing = player.playingSource();
    const shown = player.currentSource();
    return !!playing && !!shown && playing.file === shown.file && playing.version === shown.version;
  }

  return {
    attachLive(l) {
      live = l;
      l.onRanges((ranges) => codeView.setRanges(sameSource() ? ranges : []));
    },
    setEditorConnected(connected) {
      linkEl.dataset.connected = String(connected);
      linkEl.title = connected
        ? "Linked to the dev-server bridge: the VS Code extension can drive the player and show highlights"
        : "Not linked to the dev-server bridge (VS Code commands and highlights are offline)";
    },
    toggleCodeView,
    highlights: () => codeView.litRanges(),
  };
}
