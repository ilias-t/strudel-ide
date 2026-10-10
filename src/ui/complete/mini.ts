// ═══════════════════════════════════════════════════════════════════════════
// Mini-notation inside a string literal: the token under the caret, and the
// words that name sounds (pure, synchronous)
// ═══════════════════════════════════════════════════════════════════════════
//
// Follows @strudel/mini's grammar (node_modules/@strudel/mini/krill.pegjs):
// a step is a run of step characters (letters, digits, ~ - # . ^ _), so
// "c#3", "C^7" and "gm_acoustic_bass" are one word, while a lone "~" or "-" is
// a rest, a lone "_" an elongation and a lone "." the feet separator. Operators
// take an argument right after them: "*2", "/[2 3]", ":3", "%4", "(3,8)",
// "@2", "!3", "?0.3". None of those arguments name a sound.
//
// Never throws: half-typed strings ("bd(3,", "[bd sd") are the normal case.

import type { MiniToken, MiniWord } from "./types.ts";

/** A mini-notation step character (krill's step_char) */
function isStep(c: number, ch: string): boolean {
  return (
    (c >= 97 && c <= 122) || // a-z
    (c >= 65 && c <= 90) || // A-Z
    (c >= 48 && c <= 57) || // 0-9
    c === 126 || // ~
    c === 45 || // -
    c === 35 || // #
    c === 46 || // .
    c === 94 || // ^
    c === 95 || // _
    (c > 127 && /\p{L}/u.test(ch))
  );
}

/** A token character for completion: a step character, but a "~" is a rest of its own */
function isTokenChar(text: string, i: number): boolean {
  const c = text.charCodeAt(i);
  return c !== 126 && isStep(c, text[i]);
}

/**
 * The mini token at `offset` in a string whose contents run from `lo` to `hi`
 * (file offsets, quotes excluded).
 */
export function miniTokenAt(text: string, lo: number, hi: number, offset: number): MiniToken {
  const at = Math.max(lo, Math.min(offset, hi));
  let a = at;
  while (a > lo && isTokenChar(text, a - 1)) a--;
  let b = at;
  while (b < hi && isTokenChar(text, b)) b++;
  const before = a > lo ? text[a - 1] : "";
  const token: MiniToken = { start: a, end: b, text: text.slice(a, b), prefix: text.slice(a, at), before };
  if (before === ":") {
    let h = a - 1;
    while (h > lo && isTokenChar(text, h - 1)) h--;
    if (h < a - 1) token.head = text.slice(h, a - 1);
  }
  return token;
}

/** Rests ("~", "-"), elongation ("_"), feet (".") and numbers ("3", "-1", ".5") */
function isSoundWord(w: string): boolean {
  if (/^[~\-_.]+$/.test(w)) return false;
  return !/^[-+]?\.?\d/.test(w);
}

const OPENERS = "[<{";
const CLOSERS = "]>}";

/**
 * The words of a mini string that name sounds, with file offsets: `base` is
 * the file offset of the string's first content character.
 * "bd*2 [sd:3 hh]" → bd, sd (variant 3), hh.
 */
export function soundWordsWithOffsets(value: string, base: number): MiniWord[] {
  const out: MiniWord[] = [];
  const n = value.length;
  let parens = 0; // inside "(3,8)": euclid arguments
  let argOf = ""; // the operator whose argument comes next ("*", "/", "%", ":")
  let skip = 0; // bracket depth of an operator argument being skipped ("*<2 4>")
  let lastEnd = -1; // where the last sound word ended (for "sd:3")
  let i = 0;
  while (i < n) {
    const c = value.charCodeAt(i);
    const ch = value[i];
    if (skip > 0) {
      if (OPENERS.includes(ch)) skip++;
      else if (CLOSERS.includes(ch)) skip--;
      i++;
      continue;
    }
    if (isStep(c, ch)) {
      const start = i;
      while (i < n && isStep(value.charCodeAt(i), value[i])) i++;
      const w = value.slice(start, i);
      if (argOf) {
        // "sd:3": the variant of the word right before the colon
        if (argOf === ":" && start - 1 === lastEnd && /^\d+$/.test(w)) out[out.length - 1].variant = Number(w);
        argOf = "";
        continue;
      }
      if (parens === 0 && isSoundWord(w)) {
        out.push({ text: w, start: base + start, end: base + i });
        lastEnd = i;
      }
      continue;
    }
    if (argOf && OPENERS.includes(ch)) {
      // "*<2 4>", "/[2 3]", "%<4 8>": a bracketed argument
      argOf = "";
      skip = 1;
      i++;
      continue;
    }
    argOf = "";
    if (ch === "(") parens++;
    else if (ch === ")") parens = Math.max(0, parens - 1);
    else if (ch === "*" || ch === "/" || ch === "%" || ch === ":") argOf = ch;
    i++;
  }
  return out;
}

/** The words of a mini string that name sounds: "bd*2 [sd:3 hh]" → bd, sd, hh */
export function soundWords(value: string): string[] {
  return soundWordsWithOffsets(value, 0).map((w) => w.text);
}
