// ═══════════════════════════════════════════════════════════════════════════
// Library: browse, hear and insert sounds and functions (B, the file bar key)
// ═══════════════════════════════════════════════════════════════════════════
//
// A unit that slides over the rack column (#library, a drawer: ./hooks.ts),
// so the code stays in view for inserting. A lazy chunk with its CSS; the
// catalog JSON loads on the first open (./catalog.ts).
//
//   head       "library" + close (Esc)
//   keys       Sounds | Functions tabs, the search strip
//   screen     sounds by kind (groups → kinds → sounds) or by bank (drum
//              machines and their parts); functions by category, or ranked
//              search results. A function expands to its signatures, docs,
//              params and examples (built on expand, never all 771 up front)
//   readout    the screen's last line: what's playing, or what went wrong
//
// ▶ auditions through ./audition.ts (works while playing or stopped; the
// click unlocks audio). insert goes through d.insert(): it enters edit mode
// (Monaco loads lazily) and puts the item at the caret in the form the code
// there wants (./insert.ts). Focus stays in the library afterwards.
//
// Keys inside the library: arrows move between rows (↑↓) and within a row
// (←→), never reaching the stage (no song stepping); a letter or digit typed
// on a row goes to the search; Esc closes and gives focus back. B still
// toggles (hooks.ts), except in the search field, which keeps every key.
//
// Pure parts (search, ranking, row text) are in ./library-data.ts. Text goes
// in with textContent only.

import "./library.css";
import type { Discovery, FeatureHandle, FeatureOptions } from "./hooks";
import { loadFunctions, loadSounds, type FunctionInfo, type FunctionsCatalog, type SoundsCatalog } from "./catalog";
import { auditionSound, previewCode, previewable, stopAudition, type AuditionRecord } from "./audition";
import type { InsertItem } from "./insert";
import {
  bankPart,
  docBlocks,
  filterBanks,
  filterSoundGroups,
  functionInsert,
  searchFunctions,
  soundAudition,
  soundInsert,
  soundMeta,
  terms,
} from "./library-data";

type Tab = "sounds" | "functions";
type SoundView = "kind" | "bank";

/** Search results shown at once (the rest: narrow the search) */
const RESULT_LIMIT = 80;
const PLAY_GLYPH = "▶";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
  attrs?: Record<string, string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function button(className: string, text: string, testid: string, attrs: Record<string, string> = {}) {
  return el("button", className, text, { type: "button", "data-testid": testid, ...attrs });
}

