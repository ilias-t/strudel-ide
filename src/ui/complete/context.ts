// ═══════════════════════════════════════════════════════════════════════════
// What a string under the caret means (pure, synchronous). First cut from the
// design prototype; it must meet the contracts in ./types.ts (StringContext).
// ═══════════════════════════════════════════════════════════════════════════
//
// Given a song's text and a caret offset inside a string literal, decide:
//   - which call the string is an argument of (s, .bank, note, .scale, …)
//     and which argument,
//   - the whole call chain it sits in (s("bd sd").bank("tr909").gain(.5)),
//     so a role can come from *after* the string: mini("c e g").note(),
//   - the mini-notation token under the caret (word, prefix, what precedes it).
//
// No TypeScript, no worker: a tiny lexer (strings, comments, identifiers,
// single punctuation) plus bracket matching. Unclosed code (the normal state
// while typing) degrades to "unknown", never throws.

export type LexKind = "str" | "id" | "num" | "punct";
export interface Lex {
  kind: LexKind;
  start: number;
  end: number;
  text: string;
}

/** Significant tokens: comments and whitespace dropped, one punctuation char per token */
export function lex(text: string): Lex[] {
  const out: Lex[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const e = text.indexOf("\n", i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const start = i++;
      while (i < n) {
        const d = text[i];
        if (d === "\\") {
          i += 2;
          continue;
        }
        if (d === c) {
          i++;
          break;
        }
        if (d === "\n" && c !== "`") break;
        i++;
      }
      out.push({ kind: "str", start, end: Math.min(i, n), text: text.slice(start, Math.min(i, n)) });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (i < n && /[\w$]/.test(text[i])) i++;
      out.push({ kind: "id", start, end: i, text: text.slice(start, i) });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      const start = i;
      while (i < n && /[\w.]/.test(text[i])) i++;
      out.push({ kind: "num", start, end: i, text: text.slice(start, i) });
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    out.push({ kind: "punct", start: i, end: i + 1, text: c });
    i++;
  }
  return out;
}

export interface Arg {
  /** token index range [first, last] */
  first: number;
  last: number;
  /** the argument is exactly one string literal */
  string?: Lex;
  /** the argument is exactly one identifier (a const holding a string, maybe) */
  ident?: string;
}

export interface Call {
  name: string;
  method: boolean;
  /** token index of the name, of "(" and of ")" (-1: not closed yet) */
  nameIndex: number;
  open: number;
  close: number;
  args: Arg[];
}

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSE: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** index of the bracket matching toks[i] going forward, -1 if unclosed */
function matchForward(toks: Lex[], i: number): number {
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    const t = toks[j];
    if (t.kind !== "punct") continue;
    if (OPEN[t.text]) depth++;
    else if (CLOSE[t.text] && --depth === 0) return j;
  }
  return -1;
}

/** index of the bracket matching toks[i] (a closer) going backward */
function matchBackward(toks: Lex[], i: number): number {
  let depth = 0;
  for (let j = i; j >= 0; j--) {
    const t = toks[j];
    if (t.kind !== "punct") continue;
    if (CLOSE[t.text]) depth++;
    else if (OPEN[t.text] && --depth === 0) return j;
  }
  return -1;
}

/** Split a call's argument tokens (open+1 .. close-1) at top-level commas */
function argsOf(toks: Lex[], open: number, close: number): Arg[] {
  const end = close < 0 ? toks.length : close;
  const args: Arg[] = [];
  let first = open + 1;
  let depth = 0;
  for (let j = open + 1; j <= end; j++) {
    const t = toks[j];
    const atEnd = j === end;
    if (!atEnd && t.kind === "punct") {
      if (OPEN[t.text]) depth++;
      else if (CLOSE[t.text]) depth--;
      if (depth < 0) break;
    }
    if (atEnd || (depth === 0 && t.kind === "punct" && t.text === ",")) {
      const last = j - 1;
      if (last >= first) {
        const one = last === first ? toks[first] : undefined;
        args.push({ first, last, ...(one?.kind === "str" ? { string: one } : {}), ...(one?.kind === "id" ? { ident: one.text } : {}) });
      }
      first = j + 1;
    }
  }
  return args;
}

function callAt(toks: Lex[], nameIndex: number): Call | null {
  const name = toks[nameIndex];
  const open = nameIndex + 1;
  if (name?.kind !== "id" || toks[open]?.text !== "(") return null;
  const close = matchForward(toks, open);
  const method = toks[nameIndex - 1]?.text === ".";
  return { name: name.text, method, nameIndex, open, close, args: argsOf(toks, open, close) };
}

