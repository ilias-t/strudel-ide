// ═══════════════════════════════════════════════════════════════════════════
// Stage: wires the page (top bar, code view, mixer, timeline, help) to the
// player, and runs the one animation-frame loop that drives everything that
// moves (bar counter, playhead, LEDs, code highlights).
// ═══════════════════════════════════════════════════════════════════════════

import * as player from "../engine/player";
import { trackColor, trackRole, type TrackRole } from "../engine/tracks";
import { engine } from "../engine/strudel";
import type { Live } from "../engine/live";
import type { PlayerError, PlayerState } from "../engine/types";
import { contentVersion } from "../live/protocol";
import { songFile, songIdForFile, type EditorLinkStatus, type RevealResult } from "../live/editor-link";
import { CodeView } from "./code-view";
import { Mixer } from "./mixer";
import { KnobPanel } from "./knobs";
import { formatKnob, knobTextWidth, type KnobInfo } from "../engine/knobs";
import { Timeline } from "./timeline";
import { SegmentDisplay } from "./segments";
import { Room } from "./room";

/** Legend names for the pianoroll's colour families (drums share shades of ember) */
const LEGEND: Record<TrackRole, string | null> = {
  kick: "drums",
  snare: "drums",
  hats: "drums",
  perc: "drums",
  bass: "bass",
  pads: "pads",
  arp: "arp",
  lead: "lead",
  acid: "acid",
  fx: "fx",
  other: null,
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface Stage {
  attachLive(live: Live): void;
  /** The "VS Code" LED: no bridge / bridge without an editor / editor attached */
  setEditorLink(status: EditorLinkStatus): void;
  /** How clicks on the code (and the error location) open the editor */
  setRevealer(reveal: (file: string, line: number, column?: number) => RevealResult): void;
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
  const linkLabel = linkEl.querySelector(".link-label")!;
  const codeFile = $("code-file");
  const codeStale = $("code-stale");
  const codeUnsaved = $("code-unsaved");
  const help = $("help-overlay");
  const cueEl = $("cue");
  const songNo = $("song-no");
  const bpmDigits = new SegmentDisplay($("bpm-digits"), 3);
  const barDigits = new SegmentDisplay($("bar-digits"), 4);
  const beatLeds = [...$("beat-leds").children] as HTMLElement[];
  const viewEl = $("view");
  const viewName = $("view-name");
  const viewLegend = $("view-legend");
  const room = new Room(stage);
  const codeSwap = $("code-swap");
  const codeSwapText = $("code-swap-text");

  let reveal: (file: string, line: number, column?: number) => RevealResult = () => "none";
  const codeView = new CodeView({
    scroller: $("code-scroll"),
    content: $("code-content"),
    lines: $("code-lines"),
    overlay: $("code-highlights"),
    followChip: $("follow-chip"),
    onKnobChip: (name) => knobPanel.focus(name),
    // click a token or line → open it in the editor
    onPick: ({ line, column }) => {
      const file = player.currentSource()?.file;
      if (file) reveal(file, line, column);
    },
  });

  const knobPanel = new KnobPanel(
    { root: $("knobs"), grid: $("knob-grid"), writeAll: $<HTMLButtonElement>("knobs-write-all"), status: $("knobs-status") },
    {
      setKnob: player.setKnob,
      resetKnob: player.resetKnob,
      grabKnob: player.grabKnob,
      writeKnobs: player.writeKnobs,
    },
    // write-back is a dev-server endpoint
    { canWrite: import.meta.env.DEV }
  );

  /** Live values → knob panel + the chips next to each knob( call in the code */
  let shownKnobs: KnobInfo[] = [];
  function renderKnobs(list: KnobInfo[] = shownKnobs) {
    shownKnobs = list;
    knobPanel.render(list, player.currentSongId_());
    const byName = new Map(list.map((k) => [k.name, k]));
    for (const [name, chips] of codeView.knobChips()) {
      const knob = byName.get(name);
      const text = knob ? formatKnob(knob, knob.value) : "";
      for (const chip of chips) {
        if (chip.dataset.value !== text) chip.dataset.value = text;
        const dirty = String(!!knob?.dirty);
        if (chip.dataset.dirty !== dirty) chip.dataset.dirty = dirty;
        if (knob && !chip.style.minWidth) {
          const widest = knobTextWidth(knob);
          chip.style.minWidth = `calc(${widest + 2}ch + 14px)`;
        }
      }
    }
  }
  player.onKnobsChange((list) => renderKnobs(list));

  const mixer = new Mixer(
    $("strips"),
    $("mixer-empty"),
    $<HTMLButtonElement>("unmute-all"),
    { toggleTrack: player.toggleTrack, unmuteAll: player.unmuteAll },
    $("track-count")
  );

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
    return i === undefined ? undefined : trackColor(track!, i);
  };
  codeView.setColorResolver((start, end) => colorOfTrack(rangeTrack.get(start * 2 ** 22 + end)));

  // ── state → DOM ───────────────────────────────────────────────────────────
  let shownSongId = "";
  let shownSource: { text?: string; version?: string } | null = null;
  let lastError: PlayerError | null = null;
  let lastRevealed = "";
  let pausedForError = false;
  let lastState: PlayerState | null = null;
  let shownSwaps = -1;
  let swappedAt = 0;
  let prevPlaying = false;
  let prevSong = "";

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
    bpmDigits.set(String(Math.round(state.bpm)));
    const songIndex = player.allSongs().findIndex(({ id }) => id === state.songId);
    songNo.textContent = songIndex < 0 ? "" : String(songIndex + 1).padStart(2, "0");

    stage.dataset.code = state.codeView ? "on" : "off";
    room.setLook(player.songsRecord()[state.songId]?.room ?? "dusk");
    room.setPlaying(state.playing);
    codeView.setEnabled(state.codeView);

    // the code: the current song's text (on disk, or an evaluated editor buffer)
    const source = player.currentSource();
    if (source?.text !== undefined && (state.songId !== shownSongId || source.text !== shownSource?.text)) {
      if (source.version && contentVersion(source.text) !== source.version) {
        console.warn(`[code-view] ${source.file}: text does not match the version the highlights refer to`);
      }
      const otherFile = state.songId !== shownSongId;
      shownSongId = state.songId;
      shownSource = source;
      codeView.setSource(source.text, source.version, otherFile);
      codeFile.textContent = source.file;
      rangeTrack.clear();
      renderKnobs(player.knobs()); // new chips
    }
    codeUnsaved.hidden = !source?.live;
    const playing = player.playingSource();
    codeStale.hidden = !(state.playing && playing && source && playing.version !== source.version);

    // an edit landing in the song that was already playing (not play, not a song change)
    if (state.swapCount !== shownSwaps) {
      if (shownSwaps >= 0 && prevPlaying && prevSong === state.songId) swappedAt = performance.now();
      shownSwaps = state.swapCount;
    }
    if (state.songId !== prevSong || !state.playing) swappedAt = 0;
    prevPlaying = state.playing;
    prevSong = state.songId;
    trackIndex = new Map((state.tracks ?? []).map((t, i) => [t, i]));
    renderView(state);
    mixer.render(state);
    timeline.render(state);
    renderError(state.error);
  }

  /** The visualizer unit's label, and a legend of the colour families in the roll */
  let viewKey = "";
  function renderView(state: PlayerState) {
    const tracks = state.tracks ?? [];
    // the song's own setting, so the label holds while stopped
    const viz = player.songsRecord()[state.songId]?.visualization;
    const type = (typeof viz === "string" ? viz : viz?.type) ?? "none";
    const key = `${type}|${tracks.join(",")}`;
    if (key === viewKey) return;
    viewKey = key;
    viewEl.dataset.viz = type;
    const b = document.createElement("b");
    b.textContent = type === "none" ? "view" : type;
    viewName.replaceChildren(b);
    const families = new Map<string, string>();
    tracks.forEach((t, i) => {
      const family = LEGEND[trackRole(t)];
      if (family && !families.has(family)) families.set(family, trackColor(t, i));
    });
    viewLegend.replaceChildren(
      ...(type === "pianoroll" ? [...families] : []).map(([name, color]) => {
        const span = document.createElement("span");
        span.style.setProperty("--c", color);
        span.append(document.createElement("i"), name);
        return span;
      })
    );
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
    // reveal each located error once (the line arrives asynchronously, on the same object)
    const revealKey = err && inThisFile && err.line ? `${err.message}@${err.line}` : "";
    if (revealKey && revealKey !== lastRevealed) {
      // hold the error line in view (following the music would scroll it away)
      codeView.revealLine(err!.line!);
      codeView.setFollowing(false);
      pausedForError = true;
    } else if (!err && pausedForError) {
      codeView.setFollowing(true);
      pausedForError = false;
    }
    lastRevealed = revealKey;
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
    // …and in the editor
    const id = songIdForFile(lastError?.file);
    if (id && lastError?.line) reveal(songFile(id), lastError.line, lastError.column);
  });
  $("error-dismiss").addEventListener("click", () => player.setError(null));

  // ── controls ──────────────────────────────────────────────────────────────
  renderSongSelector();
  songSelect.addEventListener("change", () => {
    void player.selectSong(songSelect.value);
    songSelect.blur(); // give the keyboard back to the shortcuts
  });
  playBtn.addEventListener("click", () => void player.togglePlay());
  $("song-prev").addEventListener("click", () => void player.stepSong(-1));
  $("song-next").addEventListener("click", () => void player.stepSong(1));
  followToggle.addEventListener("change", () => player.setFollowEdits(followToggle.checked));
  audioHint.addEventListener("click", () => void engine.getAudioContext().resume());

  const showHelp = (on: boolean) => {
    help.hidden = !on;
    if (on) $("help-close").focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  };
  $("help-button").addEventListener("click", () => showHelp(help.hidden));
  $("help-close").addEventListener("click", () => showHelp(false));
  help.addEventListener("click", (e) => {
    if (e.target === help) showHelp(false);
  });

  const toggleCodeView = () => player.setCodeView(!player.getState().codeView);

  // ── keyboard ──────────────────────────────────────────────────────────────
  // Text fields and the song picker keep every key. Buttons and toggles keep
  // only Space/Enter (their own activation); other shortcuts still work after
  // clicking Play, a mute button, etc.
  const ownsKey = (target: EventTarget | null, e: KeyboardEvent) => {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable || /^(TEXTAREA|SELECT)$/.test(target.tagName)) return true;
    if (target instanceof HTMLInputElement && target.type !== "checkbox") return true;
    const activator = target.tagName === "BUTTON" || target instanceof HTMLInputElement;
    return activator && (e.code === "Space" || e.key === "Enter");
  };

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !help.hidden) {
      showHelp(false);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || ownsKey(e.target, e)) return;
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
  let litBeat = -2;

  type OnsetHap = { value: unknown; context: { track?: string; locations?: { start: number; end: number }[] } };
  /** Meter level of a hit: gain × velocity, on a gentle curve */
  const hapLevel = (hap: OnsetHap) => {
    const v = hap.value as { gain?: unknown; velocity?: unknown } | null;
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 1);
    const g = v && typeof v === "object" ? num(v.gain) * num(v.velocity) : 1;
    return Math.min(1, Math.max(0.12, Math.sqrt(Math.max(0, g))));
  };

  const onHap = (hap: OnsetHap) => {
    const track = hap.context.track;
    if (track !== undefined) {
      const level = hapLevel(hap);
      mixer.hit(track, level);
      room.hit(track, level, frameNow);
    }
    const locs = hap.context.locations;
    if (!locs?.length) return;
    const color = colorOfTrack(track) ?? "";
    for (const loc of locs) {
      if (track !== undefined) rangeTrack.set(loc.start * 2 ** 22 + loc.end, track);
      codeView.flash(loc.start, loc.end, color);
    }
  };

  /** this frame's timestamp, for hits found while polling onsets */
  let frameNow = 0;

  function frame(now: number) {
    requestAnimationFrame(frame);
    frameNow = now;
    player.tick();
    const state = lastState;
    const position = player.songPosition();
    const sections = state?.sections ?? null;
    const { bar, beat } = player.barBeat(position, sections);
    const barText = String(bar);
    const beatText = String(beat);
    if (barText !== lastBar || beatText !== lastBeat) {
      barEl.textContent = lastBar = barText;
      beatEl.textContent = lastBeat = beatText;
      barDigits.set(`${barText}.${beatText}`);
    }
    const lit = state?.playing ? beat - 1 : -1;
    if (lit !== litBeat) {
      litBeat = lit;
      beatLeds.forEach((led, i) => led.classList.toggle("on", i === lit));
    }
    timeline.frame(position, state?.section ?? null, bar, beat);
    renderCue(state);
    renderSwap(state, now);

    if (live && state?.playing) {
      const sourceOk = sameSource();
      live.pollOnsets((hap) => {
        if (!sourceOk) {
          const track = hap.context.track;
          if (track !== undefined) {
            mixer.hit(track, hapLevel(hap));
            room.hit(track, hapLevel(hap), frameNow);
          }
          return;
        }
        onHap(hap);
      });
    }
    mixer.frame(now);
    room.frame(now);
    codeView.frame(now);
  }
  requestAnimationFrame(frame);

  /** Top-bar cue: a countdown to a pending jump, or which section is looping */
  let lastCue = "";
  function renderCue(state: PlayerState | null) {
    let cue = "";
    let kind = "";
    if (state?.playing && state.pendingJump && state.sections) {
      const beats = Math.max(1, Math.ceil((state.pendingJump.atCycle - player.audibleCycle()) * 4));
      cue = `${state.sections[state.pendingJump.index].name} in ${beats} ${beats === 1 ? "beat" : "beats"}`;
      kind = "jump";
    } else if (state?.loop && state.section) {
      cue = `Looping ${state.section.name}`;
      kind = "loop";
    }
    if (cue === lastCue) return;
    lastCue = cue;
    cueEl.hidden = !cue;
    cueEl.textContent = cue;
    cueEl.dataset.kind = kind;
  }

  /** The code unit's hot-swap LED and how long ago the last swap landed */
  let lastSwap = "";
  function renderSwap(state: PlayerState | null, now: number) {
    let kind = "idle";
    let text = "";
    if (state?.error?.kind === "build" && state.error.keptPrevious) {
      kind = "error";
      text = "save not applied";
    } else if (swappedAt) {
      const s = Math.floor((now - swappedAt) / 1000);
      kind = s < 120 ? "swapped" : "idle";
      text = s < 2 ? "hot-swapped" : s < 120 ? `hot-swapped ${s} s ago` : "hot-swapped";
    }
    const key = `${kind}|${text}`;
    if (key === lastSwap) return;
    lastSwap = key;
    codeSwap.dataset.state = kind;
    codeSwapText.textContent = text;
  }

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
    setEditorLink(status) {
      const app = editorName(status.scheme);
      linkEl.dataset.state = status.state;
      linkEl.dataset.connected = String(status.state === "editor");
      linkEl.dataset.editors = String(status.editors);
      linkLabel.textContent = app;
      linkEl.title =
        status.state === "editor"
          ? `${app} is attached: it drives the player and shows highlights. Click the code to jump there.`
          : status.state === "bridge"
            ? `Dev server bridge is up, but no editor is attached (install the Strudel Live extension).${
                status.scheme ? ` Clicking the code opens it with ${status.scheme}://.` : ""
              }`
            : "Not linked to the dev-server bridge (editor commands and highlights are offline)";
    },
    setRevealer(fn) {
      reveal = fn;
    },
    toggleCodeView,
    highlights: () => codeView.litRanges(),
  };
}

/** "cursor" → "Cursor", for the editor LED */
function editorName(scheme: string | null): string {
  const names: Record<string, string> = {
    cursor: "Cursor",
    vscode: "VS Code",
    "vscode-insiders": "VS Code Insiders",
    vscodium: "VSCodium",
    windsurf: "Windsurf",
  };
  return (scheme && names[scheme]) || "VS Code";
}
