// ═══════════════════════════════════════════════════════════════════════════
// Calm warnings: names that won't play (pure)
// ═══════════════════════════════════════════════════════════════════════════
//
// diagnose(text, registry) reads every string literal the context engine sees
// (allStringContexts) and flags, by role:
//
//   s("…") / sound("…")  a word the live registry doesn't have: with a bank,
//                        "<bank>_<word>" (the bank that plays is the outermost
//                        one, the last listed); a drum-machine part without a
//                        bank ("add .bank(…)"); a variant past the end, which
//                        wraps (an info: it still plays)
//   .bank("…")           a drum machine the registry doesn't have (its chain's
//                        sounds then aren't checked: one warning, not three)
//   .scale("…")          a root that isn't a note, a scale type tonal doesn't
//                        know (only once the theory lists scales)
//
// Never: before samples are ready, the word being typed (opts.caret), strings
// built by code (only a literal that is the whole argument counts, like the
// highlighting), rests and numbers, strings no call gives a role. Warnings are
// "warning" or "info", never errors: an unknown name is a question, not a crash.
// The Monaco side (markers, quick fixes) is warnings.ts.

import type { SoundRegistry, StringContext, Theory } from "./types.ts";
import { allStringContexts, soundWordsWithOffsets } from "./context.ts";
import { didYouMean } from "./did-you-mean.ts";

export interface Diagnostic {
  severity: "warning" | "info";
  message: string;
  /** File offsets of what it's about (the word; "bd:12" for a variant) */
  start: number;
  end: number;
  /** Replacements for [start, end), best first (quick fixes) */
  fixes: string[];
  kind: "sound" | "bank-only" | "bank" | "variant" | "scale" | "scale-root";
}

export interface DiagnoseOptions {
  /** The caret while the user types: the word there is unfinished, not wrong, and is skipped */
  caret?: number | null;
  /** Scale names to check .scale() against; none (or an empty list): scales aren't checked */
  theory?: Pick<Theory, "scales"> | null;
  /** A sample map failed to load: names this knows (the catalog) count as known */
  fallback?: { has(key: string): boolean; isBank(name: string): boolean } | null;
  /** Called with the range of the word skipped for the caret */
  onSkip?: (start: number, end: number) => void;
}

/** tonal's scale aliases (alias → name): Strudel plays them, theory.json lists only names */
export const TONAL_SCALE_ALIASES: Readonly<Record<string, string>> = {
  pentatonic: "major pentatonic",
  ionian: "major",
  aeolian: "minor",
  blues: "minor blues",
  "whole-half diminished": "diminished",
  dominant: "mixolydian",
  indian: "mixolydian pentatonic",
  chinese: "lydian pentatonic",
  "minor seven flat five pentatonic": "locrian pentatonic",
  "vietnamese 2": "minor pentatonic",
  kumoi: "flat three pentatonic",
  "messiaen's mode #1": "whole tone",
  arabian: "locrian major",
  "super locrian": "altered",
  "diminished whole tone": "altered",
  pomeroy: "altered",
  "half-diminished": "locrian #2",
  "aeolian b5": "locrian #2",
  "melodic minor fifth mode": "mixolydian b6",
  hindu: "mixolydian b6",
  "lydian b7": "lydian dominant",
  overtone: "lydian dominant",
  "phrygian #6": "dorian b2",
  "melodic minor second mode": "dorian b2",
  "superlocrian bb7": "ultralocrian",
  "superlocrian diminished": "ultralocrian",
  "locrian natural 6": "locrian 6",
  "locrian sharp 6": "locrian 6",
  "ukrainian dorian": "dorian #4",
  "romanian minor": "dorian #4",
  "altered dorian": "dorian #4",
  spanish: "phrygian dominant",
  "phrygian major": "phrygian dominant",
  gypsy: "double harmonic major",
  "major #5": "major augmented",
  "ionian augmented": "major augmented",
  "ionian #5": "major augmented",
  "dominant diminished": "half-whole diminished",
  "messiaen's mode #2": "half-whole diminished",
};

/** Drum machines to suggest first when a part needs one */
const FAMILIAR_BANKS = ["RolandTR909", "RolandTR808", "RolandTR707", "LinnDrum"];

const quoteList = (xs: string[]) => xs.map((x) => `"${x}"`);
const dym = (fixes: string[]) => (fixes.length ? ` — did you mean ${quoteList(fixes)[0]}?` : "");

