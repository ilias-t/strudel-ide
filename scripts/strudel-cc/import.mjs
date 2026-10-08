// strudel.cc REPL code → src/songs/<id>.ts
//
//   npm run import -- <strudel.cc URL | file.js | -> [--id my-song] [--name "My Song"] [--force]
//
// strudel.cc runs code through a transpiler; Strudel IDE runs plain
// TypeScript. What the transpiler does, and what this importer does instead:
//   "a b" / `a b`      → m("a b"): a Pattern. Plain strings work too where a
//                         Strudel function takes them as an argument
//                         (miniAllStrings), so those stay; anywhere else
//                         (receivers like "<c e>".note(), consts, arrays,
//                         helper arguments) they become mini("a b")
//   name: pat / $: pat → pat.p('name'): the tracks. They become
//                         `const name = pat` and `return { name, … }`;
//                         `$:` is named after its sound (or track1, …)
//   _name: / name_: / .hush() → muted: kept as a commented-out track
//   hush()             → mutes everything before it
//   slider(v, min, max, step) → knob("name", v, min, max, step) (when the
//                         app has knob(); otherwise the value + a TODO)
//   setcpm / setcps / setbpm → the song's bpm (1 cycle = 1 bar of 4/4)
//   samples(…)         → a comment (and a warning unless the app loads it)
//   all(f) / each(f)   → f applied to every track
//   ._pianoroll() / .pianoroll() / .scope() … → the song's visualization
// Anything that still doesn't type-check is commented out (unknown
// functions, strudel.cc-only APIs) or marked `// @ts-expect-error TODO`.

import "./quiet.mjs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import MagicString from "magic-string";
import { root, core, mini as miniNotation } from "./runtime.mjs";
import { urlToCode, isStrudelUrl, isAppSamplePack, STRUDEL_CC_ONLY_SOUNDS, STRUDEL_CC_ONLY_PREFIXES } from "./shared.mjs";
import { ambientFiles, songDiagnostics, ts } from "./tsproject.mjs";
import { runtimeGlobals, runtimePatternMethods } from "../lib/strudel-runtime.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Names
// ─────────────────────────────────────────────────────────────────────────────

const APP_GLOBALS = new Set(runtimeGlobals().keys());
const PATTERN_METHODS = new Set(runtimePatternMethods().keys());
for (let p = core.Pattern.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
  for (const k of Object.getOwnPropertyNames(p)) PATTERN_METHODS.add(k);
}

/** String arguments of these stay plain strings (they want strings, or strudel.cc breaks them too) */
const FUNCTION_KEEP = new Set(["mini", "m", "h", "register", "samples", "pure", "aliasBank", "soundAlias", "evalScope"]);
const METHOD_DENY = new Set([
  "constructor", "bind", "call", "apply", "join", "toString", "valueOf", "toJSON",
  "split", "concat", "includes", "indexOf", "lastIndexOf", "startsWith", "endsWith",
  "replace", "replaceAll", "match", "matchAll", "search", "padStart", "padEnd",
  "localeCompare", "normalize", "trim", "at", "charAt", "get", "has", "delete", "push", "map", "filter",
]);
const RECEIVER_DENY = new Set(["console", "JSON", "Math", "Object", "Array", "String", "Number", "Promise", "document", "window", "globalThis"]);

const TEMPO = { setcpm: "cpm", setCpm: "cpm", setcps: "cps", setCps: "cps", setbpm: "bpm", setBpm: "bpm" };
const VIZ = {
  pianoroll: "pianoroll", _pianoroll: "pianoroll", punchcard: "pianoroll", _punchcard: "pianoroll",
  scope: "scope", _scope: "scope", tscope: "scope", _tscope: "scope",
  spiral: null, _spiral: null, pitchwheel: null, _pitchwheel: null, spectrum: null, _spectrum: null,
  fscope: null, _fscope: null, wordfall: null,
};
const MUTED_RE = /^_|_$/;
/** Source links longer than this go at the end of the file, not in the header */
const LONG_SOURCE = 120;

