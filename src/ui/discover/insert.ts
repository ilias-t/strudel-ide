// ═══════════════════════════════════════════════════════════════════════════
// What the library and the palette insert at the editor's caret
// ═══════════════════════════════════════════════════════════════════════════
//
// Pure: text + caret offset + item → the text to insert and where the caret
// goes in it. The context decides the form:
//
//   inside a string literal    the bare name   s("hh |") → s("hh bd")
//   after an expression        a method        s("bd")|  → s("bd").bank("TR909")
//   anywhere else              an expression   const k = | → const k = s("bd")
//
// "After an expression" means the last code before the caret (skipping
// whitespace, newlines and comments) ends a value: `)`, `]`, a string, or an
// identifier that isn't a keyword. Inserting one item after another chains:
// s("bd") then a bank gives s("bd").bank("…").

import { tokenize, type Token } from "../tokenize.ts";

export type InsertItem =
  /** A sound name (sounds.json); pitched samples get a note */
  | { type: "sound"; name: string; pitched?: boolean }
  /** A drum machine bank; `part` is the drum used when a new expression is needed (default bd) */
  | { type: "bank"; name: string; part?: string }
  /** A function (functions.json): kind decides method vs call; params = parameter count */
  | { type: "function"; name: string; kind: "method" | "function" | "both" | "value"; params: number }
  /** Code that goes in as written (a snippet, an example) */
  | { type: "code"; code: string };

export interface Insertion {
  text: string;
  /** Where the caret goes, as an offset into `text` */
  caret: number;
}

/** Words after which a new expression starts (not something to chain on) */
const EXPRESSION_KEYWORDS = new Set([
  "return", "const", "let", "var", "yield", "await", "case", "of", "in", "new", "typeof", "void",
  "delete", "throw", "else", "do", "instanceof", "export", "default", "satisfies", "as",
]);

type Context = "string" | "chain" | "expression";

/** The token containing `offset` strictly inside it (a string's quotes are its edges) */
function stringAt(tokens: Token[], text: string, offset: number): Token | null {
  for (const t of tokens) {
    if (t.start >= offset) break;
    if (t.kind !== "s" || offset <= t.start) continue;
    const q = text[t.start];
    const closed = t.end - t.start >= 2 && text[t.end - 1] === q && text[t.end - 2] !== "\\";
    if (offset < t.end || (!closed && offset === t.end)) return t;
  }
  return null;
}

function contextAt(text: string, offset: number): Context {
  const tokens = tokenize(text);
  if (stringAt(tokens, text, offset)) return "string";
  // the last token before the caret that isn't whitespace or a comment
  let last: Token | null = null;
  for (const t of tokens) {
    if (t.start >= offset) break;
    if (t.kind === "c") continue;
    const slice = text.slice(t.start, Math.min(t.end, offset));
    if (!slice.trim()) continue;
    last = t;
  }
  if (!last) return "expression";
  const piece = text.slice(last.start, Math.min(last.end, offset)).trimEnd();
  if (last.kind === "s") return "chain";
  if (last.kind === "p") return /[)\]]$/.test(piece) ? "chain" : "expression";
  if (last.kind === "k") return EXPRESSION_KEYWORDS.has(piece) ? "expression" : "chain"; // this, true, null…
  if (last.kind === "n") return "expression";
  // identifiers (plain, Type/CONSTANT, a call's name): the last word decides
  const word = /[\p{L}\p{N}_$]+$/u.exec(piece)?.[0];
  if (!word) return "expression";
  return EXPRESSION_KEYWORDS.has(word) ? "expression" : "chain";
}

/**
 * Where an insert goes when the caret was never placed (a fresh editor has it
 * at the top of the file): the start of the line of createPattern()'s last
 * `return`, where the tracks are defined. The inserted code goes on its own
 * line there, indented like the return. A heuristic over tokens (no parser):
 * the last `return` keyword after `createPattern` and before `export default`.
 */
export function defaultInsertSpot(text: string): { offset: number; indent: string } | null {
  const tokens = tokenize(text);
  let seen = false;
  let spot: number | null = null;
  for (const t of tokens) {
    const word = text.slice(t.start, t.end);
    if (!seen) {
      seen = t.kind !== "c" && t.kind !== "s" && word === "createPattern";
      continue;
    }
    if (t.kind === "k" && word === "export") break;
    if (t.kind === "k" && word === "return") spot = t.start;
  }
  if (spot === null) return null;
  const lineStart = text.lastIndexOf("\n", spot - 1) + 1;
  const indent = text.slice(lineStart, spot);
  if (indent.trim()) return null; // not alone on its line
  return { offset: lineStart, indent };
}

const str = (s: string) => JSON.stringify(s);

/** The name inside a string, with a space on each side where a neighbour would run into it */
function inString(text: string, offset: number, name: string): Insertion {
  const before = text[offset - 1] ?? "";
  const after = text[offset] ?? "";
  const glue = (c: string) => c !== "" && !/[\s"'`[\]<>{}(),|]/.test(c);
  const lead = glue(before) ? " " : "";
  const trail = glue(after) ? " " : "";
  return { text: lead + name + trail, caret: lead.length + name.length };
}

const at = (text: string, caret = text.length): Insertion => ({ text, caret });

/**
 * What to insert at `offset` (replacing [offset, selectionEnd) if given: the
 * context is read at the selection's start).
 */
export function insertionFor(text: string, offset: number, item: InsertItem, selectionEnd = offset): Insertion {
  const rest = text.slice(0, offset) + text.slice(selectionEnd);
  const ctx = contextAt(rest, offset);
  if (item.type === "code") return at(item.code);
  if (ctx === "string") return inString(rest, offset, item.name);
  switch (item.type) {
    case "sound":
      if (ctx === "chain") return at(`.s(${str(item.name)})`);
      return at(item.pitched ? `note("c3").s(${str(item.name)})` : `s(${str(item.name)})`);
    case "bank":
      if (ctx === "chain") return at(`.bank(${str(item.name)})`);
      return at(`s(${str(item.part ?? "bd")}).bank(${str(item.name)})`);
    case "function": {
      if (item.kind === "value") return at(item.name);
      const dot = item.kind === "method" || (item.kind === "both" && ctx === "chain") ? "." : "";
      const call = `${dot}${item.name}()`;
      return at(call, item.params > 0 ? call.length - 1 : call.length);
    }
  }
}
