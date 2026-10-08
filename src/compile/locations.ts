// ═══════════════════════════════════════════════════════════════════════════
// Locations transform: mini-notation literals → __strudel_m("…", offset)
// ═══════════════════════════════════════════════════════════════════════════
//
// The one implementation of the transform, used by the Vite plugin
// (vite-plugins/strudel-locations.ts, which documents the rules in full) and
// by the browser compiler (./compile.ts). It takes the `typescript` instance
// as a parameter, so this module loads no compiler by itself:
//
//     s("bd*4").bank("RolandTR808")
//  →  s(__strudel_m("bd*4", 123)).bank(__strudel_m("RolandTR808", 140))
//
// `offset` is the UTF-16 position of the opening quote in `code`, which is
// what `m` from @strudel/mini expects. All injected code is appended after the
// original text, so line numbers are unchanged.
// ═══════════════════════════════════════════════════════════════════════════

import type TS from "typescript";
import MagicString, { type SourceMap } from "magic-string";
import { contentVersion } from "../live/protocol.ts";
import { RECEIVER_DENY, type StrudelNames } from "./names.ts";

type Ts = typeof TS;

export interface Rewrite {
  /** offset of the opening quote */
  start: number;
  /** offset just past the closing quote */
  end: number;
  /** cooked string value (== raw text between the quotes) */
  value: string;
  callee: string;
}

export interface LocationsResult {
  code: string;
  map: SourceMap;
  version: string;
  rewrites: Rewrite[];
}

type StringLike = TS.StringLiteral | TS.NoSubstitutionTemplateLiteral;

/** All names declared anywhere in the file (conservative shadowing check) */
function declaredNames(ts: Ts, sf: TS.SourceFile): Set<string> {
  const names = new Set<string>();
  const addBinding = (name: TS.BindingName | undefined) => {
    if (!name) return;
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) addBinding(el.name);
  };
  const visit = (node: TS.Node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) addBinding(node.name);
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) names.add(node.name.text);
    else if (ts.isImportClause(node) && node.name) names.add(node.name.text);
    else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/** Leftmost identifier of a property-access chain (`a.b().c` → "a") */
function rootIdentifier(ts: Ts, expr: TS.Expression): TS.Expression {
  let e: TS.Expression = expr;
  for (;;) {
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e)) e = e.expression;
    else if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    else return e;
  }
}

/** Name of the callee if its string arguments should become mini patterns */
function patternCallee(ts: Ts, call: TS.CallExpression, names: StrudelNames, local: Set<string>): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    return names.functions.has(callee.text) && !local.has(callee.text) ? callee.text : null;
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
    const method = callee.name.text;
    if (!names.methods.has(method)) return null;
    const root = rootIdentifier(ts, callee.expression);
    if (ts.isIdentifier(root) && RECEIVER_DENY.has(root.text)) return null;
    const isStringLike = ts.isStringLiteral(root) || ts.isNoSubstitutionTemplateLiteral(root);
    if (isStringLike || ts.isTemplateExpression(root) || root.kind === ts.SyntaxKind.ImportKeyword) return null;
    return method;
  }
  return null; // element access, import(), super(), …
}

/**
 * Rewrite mini-notation literals in a song file. `file` is the
 * workspace-relative path that ends up in `__strudel_file`.
 */
export function transformLocations(ts: Ts, code: string, file: string, names: StrudelNames): LocationsResult {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const local = declaredNames(ts, sf);
  const s = new MagicString(code);
  const rewrites: Rewrite[] = [];
  const isStringLike = (node: TS.Node): node is StringLike =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

  /** The literal if it can carry locations, else null */
  const rewritable = (arg: TS.Expression): StringLike | null => {
    if (!isStringLike(arg)) return null;
    const inner = code.slice(arg.getStart(sf) + 1, arg.getEnd() - 1);
    if (inner !== arg.text) return null; // escapes / line continuations / CRLF → offsets would drift
    return names.parses(inner) ? arg : null;
  };
  const wrap = (arg: StringLike, callee: string) => {
    const start = arg.getStart(sf);
    const end = arg.getEnd();
    s.prependRight(start, "__strudel_m(");
    s.appendLeft(end, `, ${start})`);
    rewrites.push({ start, end, value: arg.text, callee });
  };

  const visit = (node: TS.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = patternCallee(ts, node, names, local);
      if (callee) {
        for (const arg of node.arguments) {
          const lit = rewritable(arg);
          if (lit) wrap(lit, callee);
        }
      } else if (
        // mini("a b", …) parses its args itself, so they must stay strings. When
        // all are literals, call __strudel_mini instead: sequence(m(str, offset), …)
        // is exactly what mini() builds, plus file locations.
        ts.isIdentifier(node.expression) &&
        node.expression.text === "mini" &&
        !local.has("mini") &&
        node.arguments.length > 0 &&
        node.arguments.every((arg) => rewritable(arg))
      ) {
        s.overwrite(node.expression.getStart(sf), node.expression.getEnd(), "__strudel_mini");
        for (const arg of node.arguments) wrap(arg as StringLike, "mini");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const version = contentVersion(code);
  // Appended (never prepended) so original line/column numbers are preserved.
  // Mini treats [ \n\r\t\xA0] alike, but @strudel/mini's getLeafLocation only
  // trims trailing *spaces* off a token, so a token at the end of a line in a
  // multi-line template would include the newline. Same-length replacement
  // keeps offsets and semantics intact.
  s.append(
    `\n// ── injected by vite-plugins/strudel-locations.ts ──\n` +
      `function __strudel_m(str: string, offset: number): Pattern { return (globalThis as any).m(str.replace(/[\\n\\r\\t\\xA0]/g, " "), offset); }\n` +
      `function __strudel_mini(...pats: Pattern[]): Pattern { return (globalThis as any).sequence(...pats); }\n` +
      `export const __strudel_file = ${JSON.stringify(file)};\n` +
      `export const __strudel_version = ${JSON.stringify(version)};\n`,
  );
  return {
    code: s.toString(),
    map: s.generateMap({ hires: true, source: file, includeContent: true }),
    version,
    rewrites,
  };
}
