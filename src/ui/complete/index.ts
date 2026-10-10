// ═══════════════════════════════════════════════════════════════════════════
// The editor's Strudel language support: one call wires it into Monaco
// ═══════════════════════════════════════════════════════════════════════════
//
// code-editor.ts (the lazy Monaco chunk) calls registerStrudelLanguage() once
// per editor; nothing here is on the boot path. Today it wires the calm
// warnings and their quick fixes (warnings.ts) over the live sound registry
// (registry.ts); completions and hovers join here.
//
// The registry is one per page: it follows the engine's soundMap and the
// player's ready state, and gets sounds.json (kinds, banks) when it loads.

import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";
import { engine } from "../../engine/strudel";
import * as player from "../../engine/player";
import { loadSounds, loadTheory } from "../discover/catalog";
import { createRegistry, type LiveSoundRegistry } from "./registry.ts";
import { diagnose, type Diagnostic } from "./diagnostics.ts";
import { didYouMean } from "./did-you-mean.ts";
import { wireDiagnostics, MARKER_OWNER, type Warnings } from "./warnings.ts";
import type { Theory } from "./types.ts";

let registry: LiveSoundRegistry | null = null;
let theory: Theory | null = null;
const theoryListeners = new Set<() => void>();

/** The live sound registry (created on first use, kept for the page's life) */
export function soundRegistry(): LiveSoundRegistry {
  if (registry) return registry;
  const reg = createRegistry({ soundMap: engine.soundMap, catalog: null, ready: () => player.getState().ready });
  registry = reg;
  let ready = player.getState().ready;
  player.onStateChange((s) => {
    if (s.ready === ready) return;
    ready = s.ready;
    reg.refresh();
  });
  loadSounds().then(
    (catalog) => reg.setCatalog(catalog),
    (e) => console.warn("[strudel-ide] sounds.json didn't load: warnings use the live sounds only", e)
  );
  loadTheory().then(
    (t) => {
      theory = t;
      for (const fn of theoryListeners) fn();
    },
    () => {} // no scale warnings, nothing else lost
  );
  return reg;
}

/** Strudel support for one editor; dispose with the editor */
export function registerStrudelLanguage(monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor): Monaco.IDisposable {
  const reg = soundRegistry();
  const warnings = wireDiagnostics(monaco, editor, {
    registry: reg,
    theory: () => theory,
    fallback: () => (reg.degraded() ? { has: reg.catalogHas, isBank: reg.catalogHasBank } : null),
  });
  const onTheory = () => warnings.refresh();
  theoryListeners.add(onTheory);
  installTestHook(monaco, editor, reg, warnings);
  return {
    dispose() {
      theoryListeners.delete(onTheory);
      warnings.dispose();
      if (hookEditor === editor) delete window.__strudelComplete;
    },
  };
}

// ── test hook (e2e, devtools) ───────────────────────────────────────────────

let hookEditor: Monaco.editor.IStandaloneCodeEditor | null = null;

function installTestHook(monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor, reg: LiveSoundRegistry, warnings: Warnings) {
  hookEditor = editor;
  window.__strudelComplete = {
    owner: MARKER_OWNER,
    ready: () => reg.ready(),
    version: () => reg.version(),
    degraded: () => reg.degraded(),
    flush: () => warnings.flush(),
    markers(owner) {
      const model = editor.getModel();
      if (!model) return [];
      return monaco.editor.getModelMarkers({ resource: model.uri, owner }).map((m) => ({
        owner: m.owner,
        severity: m.severity === monaco.MarkerSeverity.Error ? "error" : m.severity === monaco.MarkerSeverity.Warning ? "warning" : m.severity === monaco.MarkerSeverity.Info ? "info" : "hint",
        message: m.message,
        source: m.source,
        startLineNumber: m.startLineNumber,
        startColumn: m.startColumn,
        endLineNumber: m.endLineNumber,
        endColumn: m.endColumn,
      }));
    },
    diagnose: (text) => diagnose(text, reg, { theory, fallback: reg.degraded() ? { has: reg.catalogHas, isBank: reg.catalogHasBank } : null }),
    didYouMean,
  };
}

export interface CompleteMarker {
  owner: string;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

declare global {
  interface Window {
    /** The editor's Strudel language support (tests, devtools): set once the Monaco chunk mounts */
    __strudelComplete?: {
      /** The warnings' marker owner ("strudel-sounds") */
      owner: string;
      /** Samples finished loading: warnings run */
      ready(): boolean;
      /** The registry's version (bumps once per settled change) */
      version(): number;
      /** A sample map failed to load: catalog names count as known */
      degraded(): boolean;
      /** Run the warnings now, without the typing debounce */
      flush(): void;
      /** Markers on the editor's model, every owner unless one is given, with severity and range */
      markers(owner?: string): CompleteMarker[];
      /** diagnose() over any text with the live registry */
      diagnose(text: string): Diagnostic[];
      didYouMean: typeof didYouMean;
    };
  }
}
