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
import type { CodeSurface } from "./code-surface";
import type { CodeEditor } from "./code-editor";
import { EditSession, type SessionView } from "./edit-session";
import { editorSourceCalls, evalEdit, hasEngine, setEngineForTests } from "./editor-source";
import { readStorage, writeStorage } from "../engine/storage";
import { Mixer } from "./mixer";
import { KnobPanel } from "./knobs";
import { formatKnob, knobTextWidth, type KnobInfo } from "../engine/knobs";
import { Timeline } from "./timeline";
import { SegmentDisplay } from "./segments";
import { Room } from "./room";
import * as songsStore from "../songs-store";
import { SongSaver } from "./song-saver";
import { ask, askOpen } from "./ask";
import { mountDiscovery } from "./discover/hooks";

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
  /** The songs store replayed the saved edits at boot; these didn't build */
  storeReplayed(failed: { id: string }[]): void;
}

export function mountStage(): Stage {
  const stage = $("stage");
  // editor linking needs the dev server (src/live/bridge-client.ts)
  stage.dataset.build = import.meta.env.DEV ? "dev" : "prod";
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
  const codeScroll = $("code-scroll");
  const codeLines = $("code-lines");
  const editorHost = $("code-editor");
  const codeStatus = $("code-status");
  const takeOverKey = $<HTMLButtonElement>("code-takeover");
  const loadKey = $<HTMLButtonElement>("code-load");
  const modeKey = $<HTMLButtonElement>("code-mode");
  const editedBadge = $("code-edited");
  const revertKey = $<HTMLButtonElement>("code-revert");
  const shareKey = $<HTMLButtonElement>("code-share");
  const downloadKey = $<HTMLButtonElement>("code-download");
  const codeToast = $("code-toast");
  const editHint = $("edit-hint");

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
  /** What the code unit shows now: the read-only view, or the editor in edit mode */
  let surface: CodeSurface = codeView;
  let editor: CodeEditor | null = null;
  let mode: "view" | "edit" = "view";
  /** Whether the shown text was the playing text last frame (null: hand over the ranges) */
  let shownSame: boolean | null = null;

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
    for (const [name, chips] of surface.knobChips()) {
      const knob = byName.get(name);
      if (knob && surface === editor) editor.setChipTextWidth(name, knobTextWidth(knob));
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
  const colorOfRange = (start: number, end: number) => colorOfTrack(rangeTrack.get(start * 2 ** 22 + end));
  codeView.setColorResolver(colorOfRange);

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

    // ids and names: a user song renamed by an edit keeps the same count
    if (songListKey() !== shownSongList) renderSongSelector();
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
    surface.setEnabled(state.codeView);

    // the code: the current song's text (on disk, or an evaluated editor buffer)
    const source = player.currentSource();
    if (source?.text !== undefined && (state.songId !== shownSongId || source.text !== shownSource?.text)) {
      if (source.version && contentVersion(source.text) !== source.version) {
        console.warn(`[code-view] ${source.file}: text does not match the version the highlights refer to`);
      }
      const otherFile = state.songId !== shownSongId;
      shownSongId = state.songId;
      shownSource = source;
      if (editor && surface === editor) showInEditor(editor, state.songId, source, otherFile);
      else codeView.setSource(source.text, source.version, otherFile);
      codeFile.textContent = source.file;
      rangeTrack.clear();
      renderKnobs(player.knobs()); // new chips
    } else if (source?.text !== undefined && editor && surface === editor) {
      // same text, maybe a different status (an IDE buffer saved as is): the session decides
      syncSession(state.songId, source);
    }
    renderEdited();
    renderStale(state);

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

  /** Each song's id and the name it plays under now (an edit may rename it); ⚠ marks a song that didn't build */
  const songList = () =>
    player.allSongs().map(({ id, song }) => ({ id, name: (player.songProblem(id) ? "⚠ " : "") + (player.playingSongOf(id)?.name ?? song.name) }));
  const songListKey = () => songList().map(({ id, name }) => `${id}\u0000${name}`).join("\u0001");
  let shownSongList = "";

  function renderSongSelector() {
    const list = songList();
    shownSongList = list.map(({ id, name }) => `${id}\u0000${name}`).join("\u0001");
    songSelect.replaceChildren(
      ...list.map(({ id, name }) => {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = name;
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
    surface.setErrorLine(err && inThisFile && err.line ? err.line : null);
    // reveal each located error once (the line arrives asynchronously, on the same object)
    const revealKey = err && inThisFile && err.line ? `${err.message}@${err.line}` : "";
    if (revealKey && revealKey !== lastRevealed) {
      // hold the error line in view (following the music would scroll it away)
      surface.revealLine(err!.line!);
      surface.setFollowing(false);
      pausedForError = true;
    } else if (!err && pausedForError) {
      surface.setFollowing(true);
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
      surface.revealLine(lastError.line);
      surface.setFollowing(false);
    }
    // …and in the editor
    const id = songIdForFile(lastError?.file);
    if (id && lastError?.line) reveal(songFile(id), lastError.line, lastError.column);
  });
  $("error-dismiss").addEventListener("click", () => player.setError(null));

  // ── edit mode: Monaco, loaded only when the user starts editing ───────────
  // The read-only CodeView stays the boot-time view. The "edit" key, E or a
  // double-click in the code swap in the editor (a lazy chunk) on the same
  // glass; the choice is remembered, so a returning editor gets it right away.
  const MODE_KEY = "code-mode";
  const sessions = new Map<string, EditSession>();
  let editorModule: Promise<typeof import("./code-editor")> | null = null;
  let ideName = "your editor";

  type Source = NonNullable<ReturnType<typeof player.currentSource>>;
  /**
   * What the session hears. An evaluated buffer stays `live` even when the
   * browser sent it (the session knows its own echoes, and a live buffer is
   * not the file: a later save must not count as "already shown"). Only a
   * session that starts on a browser-sent buffer takes it as editable.
   */
  const incomingOf = (source: Source, initial = false) => ({
    text: source.text ?? "",
    version: source.version,
    live: !!source.live && !(initial && (source as { origin?: string }).origin === "browser"),
  });

  /** The song's session, told about `source` (a new session starts from it) */
  function syncSession(songId: string, source: Source): EditSession {
    const existing = sessions.get(songId);
    if (existing) {
      existing.incoming(incomingOf(source));
      return existing;
    }
    const session = new EditSession({
      initial: incomingOf(source, true),
      evaluate: (text, intent, signal) => evalEdit(songId, text, intent, signal),
      ideName: () => ideName,
      onOwnerChange: (_owner, previous) => {
        if (previous === "browser") dropKeptEdit(songId);
      },
      onChange: (view) => {
        if (songId === shownSongId && editor && surface === editor) applyView(editor, view);
      },
    });
    sessions.set(songId, session);
    // only a new session: a later file save of the buffer's own text must not bring an older kept edit back
    restoreSaved(songId, session);
    return session;
  }

  // ── edits kept in this browser (src/songs-store, src/ui/song-saver.ts) ────
  // Invariant: a song has a saved edit exactly while the browser owns its
  // buffer. Typing saves it; going back to the file / the IDE (load theirs, a
  // save of the same text, revert) drops it: every owner change away from the
  // browser does (dropKeptEdit), pending autosave included.

  /**
   * The browser stopped owning a built-in song's buffer (load theirs, a save of
   * the same text): its kept edit goes, and a pending autosave must not bring
   * it back. A user song's stored text is the song itself: it stays.
   */
  function dropKeptEdit(id: string) {
    if (!player.isBuiltInSong(id)) return;
    saver.cancel(id);
    songsStore.discard(id);
  }

  /** A built-in song's own text (its file): what revert brings back */
  const originalText = (id: string) => player.fileSource(id)?.text;

  const saver = new SongSaver({
    store: songsStore,
    originalText,
    onSaved: (id, result) => {
      if (result === "not-persisted") {
        if (!notKept.has(id)) toast("not kept: this browser blocks storage (download keeps a copy)", "error");
        notKept.add(id);
      } else {
        notKept.delete(id);
      }
      if (id === player.currentSongId_()) renderEdited();
    },
  });
  /** Songs whose last autosave the browser refused: their stored copy (if any) is older than the buffer */
  const notKept = new Set<string>();
  // a reload or a closed tab within the debounce must not lose the last keys
  addEventListener("pagehide", () => saver.flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saver.flush();
  });

  /** The edit kept in this browser for `id` that the buffer should show, if any */
  function savedEdit(id: string): string | null {
    const mine = songsStore.getMySong(id);
    if (!mine) return null;
    if (player.isBuiltInSong(id)) return mine.text === originalText(id) ? null : mine.text;
    // a user song's stored text is the song itself: only text the player doesn't have is an edit
    return mine.text === player.sourceOf(id)?.text ? null : mine.text;
  }

  /** The text of a user song that didn't build (the player holds it in a placeholder), else null */
  const brokenText = (id: string) => (player.songProblem(id) ? player.sourceOf(id)?.text ?? null : null);

  /** A saved edit comes back as the browser's buffer (after a reload, or before the store's replay lands) */
  function restoreSaved(songId: string, session: EditSession) {
    if (session.view().owner === "browser" || saver.pending(songId)) return;
    const broken = brokenText(songId);
    // a song that didn't build plays a silent placeholder: evaluate its text as typing, so its error shows inline
    if (broken !== null) return session.restore(broken, { evaluated: false });
    const text = savedEdit(songId);
    if (text === null) return;
    // the store's boot replay may still be compiling it: that eval is ours, don't evaluate twice
    const evaluated = player.sourceOf(songId)?.text === text || player.evalPending(songId);
    session.restore(text, { evaluated });
  }

  /** The file bar's "edited" badge and revert key; "unsaved" only for edits that aren't kept */
  function renderEdited() {
    const id = player.currentSongId_();
    const mine = songsStore.getMySong(id);
    // the buffer went back to the file (e.g. saved with exactly this text): nothing is edited any more
    if (mine && player.isBuiltInSong(id) && mine.text === originalText(id) && !saver.pending(id)) songsStore.discard(id);
    const edited = player.isBuiltInSong(id) && savedEdit(id) !== null && !notKept.has(id);
    editedBadge.hidden = revertKey.hidden = !edited;
    const source = player.currentSource();
    // what plays is kept, unless the browser refused the last write
    codeUnsaved.hidden = !source?.live || (edited && source.origin === "browser");
    codeUnsaved.title =
      source?.origin === "browser"
        ? "Evaluated in the browser, not kept yet."
        : "Evaluated from the editor without saving (live eval). Save the file to keep it.";
  }

  /** The current song's source → its session → the editor */
  function showInEditor(ed: CodeEditor, songId: string, source: Source, otherFile: boolean) {
    if (otherFile) ed.setFile(source.file, source.text ?? "");
    applyView(ed, syncSession(songId, source).view(), otherFile);
  }

  let shownMarker: SessionView["marker"] = null;
  function applyView(ed: CodeEditor, view: SessionView, otherFile = false) {
    if (ed.value() !== view.text) ed.setSource(view.text, undefined, otherFile);
    else if (otherFile) ed.setSource(view.text, undefined, true);
    ed.setReadOnly(view.readOnly);
    // a new result's marker, placed only while its line/column still index the
    // buffer (Monaco then carries it along as the user types)
    if (view.marker !== shownMarker || otherFile) {
      shownMarker = view.marker;
      ed.setMarker(view.marker && view.markerText === view.text ? view.marker : null);
    }
    const { kind, text } = view.status;
    codeStatus.hidden = !text;
    if (codeStatus.textContent !== text) codeStatus.textContent = text;
    codeStatus.dataset.kind = kind;
    // announce what needs attention, not every "editing…" / "evaluating…"
    codeStatus.setAttribute("aria-live", kind === "error" || kind === "conflict" || kind === "readonly" ? "polite" : "off");
    codeStatus.title = view.marker?.message ?? text;
    takeOverKey.hidden = view.status.action !== "takeOver";
    loadKey.hidden = view.status.action !== "load";
    renderStale(lastState);
  }

  /** "not playing yet": the shown code (or the buffer being edited) isn't what plays */
  function renderStale(state: PlayerState | null) {
    const source = player.currentSource();
    const playing = player.playingSource();
    let stale = !!(state?.playing && playing && source && playing.version !== source.version);
    if (!stale && state?.playing && playing?.text !== undefined && editor && surface === editor) {
      stale = playing.file === source?.file && !editor.matches(playing.text);
    }
    codeStale.hidden = !stale;
  }

  function loadEditor() {
    editorModule ??= import("./code-editor");
    return editorModule;
  }

  async function enterEdit({ focus = false, offset }: { focus?: boolean; offset?: number } = {}) {
    if (mode === "edit" && editor) {
      if (focus) editor.focus(offset);
      return;
    }
    mode = "edit";
    writeStorage(MODE_KEY, "edit");
    dismissHint(); // found it
    renderMode();
    let mod: typeof import("./code-editor");
    try {
      mod = await loadEditor();
    } catch (err) {
      console.error("[editor] could not load the editor", err);
      editorModule = null;
      mode = "view";
      renderMode();
      codeStatus.hidden = false;
      codeStatus.dataset.kind = "error";
      codeStatus.textContent = "the editor didn't load: check your connection, then press E";
      return;
    }
    if (mode !== "edit") return; // left again while it loaded
    editor ??= createEditor(mod);
    codeScroll.hidden = true;
    editorHost.hidden = false;
    codeView.setSource("", undefined, true); // one set of knob chips on the page
    surface = editor;
    shownSame = null;
    surface.setEnabled(player.getState().codeView);
    surface.setFollowing(true);
    shownSongId = ""; // show the current song in the editor
    render(player.getState());
    if (focus) editor.focus(offset);
  }

  function exitEdit() {
    if (mode === "view") return;
    mode = "view";
    writeStorage(MODE_KEY, "view");
    renderMode();
    if (surface === codeView) return;
    if (editorHost.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    surface = codeView;
    shownSame = null;
    editorHost.hidden = true;
    codeScroll.hidden = false;
    codeStatus.hidden = takeOverKey.hidden = loadKey.hidden = true;
    surface.setFollowing(true);
    shownSongId = "";
    render(player.getState());
  }

  function renderMode() {
    stage.dataset.codeMode = mode;
    modeKey.setAttribute("aria-pressed", String(mode === "edit"));
    modeKey.title = mode === "edit" ? "Back to the read-only view" : "Edit the song here while it plays (E)";
    if (mode === "edit" && !editor) {
      codeStatus.hidden = false;
      codeStatus.dataset.kind = "pending";
      codeStatus.textContent = "loading the editor…";
    }
  }

  function createEditor(mod: typeof import("./code-editor")): CodeEditor {
    const ed = new mod.CodeEditor({
      host: editorHost,
      followChip: $("follow-chip"),
      onEdit: (text) => {
        const id = shownSongId;
        // kept in this browser as typed (even when it doesn't build), so a reload doesn't lose it
        if (sessions.get(id)?.edit(text)) saver.edit(id, text);
      },
      onCommit: () => void commit(),
      onKnobChip: (name) => knobPanel.focus(name),
      onPick: ({ line, column }) => {
        const file = player.currentSource()?.file;
        if (file) reveal(file, line, column);
      },
      onChipsChanged: () => renderKnobs(),
      // hand the keyboard back to the stage's shortcuts
      onEscape: () => (document.activeElement as HTMLElement | null)?.blur(),
    });
    ed.setColorResolver(colorOfRange);
    return ed;
  }

  /** ⌘/Ctrl+Enter: evaluate now; like strudel.cc it also starts the music */
  async function commit() {
    const id = shownSongId;
    const session = sessions.get(id);
    if (!session || session.view().readOnly) return;
    // keep the buffer now, not after the autosave's debounce: the store's boot
    // replay re-reads a song's kept text right before evaluating it, and must
    // not find an older one and play it over this commit
    saver.flush(id);
    const result = await session.commit();
    if (result?.ok && !player.getState().playing) void player.play();
  }

  /** What the code unit shows: the editor's buffer while editing, else the song's current text */
  const shownText = () => (editor && surface === editor ? editor.value() : player.currentSource()?.text ?? "");

  /**
   * ⌘/Ctrl+S while editing. Under the dev server: write src/songs/<id>.ts
   * (HMR then brings the file in, and the store drops the kept copy). On the
   * site: keep the buffer in this browser now.
   */
  async function save() {
    const id = shownSongId;
    const session = sessions.get(id);
    if (!id || !session || !editor || surface !== editor) return;
    const local = await songsStore.canSaveToFile();
    // read the buffer after the probe: typing may have gone on meanwhile
    if (sessions.get(id) !== session) return;
    const view = session.view();
    if (view.readOnly) {
      toast(`${ideName} is editing this song: take over to save it here`, "warn");
      return;
    }
    const text = view.text;
    if (!local) {
      const kept = saver.keep(id, text);
      toast(
        kept === "saved"
          ? "saved in this browser"
          : kept === "unchanged"
            ? "nothing to save: this is the original"
            : "not saved: this browser blocks storage",
        kept === "not-persisted" ? "error" : "ok"
      );
      return;
    }
    const builtIn = player.isBuiltInSong(id);
    if (builtIn && text === originalText(id)) {
      saver.cancel(id);
      songsStore.discard(id);
      renderEdited();
      toast("nothing to save: the file says the same");
      return;
    }
    saver.flush(id); // the kept copy is this text, so a successful save can drop it
    toast("saving…", "pending");
    // one write per song at a time, in order: an older, slower save must never land after a newer one
    const run = (fileSaves.get(id) ?? Promise.resolve()).then(() => songsStore.saveToFile(id, text, { create: !builtIn }));
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    fileSaves.set(id, settled);
    let result: Awaited<typeof run>;
    try {
      result = await run;
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (fileSaves.get(id) === settled) fileSaves.delete(id);
    }
    renderEdited();
    if (result.ok) toast(`saved to ${result.file}`);
    else toast(`not saved: ${result.error}`, "error");
  }
  /** File saves still being written, per song (the newest of the chain) */
  const fileSaves = new Map<string, Promise<void>>();

  async function share() {
    const id = player.currentSongId_();
    let url: string;
    try {
      url = await songsStore.shareUrl(id, shownText());
    } catch (err) {
      toast(`can't share: ${err instanceof Error ? err.message : String(err)}`, "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast("link copied");
    } catch {
      // no clipboard (denied, insecure context): hand over the link to copy by hand
      const field = document.createElement("input");
      field.type = "text";
      field.readOnly = true;
      field.value = url;
      field.className = "share-link-field";
      field.dataset.testid = "share-link-url";
      field.setAttribute("aria-label", "Share link");
      field.addEventListener("focus", () => field.select());
      const shown = ask({
        testid: "share-link",
        title: "Copy this link",
        note: "The clipboard isn't available here. The link is selected: copy it with ⌘/Ctrl+C.",
        content: field,
        confirm: "done",
      });
      requestAnimationFrame(() => {
        field.focus();
        field.select();
      });
      await shown;
    }
  }

  async function revertSong() {
    const id = player.currentSongId_();
    if (askOpen() || savedEdit(id) === null) return;
    if (fileSaves.has(id)) {
      toast("a save is still being written: revert once it's done", "warn");
      return;
    }
    const name = player.playingSongOf(id)?.name ?? id;
    const ok = await ask({
      testid: "revert-dialog",
      title: "Throw away your edits?",
      facts: [
        ["song", name],
        ["file", `src/songs/${id}.ts`],
      ],
      note: "The edits kept in this browser go, and the original plays again. This can't be undone. (download keeps a copy.)",
      confirm: "revert",
      cancel: "keep them",
      tone: "warn",
      focus: "cancel",
    });
    if (!ok || player.currentSongId_() !== id || fileSaves.has(id)) return;
    saver.cancel(id); // a pending write would bring the edit back
    // a fresh session starts from the original (the old one would see it as a conflict)
    sessions.get(id)?.dispose();
    sessions.delete(id);
    songsStore.revert(id); // forgets the entry; the player plays the file again
    shownSongId = "";
    render(player.getState());
    toast("reverted to the original");
  }

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function toast(text: string, kind: "ok" | "warn" | "error" | "pending" = "ok") {
    codeToast.textContent = text;
    codeToast.dataset.kind = kind;
    codeToast.hidden = false;
    clearTimeout(toastTimer);
    if (kind !== "pending") toastTimer = setTimeout(() => (codeToast.hidden = true), kind === "ok" ? 2500 : 6000);
  }

  // ── first visit on the site: point at the edit key ─────────────────────────
  const HINT_KEY = "hint-edit";
  function dismissHint() {
    editHint.hidden = true;
    writeStorage(HINT_KEY, "done");
  }
  if (readStorage(HINT_KEY) !== "done" && readStorage(MODE_KEY) !== "edit") {
    // the hosted site: no dev server to save to (the same test the save key uses)
    void songsStore.canSaveToFile().then((local) => {
      if (!local && mode === "view" && readStorage(HINT_KEY) !== "done") editHint.hidden = false;
    });
  }
  $("edit-hint-dismiss").addEventListener("click", dismissHint);

  revertKey.addEventListener("click", () => void revertSong());
  shareKey.addEventListener("click", () => void share());
  downloadKey.addEventListener("click", () => {
    const id = player.currentSongId_();
    songsStore.download(id, shownText());
    toast(`downloaded ${id}.ts`);
  });
  // ⌘/Ctrl+S while editing saves the song, never the page (capture: before Monaco and the browser)
  addEventListener(
    "keydown",
    (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "s" || mode !== "edit") return;
      e.preventDefault();
      if (!e.repeat && !askOpen()) void save();
    },
    true
  );

  modeKey.addEventListener("click", () => (mode === "edit" ? exitEdit() : void enterEdit({ focus: true })));
  takeOverKey.addEventListener("click", () => {
    sessions.get(shownSongId)?.takeOver();
    editor?.focus();
  });
  loadKey.addEventListener("click", () => {
    const id = shownSongId;
    const session = sessions.get(id);
    const theirs = session?.view().conflict;
    if (!session || !theirs) return;
    // the browser's edits are given up for theirs: a reload must not bring them back
    if (player.isBuiltInSong(id)) {
      saver.cancel(id);
      songsStore.discard(id);
    } else {
      // a user song's stored text is the song itself: theirs is the song now (like ⌘S)
      saver.keep(id, theirs.text);
    }
    session.loadIncoming();
    // the browser's eval may have landed after theirs arrived: the player plays what the editor shows
    if (player.sourceOf(id)?.text !== theirs.text) {
      if (theirs.live) void player.evalSource(id, theirs.text, { intent: "commit", origin: "editor" });
      else player.revertSource(id);
    }
    renderEdited();
  });
  // a double-click in the read-only code starts editing right there
  codeLines.addEventListener("dblclick", (e) => {
    if ((e.target as Element | null)?.closest?.(".knob-chip")) return;
    const offset = codeView.offsetAt(e);
    void enterEdit({ focus: true, offset: offset ?? undefined });
  });
  // a returning editor gets the editor right away (still a lazy chunk)
  if (readStorage(MODE_KEY) === "edit") void enterEdit();

  // tests and devtools (separate from window.__strudel, which main.ts builds)
  window.__strudelEditor = {
    mode: () => mode,
    loaded: () => !!editor,
    enter: (opts) => enterEdit(opts),
    exit: exitEdit,
    value: () => editor?.value() ?? null,
    markers: () => editor?.markers("strudel").map((m) => ({ message: m.message, line: m.startLineNumber, column: m.startColumn })) ?? [],
    allMarkers: () => editor?.markers().map((m) => ({ owner: m.owner, message: m.message, line: m.startLineNumber })) ?? [],
    session: () => sessions.get(shownSongId)?.view() ?? null,
    calls: () => editorSourceCalls().map((c) => ({ ...c })),
    hasEngine,
    setEngineForTests,
    litRanges: () => (editor ? editor.litRanges() : []),
    flashing: () => (editor ? editor.flashingRanges() : []),
    suggest: () => editor?.suggest(),
    focus: (offset) => editor?.focus(offset),
  };

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
      surface.setFollowing(true);
    } else if (e.key === "e" || e.key === "E") {
      e.preventDefault(); // don't type the "e" into the editor it focuses
      void enterEdit({ focus: true });
    } else if (e.key === "[" || e.key === "]") {
      player.stepSection(e.key === "]" ? 1 : -1);
    } else {
      return;
    }
  });

  // ── discovery: library (B), palette (⌘K), track builder (src/ui/discover/, lazy) ──
  mountDiscovery({
    mode: () => mode,
    async editor() {
      await enterEdit();
      if (mode !== "edit" || !editor || surface !== editor) return null;
      if (sessions.get(shownSongId)?.view().readOnly) {
        toast(`${ideName} is editing this song: take over to edit it here`, "warn");
        return null;
      }
      return editor;
    },
    editing: () => (mode === "edit" && editor && surface === editor ? { songId: shownSongId, editor } : null),
    exitEdit,
    toast,
    showHelp: () => showHelp(true),
    toggleCodeView,
    follow: () => surface.setFollowing(true),
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
      surface.flash(loc.start, loc.end, color);
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

    // the shown text just became (or stopped being) the playing text, e.g. a
    // surface switch or an undo back to it: the highlighter only reports
    // changes, so hand over what's lit now
    const same = sameSource();
    if (same !== shownSame) {
      shownSame = same;
      surface.setRanges(same && live ? live.ranges() : []);
    }

    if (live && state?.playing) {
      const sourceOk = same;
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
    surface.frame(now);
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
    if (!playing || !shown || playing.file !== shown.file || playing.version !== shown.version) return false;
    // edit mode: the buffer may be ahead of (or behind) what plays
    return !(editor && surface === editor) || (playing.text !== undefined && editor.matches(playing.text));
  }

  return {
    attachLive(l) {
      live = l;
      l.onRanges((ranges) => surface.setRanges(sameSource() ? ranges : []));
    },
    setEditorLink(status) {
      const app = editorName(status.scheme);
      ideName = status.state === "editor" ? app : "your editor";
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
    highlights: () => surface.litRanges(),
    storeReplayed(failed) {
      // a saved edit that doesn't build: evaluate it as typing, so its error shows inline in the editor
      for (const { id } of failed) {
        const session = sessions.get(id);
        const text = savedEdit(id) ?? brokenText(id);
        if (session && text !== null && session.view().text === text && session.view().status.kind === "idle") {
          session.restore(text, { evaluated: false });
        }
      }
    },
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

declare global {
  interface Window {
    /** Edit mode (tests, devtools): see mountStage() */
    __strudelEditor?: {
      mode(): "view" | "edit";
      /** The Monaco chunk is loaded and mounted */
      loaded(): boolean;
      enter(opts?: { focus?: boolean; offset?: number }): Promise<void>;
      exit(): void;
      value(): string | null;
      /** Evaluation markers (typing / commit errors) on the current song */
      markers(): { message: string; line: number; column: number }[];
      /** Every marker, TypeScript's included */
      allMarkers(): { owner: string; message: string; line: number }[];
      session(): SessionView | null;
      /** What the adapter was asked to evaluate (src/ui/editor-source.ts) */
      calls(): ReturnType<typeof editorSourceCalls>[number][];
      hasEngine: typeof hasEngine;
      setEngineForTests: typeof setEngineForTests;
      litRanges(): [number, number][];
      flashing(): [number, number][];
      suggest(): void;
      focus(offset?: number): void;
    };
  }
}
