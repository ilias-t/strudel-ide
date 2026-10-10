// ═══════════════════════════════════════════════════════════════════════════
// Warnings in Monaco: diagnose() as markers, "Change to …" quick fixes
// ═══════════════════════════════════════════════════════════════════════════
//
// Markers have their own owner ("strudel-sounds"), so they never clear or get
// cleared by the eval-error marker ("strudel") or TypeScript's, and carry
// source "strudel" (Monaco prints it in the hover). Severity is Warning, or
// Info for a variant that wraps: never Error. code-editor.css draws them as a
// dotted amber (warning) or faint grey (info) underline, not a red wave.
//
// When they run:
//   - 300 ms after the text settles, skipping the word being typed (the caret
//     at the last edit, while the editor has focus);
//   - when the caret leaves that skipped word, or the editor loses focus;
//   - when the registry or the theory changes (samples loaded, catalog in);
//   - on a model switch (the old model's markers are cleared).
// Moving the caret onto a flagged word keeps its marker, so Ctrl+. fixes it.

import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";
import type { SoundRegistry } from "./types.ts";
import { diagnose, type Diagnostic, type DiagnoseOptions } from "./diagnostics.ts";

type M = typeof Monaco;

export const MARKER_OWNER = "strudel-sounds";
export const MARKER_SOURCE = "strudel";
const TYPING_DELAY = 300;

export interface WarningsOptions {
  registry: SoundRegistry;
  /** Scale names (theory.json); null until loaded */
  theory: () => DiagnoseOptions["theory"];
  /** Names the catalog knows, when a sample map failed to load */
  fallback: () => DiagnoseOptions["fallback"];
}

export interface Warnings extends Monaco.IDisposable {
  /** Run now (tests): no debounce */
  flush(): void;
  /** Run soon (something outside the text changed) */
  refresh(): void;
}

/** The last diagnostics per model (the quick fixes read them) */
const lastRun = new WeakMap<Monaco.editor.ITextModel, { versionId: number; diagnostics: Diagnostic[]; markers: Monaco.editor.IMarkerData[] }>();
const providers = new WeakSet<object>();

export function wireDiagnostics(monaco: M, editor: Monaco.editor.IStandaloneCodeEditor, o: WarningsOptions): Warnings {
  registerQuickFixes(monaco);
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Caret offset at the last edit while focused: the word there is being typed */
  let typingAt: number | null = null;
  /** The word the last run skipped for the caret */
  let skipped: [number, number] | null = null;
  const touched = new Set<Monaco.editor.ITextModel>();

  const caretOffset = () => {
    const model = editor.getModel();
    const pos = editor.getPosition();
    return model && pos ? model.getOffsetAt(pos) : null;
  };
  const inSkipped = (offset: number | null) => offset !== null && !!skipped && offset >= skipped[0] && offset <= skipped[1];

  const clear = (model: Monaco.editor.ITextModel | null) => {
    if (!model || model.isDisposed()) return;
    monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
    lastRun.delete(model);
  };

  const run = () => {
    clearTimeout(timer);
    timer = undefined;
    const model = editor.getModel();
    if (!model || model.isDisposed()) return;
    if (!o.registry.ready()) {
      clear(model);
      return;
    }
    if (!editor.hasTextFocus()) typingAt = null;
    skipped = null;
    const text = model.getValue();
    const diagnostics = diagnose(text, o.registry, {
      caret: typingAt,
      theory: o.theory(),
      fallback: o.fallback(),
      onSkip: (a, b) => (skipped = [a, b]),
    });
    // the caret already left the word typed last (moved before this ran): don't skip it
    if (skipped && !inSkipped(caretOffset())) {
      typingAt = null;
      run();
      return;
    }
    touched.add(model);
    const markers: Monaco.editor.IMarkerData[] = diagnostics.map((d) => {
      const a = model.getPositionAt(d.start);
      const b = model.getPositionAt(d.end);
      return {
        severity: d.severity === "info" ? monaco.MarkerSeverity.Info : monaco.MarkerSeverity.Warning,
        message: d.message,
        source: MARKER_SOURCE,
        startLineNumber: a.lineNumber,
        startColumn: a.column,
        endLineNumber: b.lineNumber,
        endColumn: b.column,
      };
    });
    const before = lastRun.get(model);
    lastRun.set(model, { versionId: model.getVersionId(), diagnostics, markers });
    // unchanged: leave the markers alone (any marker change makes Monaco
    // re-request code actions, which closes an open quick-fix menu)
    if (before && sameMarkers(before.markers, markers)) return;
    monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
  };

  const queue = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  };

  const disposables: Monaco.IDisposable[] = [
    editor.onDidChangeModelContent(() => {
      typingAt = editor.hasTextFocus() ? caretOffset() : null;
      skipped = null;
      queue(TYPING_DELAY);
    }),
    editor.onDidChangeCursorPosition(() => {
      if (!skipped || timer !== undefined || inSkipped(caretOffset())) return;
      typingAt = null;
      queue(30);
    }),
    editor.onDidBlurEditorText(() => {
      if (typingAt === null && !skipped) return;
      typingAt = null;
      if (skipped) queue(30);
    }),
    editor.onDidChangeModel((e) => {
      if (e.oldModelUrl) clear(monaco.editor.getModel(e.oldModelUrl));
      typingAt = null;
      skipped = null;
      queue(0);
    }),
  ];
  const offRegistry = o.registry.onChange(() => queue(30));
  queue(0);

  return {
    flush: run,
    refresh: () => queue(30),
    dispose() {
      clearTimeout(timer);
      offRegistry();
      for (const d of disposables) d.dispose();
      for (const model of touched) clear(model);
      touched.clear();
    },
  };
}