/** Is the string the whole argument: `s("…")`, not `s("a" + x)` or `s(x + "a")` */
function soleLiteral(text: string, ctx: StringContext): boolean {
  const { start, end } = ctx.string;
  if (end - start < 2 || text[end - 1] !== text[start]) return false; // unclosed: still being typed
  let a = start - 1;
  while (a >= 0 && /\s/.test(text[a])) a--;
  let b = end;
  while (b < text.length && /\s/.test(text[b])) b++;
  return (text[a] === "(" || text[a] === ",") && (text[b] === ")" || text[b] === ",");
}

export function diagnose(text: string, registry: SoundRegistry, opts: DiagnoseOptions = {}): Diagnostic[] {
  if (!registry.ready()) return [];
  const out: Diagnostic[] = [];
  const { caret, fallback, onSkip } = opts;
  const atCaret = (start: number, end: number) => {
    if (caret == null || caret < start || caret > end) return false;
    onSkip?.(start, end);
    return true;
  };
  const known = (key: string) => registry.has(key) || !!fallback?.has(key);
  const bankKnown = (bank: string) => registry.bankParts(bank).length > 0 || !!fallback?.isBank(bank);
  const scales = scaleNames(opts.theory);

  for (const ctx of allStringContexts(text)) {
    if (ctx.argIndex !== 0 || !soleLiteral(text, ctx)) continue;
    if (ctx.role === "sound") checkSounds(ctx);
    else if (ctx.role === "bank") checkBanks(ctx);
    else if (ctx.role === "scale" && scales) checkScale(ctx, scales);
  }
  return out.sort((a, b) => a.start - b.start);

  function checkSounds(ctx: StringContext) {
    const bank = ctx.banks.length ? ctx.banks[ctx.banks.length - 1] : undefined;
    // .bank(someCall()): a bank we can't read; anything could play
    if (!bank && ctx.chain.some((c) => c.name === "bank" && c.method)) return;
    // an unknown bank is flagged on its own string
    if (bank && !bankKnown(bank)) return;
    const words = soundWordsWithOffsets(ctx.value, ctx.string.start + 1);
    const kinds = new Set(words.map((w) => (known(w.text) ? registry.kind(w.text) : undefined)).filter(Boolean));
    for (const w of words) {
      const key = bank ? `${bank}_${w.text}` : w.text;
      let end = w.end;
      if (w.variant !== undefined && text[w.end] === ":") {
        end = w.end + 1;
        while (end < text.length && text[end] >= "0" && text[end] <= "9") end++;
      }
      if (atCaret(w.start, end)) continue;
      if (registry.has(key)) {
        const n = registry.variants(key);
        if (w.variant !== undefined && n && registry.type(key) === "sample" && !registry.pitched(key) && w.variant >= n) {
          out.push({
            severity: "info",
            kind: "variant",
            start: w.start,
            end,
            fixes: [],
            message: `${w.text}:${w.variant} plays ${w.text}:${w.variant % n} — ${w.text} has ${n}${bank ? ` in ${bank}` : ""}`,
          });
        }
        continue;
      }
      if (fallback?.has(key)) continue;
      if (!bank) {
        const part = w.text.toLowerCase();
        const machines = registry.banks().filter((b) => b.name === b.canonical && b.parts.includes(part)).map((b) => b.name);
        if (machines.length) {
          out.push({
            severity: "warning",
            kind: "bank-only",
            start: w.start,
            end: w.end,
            fixes: [],
            message: `"${w.text}" plays only from a drum machine — add .bank("${suggestBank(machines, words.map((x) => x.text))}")`,
          });
          continue;
        }
      }
      const pool = bank ? registry.bankParts(bank) : registry.unbanked();
      const fixes = didYouMean(w.text, pool, 3, (c) => (kinds.has(registry.kind(c)) ? 0 : 1));
      out.push({
        severity: "warning",
        kind: "sound",
        start: w.start,
        end: w.end,
        fixes,
        message: `No sound "${w.text}"${bank ? ` in ${bank}` : ""}${dym(fixes)}`,
      });
    }
  }

  /** A drum machine that has this part and as many of the string's other words as possible */
  function suggestBank(machines: string[], words: string[]): string {
    const score = (b: string) => {
      const parts = registry.bankParts(b);
      return words.filter((w) => parts.includes(w.toLowerCase())).length;
    };
    let best = machines[0];
    let bestScore = -1;
    for (const b of [...FAMILIAR_BANKS.filter((f) => machines.includes(f)), ...machines]) {
      const s = score(b);
      if (s > bestScore) {
        best = b;
        bestScore = s;
      }
    }
    return best;
  }

  function checkBanks(ctx: StringContext) {
    for (const w of soundWordsWithOffsets(ctx.value, ctx.string.start + 1)) {
      if (atCaret(w.start, w.end) || bankKnown(w.text)) continue;
      const fixes = didYouMean(
        w.text,
        registry.banks().map((b) => b.name)
      );
      out.push({ severity: "warning", kind: "bank", start: w.start, end: w.end, fixes, message: `No drum machine "${w.text}"${dym(fixes)}` });
    }
  }

  function checkScale(ctx: StringContext, names: ScaleNames) {
    for (const run of scaleRuns(ctx.value, ctx.string.start + 1)) {
      if (atCaret(run.start, run.end)) continue;
      const { parts } = run;
      if (parts.length === 1) {
        const word = parts[0].text;
        // "C:<major minor>": the types stand alone; a lone root or number isn't ours to judge
        if (isNumber(word) || isNote(word) || names.valid(word)) continue;
        flagType(word, parts[0].start, parts[0].end, names);
        continue;
      }
      const [root, ...types] = parts;
      if (root.text && !isNote(root.text)) {
        out.push({
          severity: "warning",
          kind: "scale-root",
          start: root.start,
          end: root.end,
          fixes: [],
          message: `"${root.text}" isn't a note — a scale starts with one, like "C:major"`,
        });
        continue;
      }
      if (types.some((t) => !t.text)) continue; // "C:<major minor>": the type comes from a pattern
      const type = types.map((t) => t.text).join(" ");
      if (!names.valid(type)) flagType(type, types[0].start, types[types.length - 1].end, names);
    }
  }

  function flagType(type: string, start: number, end: number, names: ScaleNames) {
    const fixes = didYouMean(type, names.list).map((f) => f.replaceAll(" ", ":"));
    out.push({ severity: "warning", kind: "scale", start, end, fixes, message: `No scale "${type.replaceAll(" ", ":")}"${dym(fixes)}` });
  }
}

