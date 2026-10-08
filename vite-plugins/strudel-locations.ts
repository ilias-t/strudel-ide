// ═══════════════════════════════════════════════════════════════════════════
// strudel-locations — give mini-notation strings in song files source locations
// ═══════════════════════════════════════════════════════════════════════════
//
// strudel.cc highlights the characters of the mini-notation token that is
// sounding right now. It can do that because its transpiler rewrites every
// "mini string" into `m("...", offset)`, so each hap carries
// `hap.context.locations = [{ start, end }]` (absolute offsets into the code).
//
// This plugin does the same for `src/songs/*.ts` (not index.ts, not `_*.ts`),
// using the TypeScript parser for exact positions and magic-string so the
// sourcemap still points at the original text:
//
//     s("bd*4").bank("RolandTR808")
//  →  s(__strudel_m("bd*4", 123)).bank(__strudel_m("RolandTR808", 140))
//
// `offset` is the UTF-16 position of the opening quote in the file as read
// from disk, which is exactly what `m` from @strudel/mini expects (it parses
// `"${str}"`, so token positions are relative to the quote).
//
// WHICH STRINGS ARE REWRITTEN (least-surprise rule: a string only becomes a
// Pattern where strudel would have turned it into a Pattern anyway)
//   ✔ string literals ('…' or "…") and backtick literals without `${}`
//   ✔ that are a DIRECT argument of a call expression (not `new`, not inside
//     arrays/objects, not property values like `name: "Jynx"`, not imports,
//     not types, not object keys)
//   ✔ whose callee is a strudel function:
//       - bare call `note("…")`: a function strudel exports that is also a
//         Pattern method (s, note, n, stack, cat, seq, lpf, …) or a known
//         pattern constructor (arrange, polymeter, timeCat, …), and that is not
//         declared anywhere in the file (a local `s`/helper shadows it)
//       - method call `x.scale("…")`: any Pattern.prototype method, minus a
//         denylist of names that also exist on strings/arrays/functions and
//         typically take plain strings (join, bind, apply, …) or strudel
//         methods that need plain strings (p, q, log, markcss, …); calls on
//         console/JSON/Math/document/… or on string literals are never touched
//   ✔ whose raw source text equals its cooked value (no escapes, no CRLF in
//     templates — otherwise offsets would drift) and which parses as mini
//     notation (an unparsable string is left alone, so runtime is unchanged)
//   ✔ special case: `mini("a b", …)` with only such literals becomes
//     `__strudel_mini(__strudel_m("a b", o), …)` (= sequence(m(…)), what mini builds)
// Everything else is left exactly as written. With `miniAllStrings()` those
// strings still become patterns at runtime, just without file locations: the
// highlighter installs location-free versions of the string parser and of the
// global `mini`/`h` (src/live/highlights.ts, stripImplicitLocations), so only
// __strudel_m patterns carry offsets.
//
// Names are introspected from the installed @strudel/core|mini|tonal, so new
// controls work without touching this file.
//
// `__strudel_m` calls the global `m` (installed by initStrudel()/evalScope),
// NOT an import from "@strudel/mini": @strudel/web is a self-contained bundle,
// and patterns from a second copy of @strudel/core would lack the methods
// tonal/webaudio/draw register on the bundled Pattern prototype.
//
// Each transformed module also exports
//   __strudel_file    — workspace-relative path, e.g. "src/songs/jynx.ts"
//   __strudel_version — contentVersion(original text): FNV-1a 32-bit over the
//                       UTF-16 code units, hex (same as src/live/protocol.ts)
// All injected code is appended after the original text, so line numbers in
// the transformed output are unchanged even without the sourcemap.
// ═══════════════════════════════════════════════════════════════════════════

import path from "node:path";
import ts from "typescript";
import MagicString from "magic-string";
import type { Plugin } from "vite";
import { contentVersion } from "../src/live/protocol.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Name sets
// ─────────────────────────────────────────────────────────────────────────────

/** Pattern constructors that are exported but are not Pattern methods */
const EXTRA_FUNCTIONS = [
  "arrange", "polymeter", "polyrhythm", "pr", "randcat", "wrandcat", "timeCat", "timecat",
  "chooseCycles", "stepcat", "stepalt", "s_cat", "s_alt", "s_polymeter",
  "stackLeft", "stackRight", "stackCentre", "stackBy", "reify",
];

/** Never rewrite arguments of these bare calls */
const FUNCTION_DENY = new Set([
  "require", "fetch", "register", "samples", "pure", "evalScope", "setStringParser",
  "aliasBank", "soundAlias", "initStrudel", "String", "Number", "Boolean", "Symbol",
  "parseInt", "parseFloat", "alert", "setTimeout", "setInterval", "m", "h",
  // its args must stay strings; literal-only mini(...) calls are handled in transformSong
  "mini",
]);

/** Never rewrite arguments of these methods, even though Pattern has them */
const METHOD_DENY = new Set([
  // builtin collisions that take plain strings / no strings
  "constructor", "bind", "call", "apply", "join", "toString", "valueOf", "toJSON",
  "split", "concat", "includes", "indexOf", "lastIndexOf", "startsWith", "endsWith",
  "replace", "replaceAll", "match", "matchAll", "search", "padStart", "padEnd",
  "localeCompare", "normalize", "trim", "at", "charAt", "get", "has", "delete", "push",
  // strudel methods that want plain strings (ids, css, labels)
  "p", "q", "log", "logValues", "onTrigger", "markcss", "describe",
]);