/** Does the app have knob()? (declared in some src/*.d.ts) */
export function knobAvailable() {
  return ambientFiles().some((f) => /declare function knob\s*\(/.test(readFileSync(f, "utf8")));
}

const RESERVED = new Set(
  ("break case catch class const continue debugger default delete do else enum export extends false finally for " +
    "function if import in instanceof new null return super switch this throw true try typeof var void while with " +
    "yield let static implements interface package private protected public await async arguments eval").split(" ")
);

const slug = (s) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const titleCase = (id) => id.split(/[-_ ]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

function indent(text, pad) {
  return text
    .split("\n")
    .map((l) => (l.trim() ? pad + l : l.replace(/[ \t]+$/, "")))
    .join("\n");
}

const commentOut = (text, pad) =>
  text
    .split("\n")
    .map((l) => `${pad}// ${l}`.replace(/\s+$/, ""))
    .join("\n");

/** Value of a constant numeric expression (numbers, + - * / %, parens, Math.*), else undefined */
function staticNumber(node) {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isParenthesizedExpression(node)) return staticNumber(node.expression);
  if (ts.isPrefixUnaryExpression(node)) {
    const v = staticNumber(node.operand);
    if (v === undefined) return undefined;
    return node.operator === ts.SyntaxKind.MinusToken ? -v : node.operator === ts.SyntaxKind.PlusToken ? v : undefined;
  }
  if (ts.isBinaryExpression(node)) {
    const a = staticNumber(node.left);
    const b = staticNumber(node.right);
    if (a === undefined || b === undefined) return undefined;
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken: return a + b;
      case ts.SyntaxKind.MinusToken: return a - b;
      case ts.SyntaxKind.AsteriskToken: return a * b;
      case ts.SyntaxKind.SlashToken: return a / b;
      case ts.SyntaxKind.PercentToken: return a % b;
      case ts.SyntaxKind.AsteriskAsteriskToken: return a ** b;
    }
  }
  return undefined;
}

const round = (n) => Math.round(n * 1e6) / 1e6;

/** Does mini-notation read `s` as the one plain value `s` (so a plain string and a mini string agree)? */
function miniKeepsAsIs(s) {
  try {
    const haps = miniNotation.mini(s).queryArc(0, 1);
    return haps.length === 1 && haps[0].value === s && haps[0].whole?.begin.valueOf() === 0 && haps[0].whole?.end.valueOf() === 1;
  } catch {
    return false;
  }
}

