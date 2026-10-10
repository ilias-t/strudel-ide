// ═══════════════════════════════════════════════════════════════════════════
// The method list after a dot: TypeScript's entries, ranked and labelled
// ═══════════════════════════════════════════════════════════════════════════
//
// TypeScript knows which members a Pattern has; completions.json knows which
// ones people use, after which call, what they are for and whether they work
// here. Everything stays in the list, ranked:
//
//   1. what songs use right after the chain's first call (after["s"]: gain,
//      bank, hpf, …), minus methods the chain already has
//   2. the rest by global rank (most used first; unused ones alphabetically)
//   3. members the catalog doesn't know, alphabetically
//   4. the ones that don't work here, with the reason on the right ("SuperDirt
//      only", "visuals", "MIDI/OSC", "internal"): never struck through
//
// Each row: label, a dimmed detail (the range, "20–20k Hz", or the best-known
// other name) and the category on the right. Aliases fold under their target
// (cutoff, ctf, lp under lpf) unless what is typed fits the alias but not the
// target: then it shows as "cutoff → lpf" and inserts what was typed. A list
// that folded something must be re-asked on every keystroke (`folded`, which
// the provider turns into `incomplete`).
//
// Pure: the provider (./provider.ts) does the TypeScript round trip.

import type { CallRef, CompletionMeta } from "./types.ts";
import type { CompletionsCatalog } from "../discover/catalog.ts";
import { formatRange } from "../discover/cheatsheet-data.ts";

/** A completion entry as TypeScript's getCompletionsAtPosition returns it */
export interface TsEntry {
  name: string;
  kind: string;
  sortText: string;
  kindModifiers?: string;
  insertText?: string;
  isSnippet?: true;
  replacementSpan?: { start: number; length: number };
}

export interface MemberRow {
  entry: TsEntry;
  label: string;
  detail?: string;
  description?: string;
  insertText: string;
  sortText: string;
  /** TypeScript says deprecated, for a name the catalog doesn't know (the catalog's names never are) */
  deprecated: boolean;
}

export interface MemberList {
  rows: MemberRow[];
  /** An alias was folded under its target: ask again as the word grows */
  folded: boolean;
}

/** Why a function sinks, as the row says it */
export const REASONS: Record<Exclude<CompletionMeta["availability"], "ok">, string> = {
  superdirt: "SuperDirt only",
  visual: "visuals",
  io: "MIDI/OSC",
  internal: "internal",
};

/** The same, as a sentence for the details pane */
const REASON_LINES: Record<keyof typeof REASONS, string> = {
  superdirt: "SuperDirt only: no effect with the built-in output",
  visual: "visuals: no sound here",
  io: "MIDI/OSC: talks to other software or the engine",
  internal: "internal: for building functions",
};

/** A list of Pattern members: TypeScript says it is a member list, and Strudel's methods are in it */
export function isPatternMemberList(info: { isMemberCompletion?: boolean; entries: readonly TsEntry[] }, catalog: CompletionsCatalog | null): boolean {
  if (!info.isMemberCompletion) return false;
  return info.entries.some((e) => e.name === "lpf" || e.name === "fast") && (!catalog || info.entries.some((e) => catalog.functions[e.name]?.availability === "ok"));
}

/** 20000 → 20k, 1500 → 1.5k, 0.95 → 0.95 */
function compactNumber(n: number): string {
  if (Math.abs(n) >= 1000) return `${+(n / 1000).toFixed(1)}k`;
  return String(+n.toFixed(3));
}

/** A range's compact form for the row: "20–20k Hz", "0–1.5", "≥0 s" */
export function compactRange(r: CompletionMeta["range"] | undefined): string | undefined {
  if (!r) return undefined;
  const unit = r.unit ? ` ${r.unit}` : "";
  const has = (x: number | undefined): x is number => typeof x === "number" && Number.isFinite(x);
  if (has(r.min) && has(r.max)) return `${compactNumber(r.min)}–${compactNumber(r.max)}${unit}`;
  if (has(r.min)) return `≥${compactNumber(r.min)}${unit}`;
  if (has(r.max)) return `≤${compactNumber(r.max)}${unit}`;
  return undefined;
}

/** The other name people know a function by best (the lowest-ranked synonym) */
function bestAlias(name: string, meta: CompletionMeta, catalog: CompletionsCatalog): string | undefined {
  let best: string | undefined;
  let bestRank = Infinity;
  for (const s of meta.synonyms ?? []) {
    if (s.toLowerCase() === name.toLowerCase()) continue;
    const rank = catalog.functions[s]?.rank ?? 9999;
    if (rank < bestRank) {
      best = s;
      bestRank = rank;
    }
  }
  return best;
}

