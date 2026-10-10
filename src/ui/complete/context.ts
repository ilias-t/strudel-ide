// ═══════════════════════════════════════════════════════════════════════════
// What a string literal means (pure, synchronous)
// ═══════════════════════════════════════════════════════════════════════════
//
// Given a song's text and a caret offset inside a string literal, decide:
//   - which call the string is an argument of (s, .bank, note, .scale, …)
//     and which argument,
//   - the whole call chain it sits in (s("bd sd").bank("tr909").gain(.5)),
//     so a role can come from *after* the string: mini("c e g").note()
//     (./roles.ts),
//   - the mini-notation token under the caret (./mini.ts),
//   - the banks that apply to it, the sounds its chain plays (for .bank("…"))
//     and the track it belongs to.
//
// No TypeScript, no worker: a small lexer (strings, templates, comments,
// identifiers, numbers, one punctuation character per token) plus one bracket
// pass, cached for the last text seen, so a keystroke costs one lex and every
// later question about the same text is cheap. allStringContexts() answers
// for every string at once (diagnostics). Half-typed code (unclosed strings
// and brackets, the normal state while typing) degrades to null, never throws.
//
// Known blind spots (by design, like highlighting: literals only): a pattern
// kept in a variable and passed by name (s(PAT)) has no context of its own;
// a carrier inside a role call (s(cat("bd", "sd"))) is plain mini-notation.

import type { CallRef, StringContext } from "./types.ts";
import { miniTokenAt, soundWords } from "./mini.ts";
import { resolveRole, type RoleCall } from "./roles.ts";

export { miniTokenAt, soundWords, soundWordsWithOffsets } from "./mini.ts";

// ── lexer ─────────────────────────────────────────────────────────────────

export type LexKind = "str" | "id" | "num" | "punct";
export interface Lex {
  kind: LexKind;
  start: number;
  end: number;
  text: string;
  /** str: has its closing quote */
  closed?: boolean;
  /** str: a template with ${…} substitutions (its inner code follows it as tokens) */
  subst?: boolean;
  /** str: the token index just past the template's inner tokens */
  innerEnd?: number;
  /** str inside a template's ${…}: the template's token index */
  outer?: number;
}

const isDigit = (c: number) => c >= 48 && c <= 57;
const isIdStart = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36;
const isIdPart = (c: number) => isIdStart(c) || isDigit(c);

/** Significant tokens: comments and whitespace dropped, one punctuation char per token */
export function lex(text: string): Lex[] {
  const out: Lex[] = [];
  lexCode(text, 0, out, -1);
  return out;
}

/** Lex code from `i`; inside a template's ${…} (outer ≥ 0), stop at its closing "}" and return its index */
function lexCode(text: string, i: number, out: Lex[], outer: number): number {
  const n = text.length;
  let braces = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c <= 32 || c === 160) {
      i++;
      continue;
    }
    if (c === 47) {
      const d = text.charCodeAt(i + 1);
      if (d === 47) {
        const e = text.indexOf("\n", i);
        i = e < 0 ? n : e;
        continue;
      }
      if (d === 42) {
        const e = text.indexOf("*/", i + 2);
        i = e < 0 ? n : e + 2;
        continue;
      }
    }
    if (c === 34 || c === 39) {
      const start = i++;
      let closed = false;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 92) {
          i += 2;
          continue;
        }
        if (d === c) {
          i++;
          closed = true;
          break;
        }
        if (d === 10) break;
        i++;
      }
      const end = Math.min(i, n);
      const tok: Lex = { kind: "str", start, end, text: text.slice(start, end), closed };
      if (outer >= 0) tok.outer = outer;
      out.push(tok);
      continue;
    }
    if (c === 96) {
      i = lexTemplate(text, i, out, outer);
      continue;
    }
    if (isIdStart(c)) {
      const start = i;
      while (i < n && isIdPart(text.charCodeAt(i))) i++;
      out.push({ kind: "id", start, end: i, text: text.slice(start, i) });
      continue;
    }
    if (isDigit(c) || (c === 46 && isDigit(text.charCodeAt(i + 1)))) {
      const start = i;
      while (i < n && (isIdPart(text.charCodeAt(i)) || text.charCodeAt(i) === 46)) i++;
      out.push({ kind: "num", start, end: i, text: text.slice(start, i) });
      continue;
    }
    if (outer >= 0) {
      if (c === 123) braces++;
      else if (c === 125 && braces-- === 0) return i;
    }
    out.push({ kind: "punct", start: i, end: i + 1, text: text[i] });
    i++;
  }
  return n;
}