/** Never rewrite arguments of methods called on these globals */
const RECEIVER_DENY = new Set([
  "console", "JSON", "Math", "Object", "Array", "String", "Number", "Reflect", "Promise",
  "document", "window", "globalThis", "self", "localStorage", "sessionStorage",
  "performance", "navigator", "crypto", "Intl", "Date", "Symbol", "URL", "Map", "Set",
  "location", "history", "process", "import",
]);

export interface StrudelNames {
  /** bare function names whose string args are rewritten */
  functions: Set<string>;
  /** method names whose string args are rewritten */
  methods: Set<string>;
  /** returns true if `"${raw}"` parses as mini notation */
  parses(raw: string): boolean;
}

let namesPromise: Promise<StrudelNames> | undefined;

/** Introspect the installed strudel packages (once, lazily) */
export function loadStrudelNames(): Promise<StrudelNames> {
  return (namesPromise ??= (async () => {
    // @strudel/core logs a banner and a "not in browser" warning on import
    const { log, warn } = console;
    console.log = console.warn = () => {};
    let core: any, mini: any, tonal: any;
    try {
      [core, mini, tonal] = await Promise.all([
        import("@strudel/core"),
        import("@strudel/mini"),
        import("@strudel/tonal"),
      ]);
    } finally {
      console.log = log;
      console.warn = warn;
    }
    const methods = new Set<string>();
    for (let p = core.Pattern.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const k of Object.getOwnPropertyNames(p)) {
        const d = Object.getOwnPropertyDescriptor(p, k);
        // operators like add/sub/set are getters returning a function (with .in/.out/…)
        if ((typeof d?.value === "function" || d?.get) && !METHOD_DENY.has(k)) methods.add(k);
      }
    }
    const functions = new Set<string>(EXTRA_FUNCTIONS);
    for (const mod of [core, mini, tonal]) {
      for (const [k, v] of Object.entries(mod)) {
        if (typeof v === "function" && methods.has(k)) functions.add(k);
      }
    }
    for (const k of FUNCTION_DENY) functions.delete(k);
    const parses = (raw: string) => {
      try {
        mini.mini2ast(`"${raw}"`);
        return true;
      } catch {
        return false;
      }
    };
    return { functions, methods, parses };
  })());
}

// Version hash: contentVersion() from the shared protocol (FNV-1a 32-bit over
// UTF-16 code units, 8 hex digits), so editors compute the identical value
export { contentVersion };

// ─────────────────────────────────────────────────────────────────────────────
// Transform
// ─────────────────────────────────────────────────────────────────────────────

export interface Rewrite {
  /** offset of the opening quote */
  start: number;
  /** offset just past the closing quote */
  end: number;
  /** cooked string value (== raw text between the quotes) */
  value: string;
  callee: string;
}

export interface TransformResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
  version: string;
  rewrites: Rewrite[];
}

type StringLike = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral;

function isStringLike(node: ts.Node): node is StringLike {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/** All names declared anywhere in the file (conservative shadowing check) */
function declaredNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const addBinding = (name: ts.BindingName | undefined) => {
    if (!name) return;
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) addBinding(el.name);
  };
  const visit = (node: ts.Node) => {
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
function rootIdentifier(expr: ts.Expression): ts.Expression {
  let e: ts.Expression = expr;
  for (;;) {
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e)) e = e.expression;
    else if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    else return e;
  }
}

/** Name of the callee if its string arguments should become mini patterns */
function patternCallee(call: ts.CallExpression, names: StrudelNames, local: Set<string>): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    return names.functions.has(callee.text) && !local.has(callee.text) ? callee.text : null;
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
    const method = callee.name.text;
    if (!names.methods.has(method)) return null;
    const root = rootIdentifier(callee.expression);
    if (ts.isIdentifier(root) && RECEIVER_DENY.has(root.text)) return null;
    if (isStringLike(root) || ts.isTemplateExpression(root) || root.kind === ts.SyntaxKind.ImportKeyword) return null;
    return method;
  }
  return null; // element access, import(), super(), …
}

/**
 * Rewrite mini-notation literals in a song file. `file` is the
 * workspace-relative path that ends up in `__strudel_file`.
 */
export function transformSong(code: string, file: string, names: StrudelNames): TransformResult {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const local = declaredNames(sf);
  const s = new MagicString(code);
  const rewrites: Rewrite[] = [];

  /** The literal if it can carry locations, else null */
  const rewritable = (arg: ts.Expression): StringLike | null => {
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

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = patternCallee(node, names, local);
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

/** Is this module id a song file the transform applies to? */
export function isSongFile(id: string, root: string): boolean {
  const [file, query = ""] = id.split("?");
  if (/(^|&)(raw|url|worker|sharedworker|inline)(&|=|$)/.test(query)) return false;
  const rel = path.relative(root, file).split(path.sep).join("/");
  const m = /^src\/songs\/([^/]+)\.ts$/.exec(rel);
  return !!m && m[1] !== "index" && !m[1].startsWith("_");
}

// ─────────────────────────────────────────────────────────────────────────────
// Vite plugin
// ─────────────────────────────────────────────────────────────────────────────

export default function strudelLocations(): Plugin {
  let root = process.cwd();
  return {
    name: "strudel-locations",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
    },
    async transform(code, id) {
      if (!isSongFile(id, root)) return null;
      const file = path.relative(root, id.split("?")[0]).split(path.sep).join("/");
      const result = transformSong(code, file, await loadStrudelNames());
      return { code: result.code, map: result.map };
    },
  };
}
