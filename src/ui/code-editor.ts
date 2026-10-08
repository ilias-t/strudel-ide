// ═══════════════════════════════════════════════════════════════════════════
// Edit mode: the song's source in Monaco, on the same black glass
// ═══════════════════════════════════════════════════════════════════════════
//
// A lazy chunk: only `import()`ed when the user starts editing (stage.ts), so
// a page that only plays never loads Monaco. It takes the same signals as the
// read-only CodeView (CodeSurface) and shows them as Monaco decorations:
//
//   setRanges()   lit tokens: an underline in the track colour
//   flash()       a hap started: a brief hard invert (dark text on the colour)
//   setErrorLine  the player's error line: red wavy underline
//   knob chips    a content widget per knob(…) call, sitting on a reserved
//                 gap (injected text) so it never covers code
//   follow        glides to the busiest lit region, like the code view
//
// Text in, text out: the stage (and its EditSession) decides what the buffer
// shows; this module reports edits (onEdit) and ⌘/Ctrl+Enter (onCommit).
// Offsets are UTF-16 offsets into the model text with LF line ends, exactly
// what the highlight ranges index into.

import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/editor.all.js";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { setupLanguage, songModelUri } from "./editor-lang";
import { tokenize } from "./tokenize";
import { findKnobCalls } from "../live/knob-calls";
import type { Range } from "../live/highlights";
import type { CodeSurface } from "./code-surface";
import type { EvalError } from "./editor-types";
import "./code-editor.css";

// Workers through Vite's ?worker: bundled as their own files, with URLs that
// respect `base` (GitHub Pages serves the app under /strudel-ide/).
self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    return label === "typescript" || label === "javascript" ? new TsWorker() : new EditorWorker();
  },
};

const PACK = 2 ** 22;
const key = (start: number, end: number) => start * PACK + end;
/** How long a hit holds the inverted colours */
const FLASH_MS = 120;
const MARKER_OWNER = "strudel";
const MONO = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

export interface CodeEditorOptions {
  host: HTMLElement;
  /** Shown when the user scrolled away; clicking it resumes following */
  followChip: HTMLElement;
  /** The user changed the text (not a programmatic setSource) */
  onEdit: (text: string) => void;
  /** ⌘/Ctrl+Enter */
  onCommit: () => void;
  /** A knob chip was clicked */
  onKnobChip?: (name: string) => void;
  /** Open this spot in the attached IDE (plain click while read-only, ⌘/Ctrl+click while editing) */
  onPick?: (pos: { offset: number; line: number; column: number }) => void;
  /** The set of chip elements changed (the stage fills in their values) */
  onChipsChanged?: () => void;
  /** Escape with nothing else to close: leave edit mode */
  onEscape?: () => void;
}

interface Chip {
  el: HTMLElement;
  widget: monaco.editor.IContentWidget;
  position: monaco.IPosition;
  name: string;
}