/** First sound name in mini-notation, e.g. "<bd*2 [~ sd]>" → "bd" */
function firstSound(mini) {
  const m = mini.replace(/[<>[\]{}(),|]/g, " ").split(/\s+/).find((w) => /^[A-Za-z]/.test(w));
  return m?.match(/^[A-Za-z][A-Za-z0-9_]*/)?.[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Import
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} code strudel.cc REPL code
 * @param {{ id?: string, name?: string, source?: string }} [opts]
 * @returns {{ ts: string, id: string, name: string, warnings: string[] }}
 */
export function importCode(code, opts = {}) {
  code = code.replace(/\r\n/g, "\n");
  const sf = ts.createSourceFile("snippet.js", code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const ms = new MagicString(code);
  const notes = []; // conversion notes, in the header
  const warnings = [];
  const note = (msg, warn = false) => {
    if (!notes.includes(msg)) notes.push(msg);
    if (warn && !warnings.includes(msg)) warnings.push(msg);
  };
  const parseErrors = sf.parseDiagnostics ?? [];
  if (parseErrors.length) {
    const d = parseErrors[0];
    const { line } = sf.getLineAndCharacterOfPosition(d.start);
    throw new Error(`can't parse the strudel.cc code (line ${line + 1}): ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  }

  // ─── metadata from comments (strudel.cc reads @title / @by too) ─────────
  const meta = {};
  for (const m of code.matchAll(/^\s*(?:\/\/|\*|\/\*)\s*@(title|by|license|details|url)\s+(.+?)\s*(?:\*\/)?$/gm)) meta[m[1]] ??= m[2];
  const name = opts.name ?? meta.title ?? (opts.id ? titleCase(opts.id) : "Imported Song");
  const id = opts.id ?? (slug(name) || "imported-song");

  // names the snippet declares (to tell helpers from Strudel functions)
  const declared = new Set();
  const collectDeclared = (n) => {
    if ((ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isParameter(n) || ts.isClassDeclaration(n)) && n.name) {
      const add = (b) => (ts.isIdentifier(b) ? declared.add(b.text) : b.elements?.forEach((e) => !ts.isOmittedExpression(e) && add(e.name)));
      add(n.name);
    }
    ts.forEachChild(n, collectDeclared);
  };
  collectDeclared(sf);

  const usesMiniAllStrings = /\bminiAllStrings\s*\(/.test(code);
  const hasKnob = knobAvailable();
  const knobNames = new Set();
  let visualization = null;

  // ─── expression rewrites ──────────────────────────────────────────────────
  const isStrudelCall = (call) => {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) return !declared.has(callee.text) && APP_GLOBALS.has(callee.text) && !FUNCTION_KEEP.has(callee.text);
    if (ts.isPropertyAccessExpression(callee)) {
      const name = callee.name.text;
      if (METHOD_DENY.has(name) || !PATTERN_METHODS.has(name)) return false;
      let r = callee.expression;
      while (ts.isPropertyAccessExpression(r) || ts.isCallExpression(r) || ts.isElementAccessExpression(r)) r = r.expression;
      return !(ts.isIdentifier(r) && RECEIVER_DENY.has(r.text));
    }
    return false;
  };
  const keepsStrings = (call) => {
    const callee = call.expression;
    return ts.isIdentifier(callee) && FUNCTION_KEEP.has(callee.text);
  };

  // A knob name for a slider: the comment right before it (export writes
  // `/* name */ slider(…)`), the const it initialises, or the method it feeds
  const sliderName = (call) => {
    const before = code.slice(0, call.getStart(sf));
    const m = before.match(/\/\*\s*([^*]+?)\s*\*\/\s*$/);
    let base = m?.[1];
    if (m) ms.remove(before.length - m[0].length, call.getStart(sf)); // the name moves into knob()
    const parent = call.parent;
    if (!base && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) base = parent.name.text;
    if (!base && ts.isCallExpression(parent)) {
      const callee = parent.expression;
      base = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : undefined;
    }
    base ??= "slider";
    let n = base;
    for (let i = 2; knobNames.has(n); i++) n = `${base} ${i}`;
    knobNames.add(n);
    return n;
  };

  // every identifier the code mentions: a track const must not shadow one
  const referenced = new Set();
  const collectRefs = (n) => {
    const p = n.parent;
    const notAReference =
      !p ||
      (ts.isLabeledStatement(p) && p.label === n) ||
      (ts.isPropertyAccessExpression(p) && p.name === n) ||
      (ts.isPropertyAssignment(p) && p.name === n);
    if (ts.isIdentifier(n) && !notAReference) referenced.add(n.text);
    ts.forEachChild(n, collectRefs);
  };
  collectRefs(sf);
  const usedNames = new Set([...declared, ...referenced, "song", "Song"]);

  /** A fresh const name: not a reserved word, nor a name the code declares or uses (e.g. a Strudel global) */
  const pickName = (wanted) => {
    let base = wanted && /^[A-Za-z_$][\w$]*$/.test(wanted) ? wanted : "track";
    if (RESERVED.has(base) || usedNames.has(base)) base = `${base}Track`;
    let n = base;
    for (let i = 2; usedNames.has(n); i++) n = `${base}${i}`;
    usedNames.add(n);
    return n;
  };

  // Three passes over the code, in this order so MagicString insertions nest
  // right: 1) slider/visualizations (rewritten or removed; strings inside
  // them are left alone), 2) strings, 3) .piano() → piano(…) around its receiver.
  const dead = []; // [start, end) ranges already rewritten
  const isDead = (n) => dead.some(([a, b]) => n.getStart(sf) >= a && n.end <= b);

  const walkCalls = (node) => {
    // slider(value, min, max, step) → knob(name, value, min, max, step)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === "slider" || node.expression.text === "sliderWithID") && !declared.has(node.expression.text)) {
      const args = node.expression.text === "sliderWithID" ? node.arguments.slice(1) : node.arguments;
      const [value, min, max, step] = args;
      const t = (n, d) => (n ? n.getText(sf) : d);
      const valueText = t(value, "0");
      if (hasKnob) {
        const kname = sliderName(node);
        ms.overwrite(node.getStart(sf), node.end, `knob(${JSON.stringify(kname)}, ${valueText}, ${t(min, "0")}, ${t(max, "1")}${step ? `, ${t(step)}` : ""})`);
        note(`slider(${[valueText, t(min, "0"), t(max, "1")].join(", ")}) → knob("${kname}")`);
      } else {
        ms.overwrite(node.getStart(sf), node.end, `${valueText} /* TODO(strudel.cc import): was slider(${args.map((a) => a.getText(sf)).join(", ")}); Strudel IDE has no knob() yet */`);
        note(`slider(…) became its value: this Strudel IDE has no knob()`, true);
      }
      dead.push([node.getStart(sf), node.end]);
      return;
    }

    // visualizations → the song's visualization; drop the call
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && Object.hasOwn(VIZ, node.expression.name.text)) {
      const method = node.expression.name.text;
      const kind = VIZ[method];
      if (kind) {
        const opts = node.arguments[0];
        visualization = kind === "pianoroll" && opts && ts.isObjectLiteralExpression(opts) ? { type: kind, options: opts.getText(sf) } : visualization?.type === kind ? visualization : { type: kind };
        note(`.${method}() → visualization "${kind}"`);
      } else {
        note(`.${method}() dropped: Strudel IDE shows a pianoroll or a scope`, true);
      }
      ms.remove(node.expression.expression.end, node.end);
      dead.push([node.expression.expression.end, node.end]);
      walkCalls(node.expression.expression);
      return;
    }
    ts.forEachChild(node, walkCalls);
  };

  const walkStrings = (node) => {
    if (isDead(node)) return;
    // strings that strudel.cc turns into patterns
    if ((ts.isStringLiteral(node) && node.getText(sf)[0] === '"') || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const parent = node.parent;
      const isKey = (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node;
      if (!isKey && !ts.isTaggedTemplateExpression(parent) && !ts.isImportDeclaration(parent)) {
        const directArg = ts.isCallExpression(parent) && parent.arguments.includes(node);
        if (ts.isTemplateExpression(node)) note("a `${…}` template: strudel.cc only reads the text before the first ${…}; kept the whole template", true);
        if (!(directArg && (isStrudelCall(parent) || keepsStrings(parent)))) {
          // attached inside the literal's own range, so slices of it keep them
          ms.prependRight(node.getStart(sf), "mini(");
          ms.appendLeft(node.end, ")");
        }
      }
      if (ts.isTemplateExpression(node)) ts.forEachChild(node, walkStrings);
      return;
    }
    // 'single-quoted' strings are plain strings on strudel.cc (pure('C minor')),
    // but Strudel IDE parses every string as mini-notation: keep them plain
    // with pure(…) where that would change the value
    if (ts.isStringLiteral(node) && !usesMiniAllStrings && ts.isCallExpression(node.parent) && node.parent.arguments.includes(node) && isStrudelCall(node.parent) && !miniKeepsAsIs(node.text)) {
      ms.prependRight(node.getStart(sf), "pure(");
      ms.appendLeft(node.end, ")");
      note(`'${node.text}' → pure('${node.text}'): single-quoted strings aren't mini-notation on strudel.cc`);
    }
    ts.forEachChild(node, walkStrings);
  };

  // .piano(): a helper of the strudel.cc website (prebake.mjs), not part of
  // Strudel. Recreated as a local function: x.piano() → piano(x)
  let pianoHelper = null;
  const walkPiano = (node) => {
    if (isDead(node)) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "piano" && node.arguments.length === 0 && !declared.has("piano")) {
      pianoHelper ??= pickName("piano");
      const receiver = node.expression.expression;
      ms.prependRight(receiver.getStart(sf), `${pianoHelper}(`);
      ms.overwrite(receiver.end, node.end, ")");
      note(`.piano() (a strudel.cc website helper) → ${pianoHelper}(…), defined at the top of createPattern()`);
    }
    ts.forEachChild(node, walkPiano);
  };

  walkCalls(sf);
  walkStrings(sf);
  walkPiano(sf);

  // ─── top-level statements → items ─────────────────────────────────────────
  const stmtRange = (s) => {
    let start = s.pos;
    const lead = ts.getTrailingCommentRanges(code, s.pos) ?? [];
    if (lead.length) start = lead[lead.length - 1].end;
    const trail = ts.getTrailingCommentRanges(code, s.end) ?? [];
    return [start, trail.length ? trail[trail.length - 1].end : s.end];
  };
  const leadingComments = (s) => code.slice(stmtRange(s)[0], s.getStart(sf)).replace(/^\s*\n/, "").replace(/\s+$/, "");
  const trailingComment = (s) => code.slice(s.end, stmtRange(s)[1]);

  // the file's own header comments (before the first statement) go in our header
  const first = sf.statements[0];
  const headerComments = (first ? code.slice(0, first.getStart(sf)) : code).trim();
  const firstStart = first ? first.getStart(sf) : 0;

  let bpm;
  /** @type {any[]} */
  const items = [];
  const allFns = []; // all()/each() transforms, applied to every track
  let anon = 0;

  const unwrapStatementExpr = (s) => {
    let e = s.expression;
    if (ts.isAwaitExpression(e)) e = e.expression;
    return e;
  };

  const exprOf = (s) => (ts.isLabeledStatement(s) && ts.isExpressionStatement(s.statement) ? s.statement.expression : null);

  const soundNameOf = (expr) => {
    let found;
    const visit = (n) => {
      if (found) return;
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const fname = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
        if (["s", "sound"].includes(fname) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
          found = firstSound(n.arguments[0].text);
          if (found) return;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(expr);
    return found;
  };

  const endsWithHush = (expr) => {
    let e = expr;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    return ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "hush";
  };

  const handle = (s) => {
    const comments = s === first ? "" : leadingComments(s);
    const trail = trailingComment(s);
    const text = ms.slice(s.getStart(sf), s.end) + trail;

    if (ts.isLabeledStatement(s)) {
      const label = s.label.text;
      const expr = exprOf(s);
      if (!expr) {
        items.push({ kind: "code", comments, text: ms.slice(s.getStart(sf), s.end) + trail });
        note(`label ${label}: on a non-expression kept as is`, true);
        return;
      }
      const muted = MUTED_RE.test(label) || endsWithHush(expr);
      const anonymous = label === "$" || label.includes("$");
      let trackName = anonymous ? soundNameOf(expr) : label.replace(/^_+|_+$/g, "").replace(/\$/g, "");
      const exprText = ms.slice(expr.getStart(sf), expr.end);
      if (!trackName || !/^[A-Za-z_$][\w$]*$/.test(trackName)) trackName = `track${++anon}`;
      // a track named like a declared const (`bass: bass`) returns that const
      const sameIdentifier = ts.isIdentifier(expr) && expr.text === trackName;
      let key = trackName;
      for (let i = 2; items.some((it) => it.kind === "track" && it.key === key); i++) key = `${trackName}${i}`;
      const constName = sameIdentifier ? trackName : pickName(key);
      items.push({ kind: "track", stmt: s, key, constName, label, comments, exprText, trail, sameIdentifier, muted: muted ? (endsWithHush(expr) ? ".hush()" : `${label}:`) : null });
      return;
    }

    if (ts.isExpressionStatement(s)) {
      const e = unwrapStatementExpr(s);
      if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && !declared.has(e.expression.text)) {
        const fn = e.expression.text;
        if (fn in TEMPO) {
          const v = e.arguments[0] ? staticNumber(e.arguments[0]) : undefined;
          if (v === undefined) {
            items.push({ kind: "comment", comments, text: `TODO(strudel.cc import): tempo not converted (not a constant): ${e.getText(sf)}` });
            note(`${fn}(…) isn't a constant; kept bpm 120`, true);
          } else {
            const unit = TEMPO[fn];
            bpm = round(unit === "cpm" ? v * 4 : unit === "cps" ? v * 240 : v);
            note(`${e.getText(sf)} → bpm ${bpm}`);
            if (comments) items.push({ kind: "comment", comments, text: null });
          }
          return;
        }
        if (fn === "samples") {
          const arg = e.arguments[0];
          const ours = arg && ts.isStringLiteralLike(arg) && isAppSamplePack(arg.text);
          items.push({ kind: "comment", comments, text: `strudel.cc: ${e.getText(sf).replace(/\n\s*/g, " ")}${ours ? " (Strudel IDE loads this pack)" : ""}` });
          if (!ours) note(`samples(${arg ? arg.getText(sf).slice(0, 60) : ""}) is not loaded by Strudel IDE: sounds from it won't play (check-songs flags them)`, true);
          return;
        }
        if (fn === "miniAllStrings") {
          note("miniAllStrings() dropped: Strudel IDE always parses strings as mini-notation");
          return;
        }
        if (fn === "hush") {
          for (const it of items) if (it.kind === "track" && !it.muted) it.muted = "hush()";
          note("hush() mutes the tracks above it: they're kept, commented out");
          return;
        }
        if (fn === "all" || fn === "each") {
          const arg = e.arguments[0];
          const fnText = arg ? ms.slice(arg.getStart(sf), arg.end) : "";
          // all(x => x.pianoroll()) only sets the visualization (the rewrite dropped the call)
          if (!arg || /^\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\1\s*$/.test(fnText)) {
            if (comments) items.push({ kind: "comment", comments, text: null });
            return;
          }
          allFns.push({ fn, text: fnText, name: pickName(fn === "all" ? "everyTrack" : "eachTrack") });
          note(`${fn}(…) is applied to every track${fn === "all" ? " (strudel.cc applies it to the stack: same for most functions)" : ""}`);
          return;
        }
      }
    }

    // anything else: plain code inside createPattern()
    const hasAwait = (() => {
      let found = false;
      const v = (n) => {
        if (found || ts.isFunctionLike(n)) return;
        if (ts.isAwaitExpression(n)) found = true;
        else ts.forEachChild(n, v);
      };
      v(s);
      return found;
    })();
    items.push({ kind: "code", stmt: s, comments, text, disabled: hasAwait ? "top-level await doesn't work inside createPattern()" : null });
    if (hasAwait) note(`top-level await commented out: ${s.getText(sf).split("\n")[0].slice(0, 60)}`, true);
  };
  for (const s of sf.statements) {
    const n0 = items.length;
    handle(s);
    // a blank line before the statement (and its comments) is kept
    const blank = /^[ \t]*\n[ \t]*\n/.test(code.slice(stmtRange(s)[0], s.getStart(sf)));
    for (let k = n0; k < items.length; k++) {
      items[k].stmt ??= s;
      items[k].blank = k === n0 && blank;
    }
  }

  // strudel.cc plays the last expression when there are no labels
  // (the value of the program's last statement, if that is an expression)
  const lastStmt = sf.statements[sf.statements.length - 1];
  const lastIdx = items.findIndex((it) => it.stmt === lastStmt);
  if (!items.some((it) => it.kind === "track") && lastIdx >= 0 && items[lastIdx].kind === "code" && ts.isExpressionStatement(lastStmt) && !items[lastIdx].disabled) {
    const it = items[lastIdx];
    const expr = lastStmt.expression;
    const key = soundNameOf(expr) ?? "track1";
    items[lastIdx] = { kind: "track", stmt: lastStmt, key, constName: pickName(key), label: "(last expression)", comments: it.comments, exprText: ms.slice(expr.getStart(sf), expr.end), trail: trailingComment(lastStmt), muted: null, blank: it.blank };
  }

  // ─── render ───────────────────────────────────────────────────────────────
  const PAD = "    ";
  const header = (extraNotes) => {
    const bar = "// " + "═".repeat(75);
    const lines = [bar, `// 🎵 ${name.toUpperCase()} — imported from strudel.cc`, bar, "//"];
    const src = opts.source ?? "(pasted code)";
    lines.push(src.length > LONG_SOURCE ? `// Source: ${src.slice(0, 48)}… (the full link is at the end of this file)` : `// Source: ${src}`);
    if (meta.by) lines.push(`// By: ${meta.by}`);
    if (meta.license) lines.push(`// License: ${meta.license}`);
    lines.push("//", "// Converted by `npm run import` (scripts/strudel-cc/import.mjs). Notes:");
    const all = [...notes, ...extraNotes];
    if (!all.length) lines.push("//   • nothing needed converting");
    for (const n of all) lines.push(`//   • ${n}`);
    lines.push("//", bar);
    return lines.join("\n");
  };

  const render = (disabledExtra = new Map()) => {
    const out = [];
    out.push(header([]));
    if (headerComments) out.push("", "// ─── from strudel.cc ─────────────────────────────────────────────────────────", headerComments);
    out.push("", `import type { Song } from ".";`, "", "const song: Song = {", `  name: ${JSON.stringify(name)},`, `  bpm: ${bpm ?? 120},`);
    if (visualization?.options) out.push(`  visualization: { type: ${JSON.stringify(visualization.type)}, options: ${visualization.options} },`);
    else out.push(`  visualization: ${JSON.stringify(visualization?.type ?? "pianoroll")},`);
    out.push("", "  createPattern() {");
    const ranges = []; // [startOffset, endOffset, itemIndex] in the rendered text
    if (pianoHelper) {
      out.push(
        `${PAD}// strudel.cc's .piano() (defined by its website, website/src/repl/prebake.mjs, AGPL-3.0):`,
        `${PAD}// the piano with clip 1 and release 0.1, panned by pitch`,
        `${PAD}const ${pianoHelper} = (pat: Pattern) =>`,
        `${PAD}  pat`,
        `${PAD}    .fmap((v) => ({ ...v, clip: v.clip ?? 1 }))`,
        `${PAD}    .s("piano")`,
        `${PAD}    .release(0.1)`,
        `${PAD}    .fmap((v) => ({ ...v, pan: (v.pan || 1) * (Math.min(Math.round(valueToMidi(v)) / noteToMidi("C8"), 1) * 0.5 + 0.25) }));`,
        ""
      );
    }
    let text = out.join("\n") + "\n";
    const tracks = [];
    items.forEach((it, i) => {
      const parts = [];
      if (it.comments) parts.push(indent(it.comments, PAD));
      const disabled = it.disabled ?? disabledExtra.get(i);
      if (it.kind === "comment") {
        if (it.text) parts.push(`${PAD}// ${it.text}`);
      } else if (it.kind === "code") {
        if (disabled) parts.push(`${PAD}// TODO(strudel.cc import): ${disabled}`, commentOut(it.text, PAD));
        else parts.push(indent(it.text, PAD));
      } else if (it.kind === "track") {
        const decl = it.sameIdentifier ? null : `const ${it.constName} = ${it.exprText};${it.trail}`;
        if (it.muted || disabled) {
          const why = disabled ? `TODO(strudel.cc import): ${disabled}` : `muted on strudel.cc (${it.muted}): uncomment it and add it to the return to hear it`;
          parts.push(`${PAD}// ${why}`);
          if (decl) parts.push(commentOut(decl, PAD));
        } else {
          if (decl) parts.push(indent(decl, PAD));
          tracks.push(it);
        }
      }
      if (!parts.length) return;
      const chunk = parts.join("\n") + "\n";
      const start = text.length;
      text += (it.blank && ranges.length ? "\n" : "") + chunk;
      ranges.push([start, text.length, i]);
    });
    // all()/each(): one function applied to every track
    let wrap = (t) => t;
    if (allFns.length && tracks.length) {
      // each() runs before all() on strudel.cc
      const ordered = [...allFns.filter((a) => a.fn === "each"), ...allFns.filter((a) => a.fn === "all")];
      const fns = ordered.map((a) => `${PAD}const ${a.name} = (${a.text}) as (pat: Pattern) => Pattern; // strudel.cc: ${a.fn}(…)`);
      text += "\n" + fns.join("\n") + "\n";
      wrap = (t) => ordered.reduce((acc, a) => `${a.name}(${acc})`, t);
    }
    if (!tracks.length) {
      text += `\n${PAD}// TODO(strudel.cc import): no playing pattern found in the strudel.cc code\n${PAD}return { silence };\n`;
      note("no playing pattern found: the song is silent", true);
    } else {
      const entries = tracks.map((t) => {
        const value = wrap(t.constName);
        return value === t.key ? t.key : `${t.key}: ${value}`;
      });
      const one = `${PAD}return { ${entries.join(", ")} };`;
      text += "\n" + (one.length <= 100 ? one : `${PAD}return {\n${entries.map((e) => `${PAD}  ${e},`).join("\n")}\n${PAD}};`) + "\n";
    }
    text += "  },\n};\n\nexport default song;\n";
    return { text, ranges };
  };

  // ─── make it type-check ───────────────────────────────────────────────────
  // 1. statements using names the app doesn't have get commented out (and so
  //    do statements that use what those declared), item by item
  // 2. implicit-any parameters get `: any`
  // 3. anything else gets `// @ts-expect-error TODO(…)`
  const virtual = join(root, "src/songs", `__strudel_cc_import_${id.replace(/[^\w]/g, "_")}.ts`);
  const disabled = new Map();
  // unknown names (2304/2552), and methods missing on patterns or strings
  // (2339/2551): what strudel.cc has and Strudel IDE doesn't
  const isUnknownApi = (d) =>
    d.code === 2304 || d.code === 2552 || ((d.code === 2339 || d.code === 2551) && /on type '(Pattern|string|")/.test(d.message));
  // what each code item declares and mentions, so commenting one out also
  // comments out its users (else `m(74)` would quietly hit the global m)
  const declaredBy = (s) => {
    const out = new Set();
    const add = (b) => (ts.isIdentifier(b) ? out.add(b.text) : b.elements?.forEach((e) => !ts.isOmittedExpression(e) && add(e.name)));
    if (ts.isVariableStatement(s)) s.declarationList.declarations.forEach((d) => add(d.name));
    else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) out.add(s.name.text);
    return out;
  };
  const mentions = (s) => {
    const out = new Set();
    const v = (n) => {
      const p = n.parent;
      if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(p) && p.name === n) && !(ts.isPropertyAssignment(p) && p.name === n) && !(ts.isLabeledStatement(p) && p.label === n)) out.add(n.text);
      ts.forEachChild(n, v);
    };
    v(s);
    return out;
  };
  const itemDecls = items.map((it) => (it.kind === "code" && it.stmt ? declaredBy(it.stmt) : new Set()));
  const itemUses = items.map((it) => (it.stmt && it.kind !== "comment" ? mentions(it.stmt) : new Set()));
  const propagate = () => {
    let changed = false;
    for (let again = true; again; ) {
      again = false;
      items.forEach((it, i) => {
        if (it.kind === "comment" || it.disabled || disabled.has(i)) return;
        for (const [j, other] of items.entries()) {
          if (!(other.disabled || disabled.has(j))) continue;
          const name = [...itemDecls[j]].find((n) => itemUses[i].has(n) && !itemDecls[i].has(n));
          if (name) {
            disabled.set(i, `uses \`${name}\`, which is commented out above`);
            again = changed = true;
            return;
          }
        }
      });
    }
    return changed;
  };
  propagate();
  let rendered = render(disabled);
  for (let round = 0; round < 25; round++) {
    const diags = songDiagnostics(virtual, rendered.text).filter(isUnknownApi);
    if (!diags.length) break;
    let changed = false;
    for (const d of diags) {
      const r = rendered.ranges.find(([a, b]) => d.start >= a && d.start < b);
      if (!r) continue;
      const idx = r[2];
      if (items[idx].kind === "comment" || disabled.has(idx)) continue;
      disabled.set(idx, d.message.replace(/\.$/, "") + " in Strudel IDE (a strudel.cc-only function?)");
      changed = true;
    }
    if (!changed) break;
    propagate();
    rendered = render(disabled);
  }
  for (const [idx, why] of disabled) {
    const it = items[idx];
    note(`commented out ${it.kind === "track" ? `track "${it.key}"` : "a statement"}: ${why}`, true);
  }
  rendered = render(disabled);
  let out = rendered.text;
  out = fixImplicitAny(out, virtual);
  out = expectErrors(out, virtual, note);
  // the notes may have grown: re-render the header
  out = out.replace(/^[\s\S]*?\n\/\/ ═+\n(?=\n)/, header([]) + "\n");

  if (opts.source && opts.source.length > LONG_SOURCE) out += `\n// Source (strudel.cc share link):\n// ${opts.source}\n`;

  return { ts: out, id, name, warnings };
}

