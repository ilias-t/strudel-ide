// ═══════════════════════════════════════════════════════════════════════════
// The cheat sheet: mini-notation, functions, sounds and keys on one card
// ═══════════════════════════════════════════════════════════════════════════
//
// The card is static in index.html (#help-overlay): its tabs and the Keys
// tab are there, so ./hooks.ts can show it at once. This lazy chunk (with its
// CSS) fills the other tabs and runs the tabs and the search:
//
//   Mini-notation   one row per operator (./cheatsheet-data.ts MINI)
//   Functions       ~60 core functions in eight groups; ranges, links and
//                   synonyms from completions.json when it has them; "more"
//                   opens the library's Functions tab on the group's category
//   Sounds          sounds.json by family, ▶ per sound and drum machine, a
//                   link into the library per family
//   Keys            static (index.html), read here for the search
//   search          every tab plus the intent table (intents.json): one list
//                   of results, ideas first; a tab clears it
//
// ▶ goes through ./audition.ts (previewCode at the song's tempo, auditionSound
// for one hit); a second press on a playing example stops it. insert goes
// through d.insert() like the library (entering edit mode first); when it
// lands, the sheet closes and the editor gets the keyboard, since the card
// hides the code. ↗ opens strudel.cc in a new tab.
//
// Keys inside: the tabs are a tablist (←→, Home, End); ↓ from the search
// goes into the rows, ↑↓ move between rows and ←→ along one; a letter or
// digit typed on a row goes to the search. hooks.ts keeps it modal (Esc,
// Tab, no stage shortcut from inside). Text goes in with textContent only.

import "./cheatsheet.css";
import type { Discovery, FeatureHandle, FeatureOptions } from "./hooks";
import { loadCompletions, loadIntents, loadSounds, type CompletionsCatalog, type Intent, type IntentsCatalog, type SoundsCatalog } from "./catalog";
import { auditionSound, previewCode, stopAudition, type AuditionRecord } from "./audition";
import { previewable } from "./previewable";
import {
  FUNCTION_GROUPS,
  MINI,
  TABS,
  buildIndex,
  functionRows,
  searchSheet,
  soundFamilies,
  docHref,
  type FnRow,
  type KeyRow,
  type MiniRow,
  type SheetTab,
  type SoundItem,
} from "./cheatsheet-data";

const PLAY = "▶";
const IDLE = "▶ plays it at the song's tempo · insert puts it at the cursor · ↗ strudel.cc";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string, attrs?: Record<string, string>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function button(className: string, text: string, testid: string, attrs: Record<string, string> = {}) {
  return el("button", className, text, { type: "button", "data-testid": testid, ...attrs });
}