// ── theme: the stage's black glass and syntax colours (stage.css .t-*) ──────
function defineTheme(club: boolean) {
  const number = club ? "d2ff6a" : "ff9a6e";
  monaco.editor.defineTheme("black-glass", {
    base: "vs-dark",
    inherit: false,
    rules: [
      { token: "", foreground: "eee9de" },
      { token: "comment", foreground: "6f6c66", fontStyle: "italic" },
      { token: "keyword", foreground: "b7b1a6" },
      { token: "string", foreground: "f4e6cf" },
      { token: "string.escape", foreground: "f4e6cf" },
      { token: "number", foreground: number },
      { token: "regexp", foreground: "f4e6cf" },
      { token: "delimiter", foreground: "77736c" },
      { token: "operator", foreground: "77736c" },
      { token: "type", foreground: "cfc9bd" },
      { token: "type.identifier", foreground: "cfc9bd" },
      { token: "identifier", foreground: "eee9de" },
    ],
    colors: {
      "editor.background": "#060607",
      "editor.foreground": "#eee9de",
      "editorLineNumber.foreground": "#3a3936",
      "editorLineNumber.activeForeground": "#8a867e",
      "editorCursor.foreground": club ? "#b9f03a" : "#ff6a2b",
      "editor.selectionBackground": "#4a463f88",
      "editor.inactiveSelectionBackground": "#4a463f55",
      "editor.selectionHighlightBackground": "#4a463f40",
      "editor.wordHighlightBackground": "#00000000",
      "editor.wordHighlightStrongBackground": "#00000000",
      "editor.lineHighlightBackground": "#ffffff07",
      "editor.lineHighlightBorder": "#00000000",
      // brackets are punctuation, as in the read-only view (.t-p)
      ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [`editorBracketHighlight.foreground${i}`, "#77736c"])),
      "editorBracketHighlight.unexpectedBracket.foreground": "#ff4433",
      "editorBracketMatch.background": "#00000000",
      "editorBracketMatch.border": "#8a867e88",
      "editorIndentGuide.background1": "#00000000",
      "editorIndentGuide.activeBackground1": "#00000000",
      "editorWhitespace.foreground": "#3a3936",
      "editorWidget.background": "#0d0d0f",
      "editorWidget.foreground": "#eee9de",
      "editorWidget.border": "#2a2a2d",
      "editorSuggestWidget.background": "#0d0d0f",
      "editorSuggestWidget.border": "#2a2a2d",
      "editorSuggestWidget.foreground": "#d8d3c8",
      "editorSuggestWidget.selectedBackground": "#1f1f22",
      "editorSuggestWidget.selectedForeground": "#eee9de",
      "editorSuggestWidget.highlightForeground": club ? "#d2ff6a" : "#ff9a6e",
      "editorSuggestWidget.focusHighlightForeground": club ? "#d2ff6a" : "#ff9a6e",
      "editorHoverWidget.background": "#0d0d0f",
      "editorHoverWidget.border": "#2a2a2d",
      "editorHoverWidget.foreground": "#d8d3c8",
      "textCodeBlock.background": "#060607",
      "textLink.foreground": "#8ea6ff",
      "textPreformat.foreground": "#f4e6cf",
      "list.hoverBackground": "#18181b",
      "list.highlightForeground": club ? "#d2ff6a" : "#ff9a6e",
      "editorError.foreground": "#ff4433",
      "editorWarning.foreground": "#f5c518",
      "editorOverviewRuler.border": "#00000000",
      "scrollbar.shadow": "#00000000",
      "scrollbarSlider.background": "#2a2a2d99",
      "scrollbarSlider.hoverBackground": "#3a3a3ecc",
      "scrollbarSlider.activeBackground": "#47474bcc",
      "editorGutter.background": "#060607",
      focusBorder: "#00000000",
      "input.background": "#141416",
      "input.border": "#2a2a2d",
    },
  });
}

/** Per-colour classes for decorations (Monaco decorations can't carry inline styles) */
class ColorClasses {
  private classes = new Map<string, string>();
  private sheet: HTMLStyleElement;
  constructor() {
    this.sheet = document.createElement("style");
    this.sheet.dataset.owner = "code-editor";
    document.head.append(this.sheet);
  }
  of(color: string): string {
    if (!color) return "";
    let cls = this.classes.get(color);
    if (!cls) {
      cls = `hlc${this.classes.size}`;
      this.classes.set(color, cls);
      this.sheet.append(`.code-editor .${cls}{--c:${color}}\n`);
    }
    return cls;
  }
  dispose() {
    this.sheet.remove();
  }
}

export class CodeEditor implements CodeSurface {
  readonly editor: monaco.editor.IStandaloneCodeEditor;
  private models = new Map<string, monaco.editor.ITextModel>();
  private model: monaco.editor.ITextModel | null = null;
  private applyingExternal = false;
  private disposables: monaco.IDisposable[] = [];
  private colors = new ColorClasses();
  private colorFor: (start: number, end: number) => string | undefined = () => undefined;
  private enabled = true;
  private readOnly = false;

  private ranges: Range[] = [];
  private rangesDirty = false;
  private lit: monaco.editor.IEditorDecorationsCollection;
  private flashes = new Map<number, { color: string; until: number }>();
  private pendingFlashes = new Map<number, string>();
  private flashDecos: monaco.editor.IEditorDecorationsCollection;
  private flashesDirty = false;
  private errorDecos: monaco.editor.IEditorDecorationsCollection;
  private errorLine: number | null = null;
  private syntaxDecos: monaco.editor.IEditorDecorationsCollection;
  private slotDecos: monaco.editor.IEditorDecorationsCollection;
  private chips: Chip[] = [];
  private chipMap = new Map<string, HTMLElement[]>();
  private chipWidth = new Map<string, number>();
  private scanQueued = false;

  private following = true;
  private lastAutoScroll = 0;
  private programmaticUntil = 0;
  private roomObserver: MutationObserver;