/** The whole chain `a(…).b(…).c(…)` around the call at `nameIndex` */
function chainAround(toks: Lex[], nameIndex: number): Call[] {
  const here = callAt(toks, nameIndex);
  if (!here) return [];
  const chain: Call[] = [here];
  // backward: while this call is a method, its receiver ends just before the "."
  let first = here;
  while (first.method) {
    const recvEnd = first.nameIndex - 2;
    const t = toks[recvEnd];
    if (!t) break;
    if (t.text === ")") {
      const open = matchBackward(toks, recvEnd);
      const prev = callAt(toks, open - 1);
      if (!prev) break; // (expr).method — a parenthesised receiver: stop
      chain.unshift(prev);
      first = prev;
    } else break; // an identifier receiver (DRUMS.bank…) or a string: chain starts here
  }
  // forward: ").name(" after the last call
  let last = here;
  while (last.close >= 0 && toks[last.close + 1]?.text === "." && toks[last.close + 2]?.kind === "id") {
    const next = callAt(toks, last.close + 2);
    if (!next) break;
    chain.push(next);
    last = next;
  }
  return chain;
}

// ── roles ─────────────────────────────────────────────────────────────────

export type Role =
  | "sound" // s / sound
  | "bank"
  | "note" // note names or midi numbers
  | "number" // n, arp, numeric patterns (sample index, scale degrees)
  | "scale"
  | "chord" // chord symbols: C^7 Dm7
  | "voicingDict" // .dict / .voicings("lefthand")
  | "vowel"
  | "struct" // x ~ t f
  | "mini"; // a mini-notation string we know nothing more about

const ROLE_OF: Record<string, Role> = {
  s: "sound",
  sound: "sound",
  bank: "bank",
  note: "note",
  n: "number",
  scale: "scale",
  chord: "chord",
  dict: "voicingDict",
  voicings: "voicingDict",
  vowel: "vowel",
  struct: "struct",
  mask: "struct",
  arp: "number",
  anchor: "note",
};

/** Calls that just carry a pattern along: their role comes from the chain after them */
const CARRIERS = new Set(["mini", "m", "seq", "sequence", "cat", "fastcat", "slowcat", "stack", "h", "pure"]);

export interface MiniToken {
  /** offsets into the file */
  start: number;
  end: number;
  text: string;
  /** text from start to the caret */
  prefix: string;
  /** the character right before the token inside the string ("" at the start) */
  before: string;
  /** for "bd:3": the word before the ":" */
  head?: string;
}

export interface StringContext {
  /** the string literal token (with quotes) */
  string: Lex;
  /** contents without quotes */
  value: string;
  call: Call;
  argIndex: number;
  chain: Call[];
  role: Role;
  /** what decided the role, for the docs ("mini(…).note()") */
  roleFrom: string;
  token: MiniToken;
  /** literal (or simple const) bank names in the chain */
  banks: string[];
  /** drum parts / sound names used by s()/sound() strings in the chain (for .bank) */
  soundsInChain: string[];
}