/** A template literal from its backtick at `start`; returns the offset after it */
function lexTemplate(text: string, start: number, out: Lex[], outer: number): number {
  const n = text.length;
  const tok: Lex = { kind: "str", start, end: n, text: "", closed: false };
  if (outer >= 0) tok.outer = outer;
  const index = out.length;
  out.push(tok);
  let i = start + 1;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 92) {
      i += 2;
      continue;
    }
    if (c === 96) {
      i++;
      tok.closed = true;
      break;
    }
    if (c === 36 && text.charCodeAt(i + 1) === 123) {
      tok.subst = true;
      i = lexCode(text, i + 2, out, index) + 1; // past the "}"
      continue;
    }
    i++;
  }
  tok.end = Math.min(i, n);
  tok.text = text.slice(start, tok.end);
  if (tok.subst) tok.innerEnd = out.length;
  return tok.end;
}

// ── the scan of one text: tokens + brackets, cached ─────────────────────────

const OPEN_OF: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

interface Call {
  name: string;
  method: boolean;
  /** token indices of the name, its "(" and its ")" (-1: not closed yet) */
  nameIndex: number;
  open: number;
  close: number;
}

interface ChainInfo {
  calls: Call[];
  /** banks of this chain and of the chains it's nested in (stack(s("bd")).bank("X")) */
  banks: string[];
  soundsInChain: string[];
}

interface Scan {
  text: string;
  toks: Lex[];
  /** for a bracket token, its partner's index (-1: unmatched) */
  match: Int32Array;
  /** for every token, the index of the bracket it sits in (-1: top level) */
  parent: Int32Array;
  /** for an opening bracket, the token index where it ends (its partner, or where it was dropped) */
  closeAt: Int32Array;
  /** indices of the string tokens, in order */
  strs: number[];
  consts?: Map<string, string>;
  chains: Map<number, ChainInfo>;
}

function scanOf(text: string): Scan {
  const toks = lex(text);
  const n = toks.length;
  const match = new Int32Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1);
  const closeAt = new Int32Array(n).fill(n);
  const strs: number[] = [];
  const stack: number[] = [];
  /** open templates: [innerEnd, bracket depth when it started] */
  const templates: [number, number][] = [];
  const drop = (depth: number, at: number) => {
    while (stack.length > depth) closeAt[stack.pop()!] = at;
  };
  for (let i = 0; i < n; i++) {
    // a template's ${…} can't leave brackets open outside it
    while (templates.length && templates[templates.length - 1][0] <= i) drop(templates.pop()![1], i);
    const t = toks[i];
    parent[i] = stack.length ? stack[stack.length - 1] : -1;
    if (t.kind === "str") {
      strs.push(i);
      if (t.subst) templates.push([t.innerEnd!, stack.length]);
      continue;
    }
    if (t.kind !== "punct") continue;
    const c = t.text;
    if (c === "(" || c === "[" || c === "{") {
      stack.push(i);
    } else if (c === ")" || c === "]" || c === "}") {
      // close the nearest matching opener; openers left unclosed inside it end here
      const want = OPEN_OF[c];
      for (let k = stack.length - 1; k >= 0; k--) {
        if (toks[stack[k]].text !== want) continue;
        const o = stack[k];
        drop(k + 1, i);
        stack.pop();
        match[o] = i;
        match[i] = o;
        closeAt[o] = i;
        parent[i] = parent[o];
        break;
      }
    }
  }
  drop(0, n);
  return { text, toks, match, parent, closeAt, strs, chains: new Map() };
}

let cache: Scan | null = null;
function scanCached(text: string): Scan {
  if (cache?.text === text) return cache;
  cache = scanOf(text);
  return cache;
}

// ── helpers over a scan ─────────────────────────────────────────────────────

/** Words like `if (`, `return (`: not calls */
const NOT_CALLS = new Set(["if", "while", "for", "switch", "catch", "return", "typeof", "void", "delete", "in", "of", "await", "yield", "case", "do", "else", "function", "new"]);

