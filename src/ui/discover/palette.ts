// ═══════════════════════════════════════════════════════════════════════════
// The command palette (⌘/Ctrl+K): fuzzy search over everything, keyboard first
// ═══════════════════════════════════════════════════════════════════════════
//
// A lazy chunk (./hooks.ts toggles it, even from inside Monaco). A small
// graphite unit near the top of a dimmed room, holding one black-glass screen:
// a search line and a listbox of results grouped by kind (actions, songs,
// sounds, drum machines, functions, snippets). Actions and songs need nothing
// loaded; the catalog (./catalog.ts) loads on the first open behind a
// "loading…" row.
//
//   ↵        run the action / switch song / insert at the editor's caret
//            (closing first; inserting enters edit mode and focuses Monaco)
//   ⇧↵       audition: a sound, a drum machine, a snippet, a function's
//            first example when previewable() (the palette stays open)
//   ⌥↵       a snippet: open the track builder with it
//   ↑↓ PgUp PgDn move (↑↓ wrap), Esc / a click on the dim / ⌘K again close
//
// ARIA: the input is a combobox (aria-activedescendant follows the active
// option); results are a listbox of labelled groups; a polite status says how
// many. Focus goes to the input on open and back where it was on close; Tab
// stays inside. Every key event that passes through the palette stops
// propagating (as in ../ask.ts), so the stage's shortcuts never fire under it.
// All text goes in through textContent.

import "./palette.css";
import * as player from "../../engine/player";
import { auditionSound, previewCode, previewable } from "./audition";
import { loadFunctions, loadSnippets, loadSounds } from "./catalog";
import { rank, type Ranked } from "./fuzzy";
import type { Discovery, FeatureHandle } from "./hooks";
import {
  KIND_TAG,
  actionItems,
  bankItems,
  functionItems,
  groupResults,
  snippetItems,
  songItems,
  soundItems,
  type PaletteGroup,
  type PaletteItem,
} from "./palette-items";

const LIMIT = 80;
const PAGE = 8;

