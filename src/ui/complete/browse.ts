// ═══════════════════════════════════════════════════════════════════════════
// Hear while browsing: arrowing through a sound list plays each row
// ═══════════════════════════════════════════════════════════════════════════
//
// Off by default (../discover/preview-setting.ts); ⌥P toggles it while a list
// is open, and the choice is remembered. With it on, arrowing to a row
// (Up/Down/PageUp/PageDown) plays it after a 120 ms pause on the row: quietly
// and briefly (auditionSound 's `preview`). Opening the list, typing,
// re-filtering, a re-query and the mouse never play: a focus change counts
// only within 150 ms of a navigation key. Closing the list stops a preview.
// Touch (a coarse pointer) never previews; neither does a screen reader,
// unless previews were turned on in this session.
//
// The hook is Monaco's suggest widget, which isn't public API:
// editor.getContribution("editor.contrib.suggestController").widget.value
// with onDidFocus / onDidHide. It is feature-detected and degrades silently
// (`hookOk` says whether it held); e2e/complete.spec.ts fails if it breaks.
//
// The details pane of a sound row ends with a line about previews; ⌥P, the
// first preview of a session and a sample that won't load update it in place.

import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";
import type { SoundPreview } from "./values.ts";
import { previewsAllowed } from "../discover/audition-values.ts";
import { onPreviewsChange, previewsEnabled, togglePreviews } from "../discover/preview-setting.ts";

export const NAV_KEYS: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown"]);
/** A focus change this long after a navigation key still counts as arrowing (ms) */
export const NAV_WINDOW_MS = 150;
/** Play once the row has had focus this long (ms) */
export const PREVIEW_DELAY_MS = 120;
/** How long the first preview's hint stays (ms) */
export const FIRST_HINT_MS = 2000;

export const HINT_OFF = "⌥P to hear sounds as you browse";
export const HINT_ON = "♪ previews on arrow · ⌥P mutes";
export const HINT_FIRST = "♪ playing as you arrow · ⌥P mutes";
export const NOTE_LOAD_FAILED = "couldn't load this sample";

/** May previews play: the setting (and not touch), and with a screen reader only if turned on this session */
export function previewsOn({ allowed, screenReader, toggledThisSession }: { allowed: boolean; screenReader: boolean; toggledThisSession: boolean }): boolean {
  return allowed && (!screenReader || toggledThisSession);
}

/** A sound row's details: its own text, a note about this row (a failed load), the previews line */
export function composeDoc(base: string, { hint, note }: { hint: string; note?: string }): string {
  return [base, note ? `⚠ ${note}` : "", `*${hint}*`].filter(Boolean).join("\n\n");
}

export interface BrowserDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  /** Previews may play now */
  enabled(): boolean;
  play(p: SoundPreview): void;
  prefetch(p: SoundPreview): void;
  stop(): void;
}

export interface Browser {
  /** A key went down in the editor (before the list handles it) */
  keyDown(key: string): void;
  /** A row got focus: its preview, or undefined for a row that isn't a sound */
  focus(p: SoundPreview | undefined): void;
  /** The list closed */
  hide(): void;
}

/** The gate: which focus changes play (pure; the clock and the audio are injected) */
export function createBrowser(deps: BrowserDeps): Browser {
  let navAt = -Infinity;
  let timer: unknown;
  let played = false;
  const cancel = () => {
    if (timer !== undefined) deps.clearTimer(timer);
    timer = undefined;
  };
  return {
    keyDown(key) {
      if (NAV_KEYS.has(key)) navAt = deps.now();
    },
    focus(p) {
      cancel();
      if (!p || !deps.enabled()) return;
      deps.prefetch(p);
      if (deps.now() - navAt > NAV_WINDOW_MS) return;
      timer = deps.setTimer(() => {
        timer = undefined;
        played = true;
        deps.play(p);
      }, PREVIEW_DELAY_MS);
    },
    hide() {
      cancel();
      if (!played) return;
      played = false;
      deps.stop();
    },
  };
}

// ── Monaco ──────────────────────────────────────────────────────────────────

/** A completion item with what browsing needs (extra fields survive Monaco's handling) */
export interface StrudelCompletion extends Monaco.languages.CompletionItem {
  /** A sound row: what it previews */
  strudel?: SoundPreview;
  /** A sound row's own details (markdown), before the previews line */
  strudelDoc?: string;
  /** Something about this row for the details pane ("couldn't load this sample") */
  strudelNote?: string;
}

/** The parts of Monaco's suggest widget (internal) this uses */
interface SuggestWidget {
  onDidFocus(fn: (e: { item: { completion: StrudelCompletion } }) => void): Monaco.IDisposable;
  onDidHide(fn: () => void): Monaco.IDisposable;
  showDetails?(loading: boolean): void;
  _isDetailsVisible?(): boolean;
}

/** The suggest widget, created if it isn't yet; null if Monaco changed and it isn't where it was */
export function suggestWidget(editor: Monaco.editor.ICodeEditor): SuggestWidget | null {
  try {
    const ctrl = editor.getContribution("editor.contrib.suggestController") as unknown as { widget?: { value?: Partial<SuggestWidget> } } | null;
    const w = ctrl?.widget?.value;
    if (w && typeof w.onDidFocus === "function" && typeof w.onDidHide === "function") return w as SuggestWidget;
  } catch {
    // an internal moved: no previews, nothing else lost
  }
  return null;
}

