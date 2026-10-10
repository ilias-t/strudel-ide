// ═══════════════════════════════════════════════════════════════════════════
// The track builder: add a track to the song from a snippet (a lazy chunk, ./hooks.ts)
// ═══════════════════════════════════════════════════════════════════════════
//
// A unit in the #track-builder drawer slot, over the rack column. The steps
// are all on the unit, in order:
//
//   1 role      kick … fx, each key capped with its track colour
//   2 snippet   snippets.json for that role: title, description, code, ▶
//   3 sound     a drum machine (drum roles) or a synth / instrument (melodic
//               roles) for the snippet, or "as written"; ▶ plays the result
//   4 name      a free name for the role (hats, hats2…) so the colour and the
//               lamp follow; validated as the planner will
//   5 add       the line to be added, and the add key
//
// Adding enters edit mode (DiscoveryHost.editor()), plans the edit in the
// compiler worker (src/compile/add-track.ts, via ../../compile/client) and
// applies it as one edit the user made: one undo step, evaluated like typing,
// so a playing song picks the track up right away. A refusal (a song the
// planner can't read, a broken file) is shown here and toasted; nothing is
// changed then.
//
// Opened by the mixer's "+ track" key or the palette (role / snippet preset).
// Esc (focus inside) closes and gives focus back.

import "./track-builder.css";
import * as player from "../../engine/player";
import { trackColor, trackRole } from "../../engine/tracks";
import { nameProblem, pickFreeName } from "../../compile/add-track";
import { tokenize } from "../tokenize";
import { previewCode, previewable, stopAudition } from "./audition";
import { loadSnippets, loadSounds, type Snippet, type SoundsCatalog } from "./catalog";
import type { Discovery, FeatureHandle, FeatureOptions } from "./hooks";
import { drumParts, withSound } from "./snippet-sound";

const ROLES = ["kick", "snare", "hats", "perc", "bass", "pads", "arp", "lead", "acid", "fx"] as const;
/** Roles whose snippets are drum machine parts: they get a bank choice */
const DRUM_ROLES = new Set(["kick", "snare", "hats", "perc", "fx"]);

type El<K extends keyof HTMLElementTagNameMap> = HTMLElementTagNameMap[K];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<El<K>> & { cls?: string; testid?: string } = {}, ...kids: (Node | string)[]): El<K> {
  const { cls, testid, ...rest } = props;
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (testid) e.dataset.testid = testid;
  Object.assign(e, rest);
  for (const k of kids) e.append(k);
  return e;
}

/** Append code as coloured tokens (the code view's classes), text only */
function appendCode(target: HTMLElement, code: string) {
  for (const t of tokenize(code)) {
    const text = code.slice(t.start, t.end);
    if (!t.kind) target.append(text);
    else target.append(el("span", { cls: `t-${t.kind}`, textContent: text }));
  }
}

const roleColor = (role: string) => trackColor(role, 0);