  constructor(private o: CodeEditorOptions) {
    setupLanguage(monaco);
    const club = () => document.documentElement.dataset.room === "club";
    defineTheme(club());
    this.roomObserver = new MutationObserver(() => {
      defineTheme(club());
      monaco.editor.setTheme("black-glass");
    });
    this.roomObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-room"] });

    this.editor = monaco.editor.create(o.host, {
      model: null,
      theme: "black-glass",
      language: "typescript",
      fontFamily: MONO,
      fontSize: 13,
      lineHeight: 17,
      fontLigatures: false,
      letterSpacing: 0,
      automaticLayout: true,
      fixedOverflowWidgets: true,
      minimap: { enabled: false },
      wordWrap: "on",
      wrappingIndent: "same",
      tabSize: 2,
      insertSpaces: true,
      detectIndentation: false,
      padding: { top: 7, bottom: 7 },
      scrollBeyondLastLine: true,
      // code and numbers line up with the read-only view's (stage.css .ln)
      lineNumbersMinChars: 5,
      lineDecorationsWidth: 24,
      glyphMargin: false,
      folding: false,
      renderLineHighlight: "line",
      renderLineHighlightOnlyWhenFocus: true,
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      guides: { indentation: false, bracketPairs: false },
      bracketPairColorization: { enabled: false },
      matchBrackets: "near",
      occurrencesHighlight: "off",
      selectionHighlight: false,
      stickyScroll: { enabled: false },
      contextmenu: false,
      cursorBlinking: "solid",
      cursorWidth: 2,
      cursorSmoothCaretAnimation: "off",
      smoothScrolling: true,
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false, alwaysConsumeMouseWheel: false },
      suggest: { showStatusBar: false, preview: false, insertMode: "replace" },
      hover: { delay: 350, sticky: true },
      // strings too: sound names in s("…"), banks in .bank("…")
      quickSuggestions: { other: true, comments: false, strings: true },
      quickSuggestionsDelay: 80,
      accessibilitySupport: "auto",
      ariaLabel: "Song source (edit mode). Ctrl or Cmd+Enter plays the edit.",
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
      links: false,
    });
    this.lit = this.editor.createDecorationsCollection();
    this.flashDecos = this.editor.createDecorationsCollection();
    this.errorDecos = this.editor.createDecorationsCollection();
    this.syntaxDecos = this.editor.createDecorationsCollection();
    this.slotDecos = this.editor.createDecorationsCollection();