export interface BrowseEvent {
  type: "preview" | "prefetch" | "stop" | "toggle";
  sound?: string;
  bank?: string;
  n?: number;
  note?: string;
  on?: boolean;
  at: number;
}

export interface BrowseWiring extends Monaco.IDisposable {
  /** The internal focus hook held */
  readonly hookOk: boolean;
  /** Previews may play now */
  on(): boolean;
  /** The previews line sound rows show now */
  hint(): string;
  /** Rewrite the details of the list's sound rows (and the open pane) */
  refresh(): void;
  /** What happened, newest last (tests) */
  readonly log: BrowseEvent[];
}

type Audition = typeof import("../discover/audition");
let audition: Promise<Audition> | null = null;
const loadAudition = () => (audition ??= import("../discover/audition"));

const LOG_LIMIT = 100;

/** Hear while browsing for one editor; `items` gives the open list's items (./provider.ts keeps them) */
export function wireBrowse(monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor, items: () => readonly StrudelCompletion[]): BrowseWiring {
  const log: BrowseEvent[] = [];
  const note = (e: Omit<BrowseEvent, "at">) => {
    log.push({ ...e, at: performance.now() });
    if (log.length > LOG_LIMIT) log.shift();
  };
  let toggledThisSession = false;
  let firstHintUntil = 0;
  let playedThisSession = false;
  let focused: StrudelCompletion | null = null;
  const disposables: Monaco.IDisposable[] = [];

  const screenReader = () => editor.getOption(monaco.editor.EditorOption.accessibilitySupport) === monaco.editor.AccessibilitySupport.Enabled;
  const on = () => previewsOn({ allowed: previewsAllowed(), screenReader: screenReader(), toggledThisSession });
  const hint = () => (!on() ? HINT_OFF : performance.now() < firstHintUntil ? HINT_FIRST : HINT_ON);

  const widget = suggestWidget(editor);
  const refresh = () => {
    const h = hint();
    for (const item of items()) {
      if (item.strudelDoc === undefined) continue;
      item.documentation = { value: composeDoc(item.strudelDoc, { hint: h, note: item.strudelNote }) };
    }
    try {
      if (widget?._isDetailsVisible?.()) widget.showDetails?.(false);
    } catch {
      // the pane catches up on the next row
    }
  };

  const opts = (p: SoundPreview) => ({ bank: p.bank, n: p.n, pitched: p.pitched, note: p.note });
  const browser = createBrowser({
    now: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    enabled: on,
    prefetch(p) {
      note({ type: "prefetch", sound: p.sound, bank: p.bank, n: p.n });
      void loadAudition().then((m) => m.prefetchSound(p.sound, opts(p)));
    },
    play(p) {
      const item = focused?.strudel === p ? focused : null;
      note({ type: "preview", sound: p.sound, bank: p.bank, n: p.n, note: p.note });
      if (!playedThisSession) {
        playedThisSession = true;
        firstHintUntil = performance.now() + FIRST_HINT_MS;
        refresh();
        setTimeout(refresh, FIRST_HINT_MS + 20);
      }
      void loadAudition()
        .then((m) => m.auditionSound(p.sound, { preview: true, ...opts(p) }).then((rec) => ({ rec, failed: m.LOAD_FAILED })))
        .then(({ rec, failed }) => {
          if (rec.status !== "error" || rec.error !== failed || !item) return;
          item.strudelNote = NOTE_LOAD_FAILED;
          refresh();
        })
        .catch(() => {});
    },
    stop() {
      note({ type: "stop" });
      void loadAudition().then((m) => m.stopAudition());
    },
  });

  if (widget) {
    // capture: before the suggest widget handles the key and moves the focus
    const node = editor.getDomNode();
    const onKey = (e: KeyboardEvent) => browser.keyDown(e.key);
    node?.addEventListener("keydown", onKey, true);
    disposables.push({ dispose: () => node?.removeEventListener("keydown", onKey, true) });
    disposables.push(
      widget.onDidFocus(({ item }) => {
        focused = item.completion;
        browser.focus(item.completion.strudel);
      }),
      widget.onDidHide(() => {
        focused = null;
        browser.hide();
      })
    );
  }

  // ⌥P while a list is open: previews on/off (remembered)
  disposables.push(
    editor.addAction({
      id: "strudel.togglePreviews",
      label: "Sound previews: on/off",
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyP],
      precondition: "suggestWidgetVisible",
      run: () => {
        const turnOn = !on();
        if (turnOn) toggledThisSession = true;
        if (turnOn !== previewsEnabled()) togglePreviews();
        note({ type: "toggle", on: on() });
        refresh();
      },
    })
  );
  // the palette can flip it too
  const unlisten = onPreviewsChange(() => refresh());
  disposables.push({ dispose: unlisten });

  return {
    hookOk: !!widget,
    on,
    hint,
    refresh,
    log,
    dispose() {
      for (const d of disposables.splice(0)) d.dispose();
    },
  };
}
