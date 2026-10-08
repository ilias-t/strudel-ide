// ═══════════════════════════════════════════════════════════════════════════
// What the ⌘K palette lists: pure builders, one per source
// ═══════════════════════════════════════════════════════════════════════════
//
// Data in, rows out: no DOM, no player, no catalog loading (./palette.ts does
// those and runs what a row says). A row says what Enter does (`run`), what
// Shift+Enter plays (`play`), and for a snippet what Alt+Enter hands the
// track builder (`track`).

import type { Candidate, Ranked } from "./fuzzy.ts";
import type { FunctionsCatalog, SnippetsCatalog, SoundsCatalog } from "./catalog.ts";
import type { InsertItem } from "./insert.ts";

export type PaletteKind = "action" | "song" | "sound" | "bank" | "function" | "snippet";

export type ActionId =
  | "play"
  | "loop"
  | "jump"
  | "next-section"
  | "previous-section"
  | "edit"
  | "library"
  | "library-functions"
  | "builder"
  | "code-view"
  | "follow"
  | "unmute"
  | "help";

export type PaletteRun =
  | { type: "action"; action: ActionId; section?: number }
  | { type: "song"; id: string }
  | { type: "insert"; item: InsertItem };

export type PalettePlay =
  | { type: "sound"; name: string; pitched?: boolean; bank?: string }
  | { type: "code"; code: string };

export interface PaletteItem extends Candidate {
  kind: PaletteKind;
  /** Unique within its kind (data-id) */
  id: string;
  /** Short words after the name, in the name's type (a function's parameters) */
  suffix?: string;
  detail: string;
  /** The stage key that does the same (actions) */
  hint?: string;
  /** The song that's selected now */
  current?: true;
  run: PaletteRun;
  play?: PalettePlay;
  /** Alt+Enter: start the track builder with this snippet */
  track?: { role: string; snippet: string };
}

/** Tie-break order: actions and songs before the catalog */
export const KIND_WEIGHT: Record<PaletteKind, number> = { action: 0, song: 1, sound: 2, bank: 2, snippet: 3, function: 4 };

export const KIND_LABEL: Record<PaletteKind, string> = {
  action: "Actions",
  song: "Songs",
  sound: "Sounds",
  bank: "Drum machines",
  function: "Functions",
  snippet: "Snippets",
};

/** Short tags shown on each row */
export const KIND_TAG: Record<PaletteKind, string> = {
  action: "do",
  song: "song",
  sound: "sound",
  bank: "bank",
  function: "fn",
  snippet: "snippet",
};

// ── actions ────────────────────────────────────────────────────────────────

export interface ActionState {
  playing: boolean;
  loop: boolean;
  codeView: boolean;
  mode: "view" | "edit";
  sections: { name: string }[] | null;
}

const action = (
  id: string,
  name: string,
  detail: string,
  run: PaletteRun & { type: "action" },
  hint?: string,
  alts?: string[]
): PaletteItem => ({ kind: "action", id, name, detail, run, weight: KIND_WEIGHT.action, ...(hint ? { hint } : {}), ...(alts ? { alts } : {}) });

export function actionItems(s: ActionState): PaletteItem[] {
  const a = (act: ActionId, section?: number): PaletteRun & { type: "action" } =>
    section === undefined ? { type: "action", action: act } : { type: "action", action: act, section };
  const items: PaletteItem[] = [
    s.playing
      ? action("play", "stop", "stop the music", a("play"), "Space", ["pause", "play"])
      : action("play", "play", "start the music", a("play"), "Space", ["start"]),
  ];
  if (s.sections?.length) {
    items.push(
      s.loop
        ? action("loop", "stop looping", "carry on through the song", a("loop"), "L", ["loop", "unloop"])
        : action("loop", "loop this section", "keep playing the section you hear", a("loop"), "L", ["repeat"])
    );
    s.sections.forEach((sec, i) =>
      items.push(action(`section:${i}`, `jump to section ${sec.name}`, "on the next bar line", a("jump", i), undefined, [`go to ${sec.name}`]))
    );
    items.push(
      action("next-section", "next section", "jump ahead one section", a("next-section"), "]"),
      action("previous-section", "previous section", "jump back one section", a("previous-section"), "[")
    );
  }
  items.push(
    s.mode === "view"
      ? action("edit", "edit the code", "open this song in the editor", a("edit"), "E", ["editor", "edit mode"])
      : action("edit", "stop editing", "back to the read-only view", a("edit"), undefined, ["view mode", "edit mode"]),
    action("library", "open the library", "browse sounds, drum machines and functions", a("library"), "B", ["browse", "sounds"]),
    action("library-functions", "browse functions", "the library's functions, by category", a("library-functions"), undefined, ["docs", "reference"]),
    action("builder", "new track…", "build a track from a snippet", a("builder"), undefined, ["add track", "track builder"]),
    s.codeView
      ? action("code-view", "hide the code", "give the room more space", a("code-view"), "C", ["code view"])
      : action("code-view", "show the code", "the song's code on the screen", a("code-view"), "C", ["code view"]),
    action("follow", "follow the music", "scroll the code along with what plays", a("follow"), "F", ["scroll"]),
    action("unmute", "clear mutes and solos", "every track back in the mix", a("unmute"), "0", ["unmute", "unsolo", "reset mix"]),
    action("help", "keyboard shortcuts", "every key the stage knows", a("help"), "?", ["help", "keys"])
  );
  return items;
}

// ── songs ──────────────────────────────────────────────────────────────────

