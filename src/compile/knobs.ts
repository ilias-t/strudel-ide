// ═══════════════════════════════════════════════════════════════════════════
// Knobs transform + knob write-back (shared transform code)
// ═══════════════════════════════════════════════════════════════════════════
//
// The one implementation, used by the Vite plugin (vite-plugins/strudel-knobs.ts,
// which documents the transform and the dev-only POST endpoint) and by the
// browser compiler (./compile.ts). Takes the `typescript` instance as a
// parameter, so this module loads no compiler by itself.
//
//   knob("cutoff", 2200, 200, 8000)  →  __strudel_knob("cutoff", 2200, 200, 8000)
//
// plus `__strudelKnobModule(file)` prepended on line 1 (no newline, so line
// numbers stay put) and the `__strudel_knob` helper appended. Must run after
// the locations transform: that one computes offsets from the text it gets.
// ═══════════════════════════════════════════════════════════════════════════

import type TS from "typescript";
import MagicString, { type SourceMap } from "magic-string";
import { contentVersion } from "../live/protocol.ts";

type Ts = typeof TS;

// ─────────────────────────────────────────────────────────────────────────────
// Transform
// ─────────────────────────────────────────────────────────────────────────────

/** Is `knob` declared in the file (a local helper shadows the global)? */
function declaresKnob(ts: Ts, sf: TS.SourceFile): boolean {
  let found = false;
  const visit = (node: TS.Node) => {
    if (found) return;
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) || ts.isImportSpecifier(node) || ts.isImportClause(node)) &&
      node.name && ts.isIdentifier(node.name) && node.name.text === "knob"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Route a song file's knob() calls through a helper that passes the file (null: the file declares its own knob) */
export function transformKnobs(ts: Ts, code: string, file: string): { code: string; map: SourceMap } | null {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (declaresKnob(ts, sf)) return null;
  const s = new MagicString(code);
  const visit = (node: TS.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "knob") {
      s.overwrite(node.expression.getStart(sf), node.expression.getEnd(), "__strudel_knob");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const f = JSON.stringify(file);
  // Prepended on line 1 (no newline), so line numbers stay put
  s.prepend(`(globalThis as any).__strudelKnobModule?.(${f}); `);
  s.append(
    `\n// ── injected by vite-plugins/strudel-knobs.ts ──\n` +
      `function __strudel_knob(...args: any[]): Pattern { const g = globalThis as any; return g.__strudelKnob ? g.__strudelKnob(${f}, ...args) : g.knob(...args); }\n`
  );
  return { code: s.toString(), map: s.generateMap({ hires: true, source: file, includeContent: true }) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Write-back: rewrite knob("name", <value>, …) literals
// ─────────────────────────────────────────────────────────────────────────────

export interface KnobWrite {
  name: string;
  value: number;
}

export interface KnobChange {
  name: string;
  /** The literal now in the file */
  literal: string;
  /** 1-based line of the (first) call */
  line: number;
}

export class KnobWriteError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.status = status;
  }
}

/** The source text for a number: the shortest literal that reads back as exactly `value` */
export function numberLiteral(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new KnobWriteError(`value must be a finite number`, 400);
  const v = Object.is(value, -0) ? 0 : value;
  return String(v);
}

/** Value argument of each `knob("<name>", <value>, …)` call */
function knobValueArgs(ts: Ts, sf: TS.SourceFile, name: string): TS.Expression[] {
  const found: TS.Expression[] = [];
  const visit = (node: TS.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "knob" &&
      node.arguments.length >= 2
    ) {
      const first = node.arguments[0];
      if ((ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) && first.text === name) {
        found.push(node.arguments[1]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Refuse a write while `buffer` (the evaluated, unsaved editor buffer of
 * `file`) differs from the file on disk.
 */
export function checkLiveBuffer(ts: Ts, code: string, file: string, writes: KnobWrite[], buffer: { text: string } | null) {
  if (!buffer || contentVersion(buffer.text) === contentVersion(code)) return;
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const onlyInBuffer = writes.find(({ name }) => typeof name === "string" && !knobValueArgs(ts, sf, name).length);
  if (onlyInBuffer) {
    throw new KnobWriteError(
      `knob("${onlyInBuffer.name}", …) is only in the unsaved editor buffer of ${file}, not in the file: save the file first, then write the knob`,
      409
    );
  }
  throw new KnobWriteError(
    `${file} has unsaved changes that are playing (evaluated from the editor): save the file first, or write the knob from the editor`,
    409
  );
}

/**
 * Rewrite the value literal of the named knobs in `code`. All-or-nothing:
 * throws KnobWriteError if any knob's call is missing or not a numeric literal.
 */
export function rewriteKnobValues(ts: Ts, code: string, file: string, writes: KnobWrite[]): { code: string; changes: KnobChange[] } {
  if (!writes.length) throw new KnobWriteError("no knobs to write", 400);
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const isNumericLiteral = (e: TS.Expression) =>
    ts.isNumericLiteral(e) ||
    (ts.isPrefixUnaryExpression(e) &&
      (e.operator === ts.SyntaxKind.MinusToken || e.operator === ts.SyntaxKind.PlusToken) &&
      ts.isNumericLiteral(e.operand));
  const s = new MagicString(code);
  const changes: KnobChange[] = [];
  for (const { name, value } of writes) {
    if (typeof name !== "string" || !name) throw new KnobWriteError("knob name must be a non-empty string", 400);
    const literal = numberLiteral(value);
    const args = knobValueArgs(ts, sf, name);
    if (!args.length) throw new KnobWriteError(`no knob("${name}", …) call in ${file}`, 404);
    for (const arg of args) {
      if (!isNumericLiteral(arg)) {
        const { line } = sf.getLineAndCharacterOfPosition(arg.getStart(sf));
        throw new KnobWriteError(
          `knob("${name}", …) in ${file}:${line + 1}: the value is \`${arg.getText(sf)}\`, not a number literal, so it can't be written back`
        );
      }
      s.overwrite(arg.getStart(sf), arg.getEnd(), literal);
    }
    const { line } = sf.getLineAndCharacterOfPosition(args[0].getStart(sf));
    changes.push({ name, literal, line: line + 1 });
  }
  return { code: s.toString(), changes };
}