function callAt(sc: Scan, nameIndex: number): Call | null {
  const { toks } = sc;
  const name = toks[nameIndex];
  const open = nameIndex + 1;
  if (name?.kind !== "id" || toks[open]?.text !== "(" || NOT_CALLS.has(name.text)) return null;
  // ".name(" is a method; "...name(" is a spread
  const method = toks[nameIndex - 1]?.text === "." && toks[nameIndex - 2]?.text !== ".";
  return { name: name.text, method, nameIndex, open, close: sc.match[open] };
}

/** The first call of the chain `a(…).b(…).c(…)` that `call` is in */
function chainHead(sc: Scan, call: Call): Call {
  let first = call;
  while (first.method) {
    const recvEnd = first.nameIndex - 2;
    if (sc.toks[recvEnd]?.text !== ")") break; // an identifier or string receiver: the chain starts here
    const open = sc.match[recvEnd];
    const prev = open > 0 ? callAt(sc, open - 1) : null;
    if (!prev) break; // (expr).method: a parenthesised receiver
    first = prev;
  }
  return first;
}

/** The calls of the chain starting at `head`, in order */
function chainFrom(sc: Scan, head: Call): Call[] {
  const { toks } = sc;
  const calls = [head];
  let last = head;
  while (last.close >= 0 && toks[last.close + 1]?.text === "." && toks[last.close + 2]?.kind === "id") {
    const next = callAt(sc, last.close + 2);
    if (!next) break;
    calls.push(next);
    last = next;
  }
  return calls;
}

/** `const NAME = "literal"` (or `const NAME: Type = "literal"`) anywhere in the file: the first one */
function constsOf(sc: Scan): Map<string, string> {
  if (sc.consts) return sc.consts;
  const { toks } = sc;
  const consts = new Map<string, string>();
  for (let i = 0; i + 3 < toks.length; i++) {
    const kw = toks[i].text;
    if ((kw !== "const" && kw !== "let" && kw !== "var") || toks[i].kind !== "id" || toks[i + 1].kind !== "id") continue;
    const name = toks[i + 1].text;
    let eq = i + 2;
    if (toks[eq].text === ":") {
      // a type annotation: up to the "=" (bounded; no statement ends inside one)
      const limit = Math.min(toks.length, eq + 40);
      while (eq < limit && toks[eq].text !== "=" && toks[eq].text !== ";") eq++;
    }
    if (toks[eq]?.text !== "=" || sc.text[toks[eq].end] === "=" || sc.text[toks[eq].end] === ">") continue;
    const lit = toks[eq + 1];
    const after = toks[eq + 2]?.text;
    if (lit?.kind !== "str" || lit.subst || after === "+" || after === "." || after === "[" || after === "?") continue;
    if (!consts.has(name)) consts.set(name, valueOf(lit));
  }
  sc.consts = consts;
  return consts;
}

/** A string token's contents, without its quotes */
function valueOf(t: Lex): string {
  return t.text.slice(1, t.closed ? -1 : undefined);
}

/** The string value of a call's first argument when it's one literal (or a const holding one) */
function firstArgString(sc: Scan, call: Call): string | undefined {
  const { toks } = sc;
  const a = toks[call.open + 1];
  const after = toks[call.open + 2];
  if (!a || (call.open + 2 !== call.close && after?.text !== ",")) return undefined;
  if (a.kind === "str") return a.subst ? undefined : valueOf(a);
  if (a.kind === "id") return constsOf(sc).get(a.text);
  return undefined;
}

const isSoundCall = (name: string) => name === "s" || name === "sound";

/** Is the "{" at token `o` a block (function body, if, …) rather than an object literal? */
function isBlock(sc: Scan, o: number): boolean {
  const prev = sc.toks[o - 1];
  if (!prev) return true;
  const p = prev.text;
  if (p === ")" || p === ";" || p === "{" || p === "}") return true;
  if (p === ">" && sc.text[prev.start - 1] === "=") return true; // => {
  return prev.kind === "id" && (p === "else" || p === "do" || p === "try" || p === "finally");
}