/** Add `: any` to parameters TypeScript can't type (callbacks of user helpers etc.) */
function fixImplicitAny(text, virtual) {
  for (let round = 0; round < 5; round++) {
    const diags = songDiagnostics(virtual, text).filter((d) => d.code === 7006 || d.code === 7031);
    if (!diags.length) return text;
    const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const edits = [];
    const find = (n, pos) => {
      if (ts.isParameter(n) && n.getStart(sf) <= pos && pos < n.end) return n;
      let found;
      ts.forEachChild(n, (c) => {
        if (!found && c.getFullStart() <= pos && pos < c.end) found = find(c, pos);
      });
      return found;
    };
    for (const d of diags) {
      const p = find(sf, d.start);
      if (!p || p.type) continue;
      const fn = p.parent;
      const parens = !(ts.isArrowFunction(fn) && fn.parameters.length === 1 && text[fn.getStart(sf)] !== "(" && !fn.modifiers?.length);
      if (parens) edits.push([p.name.end, p.name.end, ": any"]);
      else edits.push([p.getStart(sf), p.end, `(${p.getText(sf)}: any)`]);
    }
    const seen = new Set();
    for (const [a, b, s] of edits.sort((x, y) => y[0] - x[0])) {
      if (seen.has(a)) continue;
      seen.add(a);
      text = text.slice(0, a) + s + text.slice(b);
    }
  }
  return text;
}