// ── scales ──────────────────────────────────────────────────────────────────

interface ScaleNames {
  list: string[];
  valid(type: string): boolean;
}

function scaleNames(theory: DiagnoseOptions["theory"]): ScaleNames | null {
  const scales = theory?.scales ?? [];
  if (!scales.length) return null;
  const accepted = new Set<string>();
  for (const s of scales) {
    accepted.add(s.name.toLowerCase());
    for (const a of (s as { aliases?: string[] }).aliases ?? []) accepted.add(a.toLowerCase());
  }
  for (const alias of Object.keys(TONAL_SCALE_ALIASES)) accepted.add(alias);
  return { list: scales.map((s) => s.name), valid: (type) => accepted.has(type.toLowerCase()) };
}

/** A root as tonal reads it: a letter, accidentals, an octave */
const isNote = (w: string) => /^[a-gA-G](#+|b+|x+)?-?\d*$/.test(w);
const isNumber = (w: string) => /^[-+]?\.?\d/.test(w);

const isStepChar = (ch: string) => /[A-Za-z0-9~\-#.^_]/.test(ch) || (ch > "\x7f" && /\p{L}/u.test(ch));
const OPENERS = "[<{";
const CLOSERS = "]>}";

interface ScaleRun {
  start: number;
  end: number;
  /** split at ":" with file offsets */
  parts: { text: string; start: number; end: number }[];
}

/** The "root:type:type" steps of a scale string, operator arguments and euclid parens skipped */
function scaleRuns(value: string, base: number): ScaleRun[] {
  const runs: ScaleRun[] = [];
  const n = value.length;
  let parens = 0;
  let argOf = false;
  let skip = 0;
  let i = 0;
  while (i < n) {
    const ch = value[i];
    if (skip > 0) {
      if (OPENERS.includes(ch)) skip++;
      else if (CLOSERS.includes(ch)) skip--;
      i++;
      continue;
    }
    if (isStepChar(ch) || ch === ":") {
      const start = i;
      while (i < n && (isStepChar(value[i]) || value[i] === ":")) i++;
      const text = value.slice(start, i);
      if (argOf || parens > 0 || /^[~\-_.]+$/.test(text)) {
        argOf = false;
        continue;
      }
      const parts: ScaleRun["parts"] = [];
      let at = start;
      for (const p of text.split(":")) {
        parts.push({ text: p, start: base + at, end: base + at + p.length });
        at += p.length + 1;
      }
      runs.push({ start: base + start, end: base + i, parts });
      continue;
    }
    if (argOf && OPENERS.includes(ch)) {
      argOf = false;
      skip = 1;
      i++;
      continue;
    }
    argOf = false;
    if (ch === "(") parens++;
    else if (ch === ")") parens = Math.max(0, parens - 1);
    else if ("*/%@!?".includes(ch)) argOf = true;
    i++;
  }
  return runs;
}