export function createTrackBuilder(d: Discovery): FeatureHandle {
  const root = document.getElementById("track-builder")!;
  const addKey = document.getElementById("add-track");

  // ── state ─────────────────────────────────────────────────────────────────
  let snippets: Snippet[] = [];
  let sounds: SoundsCatalog | null = null;
  let role: string | null = null;
  let snippet: Snippet | null = null;
  let bank = "";
  let sound = "";
  let name = "";
  let nameTouched = false;
  /** Names a new track can't take in the current song (from the worker) */
  let taken = new Set<string>();
  /** Why the current song can't take a track, if the worker said so */
  let songProblem = "";
  let busy = false;
  let returnFocus: HTMLElement | null = null;
  let built = false;

  // ── DOM ───────────────────────────────────────────────────────────────────
  const closeKey = el("button", { cls: "key small tb-close", testid: "builder-close", type: "button", textContent: "close" });
  closeKey.setAttribute("aria-label", "Close the track builder");
  closeKey.title = "Close (Esc)";

  const step = (n: number, label: string, ...kids: Node[]) => {
    const id = `tb-step-${n}`;
    const head = el("div", { cls: "tb-step-head" }, el("span", { cls: "tb-num", textContent: String(n) }), el("span", { cls: "tb-step-name", id, textContent: label }));
    const section = el("div", { cls: "tb-step" }, head, ...kids);
    section.setAttribute("role", "group");
    section.setAttribute("aria-labelledby", id);
    return section;
  };

  const roleKeys = ROLES.map((r) => {
    const b = el("button", { cls: "key tb-role", testid: "builder-role", type: "button" }, el("i", { cls: "tb-cap" }), r);
    b.dataset.role = r;
    b.style.setProperty("--c", roleColor(r));
    b.setAttribute("aria-pressed", "false");
    b.setAttribute("aria-label", `${r} role`);
    return b;
  });
  const roleGrid = el("div", { cls: "tb-roles" }, ...roleKeys);

  const snippetList = el("div", { cls: "screen tb-snippets" });
  snippetList.setAttribute("role", "group");
  snippetList.setAttribute("aria-label", "Snippets");
  const snippetDesc = el("p", { cls: "tb-desc" });
  const snippetCode = el("code", { cls: "tb-code" });
  const snippetPlay = el("button", { cls: "key small tb-play", testid: "builder-snippet-play", type: "button", textContent: "▶ play" });
  snippetPlay.setAttribute("aria-label", "Play the snippet as written");
  const snippetDetail = el("div", { cls: "tb-detail" }, snippetDesc, el("div", { cls: "screen tb-code-row" }, snippetCode, snippetPlay));

  const bankSelect = el("select", { cls: "tb-select", testid: "builder-bank" });
  bankSelect.setAttribute("aria-label", "Drum machine");
  const soundSelect = el("select", { cls: "tb-select", testid: "builder-sound" });
  soundSelect.setAttribute("aria-label", "Sound");
  const bankWrap = el("div", { cls: "screen tb-select-wrap" }, bankSelect);
  const soundWrap = el("div", { cls: "screen tb-select-wrap" }, soundSelect);
  const soundNote = el("p", { cls: "tb-note" });
  const previewPlay = el("button", { cls: "key small tb-play", testid: "builder-preview-play", type: "button", textContent: "▶ play" });
  previewPlay.setAttribute("aria-label", "Play the snippet with this sound");

  const nameInput = el("input", { cls: "tb-name", testid: "builder-name", type: "text", spellcheck: false, autocomplete: "off" });
  nameInput.setAttribute("aria-label", "Track name");
  nameInput.setAttribute("autocapitalize", "off");
  const nameLed = el("i", { cls: "tb-cap" });
  const nameRole = el("span", { cls: "tb-maps" });
  const nameProblemText = el("p", { cls: "tb-note tb-problem", id: "tb-name-problem" });
  nameInput.setAttribute("aria-describedby", "tb-name-problem");

  const preview = el("pre", { cls: "screen tb-preview", testid: "builder-preview" });
  preview.setAttribute("aria-label", "What will be added");
  const message = el("p", { cls: "tb-message", testid: "builder-message" });
  message.setAttribute("role", "status");
  const add = el("button", { cls: "key tb-add", testid: "builder-add", type: "button" }, el("i", { cls: "tb-cap" }), "add track");
  add.setAttribute("aria-label", "Add the track to the song");

  function build() {
    if (built) return;
    built = true;
    root.textContent = "";
    root.append(
      el("div", { cls: "mod-head" }, el("span", { cls: "label" }, el("b", { textContent: "add a track" })), closeKey),
      el(
        "div",
        { cls: "tb-body" },
        step(1, "role", roleGrid),
        step(2, "snippet", snippetList, snippetDetail),
        step(3, "sound", el("div", { cls: "tb-row" }, bankWrap, soundWrap, previewPlay), soundNote),
        step(4, "name", el("div", { cls: "tb-row" }, el("div", { cls: "screen tb-name-wrap" }, nameInput), el("span", { cls: "tb-role-tag" }, nameLed, nameRole)), nameProblemText)
      ),
      el("div", { cls: "tb-foot" }, step(5, "add", preview, el("div", { cls: "tb-foot-row" }, message, add)))
    );

    closeKey.addEventListener("click", () => close());
    roleGrid.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".tb-role");
      if (b?.dataset.role) selectRole(b.dataset.role);
    });
    snippetList.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".tb-snippet");
      const s = snippets.find((x) => x.id === b?.dataset.id);
      if (s) selectSnippet(s);
    });
    snippetPlay.addEventListener("click", () => {
      if (snippet) void previewCode(snippet.code, { cycles: 2, label: snippet.id });
    });
    previewPlay.addEventListener("click", () => {
      if (snippet) void previewCode(code(), { cycles: 2, label: `${snippet.id} · ${bank || sound || "as written"}` });
    });
    bankSelect.addEventListener("change", () => {
      bank = bankSelect.value;
      render();
    });
    soundSelect.addEventListener("change", () => {
      sound = soundSelect.value;
      render();
    });
    nameInput.addEventListener("input", () => {
      name = nameInput.value.trim();
      nameTouched = true;
      render();
    });
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !add.disabled) void addTrack();
    });
    add.addEventListener("click", () => void addTrack());
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      // the stage's shortcuts stay out of the unit (← → would change the song,
      // digits mute tracks); B still toggles the library, like in the library
      if (e.metaKey || e.ctrlKey || e.altKey || e.key === "b" || e.key === "B") return;
      if (e.key.length === 1 || /^Arrow/.test(e.key)) e.stopPropagation();
    });
  }

  // ── choices ───────────────────────────────────────────────────────────────

  /** The code to add: the snippet with the chosen bank / sound */
  const code = () => (snippet ? withSound(snippet.code, { bank: bank || undefined, sound: sound || undefined }) : "");

  function selectRole(r: string, snippetId?: string) {
    const changed = r !== role;
    role = r;
    const forRole = snippets.filter((s) => s.role === r);
    const next = forRole.find((s) => s.id === snippetId) ?? (changed || !snippet ? forRole[0] : snippet);
    renderSnippetList();
    if (changed && !nameTouched) name = "";
    selectSnippet(next ?? null);
  }

  function selectSnippet(s: Snippet | null) {
    if (s !== snippet) {
      bank = "";
      sound = "";
    }
    snippet = s;
    stopAudition();
    if (message.dataset.kind === "warn") say(""); // a refusal belonged to the last try
    renderSounds();
    render();
  }

  /** Banks with every drum part the snippet plays */
  function banksFor(s: Snippet): string[] {
    if (!sounds) return [];
    const parts = drumParts(s.code);
    if (!parts.length || !parts.every((p) => sounds!.sounds[p]?.banks)) return [];
    return Object.entries(sounds.banks)
      .filter(([, info]) => parts.every((p) => info.parts.includes(p)))
      .map(([b]) => b);
  }

  /** Synths and pitched instruments, grouped */
  function soundGroups(): [string, string[]][] {
    if (!sounds) return [];
    const synths = sounds.groups
      .find((g) => g.id === "synths")
      ?.kinds.filter((k) => k.id === "synth" || k.id === "wavetable")
      .flatMap((k) => k.sounds)
      .filter((n) => !sounds!.sounds[n]?.aliasOf) ?? [];
    const pitched = Object.entries(sounds.sounds)
      .filter(([, info]) => info.pitched && !info.aliasOf)
      .map(([n]) => n)
      .sort();
    return [
      ["synths", synths],
      ["instruments", pitched],
    ];
  }

  function fillSelect(select: HTMLSelectElement, groups: [string, string[]][], value: string) {
    select.textContent = "";
    select.append(el("option", { value: "", textContent: "as written" }));
    for (const [label, names] of groups) {
      if (!names.length) continue;
      const parent = groups.length > 1 ? el("optgroup", { label }) : select;
      for (const n of names) parent.append(el("option", { value: n, textContent: n }));
      if (parent !== select) select.append(parent);
    }
    select.value = value;
  }

  function renderSounds() {
    const s = snippet;
    const banks = s && role && DRUM_ROLES.has(role) ? banksFor(s) : [];
    const melodic = !!s && !!role && !DRUM_ROLES.has(role);
    bankWrap.hidden = !banks.length;
    soundWrap.hidden = !melodic;
    if (banks.length) fillSelect(bankSelect, [["banks", banks]], bank);
    if (melodic) fillSelect(soundSelect, soundGroups(), sound);
    previewPlay.disabled = !s || (!banks.length && !melodic);
    soundNote.textContent = !s
      ? "pick a snippet first"
      : banks.length
        ? "a drum machine for the snippet, or as written"
        : melodic
          ? "a synth or an instrument for the snippet, or as written"
          : "this snippet plays its own sounds: no other drum machine has them";
  }

  function renderSnippetList() {
    snippetList.textContent = "";
    const forRole = snippets.filter((s) => s.role === role);
    if (!role) {
      snippetList.append(el("p", { cls: "tb-empty", textContent: "pick a role to see its snippets" }));
      return;
    }
    for (const s of forRole) {
      const b = el("button", { cls: "tb-snippet", testid: "builder-snippet", type: "button" }, el("span", { cls: "tb-snippet-title", textContent: s.title }));
      b.dataset.id = s.id;
      b.setAttribute("aria-pressed", "false");
      b.title = s.description;
      snippetList.append(b);
    }
  }

  /** Everything that follows from the state */
  function render() {
    const color = role ? roleColor(role) : "";
    root.style.setProperty("--c", color || "var(--silk-faint)");
    for (const b of roleKeys) b.setAttribute("aria-pressed", String(b.dataset.role === role));
    for (const b of snippetList.querySelectorAll<HTMLButtonElement>(".tb-snippet")) {
      b.setAttribute("aria-pressed", String(b.dataset.id === snippet?.id));
    }
    snippetDetail.hidden = !snippet;
    if (snippet) {
      snippetDesc.textContent = snippet.description;
      snippetCode.textContent = "";
      appendCode(snippetCode, snippet.code);
      snippetPlay.disabled = !previewable(snippet.code);
    }

    // the name: a free one for the role until the user types their own
    if (!nameTouched && role) name = pickFreeName(role, taken);
    if (nameInput.value.trim() !== name && document.activeElement !== nameInput) nameInput.value = name;
    nameInput.disabled = !role;
    const problem = role ? nameProblem(name, taken) : null;
    const mapsTo = trackRole(name);
    nameLed.style.setProperty("--c", name ? trackColor(name, 0) : "transparent");
    nameRole.textContent = !name ? "" : mapsTo === "other" ? "no role: a spare colour" : `${mapsTo} colour and lamp`;
    nameProblemText.textContent = problem ?? "";
    nameProblemText.hidden = !problem;
    nameInput.setAttribute("aria-invalid", String(!!problem));

    // what will be added
    if (snippet && role && !problem) {
      const line = `const ${name} = ${code()};`;
      preview.textContent = "";
      appendCode(preview, line);
      preview.append("\n");
      appendCode(preview, `return { …, ${name} }`);
    } else {
      preview.textContent = !role ? "pick a role" : !snippet ? "pick a snippet" : "fix the name";
    }
    preview.dataset.empty = String(!(snippet && role && !problem));
    add.disabled = busy || !snippet || !role || !!problem;
    add.style.setProperty("--c", color || "transparent");
    if (!busy && !message.dataset.kind) message.textContent = songProblem ? `this song can't take a track here: ${songProblem}` : "";
  }

  function say(text: string, kind: "" | "warn" | "pending" = "") {
    message.textContent = text;
    if (kind) message.dataset.kind = kind;
    else delete message.dataset.kind;
  }

  // ── the song ──────────────────────────────────────────────────────────────

  /** What the song's tracks are called (for the name step), from the worker */
  async function refreshNames(text: string, file: string) {
    const { trackNames } = await import("../../compile/client");
    const r = await trackNames(text, file);
    taken = new Set(r.taken);
    songProblem = r.ok ? "" : r.reason;
  }

  function shownSource(): { text: string; file: string } | null {
    const src = player.currentSource();
    return src?.text !== undefined ? { text: src.text, file: src.file } : null;
  }

  async function addTrack() {
    if (busy || !snippet || !role) return;
    busy = true;
    say("adding…", "pending");
    render();
    try {
      const ed = await d.host.editor();
      if (!ed) {
        say("the editor isn't available, so nothing was added", "warn");
        return;
      }
      const song = d.host.editing()?.songId;
      const file = player.currentSource()?.file ?? "song.ts";
      const { planAddTrack } = await import("../../compile/client");
      const attempt = async () => {
        const text = ed.value();
        if (!nameTouched) {
          // the default name must be free in the buffer as it is now
          await refreshNames(text, file);
          name = pickFreeName(role!, taken);
        }
        const plan = await planAddTrack(text, file, { name, code: code() });
        return { text, plan };
      };
      let { text, plan } = await attempt();
      if (ed.value() !== text) ({ text, plan } = await attempt()); // edited while planning: once more
      // still editing the same song: out of edit mode the hidden editor keeps the
      // old song's text, and an edit there would reach the song that's current now
      const now = d.host.editing();
      if (ed.value() !== text || !song || now?.editor !== ed || now.songId !== song) {
        plan = { ok: false, reason: "the song changed while the edit was planned: try again" };
      }
      if (!plan.ok) {
        say(plan.reason, "warn");
        d.host.toast(plan.reason, "warn");
        return;
      }
      if (!ed.applyEdits(plan.edits, { select: plan.constRange })) {
        say("the editor didn't take the edit (read-only?)", "warn");
        return;
      }
      const added = name;
      say("");
      busy = false;
      nameTouched = false;
      close({ focusEditor: () => ed.focus() });
      d.host.toast(`added ${added}`, "ok");
    } finally {
      busy = false;
      if (isOpen()) render();
    }
  }

  // ── open / close ──────────────────────────────────────────────────────────

  const isOpen = () => !root.hidden;

  async function open(opts: FeatureOptions = {}) {
    build();
    const wasOpen = isOpen();
    if (!wasOpen) {
      returnFocus = document.activeElement instanceof HTMLElement && !root.contains(document.activeElement) ? document.activeElement : null;
      d.claimDrawer("builder");
      root.hidden = false;
      addKey?.setAttribute("aria-expanded", "true");
      say("");
    }
    if (!snippets.length) {
      say("loading snippets…", "pending");
      try {
        const [sn, so] = await Promise.all([loadSnippets(), loadSounds()]);
        snippets = sn.snippets;
        sounds = so;
        say("");
      } catch {
        say("the snippets didn't load: check your connection and open this again", "warn");
        return;
      }
    }
    const preset = opts.snippet ? snippets.find((s) => s.id === opts.snippet) : undefined;
    const presetRole = preset?.role ?? (opts.role && (ROLES as readonly string[]).includes(opts.role) ? opts.role : undefined);
    if (presetRole) selectRole(presetRole, preset?.id);
    else if (!role) renderSnippetList();
    render();
    if (!wasOpen) (roleKeys.find((b) => b.dataset.role === role) ?? roleKeys[0]).focus();

    const src = shownSource();
    if (src) {
      await refreshNames(src.text, src.file);
      if (isOpen()) render();
    }
  }

  function close({ focusEditor }: { focusEditor?: () => void } = {}) {
    if (root.hidden) return;
    const hadFocus = root.contains(document.activeElement);
    stopAudition();
    root.hidden = true;
    d.releaseDrawer("builder");
    addKey?.setAttribute("aria-expanded", "false");
    if (focusEditor) focusEditor();
    else if (hadFocus) (returnFocus?.isConnected ? returnFocus : addKey)?.focus();
    returnFocus = null;
  }

  return { open, close: () => close(), isOpen };
}