/** Mark remaining type errors with `// @ts-expect-error TODO(…)` on the line above */
function expectErrors(text, virtual, note) {
  for (let round = 0; round < 5; round++) {
    const diags = songDiagnostics(virtual, text);
    if (!diags.length) return text;
    const lines = text.split("\n");
    const byLine = new Map();
    for (const d of diags) if (d.line >= 0 && !byLine.has(d.line)) byLine.set(d.line, d.message);
    for (const line of [...byLine.keys()].sort((a, b) => b - a)) {
      const pad = lines[line].match(/^\s*/)[0];
      const msg = byLine.get(line).replace(/\s+/g, " ").slice(0, 140);
      lines.splice(line, 0, `${pad}// @ts-expect-error TODO(strudel.cc import): ${msg}`);
      note(`type error marked with @ts-expect-error: ${msg}`, true);
    }
    text = lines.join("\n");
  }
  return text;
}

/** Sounds strudel.cc has but the app doesn't load, mentioned in the code */
export function strudelCcOnlySounds(code) {
  const found = new Set();
  for (const m of code.matchAll(/["'`]([^"'`]*)["'`]/g)) {
    for (const w of m[1].split(/[^A-Za-z0-9_]+/)) {
      if (STRUDEL_CC_ONLY_SOUNDS.includes(w) || STRUDEL_CC_ONLY_PREFIXES.some((p) => w.startsWith(p))) found.add(w);
    }
  }
  return [...found];
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

async function readInput(arg) {
  if (arg === "-") {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const text = Buffer.concat(chunks).toString("utf8").trim();
    return isStrudelUrl(text) && !text.includes("\n") ? { code: urlToCode(text), source: text } : { code: text, source: "(stdin)" };
  }
  if (isStrudelUrl(arg) || arg.startsWith("#")) return { code: urlToCode(arg), source: arg };
  if (existsSync(arg)) return { code: readFileSync(arg, "utf8"), source: basename(arg) };
  throw new Error(`Not a strudel.cc URL or a file: ${arg}`);
}

async function main(argv) {
  const args = argv.slice(2);
  const value = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const positional = args.filter((a, i) => (a === "-" || !a.startsWith("--")) && !["--id", "--name"].includes(args[i - 1]));
  if (!positional.length || args.includes("--help")) {
    console.error('Usage: npm run import -- <strudel.cc URL | file.js | -> [--id my-song] [--name "My Song"] [--force]');
    process.exit(positional.length ? 0 : 1);
  }
  const { code, source } = await readInput(positional[0]);
  const result = importCode(code, { id: value("--id"), name: value("--name"), source });
  const file = join(root, "src/songs", `${result.id}.ts`);
  if (existsSync(file) && !args.includes("--force")) throw new Error(`${file} exists (use --id or --force)`);
  writeFileSync(file, result.ts);
  for (const w of result.warnings) console.error(`⚠️  ${w}`);
  const only = strudelCcOnlySounds(code);
  if (only.length) console.error(`⚠️  strudel.cc-only sounds (not loaded by Strudel IDE): ${only.join(", ")}`);
  console.error(`✅ ${result.name} → src/songs/${result.id}.ts`);
  const check = spawnSync(process.execPath, [join(root, "scripts/check-songs.mjs"), result.id], { encoding: "utf8" });
  process.stderr.write((check.stdout + check.stderr).split("\n").filter((l) => !/@strudel\/core loaded|cannot use window/.test(l)).join("\n"));
  console.log(`src/songs/${result.id}.ts`); // stdout: the file, for tools
  if (check.status !== 0) {
    console.error("⚠️  check-songs reported problems (above). The file is written; fix the TODOs by hand.");
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
}
