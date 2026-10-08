// ═══════════════════════════════════════════════════════════════════════════
// Discovery: the library, the ⌘K palette and the track builder, wired in
// ═══════════════════════════════════════════════════════════════════════════
//
// The one discovery module on the boot path, so it stays small: keys, the
// slots' buttons and lazy loading. Each feature is its own chunk (with its
// CSS), imported the first time it opens; the catalog JSON loads with it
// (./catalog.ts). A page that only plays loads none of them.
//
//   B (stage key), the file bar's "library" key   → ./library.ts
//   ⌘/Ctrl+K anywhere, even in the editor          → ./palette.ts
//   the mixer's "+ track" key, the palette          → ./track-builder.ts
//
// ⌘/Ctrl+K is taken in the capture phase, before Monaco: the palette wins over
// Monaco's own ⌘K chords (⌘K ⌘C etc. — comment is also ⌘/, which still works).
//
// The library and the builder slide over the rack column (the visualizer,
// knobs and mixer): one at a time, set as `data-drawer` on the stage so the
// units underneath are hidden while one is open (stage.css).
//
// stage.ts hands in a DiscoveryHost; feature modules get a Discovery.

import type { CodeEditor } from "../code-editor";
import { askOpen } from "../ask";
import { defaultInsertSpot, insertionFor, type InsertItem } from "./insert";

export type Feature = "library" | "palette" | "builder";
export type Drawer = "library" | "builder";
export type ToastKind = "ok" | "warn" | "error" | "pending";

/** What the stage lends discovery (src/ui/stage.ts) */
export interface DiscoveryHost {
  mode(): "view" | "edit";
  /**
   * Edit mode with the current song in Monaco (entering it, which lazy-loads
   * the editor). null when it didn't load, or when the IDE owns the buffer (a
   * toast says so): nothing may be inserted then.
   */
  editor(): Promise<CodeEditor | null>;
  exitEdit(): void;
  toast(text: string, kind?: ToastKind): void;
  showHelp(): void;
  toggleCodeView(): void;
  /** Follow the music in the code again (F) */
  follow(): void;
}

/** A feature module's handle (createLibrary / createPalette / createTrackBuilder) */
export interface FeatureHandle {
  open(opts?: FeatureOptions): void | Promise<void>;
  close(): void;
  isOpen(): boolean;
}

/** Options a feature's open() understands (others ignore them) */
export interface FeatureOptions {
  /** library: which tab */
  tab?: "sounds" | "functions";
  /** library: a search to start with */
  query?: string;
  /** builder: start at this role (kick, bass, …) */
  role?: string;
  /** builder: start with this snippet id */
  snippet?: string;
}

/** What feature modules get */
export interface Discovery {
  host: DiscoveryHost;
  /**
   * Insert at the editor's caret (entering edit mode first), in the form the
   * context wants (./insert.ts). With no caret placed yet (top of the file) it
   * goes on its own line above createPattern()'s return. Never in a read-only buffer.
   */
  insert(item: InsertItem): Promise<boolean>;
  open(feature: Feature, opts?: FeatureOptions): Promise<void>;
  close(feature: Feature): void;
  /** The rack overlay is `name`'s now (an open other one closes) */
  claimDrawer(name: Drawer): void;
  /** `name` is done with the rack overlay */
  releaseDrawer(name: Drawer): void;
}

export type FeatureFactory = (d: Discovery) => FeatureHandle;

const loaders: Record<Feature, () => Promise<FeatureFactory>> = {
  library: () => import("./library").then((m) => m.createLibrary),
  palette: () => import("./palette").then((m) => m.createPalette),
  builder: () => import("./track-builder").then((m) => m.createTrackBuilder),
};

const NAMES: Record<Feature, string> = { library: "library", palette: "palette", builder: "track builder" };

const $ = (id: string) => document.getElementById(id);