/** The mini token at `offset` (file offset) inside string token `s` */
export function miniTokenAt(text: string, s: Lex, offset: number): MiniToken {
  const lo = s.start + 1;
  let a = offset;
  while (a > lo && /[^\s[\]<>{}(),|~*/!@?:%;"'`]/.test(text[a - 1])) a--;
  let b = offset;
  const hi = s.end - (/["'`]/.test(text[s.end - 1]) && s.end - 1 > s.start ? 1 : 0);
  while (b < hi && /[^\s[\]<>{}(),|~*/!@?:%;"'`]/.test(text[b])) b++;
  const before = a > lo ? text[a - 1] : "";
  let head: string | undefined;
  if (before === ":") {
    let h = a - 1;
    while (h > lo && /[^\s[\]<>{}(),|~*/!@?:%;"'`]/.test(text[h - 1])) h--;
    head = text.slice(h, a - 1);
  }
  return { start: a, end: b, text: text.slice(a, b), prefix: text.slice(a, offset), before, head };
}

/** Words of a mini string that name sounds: "bd*2 [sd:3 hh]" → bd, sd, hh */
export function soundWords(value: string): string[] {
  const out: string[] = [];
  const re = /[^\s[\]<>{}(),|~*/!@?:%;]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const prev = value[m.index - 1];
    if (prev === ":" || prev === "*" || prev === "/" || prev === "!" || prev === "@" || prev === "%" || prev === "(" || prev === ",") {
      // after ":" a variant; after * / ! @ a number; inside (3,8) numbers — but "," also separates stacked sounds
      if (prev !== "," || /^\d/.test(m[0])) continue;
    }
    if (/^[\d.\-]+$/.test(m[0])) continue;
    out.push(m[0]);
  }
  return out;
}

/** `const NAME = "literal"` anywhere in the file (simple constant propagation for .bank(DRUMS)) */
function constString(toks: Lex[], name: string): string | undefined {
  for (let i = 0; i + 3 < toks.length; i++) {
    if ((toks[i].text === "const" || toks[i].text === "let") && toks[i + 1].text === name && toks[i + 2].text === "=" && toks[i + 3].kind === "str") {
      return toks[i + 3].text.slice(1, -1);
    }
  }
  return undefined;
}

let cache: { text: string; toks: Lex[] } | null = null;
function lexCached(text: string): Lex[] {
  if (cache?.text === text) return cache.toks;
  const toks = lex(text);
  cache = { text, toks };
  return toks;
}

/** The context of the string literal containing `offset`, or null outside strings / outside calls */
export function stringContextAt(text: string, offset: number): StringContext | null {
  const toks = lexCached(text);
  // the string token: offset strictly after its opening quote, at or before its closing one
  let si = -1;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.start >= offset) break;
    if (t.kind !== "str") continue;
    const closed = t.end - t.start >= 2 && t.text[t.text.length - 1] === t.text[0];
    if (offset < t.end || (!closed && offset === t.end)) si = i;
  }
  if (si < 0) return null;
  const s = toks[si];
  if (s.text[0] === "`" && s.text.includes("${")) return null;
  // walk back to the "(" of the enclosing call, counting top-level commas
  let argIndex = 0;
  let j = si - 1;
  for (; j >= 0; j--) {
    const t = toks[j];
    if (t.kind !== "punct") continue;
    if (CLOSE[t.text]) {
      j = matchBackward(toks, j);
      if (j < 0) return null;
      continue;
    }
    if (t.text === ",") {
      argIndex++;
      continue;
    }
    if (t.text === "(") break;
    if (t.text === "[" || t.text === "{") return null; // inside an array/object literal
  }
  if (j < 0) return null;
  const call = callAt(toks, j - 1);
  if (!call) return null;
  const chain = chainAround(toks, j - 1);
  const at = chain.findIndex((c) => c.nameIndex === call.nameIndex);

  // the role: the call's own, or for a carrier (mini("…")) the first role-giving call after it
  let role: Role = ROLE_OF[call.name] ?? "mini";
  let roleFrom = `${call.method ? "." : ""}${call.name}(…)`;
  if (CARRIERS.has(call.name)) {
    for (const next of chain.slice(at + 1)) {
      const r = ROLE_OF[next.name];
      if (r && next.args.length === 0) {
        // mini("c e").note(): the method with no arguments gives the role
        role = r;
        roleFrom = `${call.name}(…).${next.name}()`;
        break;
      }
    }
  }
  // n("0 2 4").scale("C:minor"): degrees, not sample indices — still numbers
  const value = s.text.slice(1, s.text.endsWith(s.text[0]) && s.text.length > 1 ? -1 : undefined);

  const banks: string[] = [];
  const soundsInChain: string[] = [];
  for (const c of chain) {
    if (c.name === "bank" && c.args[0]) {
      const lit = c.args[0].string?.text.slice(1, -1) ?? (c.args[0].ident ? constString(toks, c.args[0].ident) : undefined);
      if (lit) banks.push(...soundWords(lit));
    }
    if ((c.name === "s" || c.name === "sound") && c.args[0]?.string) soundsInChain.push(...soundWords(c.args[0].string.text.slice(1, -1)));
    // stack(s("bd"), s("sd")).bank(…): strings of s() calls nested in the chain's first call
    if (c === chain[0] && !(c.name === "s" || c.name === "sound")) {
      for (let k = c.open + 1; k < (c.close < 0 ? toks.length : c.close); k++) {
        if ((toks[k].text === "s" || toks[k].text === "sound") && toks[k + 1]?.text === "(" && toks[k + 2]?.kind === "str") {
          soundsInChain.push(...soundWords(toks[k + 2].text.slice(1, -1)));
        }
      }
    }
  }
  return {
    string: s,
    value,
    call,
    argIndex,
    chain,
    role,
    roleFrom,
    token: miniTokenAt(text, s, offset),
    banks,
    soundsInChain: [...new Set(soundsInChain)],
  };
}