const pad = (n: number, w: number) => String(Math.max(0, Math.min(n, 10 ** w - 1))).padStart(w, "0");
const fits = (name: string, typed: string) => !!typed && name.toLowerCase().startsWith(typed.toLowerCase());

export interface RankOptions {
  /** The chain the dot continues (./context.ts callChainBefore), null if unknown */
  chain: readonly CallRef[] | null;
  /** The word typed after the dot so far */
  typed: string;
}

/** TypeScript's Pattern members, ranked and labelled */
export function rankMembers(entries: readonly TsEntry[], catalog: CompletionsCatalog, { chain, typed }: RankOptions): MemberList {
  const fns = catalog.functions;
  const names = new Set(entries.map((e) => e.name));
  const head = chain?.[0]?.name;
  const after = head ? (catalog.after[head] ?? []) : [];
  const inChain = new Set((chain ?? []).slice(1).map((c) => c.name));
  const afterAt = new Map<string, number>();
  after.forEach((n, i) => {
    if (!inChain.has(n) && !afterAt.has(n)) afterAt.set(n, i);
  });
  const rows: MemberRow[] = [];
  const sortOf = new Map<string, string>();
  const aliases: { entry: TsEntry; meta: CompletionMeta }[] = [];
  let folded = false;

  for (const entry of entries) {
    const meta = Object.prototype.hasOwnProperty.call(fns, entry.name) ? fns[entry.name] : undefined;
    const insertText = entry.insertText ?? entry.name;
    if (!meta) {
      rows.push({ entry, label: entry.name, insertText, sortText: `3${entry.name.toLowerCase()}`, deprecated: !!entry.kindModifiers?.includes("deprecated") });
      continue;
    }
    if (meta.aliasOf && meta.aliasOf !== entry.name && names.has(meta.aliasOf)) {
      folded = true;
      aliases.push({ entry, meta });
      continue;
    }
    let sortText: string;
    let description = meta.category;
    if (meta.availability !== "ok") {
      sortText = `4${entry.name.toLowerCase()}`;
      description = REASONS[meta.availability];
    } else if (afterAt.has(entry.name)) {
      sortText = `0${pad(afterAt.get(entry.name)!, 3)}`;
    } else {
      sortText = `1${pad(meta.rank, 4)}`;
    }
    sortOf.set(entry.name, sortText);
    const detail = compactRange(meta.range) ?? bestAlias(entry.name, meta, catalog);
    const row: MemberRow = { entry, label: entry.name, description, insertText, sortText, deprecated: false };
    if (detail) row.detail = ` ${detail}`;
    rows.push(row);
  }

  // an alias shows only when the word fits it and not its target: "cuto" → cutoff → lpf
  for (const { entry, meta } of aliases) {
    const target = meta.aliasOf!;
    if (!fits(entry.name, typed) || fits(target, typed)) continue;
    rows.push({
      entry,
      label: entry.name,
      detail: ` → ${target}`,
      description: meta.availability === "ok" ? meta.category : REASONS[meta.availability],
      insertText: entry.insertText ?? entry.name,
      sortText: `${sortOf.get(target) ?? `1${pad(meta.rank, 4)}`}a`,
      deprecated: false,
    });
  }
  return { rows, folded };
}

/** One line under TypeScript's docs: "effects · 20–20000 Hz · also cutoff, ctf, lp · strudel.cc ↗" (markdown) */
export function memberDocLine(name: string, catalog: CompletionsCatalog): string | undefined {
  const meta = Object.prototype.hasOwnProperty.call(catalog.functions, name) ? catalog.functions[name] : undefined;
  if (!meta) return undefined;
  const parts: string[] = [];
  if (meta.availability !== "ok") parts.push(REASON_LINES[meta.availability]);
  parts.push(meta.category);
  const range = formatRange(meta.range);
  if (range) parts.push(range);
  const target = meta.aliasOf && meta.aliasOf !== name ? meta.aliasOf : undefined;
  if (target) parts.push(`same as ${target}`);
  const others = (meta.synonyms ?? []).filter((s) => s !== name && s !== target);
  if (others.length) parts.push(`also ${others.join(", ")}`);
  if (meta.docUrl?.startsWith("https://strudel.cc/")) parts.push(`[strudel.cc ↗](${meta.docUrl})`);
  return parts.join(" · ");
}
