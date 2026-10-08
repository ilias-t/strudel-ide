// ═══════════════════════════════════════════════════════════════════════════
// Add a track to a song's text: the track builder's planner
// ═══════════════════════════════════════════════════════════════════════════
//
//   planAddTrack(ts, text, { name, code })  → the edits that add
//       const <name> = <code>;        on its own line just before createPattern's
//                                     last top-level return, indented like it
//       <name>                        after the last track of the returned record
//   trackNames(ts, text)                   → the record's tracks and every name a
//                                            new track can't take
//   freeTrackName(ts, text, base)          → base, base2, base3… (the first free one)
//   nameProblem(name, taken)               → why a name won't do (no TypeScript needed)
//
// The song is found by the TypeScript AST, never by text: the default export (an
// object literal, maybe `satisfies Song` / `as Song`, or an identifier bound to
// one), its createPattern (a method, or a function / block-bodied arrow
// property), the last `return` at the top level of its body, and that return's
// record: an object literal, or the first argument of a call (`mixdown({ … })`),
// through parentheses, `as`, `satisfies` and `!`. Anything else is refused with
// a short reason, and so is a file with a syntax error: a broken file is never
// touched.
//
// A name is refused when it is a key of the record, declared at the top level
// of createPattern or of the module, or used as an identifier anywhere in
// createPattern or in the code: a `const` there would shadow it (and calls
// before it would hit the temporal dead zone).
//
// The edits are minimal and index the original text; the file's line endings
// are kept. Before a plan is returned it is applied and checked: the result
// parses cleanly, the record has the name, and createPattern declares
// `const <name> = <code>` at its top level. Otherwise it is refused.
//
// Pure: takes the `typescript` instance as a parameter (like ./compile.ts), no
// browser APIs. Runs in the compiler worker (./worker.ts) and in Node tests.
// ═══════════════════════════════════════════════════════════════════════════

import type TS from "typescript";

type Ts = typeof TS;

export interface TrackEdit {
  /** Offsets into the original text */
  start: number;
  end: number;
  text: string;
}

export interface NewTrack {
  name: string;
  /** One expression (a snippet's code) */
  code: string;
}

export type AddTrackPlan =
  | {
      ok: true;
      /** Non-overlapping, in order, offsets into the original text */
      edits: TrackEdit[];
      /** The text with the edits applied */
      text: string;
      /** `const <name> = <code>;` in the result */
      constRange: [number, number];
    }
  | { ok: false; reason: string };

export type TrackNames =
  | { ok: true; tracks: string[]; taken: string[] }
  /** The song can't take a track; `taken` holds what could be read anyway */
  | { ok: false; reason: string; taken: string[] };

export const TRACK_LIST_REASON = "can't find the track list: createPattern() must end with return { … } or mixdown({ … })";

/** Words that can't name a const in a module (strict mode), and globals not to shadow */
const RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for " +
    "function if import in instanceof new null return super switch this throw true try typeof var void while with " +
    "yield let static implements interface package private protected public await arguments eval undefined NaN Infinity"
  ).split(" ")
);

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Why `name` can't name a new track (null: it can) */
export function nameProblem(name: string, taken: Iterable<string>): string | null {
  if (!name) return "type a name for the track";
  if (!IDENTIFIER.test(name)) return `"${name}" isn't a valid name: letters, digits, _ or $, not starting with a digit`;
  if (RESERVED.has(name)) return `"${name}" is a reserved word: pick another name`;
  for (const t of taken) if (t === name) return `"${name}" is already used in this song`;
  return null;
}

/** `base` if it's free, else base2, base3… */
export function pickFreeName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!nameProblem(base, set)) return base;
  for (let i = 2; i < 1000; i++) if (!nameProblem(`${base}${i}`, set)) return `${base}${i}`;
  return base;
}

// ─────────────────────────────────────────────────────────────────────────────
// Finding the song
// ─────────────────────────────────────────────────────────────────────────────

interface Found {
  /** createPattern's body */
  body: TS.Block;
  /** The last top-level return */
  ret: TS.ReturnStatement;
  record: TS.ObjectLiteralExpression;
}

interface Analysis {
  found: Found | null;
  /** Why `found` is null */
  reason: string;
  tracks: string[];
  taken: Set<string>;
}