export function createCheatSheet(d: Discovery): FeatureHandle {
  const $ = (id: string) => document.getElementById(id)!;
  const root = $("help-overlay");
  const card = $("help-card");
  const search = $("cheat-search") as HTMLInputElement;
  const results = $("cheat-results");
  const status = $("cheat-status");
  const tabKeys = new Map(TABS.map((t) => [t.id, $(`cheat-tab-${t.id}`) as HTMLButtonElement]));
  const panels = new Map(TABS.map((t) => [t.id, $(`cheat-panel-${t.id}`)]));

  // ── state (kept across open/close) ────────────────────────────────────────
  let tab: SheetTab = "mini";
  let query = "";
  let completions: CompletionsCatalog | null = null;
  let sounds: SoundsCatalog | null = null;
  let intents: IntentsCatalog | null = null;
  let soundsFailed = false;
  let loading: Promise<unknown> | null = null;
  const filled = new Set<SheetTab>(["keys"]);

  /** The Keys tab's rows, from the static card: text for the search, nodes for the results */
  const keyNodes = [...$("help-keys").querySelectorAll("dt")].map((dt) => ({ dt, dd: dt.nextElementSibling as HTMLElement }));
  const keyRows: KeyRow[] = keyNodes.map(({ dt, dd }) => ({ keys: flat(dt.textContent), what: flat(dd.textContent) }));
  function flat(text: string | null) {
    return (text ?? "").replace(/\s+/g, " ").trim();
  }

  // ── status line ───────────────────────────────────────────────────────────
  function say(text: string, kind: "idle" | "playing" | "error" = "idle") {
    status.textContent = text;
    status.dataset.kind = kind;
  }

  // ── rows ──────────────────────────────────────────────────────────────────
  function row(kind: string, id: string, extra = "") {
    return el("div", `cheat-row cheat-${kind}${extra}`, undefined, { "data-testid": "cheat-row", "data-kind": kind, "data-id": id });
  }

  function actions(code: string | undefined, label: string, href: string | undefined) {
    const box = el("div", "cheat-acts");
    if (code) {
      const play = button("cheat-play", PLAY, "cheat-play", { "aria-label": `play ${label}`, "data-nav": "" });
      if (previewable(code)) play.addEventListener("click", () => void audition(play, label, () => previewCode(code, { label }), true));
      else {
        play.disabled = true;
        play.title = "This can't be previewed here";
      }
      const ins = button("cheat-insert", "insert", "cheat-insert", { "aria-label": `insert ${label}` });
      ins.addEventListener("click", () => void insert(ins, code, label));
      box.append(play, ins);
    }
    if (href) {
      const a = el("a", "cheat-doc", "↗", {
        href,
        target: "_blank",
        rel: "noopener",
        "data-testid": "cheat-doc",
        "aria-label": `${label} on strudel.cc (new tab)`,
        title: "strudel.cc",
      });
      box.append(a);
    }
    return box;
  }

  function miniRow(r: MiniRow) {
    const node = row("mini", r.id);
    const what = el("div", "cheat-what");
    const line = el("p", "cheat-line");
    line.append(el("b", "cheat-name", r.name), " ", el("span", "cheat-text", r.meaning));
    what.append(line, el("code", "cheat-code", r.example));
    node.append(el("span", "cheat-sym", r.symbol, { "aria-label": r.symbol === "␣" ? "space" : r.symbol }), what, actions(r.example, `${r.name} (${r.symbol})`, docHref(r.doc)));
    return node;
  }

  function fnRow(f: FnRow) {
    const node = row("function", f.name);
    const head = el("span", "cheat-sym cheat-fn", f.display);
    const what = el("div", "cheat-what");
    const line = el("p", "cheat-line");
    if (f.range) line.append(el("span", "cheat-range", f.range), " ");
    line.append(el("span", "cheat-text", f.text));
    what.append(line, el("code", "cheat-code", f.example));
    node.append(head, what, actions(f.example, f.name, f.href));
    return node;
  }

  function soundChip(s: SoundItem) {
    const node = el("span", "cheat-chip", undefined, { "data-testid": "cheat-row", "data-kind": "sound", "data-id": s.name });
    const label = s.play.opts.bank ? `${s.play.name} on ${s.name}` : s.name;
    const play = button("cheat-play cheat-chip-key", "", "cheat-play", { "aria-label": `play ${label}`, "data-nav": "" });
    play.append(el("span", "cheat-chip-glyph", PLAY, { "aria-hidden": "true" }), el("span", undefined, s.name));
    play.addEventListener("click", () => void audition(play, label, () => auditionSound(s.play.name, s.play.opts)));
    node.append(play);
    return node;
  }

  function intentRow(it: Intent) {
    const node = row("intent", it.id);
    const what = el("div", "cheat-what");
    const line = el("p", "cheat-line");
    line.append(el("b", "cheat-name", it.phrases[0] ?? it.id), el("span", "cheat-arrow", " → "), el("span", "cheat-fns", it.functions.join(" · ")));
    what.append(line);
    if (it.tip) what.append(el("p", "cheat-text cheat-tip", it.tip));
    if (it.recipe) what.append(el("code", "cheat-code", it.recipe));
    node.append(el("span", "cheat-sym cheat-idea", "idea"), what, actions(it.recipe, it.phrases[0] ?? it.id, undefined));
    return node;
  }

  function keyRow(i: number) {
    const { dt, dd } = keyNodes[i];
    const node = el("div", "cheat-row cheat-key", undefined, { "data-testid": "cheat-row", "data-kind": "key", "data-id": String(i) });
    const k = el("span", "cheat-sym cheat-keys");
    k.append(...[...dt.childNodes].map((n) => n.cloneNode(true)));
    const w = el("span", "cheat-text");
    w.append(...[...dd.childNodes].map((n) => n.cloneNode(true)));
    node.append(k, w);
    return node;
  }

  function note(text: string, retry?: () => void) {
    const p = el("p", "cheat-empty", text);
    if (retry) {
      const again = button("cheat-insert", "try again", "cheat-retry");
      again.addEventListener("click", retry);
      p.append(" ", again);
    }
    return p;
  }

  function loadingNote() {
    const p = el("p", "cheat-loading", "loading the catalog");
    p.prepend(el("i", "spinner", undefined, { "aria-hidden": "true" }));
    return p;
  }

  // ── panels ────────────────────────────────────────────────────────────────
  function fillMini() {
    const p = panels.get("mini")!;
    const intro = el("p", "cheat-intro");
    intro.append(
      "The rhythm language inside the quotes of ",
      el("code", undefined, "s()"),
      ", ",
      el("code", undefined, "note()"),
      " and ",
      el("code", undefined, "n()"),
      ": one cycle is one bar, its steps share it evenly."
    );
    const rows = el("div", "cheat-rows");
    for (const r of MINI) rows.append(miniRow(r));
    p.replaceChildren(intro, rows);
  }

  function fillFunctions() {
    const p = panels.get("functions")!;
    const rows = functionRows(completions);
    const parts: HTMLElement[] = [];
    const intro = el("p", "cheat-intro");
    intro.append("Chain them onto a pattern: ", el("code", undefined, 's("bd sd").fast(2).room(0.3)'), ". The library (B) has all of them.");
    parts.push(intro);
    for (const g of FUNCTION_GROUPS) {
      const section = el("section", "cheat-group", undefined, { "data-testid": "cheat-group", "data-id": g.id, "aria-labelledby": `cheat-group-${g.id}` });
      const head = el("h3", "cheat-group-head");
      head.append(el("span", undefined, g.label, { id: `cheat-group-${g.id}` }));
      const more = button("cheat-more", "more in the library →", "cheat-more", { "aria-label": `more ${g.label.toLowerCase()} functions in the library` });
      more.addEventListener("click", () => toLibrary({ category: g.library }));
      head.append(more);
      section.append(head);
      for (const f of rows) if (f.group === g.id) section.append(fnRow(f));
      parts.push(section);
    }
    p.replaceChildren(...parts);
  }

  function fillSounds() {
    const p = panels.get("sounds")!;
    if (!sounds) {
      p.replaceChildren(soundsFailed ? note("The sounds didn't load. Check your connection.", () => void load(true)) : loadingNote());
      return;
    }
    const parts: HTMLElement[] = [];
    const intro = el("p", "cheat-intro");
    intro.append("Play one with ", el("code", undefined, 's("name")'), "; a drum machine with ", el("code", undefined, '.bank("RolandTR909")'), ".");
    parts.push(intro);
    let section = "";
    for (const fam of soundFamilies(sounds)) {
      if (fam.section !== section) {
        section = fam.section;
        parts.push(el("h3", "cheat-group-head", section));
      }
      const box = el("div", "cheat-family", undefined, { "data-testid": "cheat-family", "data-id": fam.id });
      const head = el("h4", "cheat-family-head");
      head.append(el("span", undefined, fam.id === "banks" ? `${fam.items.length} machines: ▶ plays its kick` : fam.label));
      const link = button("cheat-more", "in the library →", "cheat-library", { "aria-label": `${fam.label} in the library` });
      link.addEventListener("click", () => toLibrary(fam.library));
      head.append(link);
      const chips = el("div", "cheat-chips");
      for (const s of fam.items) chips.append(soundChip(s));
      box.append(head, chips);
      parts.push(box);
    }
    p.replaceChildren(...parts);
  }

  function fill(t: SheetTab) {
    if (t === "mini") fillMini();
    else if (t === "functions") fillFunctions();
    else if (t === "sounds") fillSounds();
    filled.add(t);
  }

  function renderResults() {
    const idx = buildIndex({ completions, sounds, intents, keys: keyRows });
    const r = searchSheet(idx, query);
    const parts: HTMLElement[] = [];
    const block = (title: string, nodes: HTMLElement[], className = "cheat-rows") => {
      if (!nodes.length) return;
      parts.push(el("h3", "cheat-group-head", title));
      const box = el("div", className);
      box.append(...nodes);
      parts.push(box);
    };
    block("Ideas", r.intents.map(intentRow));
    block("Mini-notation", r.mini.map(miniRow));
    block("Functions", r.functions.map(fnRow));
    block("Sounds", r.sounds.map(soundChip), "cheat-chips");
    block("Keys", r.keys.map((k) => keyRow(keyRows.indexOf(k))));
    const q = query.trim();
    if (!r.total) {
      parts.push(note(sounds ? `Nothing here for “${q}”. Try what it does: filter, echo, faster, kick.` : `Nothing yet for “${q}”: the sounds are still loading.`));
    }
    const more = button("cheat-more cheat-more-library", `search the library for “${q}” →`, "cheat-search-library");
    more.addEventListener("click", () => toLibrary({ tab: "functions", query: q }));
    parts.push(el("p", "cheat-foot"));
    parts[parts.length - 1].append(more);
    results.replaceChildren(...parts);
    results.scrollTop = 0;
  }

  /** Show the current tab, or the results while there's a query */
  function render() {
    const searching = !!query.trim();
    card.dataset.searching = String(searching);
    for (const t of TABS) {
      const on = t.id === tab;
      const key = tabKeys.get(t.id)!;
      key.setAttribute("aria-selected", String(on));
      key.tabIndex = on ? 0 : -1;
      panels.get(t.id)!.hidden = searching || !on;
    }
    results.hidden = !searching;
    if (searching) renderResults();
    else if (!filled.has(tab)) fill(tab);
  }

  // ── loading ───────────────────────────────────────────────────────────────
  /** The catalog JSON, each file on its own: a failed one doesn't hold up the rest */
  function load(retry = false) {
    if (loading && !retry) return loading;
    soundsFailed = false;
    const refresh = (t: SheetTab) => {
      filled.delete(t);
      if (!root.hidden) render();
    };
    const c = completions
      ? Promise.resolve()
      : loadCompletions().then((x) => {
          completions = x;
          refresh("functions"); // ranges, links and synonyms arrive
        });
    const s = sounds
      ? Promise.resolve()
      : loadSounds().then(
          (x) => {
            sounds = x;
            refresh("sounds");
          },
          (err) => {
            console.warn("[cheatsheet] the sounds didn't load", err);
            soundsFailed = true;
            refresh("sounds");
          }
        );
    const i = intents
      ? Promise.resolve()
      : loadIntents().then((x) => {
          intents = x;
          if (query.trim() && !root.hidden) render();
        });
    // completions and intents only add to rows that work without them
    loading = Promise.allSettled([c, s, i]);
    return loading;
  }

  // ── audition, insert, the library ─────────────────────────────────────────
  let playing: { btn: HTMLElement; timer?: ReturnType<typeof setInterval> } | null = null;

  function stopShowing() {
    if (!playing) return;
    clearInterval(playing.timer);
    playing.btn.removeAttribute("data-playing");
    playing = null;
  }

  async function audition(btn: HTMLElement, label: string, run: () => Promise<AuditionRecord>, pattern = false) {
    if (pattern && playing?.btn === btn) {
      stopAudition();
      stopShowing();
      say(IDLE);
      return;
    }
    stopShowing();
    const mine: NonNullable<typeof playing> = { btn };
    playing = mine;
    btn.dataset.playing = "true";
    say(`${PLAY} ${label}`, "playing");
    let rec: AuditionRecord;
    try {
      rec = await run();
    } catch (err) {
      rec = { id: 0, kind: "sound", label, events: [], status: "error", error: err instanceof Error ? err.message : String(err) };
    }
    if (playing !== mine) return; // another one took over
    const settle = () => {
      if (rec.status === "playing") return false;
      stopShowing();
      if (rec.status === "error") say(`couldn't play ${label}: ${rec.error ?? "unknown error"}`, "error");
      else say(IDLE);
      return true;
    };
    if (!settle()) mine.timer = setInterval(settle, 80);
  }

  async function insert(btn: HTMLButtonElement, code: string, label: string) {
    if (btn.getAttribute("aria-busy") === "true") return;
    btn.setAttribute("aria-busy", "true");
    let ok = false;
    try {
      ok = await d.insert({ type: "code", code });
    } catch (err) {
      console.warn("[cheatsheet] insert failed", err);
    } finally {
      btn.removeAttribute("aria-busy");
    }
    if (ok) {
      // the card covers the code: get out of the way and hand the editor the keyboard
      d.close("cheatsheet");
      d.host.editing()?.editor.focus();
      return;
    }
    if (!root.hidden && btn.isConnected && !card.contains(document.activeElement)) btn.focus({ preventScroll: true });
    say(`couldn't insert ${label}: put the cursor where an expression starts (after =, or on a line of its own)`, "error");
  }

  function toLibrary(opts: FeatureOptions) {
    d.close("cheatsheet");
    void d.open("library", opts);
  }

  // ── controls ──────────────────────────────────────────────────────────────
  function setTab(t: SheetTab, focusKey = false) {
    const clearing = !!query.trim();
    if (clearing) {
      query = "";
      search.value = "";
    }
    if (t !== tab || clearing) {
      tab = t;
      render();
      panels.get(t)!.scrollTop = 0;
    }
    if (focusKey) tabKeys.get(t)!.focus();
  }
  for (const [id, key] of tabKeys) key.addEventListener("click", () => setTab(id));
  search.addEventListener("input", () => {
    query = search.value;
    render();
  });

  // ── keys (hooks.ts handles Esc, Tab and keeps the stage out) ──────────────
  const view = () => (query.trim() ? results : panels.get(tab)!);
  const navItems = () =>
    [...view().querySelectorAll<HTMLElement>("[data-nav]")].filter((n) => !(n as HTMLButtonElement).disabled && n.getClientRects().length > 0);
  const rowOf = (n: Element) => n.closest(".cheat-row, .cheat-chip");
  function moveNav(from: HTMLElement | null, step: 1 | -1) {
    const items = navItems();
    if (!items.length) return;
    const scope = from && rowOf(from);
    let i = scope ? items.findIndex((n) => rowOf(n) === scope) : -1;
    if (i < 0) i = step === 1 ? -1 : items.length;
    const next = items[i + step];
    if (next) {
      next.focus();
      next.scrollIntoView({ block: "nearest" });
    } else if (step === -1) search.focus();
  }

  card.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target === search) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        e.preventDefault();
        moveNav(null, 1);
      }
      return;
    }
    if (target.getAttribute("role") === "tab") {
      const ids = TABS.map((t) => t.id);
      const at = ids.indexOf(tab);
      const to =
        e.key === "ArrowRight"
          ? ids[(at + 1) % ids.length]
          : e.key === "ArrowLeft"
            ? ids[(at + ids.length - 1) % ids.length]
            : e.key === "Home"
              ? ids[0]
              : e.key === "End"
                ? ids[ids.length - 1]
                : null;
      if (to) {
        e.preventDefault();
        setTab(to, true);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveNav(null, 1);
        return;
      }
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (view().contains(target)) moveNav(target, e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const scope = rowOf(target);
      if (!scope) return;
      const keys = [...scope.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]")];
      const next = keys[keys.indexOf(target) + (e.key === "ArrowRight" ? 1 : -1)];
      if (next) next.focus();
      else moveNav(target, e.key === "ArrowRight" ? 1 : -1); // chips: on to the next one
      return;
    }
    // type-ahead: a letter or digit on a row goes to the search
    if (e.key.length === 1 && /[\p{L}\p{N}]/u.test(e.key)) {
      e.preventDefault();
      search.focus();
      search.value += e.key;
      search.dispatchEvent(new Event("input"));
    }
  });

  // ── open / close (hooks.ts shows and hides the card) ─────────────────────
  function isOpen() {
    return !root.hidden;
  }

  async function open(opts: FeatureOptions = {}) {
    if (opts.sheet) tab = opts.sheet;
    if (opts.query !== undefined) {
      query = opts.query;
      search.value = query;
    }
    render();
    await load();
  }

  function close() {
    if (playing) {
      stopAudition();
      stopShowing();
    }
    say(IDLE);
  }

  say(IDLE);
  return { open, close, isOpen };
}
