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
//   ? (stage key), the top bar's ?, the file bar's
//   "help" key, F1 in the editor (stage.ts)         → ./cheatsheet.ts
//
// The cheat sheet's card is static markup in index.html (#help-overlay: its
// tabs and the Keys tab), so it shows the moment it's asked for: this module
// reveals it, focuses its search, keeps it modal (no stage shortcut fires
// from inside, Tab stays inside) and closes it with Esc, giving focus back
// where it was (the editor keeps its caret). The chunk fills the other tabs.
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
import type { SheetTab } from "./cheatsheet-data";

export type Feature = "library" | "palette" | "builder" | "cheatsheet";
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
  /**
   * The song the editor is editing now and the editor, or null outside edit
   * mode. An edit planned across an await must still find the same song here
   * before it is applied: the hidden editor keeps the last song's text, and its
   * edits would reach whichever song is current.
   */
  editing(): { songId: string; editor: CodeEditor } | null;
  exitEdit(): void;
  toast(text: string, kind?: ToastKind): void;
  /** Open the cheat sheet (on its last tab) */
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
  /** library, cheat sheet: a search to start with */
  query?: string;
  /** library: open the Functions tab on this category (functions.json id), expanded and in view */
  category?: string;
  /** cheat sheet: which tab */
  sheet?: SheetTab;
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
  cheatsheet: () => import("./cheatsheet").then((m) => m.createCheatSheet),
};

const NAMES: Record<Feature, string> = { library: "library", palette: "palette", builder: "track builder", cheatsheet: "cheat sheet" };

const $ = (id: string) => document.getElementById(id);

/** What stage.ts drives the cheat sheet with (?, the top bar's ?, F1, Esc) */
export interface DiscoveryControls {
  showHelp(opts?: FeatureOptions): void;
  hideHelp(): void;
  helpOpen(): boolean;
}

/** Text fields keep every key (the stage's rule, src/ui/stage.ts) */
const isTextField = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName) || (t instanceof HTMLInputElement && t.type !== "checkbox"));

export function mountDiscovery(host: DiscoveryHost): DiscoveryControls {
  const stage = $("stage")!;
  const handles = new Map<Feature, Promise<FeatureHandle>>();
  const ready = new Map<Feature, FeatureHandle>();

  // ── the cheat sheet's card (static in index.html; ./cheatsheet.ts fills it) ──
  const sheet = $("help-overlay")!;
  const sheetCard = $("help-card");
  const sheetKeys = [$("help-button"), $("code-help")].filter((k): k is HTMLElement => !!k);
  let sheetReturn: HTMLElement | null = null;
  const visible = (el: HTMLElement) => el.isConnected && el.getClientRects().length > 0;

  function revealSheet() {
    if (!sheet.hidden) return;
    const active = document.activeElement;
    sheetReturn = active instanceof HTMLElement && active !== document.body && !sheet.contains(active) ? active : null;
    sheet.hidden = false;
    for (const k of sheetKeys) k.setAttribute("aria-expanded", "true");
    const search = $("cheat-search") as HTMLInputElement | null;
    search?.focus();
    search?.select();
  }

  function hideSheet() {
    if (sheet.hidden) return;
    ready.get("cheatsheet")?.close();
    const hadFocus = sheet.contains(document.activeElement) || document.activeElement === document.body;
    sheet.hidden = true;
    for (const k of sheetKeys) k.setAttribute("aria-expanded", "false");
    const back = sheetReturn;
    sheetReturn = null;
    if (!hadFocus) return;
    if (back && visible(back)) back.focus({ preventScroll: true });
    else (document.activeElement as HTMLElement | null)?.blur();
  }

  /** The chunk didn't load: the Keys tab is static, show that */
  function sheetFallback() {
    for (const t of sheet.querySelectorAll<HTMLElement>("[role=tab]")) {
      const on = t.dataset.tab === "keys";
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    }
    for (const p of sheet.querySelectorAll<HTMLElement>("[role=tabpanel]")) p.hidden = p.id !== "cheat-panel-keys";
  }

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
    if (feature === "cheatsheet") revealSheet(); // at once: the chunk fills it in
    let h: FeatureHandle;
    try {
      h = await handle(feature);
    } catch (err) {
      console.warn(`[discover] the ${NAMES[feature]} didn't load`, err);
      host.toast(`the ${NAMES[feature]} didn't load: check your connection`, "error");
      if (feature === "cheatsheet") sheetFallback();
      return;
    }
    if (feature === "cheatsheet" && sheet.hidden) return; // closed while it loaded
    await h.open(opts);
  }

  function close(feature: Feature) {
    if (feature === "cheatsheet") hideSheet();
    else ready.get(feature)?.close();
  }

  const isOpen = (feature: Feature) => (feature === "cheatsheet" ? !sheet.hidden : (ready.get(feature)?.isOpen() ?? false));
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
      const refuse = () => {
        host.toast(
          item.type === "function" && item.kind === "method"
            ? `.${item.name}() chains onto a pattern: put the cursor right after one, like s("bd")|`
            : "code doesn't go here: put the cursor where an expression starts (after =, in a call's parentheses)",
          "warn"
        );
        return false;
      };
      if (spot) {
        const ins = insertionFor(text, spot.offset, item, spot.offset, { ownLine: true });
        if (!ins) return refuse();
        const line = `${spot.indent}${ins.text}\n`;
        return ed.applyEdits([{ start: spot.offset, end: spot.offset, text: line }], {
          caret: spot.offset + spot.indent.length + ins.caret,
        });
      }
      const ins = insertionFor(text, sel.start, item, sel.end);
      if (!ins) return refuse();
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

  // the cheat sheet: its keys, the close key, a click on the dim; modal
  for (const k of sheetKeys) k.addEventListener("click", () => void toggle("cheatsheet"));
  $("help-close")?.addEventListener("click", () => hideSheet());
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) hideSheet();
  });
  sheet.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      hideSheet();
      return;
    }
    if (e.key === "F1") {
      e.preventDefault(); // already open (and not the browser's help)
      e.stopPropagation();
      return;
    }
    if (e.key === "Tab" && sheetCard) {
      // keep Tab inside the card
      const stops = [...sheetCard.querySelectorAll<HTMLElement>("button, input, a[href], [tabindex='0']")].filter(
        (n) => !(n as HTMLButtonElement).disabled && n.tabIndex >= 0 && visible(n)
      );
      const first = stops[0];
      const last = stops[stops.length - 1];
      const at = document.activeElement;
      if (first && last && (e.shiftKey ? at === first || at === sheetCard : at === last)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
      return;
    }
    if (e.metaKey || e.ctrlKey) return; // ⌘K (capture phase above) and the browser's own
    e.stopPropagation(); // the stage's shortcuts never fire from in here
    if (e.key === "?" && !isTextField(e.target)) {
      e.preventDefault();
      hideSheet();
    }
  });

  // tests and devtools
  window.__strudelDiscover = {
    open: (feature, opts) => open(feature, opts),
    close,
    isOpen,
    loaded: () => [...ready.keys()],
    insert: discovery.insert,
    auditions: async () => (await import("./audition")).auditions(),
  };

  return {
    showHelp: (opts) => void open("cheatsheet", opts),
    hideHelp: hideSheet,
    helpOpen: () => !sheet.hidden,
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