function parse(ts: Ts, text: string, file: string): TS.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Syntax errors the parser found (not in the public typings) */
const parseErrors = (sf: TS.SourceFile) => (sf as unknown as { parseDiagnostics?: readonly TS.Diagnostic[] }).parseDiagnostics ?? [];

/** Through parentheses, `as`, `satisfies`, `<T>x` and `!` */
function unwrap(ts: Ts, e: TS.Expression): TS.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) {
      e = e.expression;
    } else {
      return e;
    }
  }
}

function propName(ts: Ts, name: TS.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  return undefined;
}

function bindingNames(ts: Ts, name: TS.BindingName, out: Set<string>) {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(ts, el.name, out);
}

/** Names a statement list declares at its own level */
function declaredIn(ts: Ts, statements: readonly TS.Statement[], out: Set<string>) {
  for (const s of statements) {
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) bindingNames(ts, d.name, out);
    } else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isEnumDeclaration(s)) && s.name) {
      out.add(s.name.text);
    } else if (ts.isImportDeclaration(s) && s.importClause) {
      const c = s.importClause;
      if (c.name) out.add(c.name.text);
      const nb = c.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) out.add(nb.name.text);
      else if (nb) for (const el of nb.elements) out.add(el.name.text);
    } else if (ts.isImportEqualsDeclaration(s)) {
      out.add(s.name.text);
    }
  }
}

/** Every identifier used in `node` other than as a property name */
function identifiersIn(ts: Ts, node: TS.Node, out: Set<string>) {
  const visit = (n: TS.Node) => {
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isPropName =
        p &&
        ((ts.isPropertyAccessExpression(p) && p.name === n) ||
          ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p)) && p.name === n));
      if (!isPropName) out.add(n.text);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
}

function analyze(ts: Ts, sf: TS.SourceFile): Analysis {
  const taken = new Set<string>();
  declaredIn(ts, sf.statements, taken);
  const fail = (reason: string): Analysis => ({ found: null, reason, tracks: [], taken });

  // the default export, as an object literal
  let exported: TS.Expression | undefined;
  for (const s of sf.statements) if (ts.isExportAssignment(s) && !s.isExportEquals) exported = s.expression;
  if (!exported) return fail("can't find the song: the file must `export default` a song");
  let songExpr = unwrap(ts, exported);
  if (ts.isIdentifier(songExpr)) {
    const id = songExpr.text;
    let init: TS.Expression | undefined;
    for (const s of sf.statements) {
      if (!ts.isVariableStatement(s)) continue;
      for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === id) init = d.initializer;
    }
    if (!init) return fail(`can't find the song: \`${id}\` isn't a const in this file`);
    songExpr = unwrap(ts, init);
  }
  if (!ts.isObjectLiteralExpression(songExpr)) return fail("can't find the song: the default export must be an object { name, createPattern() { … } }");

  // createPattern, with a block body
  let fn: TS.FunctionLikeDeclaration | undefined;
  for (const p of songExpr.properties) {
    if (propName(ts, p.name) !== "createPattern") continue;
    if (ts.isMethodDeclaration(p)) fn = p;
    else if (ts.isPropertyAssignment(p)) {
      const v = unwrap(ts, p.initializer);
      if (ts.isFunctionExpression(v) || ts.isArrowFunction(v)) fn = v;
      else return fail("createPattern must be a function");
    }
  }
  if (!fn) return fail("can't find createPattern() in the song");
  const body = fn.body;
  if (!body || !ts.isBlock(body)) return fail("createPattern() needs a { … } body that ends with return { … }");
  for (const p of fn.parameters) bindingNames(ts, p.name, taken);
  declaredIn(ts, body.statements, taken);
  identifiersIn(ts, body, taken);

  // its last top-level return, and the record
  const returns = body.statements.filter(ts.isReturnStatement);
  const ret = returns[returns.length - 1];
  if (!ret?.expression) return fail(TRACK_LIST_REASON);
  let value = unwrap(ts, ret.expression);
  if (ts.isCallExpression(value) && value.arguments.length) value = unwrap(ts, value.arguments[0]);
  if (!ts.isObjectLiteralExpression(value)) return fail(TRACK_LIST_REASON);
  const props = value.properties;
  if (props.length && props.every(ts.isSpreadAssignment)) return fail(TRACK_LIST_REASON);
  const tracks: string[] = [];
  for (const p of props) {
    const name = ts.isSpreadAssignment(p) ? undefined : propName(ts, p.name);
    if (name !== undefined) {
      tracks.push(name);
      taken.add(name);
    }
  }
  return { found: { body, ret, record: value }, reason: "", tracks, taken };
}