type Result = Ranked<PaletteItem>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** `text` with the characters at `indices` wrapped in <mark> */
function highlighted(text: string, indices: number[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  const hit = new Set(indices);
  let i = 0;
  while (i < text.length) {
    const on = hit.has(i);
    let j = i + 1;
    while (j < text.length && hit.has(j) === on) j++;
    const piece = text.slice(i, j);
    frag.append(on ? el("mark", undefined, piece) : document.createTextNode(piece));
    i = j;
  }
  return frag;
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function createPalette(d: Discovery): FeatureHandle {
  const root = document.getElementById("palette")!;
  root.replaceChildren();

  // ── DOM ────────────────────────────────────────────────────────────────────
  const panel = el("div", "pal");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Command palette");
  panel.dataset.testid = "palette-panel";

  const screen = el("div", "pal-screen screen");
  const search = el("div", "pal-search");
  const led = el("span", "pal-led");
  led.setAttribute("aria-hidden", "true");
  const label = el("label", "sr-only", "Search actions, songs, sounds, drum machines, functions and snippets");
  label.htmlFor = "palette-input";
  const input = el("input", "pal-input");
  input.id = "palette-input";
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "search sounds, functions, snippets, songs, actions";
  input.dataset.testid = "palette-input";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", "palette-list");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-haspopup", "listbox");
  const esc = el("kbd", "pal-esc", "esc");
  esc.setAttribute("aria-hidden", "true");
  search.append(led, label, input, esc);

  const scroll = el("div", "pal-scroll");
  scroll.dataset.testid = "palette-scroll";
  const list = el("div", "pal-list");
  list.id = "palette-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Results");
  list.dataset.testid = "palette-list";
  const note = el("div", "pal-note");
  scroll.append(list, note);
  screen.append(search, scroll);

  const foot = el("div", "pal-foot");
  const keys = el("div", "pal-keys");
  keys.setAttribute("aria-hidden", "true");
  const footKey = (k: string, what: string) => {
    const span = el("span", "pal-key");
    span.append(el("kbd", undefined, k), document.createTextNode(` ${what}`));
    keys.append(span);
    return span;
  };
  const runKey = footKey("↵", "run");
  const playKey = footKey("⇧↵", "play");
  const trackKey = footKey(isMac ? "⌥↵" : "Alt ↵", "add as a track");
  footKey("↑↓", "move");
  footKey("esc", "close");
  const status = el("div", "pal-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.dataset.testid = "palette-status";
  foot.append(keys, status);

  panel.append(el("span", "screw pal-screw"), el("span", "screw pal-screw"), screen, foot);
  root.append(panel);

  // ── state ──────────────────────────────────────────────────────────────────
  let open = false;
  let prevFocus: HTMLElement | null = null;
  let shown: Result[] = [];
  let active = 0;
  let catalog: "idle" | "loading" | "ready" | "error" = "idle";
  let catalogItems: PaletteItem[] = [];
  let counts = { sounds: 0, banks: 0, functions: 0, snippets: 0 };
  let flash = ""; // a passing message in the status (an audition, "nothing to play")
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  function liveItems(): PaletteItem[] {
    const s = player.getState();
    return [
      ...actionItems({
        playing: s.playing,
        loop: s.loop,
        codeView: s.codeView,
        mode: d.host.mode(),
        sections: s.sections,
      }),
      ...songItems(player.allSongs(), player.currentSongId_()),
    ];
  }

  function loadCatalog() {
    if (catalog === "loading" || catalog === "ready") return;
    catalog = "loading";
    Promise.all([loadSounds(), loadFunctions(), loadSnippets()]).then(
      ([sounds, functions, snippets]) => {
        const s = soundItems(sounds);
        const b = bankItems(sounds);
        const f = functionItems(functions, previewable);
        const n = snippetItems(snippets);
        catalogItems = [...s, ...b, ...n, ...f];
        counts = { sounds: s.length, banks: b.length, functions: f.length, snippets: n.length };
        catalog = "ready";
        if (open) render({ keep: true });
      },
      (err: unknown) => {
        console.warn("[palette] the catalog didn't load", err);
        catalog = "error";
        if (open) render({ keep: true });
      }
    );
  }

  // ── rendering ──────────────────────────────────────────────────────────────
  const optionId = (i: number) => `palette-opt-${i}`;
  const keyOf = (r: Result | undefined) => (r ? `${r.item.kind}:${r.item.id}` : "");

  function groupsFor(query: string): PaletteGroup[] {
    if (!query.trim()) {
      const live = liveItems().map((item): Result => ({ item, score: 0, indices: [] }));
      return groupResults(live);
    }
    return groupResults(rank([...liveItems(), ...catalogItems], query, { limit: LIMIT }));
  }

  function row(r: Result, index: number): HTMLElement {
    const { item } = r;
    const opt = el("div", "pal-opt");
    opt.id = optionId(index);
    opt.setAttribute("role", "option");
    opt.setAttribute("aria-selected", "false");
    opt.dataset.testid = "palette-option";
    opt.dataset.kind = item.kind;
    opt.dataset.id = item.id;
    opt.dataset.index = String(index);
    if (item.current) opt.dataset.current = "true";

    const tag = el("span", "pal-tag", KIND_TAG[item.kind]);
    tag.setAttribute("aria-hidden", "true");
    const name = el("span", "pal-name");
    name.append(highlighted(item.name, r.indices));
    if (item.suffix) name.append(el("span", "pal-suffix", item.suffix));
    // a function found by a synonym says which (a bank's aliases are in its detail already)
    const detailText = r.via && item.kind === "function" ? `aka ${r.via} · ${item.detail}` : item.detail;
    const detail = el("span", "pal-detail", detailText);
    if (item.current) detail.prepend(el("span", "pal-current"));
    opt.append(tag, name, detail);
    if (item.hint) {
      const hint = el("kbd", "pal-hint", item.hint);
      hint.setAttribute("aria-hidden", "true");
      opt.append(hint);
    }
    // what a screen reader hears: kind, name, detail
    opt.setAttribute("aria-label", `${KIND_TAG[item.kind]}: ${item.name}${item.suffix ?? ""}, ${detailText}`);
    return opt;
  }

  function setNote(testid: string | null, text = "", sub = "") {
    note.hidden = !testid;
    note.replaceChildren();
    if (!testid) return;
    note.dataset.testid = testid;
    note.append(el("span", "pal-note-main", text));
    if (sub) note.append(el("span", "pal-note-sub", sub));
  }

  function render({ keep = false } = {}) {
    const query = input.value;
    const keepKey = keep && active > 0 ? keyOf(shown[active]) : "";
    const groups = groupsFor(query);
    shown = [];
    list.replaceChildren();
    for (const g of groups) {
      const group = el("div", "pal-group");
      group.setAttribute("role", "group");
      const head = el("div", "pal-group-head", g.label);
      head.id = `palette-group-${g.kind}`;
      head.setAttribute("aria-hidden", "true");
      group.setAttribute("aria-labelledby", head.id);
      group.append(head);
      for (const r of g.results) group.append(row(r, shown.push(r) - 1));
      list.append(group);
    }
    const found = keepKey ? shown.findIndex((r) => keyOf(r) === keepKey) : -1;
    active = found >= 0 ? found : 0;

    const empty = query.trim() !== "" && shown.length === 0;
    if (catalog === "loading") setNote("palette-loading", "loading sounds, functions and snippets…");
    else if (catalog === "error") setNote("palette-error", "the catalog didn't load", "check your connection: it tries again next time you open this");
    else if (empty) setNote("palette-empty", `nothing matches “${query.trim()}”`, "try fewer letters, or another name for it: cutoff finds lpf");
    else if (!query.trim())
      setNote(
        "palette-hint",
        `type to search ${counts.sounds} sounds, ${counts.banks} drum machines, ${counts.functions} functions and ${counts.snippets} snippets`
      );
    else setNote(null);

    input.setAttribute("aria-expanded", String(shown.length > 0));
    setActive(active, { scroll: false });
    scroll.scrollTop = 0;
    if (found >= 0) list.querySelector(`#${optionId(active)}`)?.scrollIntoView({ block: "nearest" });
    flash = "";
    updateStatus();
  }

  function updateStatus() {
    if (flash) {
      status.textContent = flash;
      return;
    }
    const n = shown.length;
    const query = input.value.trim();
    status.textContent = !query ? `${n} actions and songs` : n === 0 ? "no results" : n >= LIMIT ? `top ${n} results` : `${n} ${n === 1 ? "result" : "results"}`;
  }

  function say(text: string) {
    flash = text;
    updateStatus();
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flash = "";
      updateStatus();
    }, 2500);
  }

  function setActive(i: number, { scroll: reveal = true } = {}) {
    list.querySelector('[aria-selected="true"]')?.setAttribute("aria-selected", "false");
    if (!shown.length) {
      active = 0;
      input.removeAttribute("aria-activedescendant");
      updateKeys(undefined);
      return;
    }
    active = Math.max(0, Math.min(shown.length - 1, i));
    const opt = list.querySelector<HTMLElement>(`#${optionId(active)}`);
    opt?.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", optionId(active));
    if (reveal) opt?.scrollIntoView({ block: "nearest" });
    updateKeys(shown[active].item);
  }

  /** The footer's keys follow the active row: what ↵ does, whether ⇧↵ plays, ⌥↵ for snippets */
  function updateKeys(item: PaletteItem | undefined) {
    const verb = !item ? "run" : item.run.type === "insert" ? "insert" : item.run.type === "song" ? "switch" : "run";
    runKey.lastChild!.textContent = ` ${verb}`;
    playKey.dataset.off = String(!item?.play);
    trackKey.hidden = !item?.track;
  }

  function move(by: number, wrap: boolean) {
    if (!shown.length) return;
    const n = shown.length;
    const next = wrap ? (active + by + n) % n : Math.max(0, Math.min(n - 1, active + by));
    setActive(next);
  }

  // ── running a row ──────────────────────────────────────────────────────────
  async function audition(item: PaletteItem) {
    const p = item.play;
    if (!p) {
      say(item.kind === "function" ? "this one has no example to play" : "nothing to play here");
      return;
    }
    say(`playing ${item.name}`);
    const rec =
      p.type === "sound"
        ? await auditionSound(p.name, { pitched: p.pitched, ...(p.bank ? { bank: p.bank } : {}) })
        : await previewCode(p.code, { label: item.name });
    if (rec.status === "error") say(rec.error ?? "it didn't play");
  }

  async function focusEditor() {
    (await d.host.editor())?.focus();
  }

  async function runAction(item: PaletteItem) {
    const r = item.run;
    if (r.type !== "action") return;
    switch (r.action) {
      case "play":
        void player.togglePlay();
        break;
      case "loop":
        player.toggleLoop();
        break;
      case "jump":
        player.jumpToSection(r.section ?? 0);
        break;
      case "next-section":
        player.stepSection(1);
        break;
      case "previous-section":
        player.stepSection(-1);
        break;
      case "edit":
        if (d.host.mode() === "edit") d.host.exitEdit();
        else await focusEditor();
        break;
      case "library":
        await d.open("library");
        break;
      case "library-functions":
        await d.open("library", { tab: "functions" });
        break;
      case "builder":
        await d.open("builder");
        break;
      case "code-view":
        d.host.toggleCodeView();
        break;
      case "follow":
        d.host.follow();
        break;
      case "unmute":
        player.unmuteAll();
        break;
      case "help":
        d.host.showHelp();
        break;
    }
  }

  /** Actions that leave focus where it was before the palette opened */
  const KEEPS_FOCUS = new Set(["play", "loop", "jump", "next-section", "previous-section", "code-view", "follow", "unmute"]);

  async function run(r: Result | undefined, how: "run" | "play" | "track") {
    if (!r) return;
    const { item } = r;
    if (how === "play") return audition(item);
    if (how === "track" && item.track) {
      close({ restore: false });
      await d.open("builder", { role: item.track.role, snippet: item.track.snippet });
      return;
    }
    const run = item.run;
    if (run.type === "action") {
      close({ restore: KEEPS_FOCUS.has(run.action) });
      await runAction(item);
    } else if (run.type === "song") {
      close();
      await player.selectSong(run.id);
    } else {
      close({ restore: false });
      const ok = await d.insert(run.item);
      if (ok) await focusEditor();
      else if (d.host.mode() !== "edit") d.host.toast("couldn't insert it: the editor didn't open", "error");
    }
  }

  // ── keyboard and pointer ───────────────────────────────────────────────────
  const stop = (e: Event) => e.stopPropagation();
  root.addEventListener("keyup", stop);
  root.addEventListener("keypress", stop);
  root.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.isComposing) return;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        move(e.key === "ArrowDown" ? 1 : -1, true);
        break;
      case "PageDown":
      case "PageUp":
        e.preventDefault();
        move(e.key === "PageDown" ? PAGE : -PAGE, false);
        break;
      case "Enter":
        e.preventDefault();
        if (e.repeat) return; // a held Enter (from whatever came before) runs nothing
        void run(shown[active], e.shiftKey ? "play" : e.altKey ? "track" : "run");
        break;
      case "Escape":
        e.preventDefault();
        close();
        break;
      case "Tab":
        // the input is the one stop: Tab stays put
        e.preventDefault();
        input.focus();
        break;
    }
  });

  input.addEventListener("input", () => render());

  // keep focus in the input while the pointer works the list
  list.addEventListener("pointerdown", (e) => e.preventDefault());
  let lastPointer = "";
  list.addEventListener("pointermove", (e) => {
    // only a real move (not the list scrolling under a still pointer) changes the active row
    const at = `${e.clientX},${e.clientY}`;
    if (at === lastPointer) return;
    lastPointer = at;
    const opt = (e.target as HTMLElement).closest<HTMLElement>(".pal-opt");
    if (opt && Number(opt.dataset.index) !== active) setActive(Number(opt.dataset.index), { scroll: false });
  });
  list.addEventListener("click", (e) => {
    const opt = (e.target as HTMLElement).closest<HTMLElement>(".pal-opt");
    if (!opt) return;
    const i = Number(opt.dataset.index);
    setActive(i, { scroll: false });
    void run(shown[i], e.shiftKey ? "play" : e.altKey ? "track" : "run");
  });

  // the dim: only a press that starts and ends on it closes (not a drag out of the panel)
  let downOnDim = false;
  root.addEventListener("pointerdown", (e) => {
    downOnDim = e.target === root;
  });
  root.addEventListener("click", (e) => {
    if (e.target === root && downOnDim) close();
    downOnDim = false;
  });

  // keys aimed outside while open (focus fell to <body>): never the stage's
  const onStrayKey = (e: KeyboardEvent) => {
    if (e.target instanceof Node && root.contains(e.target)) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.key === "Escape") close();
    else input.focus();
  };
  const onFocusIn = (e: FocusEvent) => {
    if (e.target instanceof Node && root.contains(e.target)) return;
    input.focus();
  };

  // ── open / close ───────────────────────────────────────────────────────────
  function show() {
    if (open) {
      input.focus();
      return;
    }
    open = true;
    const at = document.activeElement;
    prevFocus = at instanceof HTMLElement && at !== document.body ? at : null;
    input.value = "";
    root.hidden = false;
    loadCatalog();
    render();
    document.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("keydown", onStrayKey, true);
    input.focus({ preventScroll: true });
  }

  function close({ restore = true } = {}) {
    if (!open) return;
    open = false;
    document.removeEventListener("focusin", onFocusIn, true);
    window.removeEventListener("keydown", onStrayKey, true);
    clearTimeout(flashTimer);
    root.hidden = true;
    input.removeAttribute("aria-activedescendant");
    const prev = prevFocus;
    prevFocus = null;
    if (restore && prev?.isConnected && prev.getClientRects().length > 0) {
      try {
        prev.focus({ preventScroll: true });
      } catch {
        /* nothing to restore to */
      }
    } else if (document.activeElement === input) input.blur();
  }

  return {
    open: show,
    close: () => close(),
    isOpen: () => open,
  };
}