/** The chain whose first call is `head`, with its banks and sounds (memoised per scan) */
function chainInfo(sc: Scan, head: Call): ChainInfo {
  const hit = sc.chains.get(head.nameIndex);
  if (hit) return hit;
  const { toks } = sc;
  const calls = chainFrom(sc, head);
  const banks: string[] = [];
  const sounds: string[] = [];
  for (const c of calls) {
    if (c.name === "bank") {
      const v = firstArgString(sc, c);
      if (v !== undefined) banks.push(...soundWords(v));
    }
    if (isSoundCall(c.name)) {
      const v = firstArgString(sc, c);
      if (v !== undefined) sounds.push(...soundWords(v));
    }
    // stack(s("bd"), s("sd")).bank(…): s() strings nested in the chain's arguments
    const end = Math.min(sc.closeAt[c.open], toks.length);
    for (let k = c.open + 1; k < end; k++) {
      if (toks[k].kind !== "id" || !isSoundCall(toks[k].text)) continue;
      const inner = callAt(sc, k);
      const v = inner ? firstArgString(sc, inner) : undefined;
      if (v !== undefined) sounds.push(...soundWords(v));
    }
  }
  // banks of the chains this one is nested in: stack(s("bd"), …).bank("X") banks "bd" too
  const outer = enclosingCall(sc, head.nameIndex);
  if (outer) banks.push(...chainInfo(sc, chainHead(sc, outer)).banks);
  const info: ChainInfo = { calls, banks: [...new Set(banks)], soundsInChain: [...new Set(sounds)] };
  sc.chains.set(head.nameIndex, info);
  return info;
}

/** The nearest call whose arguments contain token `i` (through arrays and records, never out of a block) */
function enclosingCall(sc: Scan, i: number): Call | null {
  const { toks, parent } = sc;
  for (let o = parent[i]; o >= 0; o = parent[o]) {
    const t = toks[o].text;
    if (t === "(") {
      const c = o > 0 ? callAt(sc, o - 1) : null;
      if (c) return c;
    } else if (t === "{" && isBlock(sc, o)) return null;
  }
  return null;
}

// ── track names ─────────────────────────────────────────────────────────────

/** `x = …`: an assignment, not `==`, `=>`, `<=`, `!=` */
function isAssign(sc: Scan, t: Lex): boolean {
  if (t.text !== "=") return false;
  const next = sc.text[t.end];
  const prev = sc.text[t.start - 1];
  return next !== "=" && next !== ">" && prev !== "=" && prev !== "!" && prev !== "<" && prev !== ">";
}

/** At block level, scanning back from token `i`: the name `const NAME = …` binds, if this statement is one */
function bindingBefore(sc: Scan, i: number, lo: number): string | undefined {
  const { toks, match } = sc;
  for (let j = i - 1; j > lo; j--) {
    const t = toks[j];
    if (t.kind === "punct") {
      if ((t.text === ")" || t.text === "]") && match[j] >= 0) {
        j = match[j];
        continue;
      }
      if (t.text === ";" || t.text === "}" || t.text === "{") return undefined;
      if (isAssign(sc, t)) {
        // const NAME = … | const NAME: Type = …
        for (let k = j - 1; k > lo && k >= j - 40; k--) {
          const kw = toks[k];
          if (kw.kind === "id" && (kw.text === "const" || kw.text === "let" || kw.text === "var")) {
            const name = toks[k + 1];
            return name?.kind === "id" && (k + 2 === j || toks[k + 2].text === ":") ? name.text : undefined;
          }
          if (kw.text === ";" || kw.text === "{" || kw.text === "}") return undefined;
        }
        return undefined;
      }
    } else if (t.kind === "id" && t.text === "return") return undefined;
  }
  return undefined;
}

/** In the record opened at `o`, the key of the property token `i` belongs to */
function keyBefore(sc: Scan, i: number, o: number): string | undefined {
  const { toks, match } = sc;
  let j = i - 1;
  for (; j > o; j--) {
    const t = toks[j];
    if (t.kind !== "punct") continue;
    if ((t.text === ")" || t.text === "]" || t.text === "}") && match[j] >= 0) j = match[j];
    else if (t.text === ",") break;
  }
  const key = toks[j + 1];
  if (j + 1 >= i || toks[j + 2]?.text !== ":") return undefined;
  if (key.kind === "id") return key.text;
  if (key.kind === "str" && !key.subst) return valueOf(key);
  return undefined;
}

/**
 * The track token `i` belongs to: the innermost record key whose record
 * isn't a call argument (`{ pulse: s(…) }`, `return { kick: … }`), else the
 * innermost `const x = …`, else the innermost key of a record passed to a call
 * (`mixdown({ kick: … })`; but `const kick = track({ intro: … })` is "kick").
 * A function or method body ends the search.
 */