/** The record's tracks and the names a new track can't take */
export function trackNames(ts: Ts, text: string, file = "song.ts"): TrackNames {
  const sf = parse(ts, text, file);
  const a = analyze(ts, sf);
  const taken = [...a.taken].sort();
  if (parseErrors(sf).length) return { ok: false, reason: SYNTAX_REASON, taken };
  if (!a.found) return { ok: false, reason: a.reason, taken };
  return { ok: true, tracks: a.tracks, taken };
}

/** `base`, or base2, base3…: the first name a new track can take (never throws) */
export function freeTrackName(ts: Ts, text: string, base: string): string {
  return pickFreeName(base, analyze(ts, parse(ts, text, "song.ts")).taken);
}

// ─────────────────────────────────────────────────────────────────────────────
// Planning
// ─────────────────────────────────────────────────────────────────────────────

const SYNTAX_REASON = "the song has a syntax error: fix it first";
const UNVERIFIED_REASON = "the edit didn't verify, so the song was left alone";

/** The offset after spaces, tabs, line breaks and comments from `i` (stops at `limit`) */
function skipTrivia(text: string, i: number, limit = text.length, { newlines = true } = {}): number {
  while (i < limit) {
    const c = text[i];
    if (c === " " || c === "\t") i++;
    else if (newlines && (c === "\n" || c === "\r")) i++;
    else if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i);
      i = nl < 0 || nl > limit ? limit : text[nl - 1] === "\r" ? nl - 1 : nl;
    } else if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2);
      if (close < 0 || close + 2 > limit) return i;
      if (!newlines && /[\r\n]/.test(text.slice(i, close))) return i;
      i = close + 2;
    } else break;
  }
  return i;
}

const lineStartOf = (text: string, at: number) => text.lastIndexOf("\n", at - 1) + 1;

/** The end of `at`'s line, before its line break */
function lineEndOf(text: string, at: number): number {
  const nl = text.indexOf("\n", at);
  if (nl < 0) return text.length;
  return text[nl - 1] === "\r" ? nl - 1 : nl;
}

/** Whether `code` is exactly one expression (no statements, no comma operator, no dangling comment) */
function isOneExpression(ts: Ts, code: string): boolean {
  const wrapped = `(${code});`;
  const sf = parse(ts, wrapped, "snippet.ts");
  if (parseErrors(sf).length || sf.statements.length !== 1) return false;
  const st = sf.statements[0];
  if (!ts.isExpressionStatement(st) || !ts.isParenthesizedExpression(st.expression)) return false;
  if (st.getStart(sf) !== 0 || st.end !== wrapped.length) return false;
  const inner = st.expression.expression;
  return !(ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.CommaToken);
}

/** The record edits: `name` after the last track */
function recordEdits(text: string, record: TS.ObjectLiteralExpression, sf: TS.SourceFile, name: string, eol: string): TrackEdit[] {
  const open = record.getStart(sf);
  const close = record.end - 1; // "}"
  const props = record.properties;
  if (!props.length) {
    const inner = text.slice(open + 1, close);
    if (/^\s*$/.test(inner)) return [{ start: open + 1, end: close, text: ` ${name} ` }];
    return [{ start: open + 1, end: open + 1, text: ` ${name},` }]; // only comments inside
  }
  const last = props[props.length - 1];
  const lastStart = last.getStart(sf);
  const lastEnd = last.end;
  let comma = -1;
  if (props.hasTrailingComma) {
    comma = skipTrivia(text, lastEnd, close);
    if (text[comma] !== ",") comma = -1;
  }
  const lineStart = lineStartOf(text, lastStart);
  const ownLine = /^[ \t]*$/.test(text.slice(lineStart, lastStart)) && lineStartOf(text, open) !== lineStart;
  if (ownLine) {
    // one track per line: a new line after the last one's (and after a comment ending it)
    const anchor = comma >= 0 ? comma + 1 : lastEnd;
    const lineEnd = lineEndOf(text, anchor);
    if (lineEnd <= close && skipTrivia(text, anchor, lineEnd, { newlines: false }) === lineEnd) {
      const indent = text.slice(lineStart, lastStart);
      const line = `${eol}${indent}${name}${comma >= 0 ? "," : ""}`;
      if (comma >= 0) return [{ start: lineEnd, end: lineEnd, text: line }];
      // no trailing comma: one after the last track (before a comment ending its line)
      // as its own edit, or merged when it's the same spot (edits never share an offset)
      if (lineEnd === lastEnd) return [{ start: lastEnd, end: lastEnd, text: `,${line}` }];
      return [
        { start: lastEnd, end: lastEnd, text: "," },
        { start: lineEnd, end: lineEnd, text: line },
      ];
    }
  }
  if (comma >= 0) return [{ start: comma + 1, end: comma + 1, text: ` ${name},` }];
  return [{ start: lastEnd, end: lastEnd, text: `, ${name}` }];
}

