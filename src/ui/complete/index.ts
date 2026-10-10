// ═══════════════════════════════════════════════════════════════════════════
// The editor's Strudel language support: one call wires it into Monaco
// ═══════════════════════════════════════════════════════════════════════════
//
// code-editor.ts (the lazy Monaco chunk) calls registerStrudelLanguage() once
// per editor; nothing here is on the boot path. It wires, over the live sound
// registry (registry.ts):
//   - the calm warnings and their quick fixes (warnings.ts)
//   - the one completion provider (inside strings and after a dot), the hover
//     on names inside strings and its ▶ command (provider.ts)
//   - hear-while-browsing in the suggest list (browse.ts)
//
// The registry is one per page: it follows the engine's soundMap and the
// player's ready state, and gets sounds.json (kinds, banks) when it loads.
// theory.json loads with it; completions.json on the first method list.

import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";
import { engine } from "../../engine/strudel";
import * as player from "../../engine/player";
import { loadCompletions, loadSounds, loadTheory, type CompletionsCatalog, type SoundsCatalog } from "../discover/catalog";
import { previewsEnabled } from "../discover/preview-setting.ts";
import { registerProviders, type Providers } from "./provider.ts";
import { HINT_OFF, wireBrowse, type BrowseEvent, type BrowseWiring } from "./browse.ts";
import { createRegistry, type LiveSoundRegistry } from "./registry.ts";
import { diagnose, type Diagnostic } from "./diagnostics.ts";
import { didYouMean } from "./did-you-mean.ts";
import { wireDiagnostics, MARKER_OWNER, type Warnings } from "./warnings.ts";
import type { Theory } from "./types.ts";

let registry: LiveSoundRegistry | null = null;
let theory: Theory | null = null;
const theoryListeners = new Set<() => void>();
/** About how many sounds there are once every sample map is in (sounds.json) */
let soundsTotal = 1500;

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
    (catalog) => {
      soundsTotal = countSounds(catalog) || soundsTotal;
      reg.setCatalog(catalog);
    },
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

/** Keys the soundMap holds once every map is in: sounds that play alone, and each bank's (and alias's) parts */
function countSounds(catalog: SoundsCatalog): number {
  let n = 0;
  for (const info of Object.values(catalog.sounds)) if (info.count !== undefined || info.source === "superdough") n++;
  for (const bank of Object.values(catalog.banks)) n += (1 + bank.aliases.length) * bank.parts.length;
  return n;
}

let completions: Promise<CompletionsCatalog | null> | null = null;
/** completions.json, loaded on first use (never at boot); null if it won't load (TypeScript's plain list then) */
function completionsCatalog(): Promise<CompletionsCatalog | null> {
  completions ??= loadCompletions().catch((e) => {
    console.warn("[strudel-ide] completions.json didn't load: the method list stays unranked", e);
    completions = null; // try again next time
    return null;
  });
  return completions;
}

// one provider for the page, however many editors mount
let providers: Providers | null = null;
let providerUsers = 0;
/** The editor whose suggest list is open (or was last): its previews line */
let activeBrowse: BrowseWiring | null = null;

function acquireProviders(monaco: typeof Monaco, reg: LiveSoundRegistry): Providers {
  providerUsers++;
  providers ??= registerProviders(monaco, {
    registry: reg,
    theory: () => theory,
    completions: completionsCatalog,
    loading: () => ({ count: Object.keys(engine.soundMap.get()).length, total: soundsTotal }),
    hint: () => activeBrowse?.hint() ?? HINT_OFF,
  });
  return providers;
}

function releaseProviders() {
  if (--providerUsers > 0 || !providers) return;
  providers.dispose();
  providers = null;
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
  const prov = acquireProviders(monaco, reg);
  const browse = wireBrowse(monaco, editor, () => prov.lastItems());
  activeBrowse = browse;
  const focus = editor.onDidFocusEditorText(() => (activeBrowse = browse));
  installTestHook(monaco, editor, reg, warnings, prov, browse);
  return {
    dispose() {
      theoryListeners.delete(onTheory);
      warnings.dispose();
      focus.dispose();
      browse.dispose();
      if (activeBrowse === browse) activeBrowse = null;
      releaseProviders();
      if (hookEditor === editor) delete window.__strudelComplete;
    },
  };
}