    // ⌘/Ctrl+Enter: evaluate now (Monaco would insert a line)
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => o.onCommit());
    // Escape with no suggest/hover/find open: leave edit mode
    this.editor.addCommand(
      monaco.KeyCode.Escape,
      () => o.onEscape?.(),
      "!suggestWidgetVisible && !findWidgetVisible && !parameterHintsVisible && !inSnippetMode && !hasMultipleSelections"
    );

    this.disposables.push(
      this.editor.onDidChangeModelContent(() => {
        this.queueScan();
        if (this.applyingExternal || !this.model) return;
        // the lit ranges index into the text before this edit
        this.ranges = [];
        this.rangesDirty = true;
        this.flashes.clear();
        this.flashesDirty = true;
        this.setFollowing(false);
        o.onEdit(this.model.getValue());
      }),
      this.editor.onDidScrollChange((e) => {
        if (!e.scrollTopChanged || performance.now() < this.programmaticUntil) return;
        if (this.editor.hasTextFocus() || this.mouseInside) this.setFollowing(false);
      }),
      this.editor.onMouseDown((e) => this.pick(e)),
      this.editor.onDidChangeConfiguration((e) => {
        if (e.hasChanged(monaco.editor.EditorOption.fontInfo)) this.relayoutChips();
      })
    );
    o.host.addEventListener("mouseenter", this.onEnter);
    o.host.addEventListener("mouseleave", this.onLeave);
    o.followChip.addEventListener("click", this.onFollowChip);
    // Geist Mono is a webfont: measure again once it's in
    void document.fonts?.ready.then(() => monaco.editor.remeasureFonts());
  }

  private mouseInside = false;
  private onEnter = () => (this.mouseInside = true);
  private onLeave = () => (this.mouseInside = false);
  private onFollowChip = () => this.setFollowing(true);

  // ── text ───────────────────────────────────────────────────────────────────

  /** Switch to song file `file` (a model per file keeps each song's undo history) */
  setFile(file: string, text: string) {
    let model = this.models.get(file);
    if (!model) {
      const uri = songModelUri(monaco, file);
      model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, "typescript", uri);
      model.setEOL(monaco.editor.EndOfLineSequence.LF);
      this.models.set(file, model);
    }
    if (this.model === model) return;
    this.model = model;
    this.applyingExternal = true;
    try {
      this.editor.setModel(model);
    } finally {
      this.applyingExternal = false;
    }
    this.errorLine = null;
    this.errorDecos.clear();
    this.clearChips();
    this.ranges = [];
    this.rangesDirty = true;
    this.flashes.clear();
    this.flashesDirty = true;
    this.queueScan();
  }

  /** Show `text`, keeping undo history and the scroll position (an edit of the same file) */
  setSource(text: string, _version: string | undefined, otherFile: boolean) {
    const model = this.model;
    if (!model) return;
    if (model.getValue() !== text) {
      this.applyingExternal = true;
      try {
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
        model.pushStackElement();
      } finally {
        this.applyingExternal = false;
      }
      // the replace moved the error line's decoration: put it back where it belongs
      const line = this.errorLine;
      this.errorLine = null;
      this.setErrorLine(line);
    }
    this.ranges = [];
    this.rangesDirty = true;
    if (otherFile) {
      this.setFollowing(true);
      this.programmaticUntil = performance.now() + 300;
      this.editor.setScrollTop(0, monaco.editor.ScrollType.Immediate);
    }
  }

  value(): string {
    return this.model?.getValue() ?? "";
  }

  private matchCache: { model: monaco.editor.ITextModel; versionId: number; text: string; same: boolean } | null = null;
  /** The buffer says exactly `text` (cached per model version: called every frame) */
  matches(text: string): boolean {
    const model = this.model;
    if (!model) return false;
    const versionId = model.getAlternativeVersionId();
    const c = this.matchCache;
    if (c && c.model === model && c.versionId === versionId && c.text === text) return c.same;
    const same = model.getValueLength() === text.length && model.getValue() === text;
    this.matchCache = { model, versionId, text, same };
    return same;
  }

  setReadOnly(on: boolean) {
    if (on === this.readOnly) return;
    this.readOnly = on;
    this.editor.updateOptions({ readOnly: on, domReadOnly: on, readOnlyMessage: { value: "Your editor owns this buffer. Use **take over** to edit it here." } });
    this.o.host.dataset.readonly = String(on);
  }

  /** An evaluation error (typing or commit) as a marker; null clears it */
  setMarker(error: EvalError | null) {
    const model = this.model;
    if (!model) return;
    if (!error) {
      monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
      return;
    }
    const line = Math.min(Math.max(1, error.line ?? 1), model.getLineCount());
    const maxCol = model.getLineMaxColumn(line);
    let startColumn = error.column ? Math.min(error.column, maxCol) : model.getLineFirstNonWhitespaceColumn(line) || 1;
    let endColumn = maxCol;
    if (error.column) {
      const word = model.getWordAtPosition({ lineNumber: line, column: startColumn });
      if (word) {
        startColumn = word.startColumn;
        endColumn = word.endColumn;
      } else endColumn = Math.min(maxCol, startColumn + 1);
    }
    if (endColumn <= startColumn) {
      startColumn = Math.max(1, maxCol - 1);
      endColumn = maxCol;
    }
    monaco.editor.setModelMarkers(model, MARKER_OWNER, [
      {
        severity: monaco.MarkerSeverity.Error,
        message: error.message,
        source: "strudel",
        startLineNumber: line,
        startColumn,
        endLineNumber: line,
        endColumn,
      },
    ]);
  }

  /** Markers on the current model (tests) */
  markers(owner?: string) {
    if (!this.model) return [];
    return monaco.editor.getModelMarkers({ resource: this.model.uri, owner });
  }

  /** Put the caret at `offset` and give the editor the keyboard */
  focus(offset?: number) {
    if (this.model && offset !== undefined) {
      const pos = this.model.getPositionAt(offset);
      this.editor.setPosition(pos);
      this.editor.revealPositionInCenterIfOutsideViewport(pos);
    }
    this.editor.focus();
  }

  hasFocus() {
    return this.editor.hasTextFocus();
  }

  /** Open the suggest widget at the caret (tests and the help card) */
  suggest() {
    this.editor.trigger("stage", "editor.action.triggerSuggest", {});
  }

  // ── edits from the stage (library, palette, track builder) ────────────────

  /** The selection as offsets into value() (start === end: just the caret), or null without a model */
  selectionOffsets(): { start: number; end: number } | null {
    const model = this.model;
    const sel = this.editor.getSelection();
    if (!model || !sel) return null;
    const a = model.getOffsetAt(sel.getStartPosition());
    const b = model.getOffsetAt(sel.getEndPosition());
    return { start: Math.min(a, b), end: Math.max(a, b) };
  }

  /**
   * Replace [start, end) ranges of value() with new text, as one edit the user
   * made: one undo step (⌘Z reverts all of it), and it reaches onEdit like
   * typing (so it is evaluated and kept like typing). Offsets index into the
   * text before the edit. Refused (false) while read-only or without a model.
   * `caret` puts the caret at that offset of the *new* text; `select` selects
   * a range of it. The edited spot is revealed.
   */
  applyEdits(
    edits: { start: number; end: number; text: string }[],
    { caret, select }: { caret?: number; select?: [number, number] } = {}
  ): boolean {
    const model = this.model;
    if (!model || this.readOnly || !edits.length) return false;
    const ops = edits.map((e) => {
      const a = model.getPositionAt(e.start);
      const b = model.getPositionAt(e.end);
      return { range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), text: e.text, forceMoveMarkers: true };
    });
    this.editor.pushUndoStop();
    const ok = this.editor.executeEdits("stage", ops);
    this.editor.pushUndoStop();
    if (!ok) return false;
    const [from, to] = select ?? (caret !== undefined ? [caret, caret] : [null, null]);
    if (from !== null && to !== null) {
      const a = model.getPositionAt(from);
      const b = model.getPositionAt(to);
      this.editor.setSelection(new monaco.Selection(a.lineNumber, a.column, b.lineNumber, b.column));
      // the editor may have just been shown (an insert from the read-only view):
      // measure first, and again next frame, or the reveal centres on a 0-px viewport
      const range = new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column);
      this.editor.layout();
      this.programmaticUntil = performance.now() + 900;
      this.editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Immediate);
      requestAnimationFrame(() => {
        if (this.model !== model) return;
        this.editor.layout();
        this.editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Immediate);
      });
    }
    return true;
  }

  /** Undo / redo the last edit (tests; the user has ⌘Z) */
  undo() {
    this.editor.trigger("stage", "undo", null);
  }
  redo() {
    this.editor.trigger("stage", "redo", null);
  }

  // ── CodeSurface ────────────────────────────────────────────────────────────

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      this.rangesDirty = true;
      this.editor.layout();
    }
  }

  setColorResolver(fn: (start: number, end: number) => string | undefined) {
    this.colorFor = fn;
  }

  setRanges(ranges: Range[]) {
    this.ranges = ranges;
    this.rangesDirty = true;
  }

  knobChips(): ReadonlyMap<string, HTMLElement[]> {
    return this.chipMap;
  }

  litRanges(): Range[] {
    return this.ranges;
  }

  flash(start: number, end: number, color: string) {
    this.pendingFlashes.set(key(start, end), color);
  }

  setErrorLine(line: number | null) {
    if (line === this.errorLine) return;
    this.errorLine = line;
    const model = this.model;
    if (!model || line === null || line < 1 || line > model.getLineCount()) {
      this.errorDecos.clear();
      return;
    }
    const first = model.getLineFirstNonWhitespaceColumn(line) || 1;
    this.errorDecos.set([
      {
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: "cm-error-line", linesDecorationsClassName: "cm-error-gutter" },
      },
      {
        range: new monaco.Range(line, first, line, model.getLineMaxColumn(line)),
        options: { inlineClassName: "cm-error-text", hoverMessage: { value: "The player reports an error on this line" } },
      },
    ]);
  }

  revealLine(line: number) {
    this.programmaticUntil = performance.now() + 900;
    this.editor.revealLineInCenter(line, monaco.editor.ScrollType.Smooth);
  }

  setFollowing(on: boolean) {
    this.following = on;
    this.o.followChip.hidden = on;
    if (on) this.lastAutoScroll = 0;
  }

  frame(now: number) {
    const model = this.model;
    if (!this.enabled || !model) {
      this.pendingFlashes.clear();
      return;
    }
    const length = model.getValueLength();
    const toRange = (start: number, end: number) => {
      if (end <= start || end > length) return null;
      const a = model.getPositionAt(start);
      const b = model.getPositionAt(end);
      return new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column);
    };

    if (this.rangesDirty) {
      this.rangesDirty = false;
      const decos: monaco.editor.IModelDeltaDecoration[] = [];
      const ys: number[] = [];
      for (const [start, end] of this.ranges) {
        const range = toRange(start, end);
        if (!range) continue;
        const color = this.colors.of(this.colorFor(start, end) ?? "");
        decos.push({
          range,
          options: {
            inlineClassName: `cm-lit ${color}`,
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        });
        if (this.following) ys.push(this.editor.getTopForPosition(range.startLineNumber, range.startColumn));
      }
      this.lit.set(decos);
      if (this.following && ys.length) this.autoScroll(ys, now);
    }

    if (this.pendingFlashes.size) {
      for (const [k, color] of this.pendingFlashes) this.flashes.set(k, { color, until: now + FLASH_MS });
      this.pendingFlashes.clear();
      this.flashesDirty = true;
    }
    for (const [k, f] of this.flashes) {
      if (f.until < now) {
        this.flashes.delete(k);
        this.flashesDirty = true;
      }
    }
    if (this.flashesDirty) {
      this.flashesDirty = false;
      const decos: monaco.editor.IModelDeltaDecoration[] = [];
      for (const [k, f] of this.flashes) {
        const range = toRange(Math.floor(k / PACK), k % PACK);
        if (!range) continue;
        decos.push({ range, options: { inlineClassName: `cm-flash ${this.colors.of(f.color)}` } });
      }
      this.flashDecos.set(decos);
    }
  }

  /** Flashing ranges now (tests) */
  flashingRanges(): Range[] {
    return [...this.flashes.keys()].map((k) => [Math.floor(k / PACK), k % PACK]);
  }

  dispose() {
    this.o.host.removeEventListener("mouseenter", this.onEnter);
    this.o.host.removeEventListener("mouseleave", this.onLeave);
    this.o.followChip.removeEventListener("click", this.onFollowChip);
    this.roomObserver.disconnect();
    this.clearChips();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.editor.dispose();
    for (const model of this.models.values()) model.dispose();
    this.models.clear();
    this.model = null;
    this.colors.dispose();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private pick(e: monaco.editor.IEditorMouseEvent) {
    const model = this.model;
    if (!this.o.onPick || !model || !e.event.leftButton) return;
    if (e.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT || !e.target.position) return;
    const modifier = e.event.metaKey || e.event.ctrlKey;
    if (!this.readOnly && !modifier) return; // a plain click places the caret
    const { lineNumber, column } = e.target.position;
    this.o.onPick({ offset: model.getOffsetAt(e.target.position), line: lineNumber, column });
  }

  /** Syntax extras and knob chips follow the text (once per frame at most) */
  private queueScan() {
    if (this.scanQueued) return;
    this.scanQueued = true;
    requestAnimationFrame(() => {
      this.scanQueued = false;
      this.scan();
    });
  }

  private scan() {
    const model = this.model;
    if (!model) return;
    const text = model.getValue();
    const tokens = tokenize(text);
    // function calls and Types/CONSTANTS carry colour in the code view; Monaco's
    // tokenizer has no "call" token, so they come from the same tokenizer
    const decos: monaco.editor.IModelDeltaDecoration[] = [];
    for (const t of tokens) {
      if (t.kind !== "f" && t.kind !== "t") continue;
      const a = model.getPositionAt(t.start);
      const b = model.getPositionAt(t.end);
      decos.push({ range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), options: { inlineClassName: `t-${t.kind}` } });
    }
    this.syntaxDecos.set(decos);
    this.layoutChips(findKnobCalls(text, tokens).map((c) => ({ name: c.name, position: model.getPositionAt(c.end) })));
  }

  private charWidth() {
    return this.editor.getOption(monaco.editor.EditorOption.fontInfo).typicalHalfwidthCharacterWidth || 7.8;
  }

  /** Characters a knob's chip needs (its widest text, "◉ ", padding) */
  private chipChars(name: string) {
    return Math.max(6, (this.chipWidth.get(name) ?? 4) + 5);
  }

  /** Stage: the widest text a knob's value can take, so chips never jump in width */
  setChipTextWidth(name: string, chars: number) {
    if (this.chipWidth.get(name) === chars) return;
    this.chipWidth.set(name, chars);
    this.queueScan();
  }

  private layoutChips(calls: { name: string; position: monaco.IPosition }[]) {
    const same =
      calls.length === this.chips.length &&
      calls.every((c, i) => c.name === this.chips[i].name && monaco.Position.equals(c.position, this.chips[i].position));
    // the gap each chip sits on: injected text, so the code after it moves aside
    this.slotDecos.set(
      calls.map((c) => ({
        range: new monaco.Range(c.position.lineNumber, c.position.column, c.position.lineNumber, c.position.column),
        options: {
          after: {
            content: " ".repeat(this.chipChars(c.name)),
            inlineClassName: "cm-chip-slot",
            cursorStops: monaco.editor.InjectedTextCursorStops.None,
          },
          showIfCollapsed: true,
        },
      }))
    );
    if (same) {
      this.relayoutChips();
      return;
    }
    const old = this.chips;
    this.chips = [];
    this.chipMap = new Map();
    calls.forEach((c, i) => {
      const reuse = old[i]?.name === c.name ? old[i] : undefined;
      const chip = reuse ?? this.createChip(c.name, i);
      chip.position = c.position;
      this.chips.push(chip);
      const list = this.chipMap.get(c.name) ?? [];
      list.push(chip.el);
      this.chipMap.set(c.name, list);
      if (reuse) this.editor.layoutContentWidget(chip.widget);
      else this.editor.addContentWidget(chip.widget);
    });
    for (const chip of old) if (!this.chips.includes(chip)) this.editor.removeContentWidget(chip.widget);
    this.relayoutChips();
    this.o.onChipsChanged?.();
  }

  private relayoutChips() {
    const w = this.charWidth();
    for (const chip of this.chips) {
      chip.el.style.width = `${Math.round(this.chipChars(chip.name) * w - 0.6 * w)}px`;
      this.editor.layoutContentWidget(chip.widget);
    }
  }

  private createChip(name: string, index: number): Chip {
    const el = document.createElement("span");
    el.className = "knob-chip cm-knob-chip";
    el.dataset.knob = name;
    el.dataset.testid = "knob-chip";
    // like the code view's chips: a pointer shortcut to the knob panel, which is
    // where the knob is reachable by keyboard and screen readers
    el.setAttribute("aria-hidden", "true");
    el.title = `${name}: click to focus the knob`;
    // Monaco would take the mousedown for the caret
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.o.onKnobChip?.(name);
    });
    const chip: Chip = {
      el,
      name,
      position: { lineNumber: 1, column: 1 },
      widget: {
        getId: () => `strudel.knob.${index}.${name}`,
        getDomNode: () => el,
        getPosition: () => ({
          position: chip.position,
          preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
          positionAffinity: monaco.editor.PositionAffinity.LeftOfInjectedText,
        }),
      },
    };
    return chip;
  }

  private clearChips() {
    for (const chip of this.chips) this.editor.removeContentWidget(chip.widget);
    this.chips = [];
    this.chipMap = new Map();
    this.slotDecos?.clear();
  }

  /** Same idea as the code view: glide to the busiest window of lit tokens */
  private autoScroll(tops: number[], now: number) {
    if (now - this.lastAutoScroll < 1200) return;
    const h = this.editor.getLayoutInfo().height;
    if (!h) return;
    const lh = this.editor.getOption(monaco.editor.EditorOption.lineHeight);
    const ys = tops.map((t) => t + lh / 2).sort((a, b) => a - b);
    const span = h * 0.7;
    let best = 0;
    let bestI = 0;
    let bestJ = 0;
    for (let i = 0, j = 0; i < ys.length; i++) {
      while (j < ys.length && ys[j] - ys[i] <= span) j++;
      if (j - i > best) {
        best = j - i;
        bestI = i;
        bestJ = j - 1;
      }
    }
    const scrollTop = this.editor.getScrollTop();
    const margin = h * 0.08;
    const inView = ys.filter((y) => y >= scrollTop + margin && y <= scrollTop + h - margin).length;
    if (inView >= best * 0.75) return;
    const target = Math.max(0, (ys[bestI] + ys[bestJ]) / 2 - h / 2);
    this.lastAutoScroll = now;
    this.programmaticUntil = now + 900;
    this.editor.setScrollTop(target, monaco.editor.ScrollType.Smooth);
  }
}
