// ═══════════════════════════════════════════════════════════════════════════
// A small TypeScript tokenizer for the code view's syntax colours
// ═══════════════════════════════════════════════════════════════════════════
//
// Not a parser: it only has to colour song files nicely and never lose a
// character. Tokens cover the text completely and in order, so offsets into
// the original text map 1:1 onto rendered characters.

export type TokenKind =
  | "c" // comment
  | "k" // keyword
  | "s" // string / template
  | "n" // number
  | "f" // function or method being called
  | "t" // Type / CONSTANT
  | "p" // punctuation / operator
  | ""; // plain (identifiers, whitespace)

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
}

const KEYWORDS = new Set(
  (
    "const let var function return if else for while do break continue switch case default new " +
    "typeof instanceof in of import export from as type interface extends implements class this " +
    "true false null undefined void async await yield try catch finally throw satisfies keyof readonly"
  ).split(" ")
);

const isIdStart = (c: number) =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c > 127;
const isIdPart = (c: number) => isIdStart(c) || (c >= 48 && c <= 57);
const isDigit = (c: number) => c >= 48 && c <= 57;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;
  let plainStart = -1;

  const flushPlain = (at: number) => {
    if (plainStart >= 0 && at > plainStart) tokens.push({ kind: "", start: plainStart, end: at });
    plainStart = -1;
  };
  const push = (kind: TokenKind, start: number, end: number) => {
    flushPlain(start);
    tokens.push({ kind, start, end });
  };
  const plain = () => {
    if (plainStart < 0) plainStart = i;
  };

  while (i < n) {
    const c = text.charCodeAt(i);
    const next = text.charCodeAt(i + 1);

    // comments
    if (c === 47 /* / */ && next === 47) {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      push("c", i, stop);
      i = stop;
      continue;
    }
    if (c === 47 && next === 42 /* * */) {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      push("c", i, stop);
      i = stop;
      continue;
    }

    // strings
    if (c === 34 || c === 39 || c === 96) {
      const start = i;
      i++;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 92 /* \ */) {
          i += 2;
          continue;
        }
        if (d === c) {
          i++;
          break;
        }
        if (d === 10 && c !== 96) break; // unterminated single-line string
        i++;
      }
      push("s", start, Math.min(i, n));
      continue;
    }

    // numbers
    if (isDigit(c) || (c === 46 && isDigit(next))) {
      const start = i;
      i++;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (isIdPart(d) || d === 46) i++;
        else break;
      }
      push("n", start, i);
      continue;
    }

    // identifiers / keywords / calls
    if (isIdStart(c)) {
      const start = i;
      i++;
      while (i < n && isIdPart(text.charCodeAt(i))) i++;
      const word = text.slice(start, i);
      let j = i;
      while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
      const prev = start > 0 ? text.charCodeAt(start - 1) : 0;
      if (KEYWORDS.has(word) && prev !== 46 /* . */) push("k", start, i);
      else if (text.charCodeAt(j) === 40 /* ( */) push("f", start, i);
      else if (/^[A-Z]/.test(word)) push("t", start, i);
      else {
        plainStart = plainStart < 0 ? start : plainStart;
      }
      continue;
    }

    // punctuation / operators
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) {
      const start = i;
      i++;
      while (i < n) {
        const d = text.charCodeAt(i);
        if ("{}[]();,.:=+-*/%<>!?&|^~@#".includes(text[i]) && d !== 47) i++;
        else break;
      }
      push("p", start, i);
      continue;
    }

    plain();
    i++;
  }
  flushPlain(n);
  return tokens;
}