/** Plan adding `const <name> = <code>;` and `<name>` to the song (see the header). Never throws. */
export function planAddTrack(ts: Ts, text: string, track: NewTrack, file = "song.ts"): AddTrackPlan {
  try {
    return plan(ts, text, track, file);
  } catch (err) {
    return { ok: false, reason: `couldn't plan the edit: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function plan(ts: Ts, text: string, { name, code: rawCode }: NewTrack, file: string): AddTrackPlan {
  const sf = parse(ts, text, file);
  if (parseErrors(sf).length) return { ok: false, reason: SYNTAX_REASON };
  const a = analyze(ts, sf);
  if (!a.found) return { ok: false, reason: a.reason };

  const code = rawCode.trim();
  if (!code) return { ok: false, reason: "the snippet's code is empty" };
  if (!isOneExpression(ts, code)) return { ok: false, reason: "the snippet's code must be one expression" };
  const used = new Set(a.taken);
  identifiersIn(ts, parse(ts, `(${code});`, "snippet.ts"), used);
  const problem = nameProblem(name, used);
  if (problem) return { ok: false, reason: problem };
  // the parser agrees it can name a const
  const decl = parse(ts, `const ${name} = 0;`, "name.ts");
  const st = decl.statements[0];
  if (
    parseErrors(decl).length ||
    decl.statements.length !== 1 ||
    !ts.isVariableStatement(st) ||
    st.declarationList.declarations.length !== 1 ||
    !ts.isIdentifier(st.declarationList.declarations[0].name) ||
    st.declarationList.declarations[0].name.text !== name
  ) {
    return { ok: false, reason: `"${name}" can't name a track: pick another name` };
  }

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const { ret, record } = a.found;
  const constText = `const ${name} = ${code};`;
  const retStart = ret.getStart(sf);
  const retLine = lineStartOf(text, retStart);
  const indent = text.slice(retLine, retStart);
  let constEdit: TrackEdit;
  let constStart: number;
  if (/^[ \t]*$/.test(indent)) {
    constEdit = { start: retLine, end: retLine, text: `${indent}${constText}${eol}` };
    constStart = retLine + indent.length;
  } else {
    constEdit = { start: retStart, end: retStart, text: `${constText} ` };
    constStart = retStart;
  }
  const edits = [constEdit, ...recordEdits(text, record, sf, name, eol)].sort((x, y) => x.start - y.start);

  let out = text;
  for (const e of [...edits].reverse()) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  const constRange: [number, number] = [constStart, constStart + constText.length];

  // verify: parses, the record has the name, createPattern declares it
  const sf2 = parse(ts, out, file);
  if (parseErrors(sf2).length) return { ok: false, reason: UNVERIFIED_REASON };
  const b = analyze(ts, sf2);
  if (!b.found || !b.tracks.includes(name) || b.tracks.length !== a.tracks.length + 1) return { ok: false, reason: UNVERIFIED_REASON };
  const declared = b.found.body.statements.some(
    (s) =>
      ts.isVariableStatement(s) &&
      s.getStart(sf2) === constStart &&
      s.end === constRange[1] &&
      (s.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
      s.declarationList.declarations.length === 1 &&
      ts.isIdentifier(s.declarationList.declarations[0].name) &&
      s.declarationList.declarations[0].name.text === name &&
      s.declarationList.declarations[0].initializer?.getText(sf2) === code
  );
  if (!declared) return { ok: false, reason: UNVERIFIED_REASON };
  return { ok: true, edits, text: out, constRange };
}