function trackNameFrom(sc: Scan, i: number): string | undefined {
  const { toks, parent } = sc;
  let binding: string | undefined;
  let argKey: string | undefined;
  let at = i;
  for (;;) {
    const o = parent[at];
    if (o < 0 || (toks[o].text === "{" && isBlock(sc, o))) {
      // the top level or a function body: this statement decides
      binding ??= bindingBefore(sc, at, o);
      break;
    }
    if (toks[o].text === "{") {
      const key = keyBefore(sc, at, o);
      if (key !== undefined) {
        const po = parent[o];
        const inCall = po > 0 && toks[po].text === "(" && callAt(sc, po - 1) !== null;
        if (!inCall) return key;
        argKey ??= key;
      }
    }
    at = o; // out of a call's parentheses, an array or a record
  }
  return binding ?? argKey;
}

/** The track the code at `offset` belongs to: `const hats = …` or a record key `hats: …` */
export function trackNameAt(text: string, offset: number): string | undefined {
  const sc = scanCached(text);
  const i = lastTokenBefore(sc.toks, offset);
  return i < 0 ? undefined : trackNameFrom(sc, i);
}

/** Index of the last token starting before `offset`, -1 if none */
function lastTokenBefore(toks: Lex[], offset: number): number {
  let lo = 0;
  let hi = toks.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (toks[mid].start < offset) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

// ── string contexts ─────────────────────────────────────────────────────────

const ref = (c: Call): CallRef => ({ name: c.name, method: c.method });

/** Does string token `t` hold the caret at `offset`: after its opening quote, at or before its closing one */
function holds(t: Lex, offset: number): boolean {
  return offset > t.start && (offset < t.end || (!t.closed && offset === t.end));
}

/** The context of string token `si` with the caret at `offset` */
function contextOf(sc: Scan, si: number, offset: number): StringContext | null {
  const { toks, parent, match } = sc;
  const s = toks[si];
  if (s.subst) return null;
  const p = parent[si];
  if (p < 0 || toks[p].text !== "(") return null; // outside calls, or in an array / object literal
  const call = p > 0 ? callAt(sc, p - 1) : null;
  if (!call) return null;
  let argIndex = 0;
  for (let j = si - 1; j > p; j--) {
    const t = toks[j];
    if (t.kind !== "punct") continue;
    if ((t.text === ")" || t.text === "]" || t.text === "}") && match[j] >= 0) j = match[j];
    else if (t.text === ",") argIndex++;
  }
  const info = chainInfo(sc, chainHead(sc, call));
  const at = info.calls.findIndex((c) => c.nameIndex === call.nameIndex);
  const roleCalls: RoleCall[] = info.calls.map((c) => ({ name: c.name, method: c.method, empty: c.close === c.open + 1 }));
  const { role, roleFrom } = resolveRole(roleCalls, at);
  const contentEnd = s.closed ? s.end - 1 : s.end;
  const ctx: StringContext = {
    string: { start: s.start, end: s.end },
    value: valueOf(s),
    call: ref(call),
    argIndex,
    chain: info.calls.map(ref),
    role,
    roleFrom,
    token: miniTokenAt(sc.text, s.start + 1, contentEnd, offset),
    banks: [...info.banks],
    soundsInChain: [...info.soundsInChain],
  };
  const track = trackNameFrom(sc, si);
  if (track !== undefined) ctx.trackName = track;
  return ctx;
}

/** The context of the string literal holding `offset`, or null outside strings, outside calls and in templates with ${…} */
export function stringContextAt(text: string, offset: number): StringContext | null {
  const sc = scanCached(text);
  const { toks, strs } = sc;
  // the last string starting before the caret, or a template around it
  let lo = 0;
  let hi = strs.length - 1;
  let k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (toks[strs[mid]].start < offset) {
      k = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (k < 0) return null;
  let si = strs[k];
  while (!holds(toks[si], offset)) {
    const up = toks[si].outer;
    if (up === undefined) return null;
    si = up;
  }
  return contextOf(sc, si, offset);
}

/** The context of every string literal that is a call argument, in order; each token sits at its string's start */
export function allStringContexts(text: string): StringContext[] {
  const sc = scanCached(text);
  const out: StringContext[] = [];
  for (const si of sc.strs) {
    const c = contextOf(sc, si, sc.toks[si].start + 1);
    if (c) out.push(c);
  }
  return out;
}