export function mountDiscovery(host: DiscoveryHost) {
  const stage = $("stage")!;
  const handles = new Map<Feature, Promise<FeatureHandle>>();
  const ready = new Map<Feature, FeatureHandle>();

  function handle(feature: Feature): Promise<FeatureHandle> {
    let p = handles.get(feature);
    if (!p) {
      p = loaders[feature]().then((create) => {
        const h = create(discovery);
        ready.set(feature, h);
        return h;
      });
      // a failed chunk load is retried next time
      p.catch(() => handles.delete(feature));
      handles.set(feature, p);
    }
    return p;
  }

  async function open(feature: Feature, opts?: FeatureOptions) {
    let h: FeatureHandle;
    try {
      h = await handle(feature);
    } catch (err) {
      console.warn(`[discover] the ${NAMES[feature]} didn't load`, err);
      host.toast(`the ${NAMES[feature]} didn't load: check your connection`, "error");
      return;
    }
    await h.open(opts);
  }

  function close(feature: Feature) {
    ready.get(feature)?.close();
  }

  const isOpen = (feature: Feature) => ready.get(feature)?.isOpen() ?? false;
  const toggle = (feature: Feature, opts?: FeatureOptions) => (isOpen(feature) ? close(feature) : open(feature, opts));

  let drawer: Drawer | null = null;
  const discovery: Discovery = {
    host,
    insert: async (item) => {
      const ed = await host.editor();
      const sel = ed?.selectionOffsets();
      if (!ed || !sel) return false;
      const text = ed.value();
      // no caret placed yet (a fresh editor has it at the very top): on its own line where the tracks are
      const spot = sel.start === 0 && sel.end === 0 ? defaultInsertSpot(text) : null;
      if (spot) {
        const ins = insertionFor(text, spot.offset, item);
        const line = `${spot.indent}${ins.text}\n`;
        return ed.applyEdits([{ start: spot.offset, end: spot.offset, text: line }], {
          caret: spot.offset + spot.indent.length + ins.caret,
        });
      }
      const ins = insertionFor(text, sel.start, item, sel.end);
      return ed.applyEdits([{ start: sel.start, end: sel.end, text: ins.text }], { caret: sel.start + ins.caret });
    },
    open,
    close,
    claimDrawer(name) {
      if (drawer && drawer !== name) close(drawer === "library" ? "library" : "builder");
      drawer = name;
      stage.dataset.drawer = name;
    },
    releaseDrawer(name) {
      if (drawer !== name) return;
      drawer = null;
      delete stage.dataset.drawer;
    },
  };

  // ── keys ──────────────────────────────────────────────────────────────────
  // ⌘/Ctrl+K: capture phase, so it wins over Monaco (and the browser's search)
  addEventListener(
    "keydown",
    (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "k") return;
      if (askOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) void toggle("palette");
    },
    true
  );

  // B: the stage's shortcut rules (src/ui/stage.ts): text fields keep every key,
  // buttons and toggles keep only their own Space/Enter
  const ownsKey = (target: EventTarget | null, e: KeyboardEvent) => {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable || /^(TEXTAREA|SELECT)$/.test(target.tagName)) return true;
    if (target instanceof HTMLInputElement && target.type !== "checkbox") return true;
    const activator = target.tagName === "BUTTON" || target instanceof HTMLInputElement;
    return activator && (e.code === "Space" || e.key === "Enter");
  };
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || ownsKey(e.target, e)) return;
    if (e.key !== "b" && e.key !== "B") return;
    if (askOpen() || !$("help-overlay")?.hidden) return;
    e.preventDefault();
    void toggle("library");
  });

  $("code-library")?.addEventListener("click", () => void toggle("library"));
  $("add-track")?.addEventListener("click", () => void open("builder"));

  // tests and devtools
  window.__strudelDiscover = {
    open: (feature, opts) => open(feature, opts),
    close,
    isOpen,
    loaded: () => [...ready.keys()],
    insert: discovery.insert,
    auditions: async () => (await import("./audition")).auditions(),
  };
}

declare global {
  interface Window {
    /** Discovery (tests, devtools): see mountDiscovery() */
    __strudelDiscover?: {
      open(feature: Feature, opts?: FeatureOptions): Promise<void>;
      close(feature: Feature): void;
      isOpen(feature: Feature): boolean;
      /** Feature modules loaded so far */
      loaded(): Feature[];
      insert(item: InsertItem): Promise<boolean>;
      /** Recent auditions (loads ./audition.ts if it isn't yet) */
      auditions(): Promise<import("./audition").AuditionRecord[]>;
    };
  }
}