function sameMarkers(a: Monaco.editor.IMarkerData[], b: Monaco.editor.IMarkerData[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (m, i) =>
        m.message === b[i].message &&
        m.severity === b[i].severity &&
        m.startLineNumber === b[i].startLineNumber &&
        m.startColumn === b[i].startColumn &&
        m.endLineNumber === b[i].endLineNumber &&
        m.endColumn === b[i].endColumn
    )
  );
}

/** "Change to "bd"" for our markers: once per Monaco (providers are global) */
function registerQuickFixes(monaco: M) {
  if (providers.has(monaco)) return;
  providers.add(monaco);
  // Monaco cancels a pending code-action request whenever the caret or the
  // markers move; for a Ctrl+. request it hands that promise to its progress
  // indicator without a catch, so the cancellation surfaces as an unhandled
  // rejection. VS Code drops those globally (isCancellationError); so do we,
  // and only those.
  window.addEventListener("unhandledrejection", (e) => {
    const r: unknown = e.reason;
    if (r instanceof Error && r.name === "Canceled" && r.message === "Canceled") e.preventDefault();
  });
  monaco.languages.registerCodeActionProvider("typescript", {
    provideCodeActions(model, _range, context) {
      const run = lastRun.get(model);
      const actions: Monaco.languages.CodeAction[] = [];
      if (!run || run.versionId !== model.getVersionId()) return { actions, dispose() {} };
      for (const marker of context.markers) {
        if (marker.source !== MARKER_SOURCE) continue;
        const d = run.diagnostics.find((x) => {
          if (x.message !== marker.message) return false;
          const a = model.getPositionAt(x.start);
          const b = model.getPositionAt(x.end);
          return a.lineNumber === marker.startLineNumber && a.column === marker.startColumn && b.lineNumber === marker.endLineNumber && b.column === marker.endColumn;
        });
        if (!d) continue;
        d.fixes.slice(0, 3).forEach((fix, i) => {
          actions.push({
            title: `Change to "${fix}"`,
            kind: "quickfix",
            diagnostics: [marker],
            isPreferred: i === 0,
            edit: {
              edits: [
                {
                  resource: model.uri,
                  versionId: model.getVersionId(),
                  textEdit: {
                    range: {
                      startLineNumber: marker.startLineNumber,
                      startColumn: marker.startColumn,
                      endLineNumber: marker.endLineNumber,
                      endColumn: marker.endColumn,
                    },
                    text: fix,
                  },
                },
              ],
            },
          });
        });
      }
      return { actions, dispose() {} };
    },
  });
}
