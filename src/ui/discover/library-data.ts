// ═══════════════════════════════════════════════════════════════════════════
// The library's pure parts: search, ranking, row text, ▶ and insert arguments
// ═══════════════════════════════════════════════════════════════════════════
//
// No DOM, no engine: ./library.ts renders what these return, and
// test/discover-library.test.ts runs them on the real catalog in Node.
//
//   sounds by kind   every term must match the sound's name, kind, group,
//                    source or alias target; catalog order is kept
//   banks            every term must match the bank's name or an alias
//                    (substring) or one of its parts (whole: "cb", not "c")
//   functions        every term must match the name, a synonym, the alias
//                    target, the summary or the category; ranked by where
//                    each term matched (exact name, name prefix, name, synonym,
//                    category, summary), ties by name

import type { BankInfo, FunctionInfo, FunctionsCatalog, SoundGroup, SoundInfo, SoundsCatalog } from "./catalog";
import type { InsertItem } from "./insert";

/** The query's words, lowercased */
export function terms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

const has = (field: string | undefined, term: string) => !!field && field.toLowerCase().includes(term);

/** The groups → kinds → sounds that match `query`, empty kinds and groups dropped */
export function filterSoundGroups(cat: SoundsCatalog, query: string): SoundGroup[] {
  const words = terms(query);
  if (!words.length) return cat.groups;
  const out: SoundGroup[] = [];
  for (const g of cat.groups) {
    const kinds = [];
    for (const k of g.kinds) {
      const sounds = k.sounds.filter((name) => {
        const info = cat.sounds[name];
        const fields = [name, k.id, k.label, g.id, g.label, info?.source, info?.aliasOf];
        return words.every((w) => fields.some((f) => has(f, w)));
      });
      if (sounds.length) kinds.push({ ...k, sounds });
    }
    if (kinds.length) out.push({ ...g, kinds });
  }
  return out;
}

/** Bank names that match `query`, in catalog order */
export function filterBanks(cat: SoundsCatalog, query: string): string[] {
  const words = terms(query);
  return Object.keys(cat.banks).filter((name) => {
    const b = cat.banks[name];
    return words.every((w) => has(name, w) || b.aliases.some((a) => has(a, w)) || b.parts.includes(w));
  });
}

/** Doc text without its markup (**l**ow-pass → low-pass), memoized: searched on every key */
const plain = new Map<string, string>();
function plainText(text: string): string {
  let p = plain.get(text);
  if (p === undefined) {
    p = docBlocks(text)
      .map((b) => b.spans.map((s) => s.text).join(""))
      .join(" ");
    plain.set(text, p);
  }
  return p;
}

/** Lower is better; Infinity: no match */
function rank(fn: FunctionInfo, term: string, categoryLabel: string): number {
  const name = fn.name.toLowerCase();
  if (name === term) return 0;
  if (name.startsWith(term)) return 1;
  if (name.includes(term)) return 2;
  const others = [...fn.synonyms, fn.aliasOf ?? ""].map((s) => s.toLowerCase());
  if (others.some((s) => s === term)) return 3;
  if (others.some((s) => s.includes(term))) return 4;
  if (has(fn.category, term) || has(categoryLabel, term)) return 5;
  if (has(plainText(fn.summary), term)) return 6;
  return Infinity;
}

/** Functions matching `query`, best first (none for an empty query) */
export function searchFunctions(cat: FunctionsCatalog, query: string): FunctionInfo[] {
  const words = terms(query);
  if (!words.length) return [];
  const labels = new Map(cat.categories.map((c) => [c.id, c.label]));
  const scored: { fn: FunctionInfo; score: number }[] = [];
  for (const fn of cat.functions) {
    const label = labels.get(fn.category) ?? "";
    let score = 0;
    for (const w of words) score += rank(fn, w, label);
    if (score !== Infinity) scored.push({ fn, score });
  }
  scored.sort((a, b) => a.score - b.score || (a.fn.name < b.fn.name ? -1 : a.fn.name > b.fn.name ? 1 : 0));
  return scored.map((s) => s.fn);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The short facts on a sound's row, one per piece */
export function soundMeta(info: SoundInfo): string[] {
  const out: string[] = [];
  const banks = info.banks ? Object.keys(info.banks).length : 0;
  if (info.source === "superdough") out.push("built-in synth");
  else if (info.count !== undefined) {
    out.push(plural(info.count, "file"));
    if (info.source) out.push(info.source);
  } else if (banks) out.push("only in banks");
  if (info.pitched) out.push("pitched");
  if (banks) out.push(plural(banks, "bank"));
  if (info.aliasOf) out.push(`= ${info.aliasOf}`);
  return out;
}

/** Plays notes: a pitched sample or a waveform synth */
const playsNotes = (info: SoundInfo) => !!info.pitched || info.kind === "synth";

/** What ▶ on a sound row plays: auditionSound(name, opts) */
export function soundAudition(name: string, info: SoundInfo): { name: string; opts: { bank?: string; pitched?: boolean } } {
  if (info.count === undefined && info.source === undefined && info.banks) {
    const first = Object.keys(info.banks)[0];
    if (first) return { name, opts: { bank: first } };
  }
  return { name, opts: playsNotes(info) ? { pitched: true } : {} };
}

/** What insert on a sound row inserts */
export function soundInsert(name: string, info: SoundInfo): InsertItem {
  return { type: "sound", name, pitched: playsNotes(info) };
}

/** The drum a bank row plays and inserts: bd, else its first part */
export function bankPart(bank: BankInfo): string {
  return bank.parts.includes("bd") ? "bd" : (bank.parts[0] ?? "bd");
}

/** What insert on a function row inserts */
export function functionInsert(fn: FunctionInfo): InsertItem {
  return { type: "function", name: fn.name, kind: fn.kind, params: fn.params.length };
}

// ── doc text (markdown-ish JSDoc) ───────────────────────────────────────────

export interface DocSpan {
  kind: "text" | "code" | "strong" | "em";
  text: string;
}

export interface DocBlock {
  type: "p" | "li";
  spans: DocSpan[];
}

/** `code`, **strong**, *em*, [label](url) → label; anything unmatched stays literal */
const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*?)\*|\[([^\]]+)\]\([^)]*\)/g;

function spans(text: string): DocSpan[] {
  const out: DocSpan[] = [];
  const push = (kind: DocSpan["kind"], t: string) => {
    if (t) out.push({ kind, text: t });
  };
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    push("text", text.slice(at, m.index));
    if (m[1] !== undefined) push("code", m[1]);
    else if (m[2] !== undefined) push("strong", m[2]);
    else if (m[3] !== undefined) push("em", m[3]);
    else push("text", m[4]);
    at = m.index + m[0].length;
  }
  push("text", text.slice(at));
  return out;
}

/** Paragraphs and list items of a function's description, with inline markup */
export function docBlocks(text: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    let current: { type: DocBlock["type"]; lines: string[] } | null = null;
    const flush = () => {
      if (current) blocks.push({ type: current.type, spans: spans(current.lines.join(" ")) });
      current = null;
    };
    for (const raw of para.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const item = /^[-*]\s+(.*)$/.exec(line);
      if (item) {
        flush();
        current = { type: "li", lines: [item[1]] };
      } else if (current) current.lines.push(line);
      else current = { type: "p", lines: [line] };
    }
    flush();
  }
  return blocks;
}