export function createLibrary(d: Discovery): FeatureHandle {
  const root = document.getElementById("library")!;
  const libKey = document.getElementById("code-library");

  // ── state (kept across open/close) ────────────────────────────────────────
  let tab: Tab = "sounds";
  let view: SoundView = "kind";
  let query = "";
  const openCategories = new Set<string>();
  const openFunctions = new Set<string>();
  let sounds: SoundsCatalog | null = null;
  let functions: FunctionsCatalog | null = null;
  let loadError = false;
  let returnFocus: HTMLElement | null = null;

  // ── DOM ───────────────────────────────────────────────────────────────────
  // room.ts already put its light layers in the slot: append, never replace
  const head = el("div", "mod-head lib-head");
  const title = el("span", "label", undefined, { id: "library-title" });
  title.append(el("b", undefined, "library"));
  const closeKey = button("key small lib-close", "close", "library-close", { title: "Close the library (Esc)" });
  closeKey.append(el("kbd", undefined, "esc", { "aria-hidden": "true" }));
  head.append(title, closeKey);

  const controls = el("div", "lib-controls");
  const tabs = el("div", "lib-tabs", undefined, { role: "tablist", "aria-label": "What to browse" });
  const tabKeys: Record<Tab, HTMLButtonElement> = {
    sounds: button("key small lib-tab", "sounds", "library-tab-sounds", { role: "tab", id: "library-tab-sounds", "aria-controls": "library-panel" }),
    functions: button("key small lib-tab", "functions", "library-tab-functions", {
      role: "tab",
      id: "library-tab-functions",
      "aria-controls": "library-panel",
    }),
  };
  tabs.append(tabKeys.sounds, tabKeys.functions);
  const search = el("input", "lib-search", undefined, {
    type: "search",
    "data-testid": "library-search",
    "aria-label": "Search the library",
    autocomplete: "off",
    spellcheck: "false",
  });
  controls.append(tabs, search);

  const screen = el("div", "screen lib-screen");
  const bar = el("div", "lib-bar");
  const viewKeys = el("span", "lib-views", undefined, { role: "group", "aria-label": "Show sounds" });
  const viewKind = button("chip lib-view", "by kind", "library-view-kind", { "aria-pressed": "true" });
  const viewBank = button("chip lib-view", "by bank", "library-view-bank", { "aria-pressed": "false" });
  viewKeys.append(viewKind, viewBank);
  const count = el("span", "lib-count", undefined, { "aria-live": "polite" });
  bar.append(viewKeys, count);
  const list = el("div", "lib-list", undefined, { role: "tabpanel", id: "library-panel", tabindex: "-1" });
  const readout = el("div", "lib-readout", undefined, { role: "status", "data-testid": "library-status" });
  const readoutLed = el("i", "led lib-led", undefined, { "aria-hidden": "true" });
  const readoutText = el("span", "lib-readout-text");
  readout.append(readoutLed, readoutText);
  screen.append(bar, list, readout);

  root.setAttribute("aria-labelledby", "library-title");
  root.removeAttribute("aria-label");
  root.append(head, controls, screen);

  // ── readout ───────────────────────────────────────────────────────────────
  const IDLE = "▶ to hear it, insert to put it at the cursor";
  function say(text: string, kind: "idle" | "playing" | "error" = "idle") {
    readoutText.textContent = text;
    readout.dataset.kind = kind;
    readoutLed.classList.toggle("on", kind === "playing");
  }
  say(IDLE);

  // ── rendering ─────────────────────────────────────────────────────────────
  function renderTabs() {
    for (const t of ["sounds", "functions"] as Tab[]) {
      const on = t === tab;
      tabKeys[t].setAttribute("aria-selected", String(on));
      tabKeys[t].tabIndex = on ? 0 : -1;
    }
    list.setAttribute("aria-labelledby", `library-tab-${tab}`);
    search.placeholder = tab === "sounds" ? "search sounds, kinds, drum machines" : "search functions, what they do";
    viewKeys.hidden = tab !== "sounds";
    viewKind.setAttribute("aria-pressed", String(view === "kind"));
    viewBank.setAttribute("aria-pressed", String(view === "bank"));
  }

  function message(text: string, retry = false) {
    const p = el("p", "lib-empty", text);
    if (retry) {
      const again = button("chip lib-retry", "try again", "library-retry");
      again.addEventListener("click", () => void load());
      p.append(" ", again);
    }
    list.append(p);
  }

  function render() {
    renderTabs();
    list.replaceChildren();
    list.scrollTop = 0;
    if (loadError) {
      count.textContent = "";
      message("The catalog didn't load. Check your connection.", true);
      return;
    }
    if (tab === "sounds") {
      if (!sounds) return loading();
      if (view === "kind") renderKinds(sounds);
      else renderBanks(sounds);
    } else {
      if (!functions) return loading();
      renderFunctions(functions);
    }
  }

  function loading() {
    count.textContent = "";
    const p = el("p", "lib-empty lib-loading", "loading the catalog");
    p.prepend(el("i", "spinner", undefined, { "aria-hidden": "true" }));
    list.append(p);
  }

  function renderKinds(cat: SoundsCatalog) {
    const groups = filterSoundGroups(cat, query);
    let n = 0;
    for (const g of groups) {
      const section = el("section", "lib-group", undefined, { "aria-label": g.label });
      section.append(el("h3", "lib-group-head", g.label));
      for (const k of g.kinds) {
        const kindHead = el("h4", "lib-kind-head", k.label);
        kindHead.append(el("span", "lib-tally", String(k.sounds.length)));
        section.append(kindHead);
        for (const name of k.sounds) {
          section.append(soundRow(cat, name));
          n++;
        }
      }
      list.append(section);
    }
    count.textContent = query ? `${n} of ${Object.keys(cat.sounds).length} sounds` : `${n} sounds`;
    if (!n) message(`No sound matches “${query.trim()}”. Try a kind (kick, keys, synth) or a machine (909).`);
  }

  function soundRow(cat: SoundsCatalog, name: string) {
    const info = cat.sounds[name];
    const row = el("div", "lib-row lib-sound", undefined, { "data-testid": "library-sound", "data-name": name });
    const play = button("lib-play", PLAY_GLYPH, "library-sound-play", { "aria-label": `play ${name}`, "data-nav": "" });
    const { name: s, opts } = soundAudition(name, info);
    play.addEventListener("click", () => void audition(play, `${s}${opts.bank ? ` on ${opts.bank}` : ""}`, () => auditionSound(s, opts)));
    const ins = button("chip lib-insert", "insert", "library-sound-insert", { "aria-label": `insert ${name}` });
    ins.addEventListener("click", () => void insert(ins, soundInsert(name, info), name));
    row.append(play, el("span", "lib-name", name), metaLine(soundMeta(info)), ins);
    return row;
  }

  function metaLine(parts: string[]) {
    const meta = el("span", "lib-meta");
    for (const p of parts) meta.append(el("span", undefined, p));
    return meta;
  }

  function renderBanks(cat: SoundsCatalog) {
    const names = filterBanks(cat, query);
    for (const name of names) list.append(bankRow(cat, name));
    const total = Object.keys(cat.banks).length;
    count.textContent = query ? `${names.length} of ${total} drum machines` : `${total} drum machines`;
    if (!names.length) message(`No drum machine matches “${query.trim()}”. Try 808, linn or a part like cb.`);
  }

  function bankRow(cat: SoundsCatalog, name: string) {
    const bank = cat.banks[name];
    const part = bankPart(bank);
    const row = el("div", "lib-row lib-bank", undefined, { "data-testid": "library-bank", "data-name": name });
    const play = button("lib-play", PLAY_GLYPH, "library-bank-play", { "aria-label": `play ${name}`, "data-nav": "" });
    play.addEventListener("click", () => void audition(play, `${part} on ${name}`, () => auditionSound(part, { bank: name })));
    const ins = button("chip lib-insert", "insert", "library-bank-insert", { "aria-label": `insert ${name}` });
    ins.addEventListener("click", () => void insert(ins, { type: "bank", name, part }, name));
    const label = el("span", "lib-name", name);
    const aliases = el("span", "lib-meta");
    if (bank.aliases.length) aliases.append(el("span", undefined, `also ${bank.aliases.join(", ")}`));
    const parts = el("div", "lib-parts", undefined, { role: "group", "aria-label": `${name} parts` });
    const words = terms(query);
    for (const p of bank.parts) {
      const chip = button("lib-part", p, "library-bank-part", { "data-part": p, "aria-label": `play ${p} on ${name}` });
      if (words.includes(p)) chip.dataset.match = "true";
      chip.addEventListener("click", () => void audition(chip, `${p} on ${name}`, () => auditionSound(p, { bank: name })));
      parts.append(chip);
    }
    row.append(play, label, aliases, ins, parts);
    return row;
  }

  function renderFunctions(cat: FunctionsCatalog) {
    const labels = new Map(cat.categories.map((c) => [c.id, c.label]));
    if (!terms(query).length) {
      count.textContent = `${cat.functions.length} functions`;
      for (const c of cat.categories) {
        const open = openCategories.has(c.id);
        const section = el("section", "lib-cat");
        const key = button("lib-cat-key", "", "library-category", {
          "data-id": c.id,
          "aria-expanded": String(open),
          "aria-controls": `library-cat-${c.id}`,
          "data-nav": "",
        });
        key.append(el("span", "lib-cat-label", c.label), el("span", "lib-tally", String(c.count)));
        const body = el("div", "lib-cat-body", undefined, { id: `library-cat-${c.id}` });
        body.hidden = !open;
        key.addEventListener("click", () => {
          const now = !openCategories.has(c.id);
          if (now) openCategories.add(c.id);
          else openCategories.delete(c.id);
          key.setAttribute("aria-expanded", String(now));
          body.hidden = !now;
          if (now && !body.childElementCount) for (const f of cat.functions) if (f.category === c.id) body.append(functionRow(f));
        });
        if (open) for (const f of cat.functions) if (f.category === c.id) body.append(functionRow(f));
        section.append(key, body);
        list.append(section);
      }
      return;
    }
    const found = searchFunctions(cat, query);
    count.textContent = `${found.length} of ${cat.functions.length} functions`;
    for (const f of found.slice(0, RESULT_LIMIT)) list.append(functionRow(f, labels.get(f.category)));
    if (found.length > RESULT_LIMIT) message(`${found.length - RESULT_LIMIT} more: add a word to narrow the search.`);
    if (!found.length) message(`No function matches “${query.trim()}”. Try what it does: filter, delay, reverse.`);
  }

  function functionRow(f: FunctionInfo, category?: string) {
    const row = el("div", "lib-row lib-fn", undefined, { "data-testid": "library-function", "data-name": f.name });
    const open = openFunctions.has(f.name);
    const detailId = `library-fn-${f.name.replace(/[^\w-]/g, "_")}`;
    const toggle = button("lib-fn-key", "", "library-function-toggle", {
      "aria-expanded": String(open),
      "aria-controls": detailId,
      "data-nav": "",
    });
    const name = el("span", "lib-name", f.kind === "method" ? `.${f.name}` : f.name);
    const summary = el("span", "lib-summary", plainSummary(f));
    toggle.append(name, summary);
    if (category) toggle.append(el("span", "lib-tag", category));
    const ins = button("chip lib-insert", "insert", "library-function-insert", { "aria-label": `insert ${f.name}` });
    ins.addEventListener("click", () => void insert(ins, functionInsert(f), f.name));
    row.append(toggle, ins);
    const detail = el("div", "lib-detail", undefined, { id: detailId });
    detail.hidden = !open;
    if (open) fillDetail(detail, f);
    row.append(detail);
    toggle.addEventListener("click", () => {
      const now = !openFunctions.has(f.name);
      if (now) openFunctions.add(f.name);
      else openFunctions.delete(f.name);
      toggle.setAttribute("aria-expanded", String(now));
      detail.hidden = !now;
      if (now && !detail.childElementCount) fillDetail(detail, f);
    });
    return row;
  }

  function plainSummary(f: FunctionInfo) {
    const s = docBlocks(f.summary)[0]?.spans.map((x) => x.text).join("") ?? "";
    return s || (f.aliasOf ? `same as ${f.aliasOf}` : "");
  }

  function fillDetail(detail: HTMLElement, f: FunctionInfo) {
    const sigs = el("div", "lib-sigs");
    for (const s of f.signatures) sigs.append(el("code", "lib-sig", s));
    detail.append(sigs);

    const flags = el("div", "lib-flags");
    if (f.aliasOf) flags.append(el("span", "lib-flag", `alias of ${f.aliasOf}`));
    if (f.synonyms.length) flags.append(el("span", "lib-flag", `also ${f.synonyms.join(", ")}`));
    if (f.superdirtOnly) flags.append(el("span", "lib-flag lib-flag-warn", "SuperDirt only: silent in the browser"));
    if (f.deprecated) flags.append(el("span", "lib-flag lib-flag-warn", f.deprecated === true ? "deprecated" : `deprecated: ${f.deprecated}`));
    if (flags.childElementCount) detail.append(flags);

    const doc = el("div", "lib-doc");
    for (const block of docBlocks(f.description)) {
      const node = el(block.type === "li" ? "li" : "p");
      for (const s of block.spans) {
        node.append(s.kind === "text" ? document.createTextNode(s.text) : el(s.kind === "code" ? "code" : s.kind, undefined, s.text));
      }
      doc.append(node);
    }
    if (!doc.childElementCount) doc.append(el("p", "lib-undocumented", "No description upstream yet."));
    detail.append(doc);

    if (f.params.length) {
      const params = el("dl", "lib-params");
      for (const p of f.params) params.append(el("dt", undefined, p.name), el("dd", undefined, p.description || "—"));
      detail.append(params);
    }

    f.examples.forEach((code, i) => {
      const ex = el("div", "lib-example", undefined, { "data-testid": "library-example" });
      const which = f.examples.length > 1 ? `example ${i + 1} of ${f.name}` : `the ${f.name} example`;
      const ok = previewable(code);
      const play = button("lib-play", PLAY_GLYPH, "library-example-play", { "aria-label": `play ${which}`, "data-nav": "" });
      if (ok) play.addEventListener("click", () => void audition(play, which, () => previewCode(code, { label: `${f.name} example ${i + 1}` }), true));
      else {
        play.disabled = true;
        play.title = "This example reaches outside the pattern (outputs, visuals, tempo), so it can't be previewed here";
      }
      const ins = button("chip lib-insert", "insert", "library-example-insert", { "aria-label": `insert ${which}` });
      ins.addEventListener("click", () => void insert(ins, { type: "code", code }, which));
      ex.append(play, el("pre", "lib-code", code), ins);
      detail.append(ex);
    });
  }

  // ── audition and insert ───────────────────────────────────────────────────
  let playing: { btn: HTMLElement; timer?: ReturnType<typeof setInterval>; rec?: AuditionRecord } | null = null;

  function stopShowing() {
    if (!playing) return;
    clearInterval(playing.timer);
    playing.btn.removeAttribute("data-playing");
    playing.btn.closest(".lib-row, .lib-example")?.removeAttribute("data-playing");
    playing = null;
  }

  async function audition(btn: HTMLElement, label: string, run: () => Promise<AuditionRecord>, pattern = false) {
    // a second press on a pattern that's playing stops it
    if (pattern && playing?.btn === btn) {
      stopAudition();
      stopShowing();
      say(IDLE);
      return;
    }
    stopShowing();
    const mine = { btn } as NonNullable<typeof playing>;
    playing = mine;
    btn.dataset.playing = "true";
    btn.closest(".lib-row, .lib-example")?.setAttribute("data-playing", "true");
    say(`${PLAY_GLYPH} ${label}`, "playing");
    let rec: AuditionRecord;
    try {
      rec = await run();
    } catch (err) {
      rec = { id: 0, kind: "sound", label, events: [], status: "error", error: err instanceof Error ? err.message : String(err) };
    }
    if (playing !== mine) return; // another one took over
    mine.rec = rec;
    const settle = () => {
      if (rec.status === "playing") return false;
      stopShowing();
      if (rec.status === "error") say(`couldn't play ${label}: ${rec.error ?? "unknown error"}`, "error");
      else say(IDLE);
      return true;
    };
    if (settle()) return;
    mine.timer = setInterval(settle, 80);
  }

  async function insert(btn: HTMLButtonElement, item: InsertItem, label: string) {
    if (btn.getAttribute("aria-busy") === "true") return;
    btn.setAttribute("aria-busy", "true");
    let ok = false;
    try {
      ok = await d.insert(item);
    } catch (err) {
      console.warn("[library] insert failed", err);
    } finally {
      btn.removeAttribute("aria-busy");
    }
    // keep the keyboard here: the editor shows the inserted text selected
    if (isOpen() && btn.isConnected && !root.contains(document.activeElement)) btn.focus({ preventScroll: true });
    if (!ok) say(`couldn't insert ${label}: the song isn't open for editing here`, "error");
    else if (readout.dataset.kind === "error") say(IDLE);
  }

  // ── loading ───────────────────────────────────────────────────────────────
  async function load() {
    loadError = false;
    const s = loadSounds().then((c) => {
      sounds = c;
      if (tab === "sounds") render();
    });
    const f = loadFunctions().then((c) => {
      functions = c;
      if (tab === "functions") render();
    });
    render();
    try {
      await Promise.all([s, f]);
    } catch (err) {
      console.warn("[library] the catalog didn't load", err);
      loadError = true;
      render();
    }
  }

  // ── controls ──────────────────────────────────────────────────────────────
  function setTab(t: Tab, focusKey = false) {
    if (t !== tab) {
      tab = t;
      render();
    }
    if (focusKey) tabKeys[t].focus();
  }
  tabKeys.sounds.addEventListener("click", () => setTab("sounds"));
  tabKeys.functions.addEventListener("click", () => setTab("functions"));
  const setView = (v: SoundView) => {
    if (v === view) return;
    view = v;
    render();
  };
  viewKind.addEventListener("click", () => setView("kind"));
  viewBank.addEventListener("click", () => setView("bank"));
  search.addEventListener("input", () => {
    query = search.value;
    render();
  });
  closeKey.addEventListener("click", () => close());

  // ── keys ──────────────────────────────────────────────────────────────────
  const navItems = () =>
    [...list.querySelectorAll<HTMLElement>("[data-nav]")].filter((n) => !(n as HTMLButtonElement).disabled && n.offsetParent !== null);
  /** The row a key belongs to: an example, a sound / bank / function row, a category */
  const scopeOf = (n: Element) => n.closest(".lib-example, .lib-row, .lib-cat-key");
  const moveNav = (from: HTMLElement | null, step: 1 | -1) => {
    const items = navItems();
    if (!items.length) return;
    const scope = from && scopeOf(from);
    let i = scope ? items.findIndex((n) => scopeOf(n) === scope) : -1;
    if (i < 0) i = step === 1 ? -1 : items.length;
    const next = items[i + step];
    if (next) {
      next.focus();
      next.scrollIntoView({ block: "nearest" });
    } else if (step === -1) search.focus();
  };

  root.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (target === search) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        e.preventDefault();
        moveNav(null, 1);
      }
      return; // the field keeps every other key (hooks.ts and stage.ts leave inputs alone)
    }
    if (target.getAttribute("role") === "tab") {
      const other: Tab = tab === "sounds" ? "functions" : "sounds";
      const to = e.key === "ArrowRight" || e.key === "ArrowLeft" ? other : e.key === "Home" ? "sounds" : e.key === "End" ? "functions" : null;
      if (to) {
        e.preventDefault();
        e.stopPropagation();
        setTab(to, true);
        return;
      }
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (list.contains(target)) moveNav(target, e.key === "ArrowDown" ? 1 : -1);
      else if (e.key === "ArrowDown") moveNav(null, 1);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      // never the stage's song stepping from in here; within a row, the next key
      e.preventDefault();
      e.stopPropagation();
      const scope = scopeOf(target);
      if (!scope) return;
      const keys = [...scope.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")].filter((b) => scopeOf(b) === scope);
      keys[keys.indexOf(target as HTMLButtonElement) + (e.key === "ArrowRight" ? 1 : -1)]?.focus();
      return;
    }
    // type-ahead: a letter or digit on a row goes to the search (B still toggles the library)
    if (e.key.length === 1 && /[\p{L}\p{N}]/u.test(e.key) && e.key !== "b" && e.key !== "B") {
      e.preventDefault();
      e.stopPropagation();
      search.focus();
      search.value += e.key;
      search.dispatchEvent(new Event("input"));
    }
  });

  // ── open / close ──────────────────────────────────────────────────────────
  function isOpen() {
    return !root.hidden;
  }

  async function open(opts: FeatureOptions = {}) {
    const wasOpen = isOpen();
    if (!wasOpen) {
      const active = document.activeElement;
      returnFocus = active instanceof HTMLElement && active !== document.body && !root.contains(active) ? active : null;
      d.claimDrawer("library");
      root.hidden = false;
      libKey?.setAttribute("aria-expanded", "true");
      root.classList.remove("lib-enter");
      void root.offsetWidth; // restart the slide-in
      root.classList.add("lib-enter");
    }
    if (opts.tab) tab = opts.tab;
    // a category (the cheat sheet's "more"): the Functions tab, unfiltered, that category open
    if (opts.category) {
      tab = "functions";
      openCategories.add(opts.category);
      if (opts.query === undefined) {
        query = "";
        search.value = "";
      }
    }
    if (opts.query !== undefined) {
      query = opts.query;
      search.value = query;
    }
    search.focus();
    search.select();
    if (!sounds || !functions) {
      if (!wasOpen || loadError) await load();
      else render();
    } else render();
    if (opts.category && tab === "functions") {
      list.querySelector(`[data-testid=library-category][data-id="${CSS.escape(opts.category)}"]`)?.scrollIntoView({ block: "start" });
    }
  }

  function close() {
    if (!isOpen()) return;
    const hadFocus = root.contains(document.activeElement);
    stopShowing();
    root.hidden = true;
    d.releaseDrawer("library");
    libKey?.setAttribute("aria-expanded", "false");
    if (hadFocus) {
      const back = returnFocus;
      if (back?.isConnected && back.offsetParent !== null) back.focus({ preventScroll: true });
      else (document.activeElement as HTMLElement | null)?.blur();
    }
    returnFocus = null;
  }

  return { open, close, isOpen };
}
