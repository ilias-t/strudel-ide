// ═══════════════════════════════════════════════════════════════════════════
// strudel-knobs — song identity for knob() + the dev-only write-back endpoint
// ═══════════════════════════════════════════════════════════════════════════
//
// 1. Transform (src/songs/*.ts, after strudel-locations)
//      knob("cutoff", 2200, 200, 8000)
//   →  __strudel_knob("cutoff", 2200, 200, 8000)
//   plus, prepended to the module, `__strudelKnobModule(file)` (this module
//   evaluates now: its top-level knobs are declared anew) and, appended, the
//   helper that calls the global `__strudelKnob(file, …args)`. That tells the
//   player which song a knob belongs to, also for knobs at the top of the file
//   (which run when the module is imported, outside any build). See
//   src/engine/knobs.ts. A file that declares its own `knob` is left alone.
//   It must run after strudel-locations: that plugin computes file offsets
//   from the text it receives, and this one changes lengths.
//
// 2. POST /__strudel/knob   (dev server only)
//      { file: "src/songs/untitled.ts", knobs: [{ name: "cutoff", value: 1800 }] }
//   (or a single { file, name, value }) rewrites the numeric `value` literal of
//   every `knob("cutoff", <value>, …)` call in that file, using the TypeScript
//   AST for exact positions, in one write (so "Write all" is one hot-swap).
//   Refuses (4xx, nothing written) when a call isn't found, or its value isn't
//   a numeric literal (`2200`, `-3`, `0.15`), and (409) while the player plays
//   an evaluated, unsaved editor buffer of that file (live eval, see
//   strudel-live-eval.ts): writing the file would replace those unsaved edits
//   in the player and clash with the editor's buffer. The editor extension
//   writes into its buffer instead; from the stage, save first. Vite's watcher then sends the
//   usual HMR update. Response: { ok: true, changes: [{ name, literal, line }] }
//   or { ok: false, error }.
// ═══════════════════════════════════════════════════════════════════════════

import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import MagicString from "magic-string";
import type { Plugin } from "vite";
import { isSongFile } from "./strudel-locations.ts";
import type { StrudelBridgeApi } from "./strudel-bridge.ts";
import { contentVersion } from "../src/live/protocol.ts";

export const KNOB_ENDPOINT = "/__strudel/knob";

// ─────────────────────────────────────────────────────────────────────────────
// Transform
// ─────────────────────────────────────────────────────────────────────────────

/** Is `knob` declared in the file (a local helper shadows the global)? */
function declaresKnob(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
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

/** Route a song file's knob() calls through a helper that passes the file */
export function transformKnobs(code: string, file: string): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (declaresKnob(sf)) return null;
  const s = new MagicString(code);
  const visit = (node: ts.Node) => {
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
// Write-back
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

/**
 * Refuse a write while `buffer` (the evaluated, unsaved editor buffer of
 * `file`) differs from the file on disk.
 */
export function checkLiveBuffer(code: string, file: string, writes: KnobWrite[], buffer: { text: string } | null) {
  if (!buffer || contentVersion(buffer.text) === contentVersion(code)) return;
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const onlyInBuffer = writes.find(({ name }) => typeof name === "string" && !knobValueArgs(sf, name).length);
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

/** Value argument of each `knob("<name>", <value>, …)` call */
function knobValueArgs(sf: ts.SourceFile, name: string): ts.Expression[] {
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
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

const isNumericLiteral = (e: ts.Expression) =>
  ts.isNumericLiteral(e) ||
  (ts.isPrefixUnaryExpression(e) &&
    (e.operator === ts.SyntaxKind.MinusToken || e.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(e.operand));

/**
 * Rewrite the value literal of the named knobs in `code`. All-or-nothing:
 * throws KnobWriteError if any knob's call is missing or not a numeric literal.
 */
export function rewriteKnobValues(code: string, file: string, writes: KnobWrite[]): { code: string; changes: KnobChange[] } {
  if (!writes.length) throw new KnobWriteError("no knobs to write", 400);
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const s = new MagicString(code);
  const changes: KnobChange[] = [];
  for (const { name, value } of writes) {
    if (typeof name !== "string" || !name) throw new KnobWriteError("knob name must be a non-empty string", 400);
    const literal = numberLiteral(value);
    const args = knobValueArgs(sf, name);
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

// ─────────────────────────────────────────────────────────────────────────────
// Vite plugin
// ─────────────────────────────────────────────────────────────────────────────

async function readBody(req: NodeJS.ReadableStream): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64_000) throw new KnobWriteError("request too large", 413);
  }
  return body;
}

export default function strudelKnobs(): Plugin {
  let root = process.cwd();
  return {
    name: "strudel-knobs",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
    },
    transform(code, id) {
      if (!isSongFile(id, root)) return null;
      const file = path.relative(root, id.split("?")[0]).split(path.sep).join("/");
      const result = transformKnobs(code, file);
      return result && { code: result.code, map: result.map.toString() };
    },
    configureServer(server) {
      server.middlewares.use(KNOB_ENDPOINT, (req, res) => {
        const reply = (status: number, body: object) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
        };
        if (req.method !== "POST") return reply(405, { ok: false, error: "POST only" });
        void (async () => {
          try {
            let payload: { file?: unknown; name?: unknown; value?: unknown; knobs?: unknown };
            try {
              payload = JSON.parse(await readBody(req));
            } catch (err) {
              if (err instanceof KnobWriteError) throw err;
              throw new KnobWriteError("body must be JSON", 400);
            }
            const { file } = payload;
            if (typeof file !== "string") throw new KnobWriteError("file must be a string", 400);
            const abs = path.resolve(root, file);
            const rel = path.relative(root, abs).split(path.sep).join("/");
            if (rel.startsWith("..") || path.isAbsolute(rel) || !isSongFile(abs, root)) {
              throw new KnobWriteError(`${file} is not a song file (src/songs/*.ts)`, 403);
            }
            const writes = (Array.isArray(payload.knobs) ? payload.knobs : [{ name: payload.name, value: payload.value }]) as KnobWrite[];
            let code: string;
            try {
              code = await fs.readFile(abs, "utf8");
            } catch {
              throw new KnobWriteError(`${file} not found`, 404);
            }
            const bridge = server.config.plugins.find((p) => p.name === "strudel-bridge")?.api as StrudelBridgeApi | undefined;
            checkLiveBuffer(code, rel, writes, bridge?.live?.activeBuffer(rel) ?? null);
            const result = rewriteKnobValues(code, rel, writes);
            if (result.code !== code) await fs.writeFile(abs, result.code);
            reply(200, { ok: true, file: rel, changes: result.changes });
          } catch (err) {
            const status = err instanceof KnobWriteError ? err.status : 500;
            reply(status, { ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        })();
      });
    },
  };
}