// ── test hook (e2e, devtools) ───────────────────────────────────────────────

let hookEditor: Monaco.editor.IStandaloneCodeEditor | null = null;

const median = (list: readonly number[]) => (list.length ? [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] : null);

/** The suggest list's rows as they show, in order (only the rendered ones: about a screenful) */
function suggestRows(): SuggestRow[] {
  const rows = [...document.querySelectorAll<HTMLElement>(".suggest-widget.visible .monaco-list-row")];
  rows.sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index));
  const text = (el: Element, sel: string) => el.querySelector(sel)?.textContent ?? "";
  return rows.map((row) => ({
    index: Number(row.dataset.index),
    label: text(row, ".label-name"),
    detail: text(row, ".signature-label"),
    description: text(row, ".details-label"),
    focused: row.classList.contains("focused"),
    deprecated: !!row.querySelector(".deprecated"),
  }));
}

/** The suggest detail pane's text while it shows */
function suggestDetails(): string | null {
  const pane = document.querySelector<HTMLElement>(".suggest-details-container .suggest-details");
  if (!pane || !pane.isConnected || pane.offsetParent === null) return null;
  return pane.innerText;
}

function installTestHook(
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  reg: LiveSoundRegistry,
  warnings: Warnings,
  prov: Providers,
  browse: BrowseWiring
) {
  hookEditor = editor;
  window.__strudelComplete = {
    hookOk: browse.hookOk,
    rows: suggestRows,
    details: suggestDetails,
    previews: () => ({ enabled: previewsEnabled(), on: browse.on(), hint: browse.hint(), log: browse.log.map((e) => ({ ...e })) }),
    timings: () => ({ strings: median(prov.timings.strings), members: median(prov.timings.members), ts: median(prov.timings.ts), tsCalls: prov.tsCalls() }),
    trigger: (id, args) => editor.trigger("e2e", id, args ?? {}),
    pointAt(offset) {
      const model = editor.getModel();
      const node = editor.getDomNode();
      if (!model || !node) return null;
      const pos = model.getPositionAt(offset);
      editor.revealPositionInCenterIfOutsideViewport(pos);
      const at = editor.getScrolledVisiblePosition(pos);
      if (!at) return null;
      const box = node.getBoundingClientRect();
      return { x: box.left + at.left, y: box.top + at.top + at.height / 2 };
    },
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

export interface SuggestRow {
  index: number;
  label: string;
  /** label.detail: " ×8", " 20–20k Hz", " → lpf" */
  detail: string;
  /** label.description, right-aligned: "kick", "effects", "visuals" */
  description: string;
  focused: boolean;
  /** Struck through (Monaco's Deprecated tag) */
  deprecated: boolean;
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
      /** Hear-while-browsing found Monaco's (internal) suggest widget focus hook */
      hookOk: boolean;
      /** The open suggest list's rendered rows, in order */
      rows(): SuggestRow[];
      /** The suggest detail pane's text while it shows, else null */
      details(): string | null;
      /** Hear-while-browsing: the setting, whether previews may play now, the previews line, what happened */
      previews(): { enabled: boolean; on: boolean; hint: string; log: BrowseEvent[] };
      /** Median ms: in-string lists, member-list post-processing, TypeScript round trips; and the round trips so far */
      timings(): { strings: number | null; members: number | null; ts: number | null; tsCalls: number };
      /** Run an editor command (selectLastSuggestion, toggleSuggestionDetails, …) */
      trigger(id: string, args?: unknown): void;
      /** Page coordinates of the text at `offset` (scrolled into view), for the mouse */
      pointAt(offset: number): { x: number; y: number } | null;
    };
  }
}