export function songItems(songs: { id: string; song: { name?: string; bpm?: number } }[], currentId: string): PaletteItem[] {
  return songs.map(({ id, song }) => {
    const current = id === currentId;
    const bpm = song.bpm ? `${song.bpm} bpm` : "";
    return {
      kind: "song",
      id,
      name: song.name || id,
      alts: [id],
      detail: current ? ["the song you're on", bpm].filter(Boolean).join(" · ") : ["switch to it", bpm].filter(Boolean).join(" · "),
      weight: KIND_WEIGHT.song,
      run: { type: "song", id },
      ...(current ? { current: true as const } : {}),
    };
  });
}

// ── sounds and banks ───────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function soundItems(catalog: SoundsCatalog): PaletteItem[] {
  const kindLabel = new Map<string, string>();
  for (const g of catalog.groups) for (const k of g.kinds) kindLabel.set(k.id, k.label);
  return Object.entries(catalog.sounds).map(([name, info]) => {
    const parts = [kindLabel.get(info.kind) ?? info.kind];
    if (info.aliasOf) parts.push(`same as ${info.aliasOf}`);
    else if (info.source === "superdough") parts.push("built-in synth");
    if (info.pitched) parts.push("pitched: play it with note()");
    else if (info.count && info.count > 1) parts.push(plural(info.count, "file"));
    const banks = info.banks ? Object.keys(info.banks).length : 0;
    if (banks) parts.push(`in ${plural(banks, "drum machine")}`);
    const pitched = info.pitched ? { pitched: true } : {};
    return {
      kind: "sound",
      id: name,
      name,
      detail: parts.join(" · "),
      weight: KIND_WEIGHT.sound,
      run: { type: "insert", item: { type: "sound", name, ...pitched } },
      play: { type: "sound", name, ...pitched },
    };
  });
}

export function bankItems(catalog: SoundsCatalog): PaletteItem[] {
  return Object.entries(catalog.banks).map(([name, bank]) => {
    const part = bank.parts.includes("bd") ? "bd" : bank.parts[0] ?? "bd";
    const shown = bank.parts.slice(0, 8).join(" ") + (bank.parts.length > 8 ? " …" : "");
    const detail = [bank.aliases.length ? `aka ${bank.aliases.join(", ")}` : "", shown].filter(Boolean).join(" · ");
    return {
      kind: "bank",
      id: name,
      name,
      alts: bank.aliases,
      detail,
      weight: KIND_WEIGHT.bank,
      run: { type: "insert", item: { type: "bank", name, part } },
      play: { type: "sound", name: part, bank: name },
    };
  });
}

// ── functions ──────────────────────────────────────────────────────────────

/** Markdown-ish doc text as plain text: no emphasis, code ticks or link targets */
export function plainText(md: string): string {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** ".lpf(frequency?: NumberInput): Pattern" → "(frequency?)"; "" without a parameter list */
export function compactSignature(sig: string): string {
  const open = sig.indexOf("(");
  if (open < 0) return "";
  const names: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = open + 1; i < sig.length; i++) {
    const c = sig[i];
    if (depth === 0 && (c === "," || c === ")")) {
      const name = current.split(":")[0].trim();
      if (name) names.push(name);
      current = "";
      if (c === ")") break;
      continue;
    }
    if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c) && !(c === ">" && sig[i - 1] === "=")) depth--;
    current += c;
  }
  return `(${names.join(", ")})`;
}

export function functionItems(catalog: FunctionsCatalog, previewable: (code: string) => boolean): PaletteItem[] {
  const category = new Map(catalog.categories.map((c) => [c.id, c.label]));
  return catalog.functions.map((fn) => {
    const notes: string[] = [];
    if (fn.aliasOf) notes.push(`same as ${fn.aliasOf}`);
    if (fn.deprecated) notes.push("deprecated");
    if (fn.superdirtOnly) notes.push("SuperDirt only");
    const summary = plainText(fn.summary) || category.get(fn.category) || fn.category;
    const example = fn.examples[0];
    return {
      kind: "function",
      id: fn.name,
      name: fn.name,
      ...(fn.synonyms.length ? { alts: fn.synonyms } : {}),
      suffix: fn.kind === "value" ? "" : compactSignature(fn.signatures[0] ?? ""),
      detail: [...notes, summary].join(" · "),
      weight: KIND_WEIGHT.function,
      run: { type: "insert", item: { type: "function", name: fn.name, kind: fn.kind, params: fn.params.length } },
      ...(example && previewable(example) ? { play: { type: "code" as const, code: example } } : {}),
    };
  });
}

// ── snippets ───────────────────────────────────────────────────────────────

export function snippetItems(catalog: SnippetsCatalog): PaletteItem[] {
  return catalog.snippets.map((s) => ({
    kind: "snippet",
    id: s.id,
    name: s.title,
    alts: [s.role, ...(s.tags ?? [])],
    detail: `${s.role} · ${plainText(s.description)}`,
    weight: KIND_WEIGHT.snippet,
    run: { type: "insert", item: { type: "code", code: s.code } },
    play: { type: "code", code: s.code },
    track: { role: s.role, snippet: s.id },
  }));
}

// ── grouping ───────────────────────────────────────────────────────────────

export interface PaletteGroup {
  kind: PaletteKind;
  label: string;
  results: Ranked<PaletteItem>[];
}

/** Ranked results by kind: groups in the order of their best result */
export function groupResults(ranked: Ranked<PaletteItem>[]): PaletteGroup[] {
  const groups = new Map<PaletteKind, PaletteGroup>();
  for (const r of ranked) {
    const kind = r.item.kind;
    let g = groups.get(kind);
    if (!g) groups.set(kind, (g = { kind, label: KIND_LABEL[kind], results: [] }));
    g.results.push(r);
  }
  return [...groups.values()];
}
