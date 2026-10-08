// Song file → strudel.cc REPL code.
//
//   npm run export -- <song-id | path/to/song.ts> [--url] [--out file.js]
//
// What it does (see docs/strudel-cc.md):
//   - inlines the top-level constants/helpers createPattern() uses, then the
//     createPattern() body, with TypeScript types erased in place (TS AST), so
//     formatting and comments survive
//   - the returned tracks become strudel.cc labels: `kick: s("bd*4")…`
//   - setcpm(bpm/4), and miniAllStrings(): Strudel IDE parses every string it
//     hands to a pattern function as mini-notation; strudel.cc only does that
//     for "double-quoted" and `backtick` literals (its transpiler wraps them in
//     m(…)). So strings stay double-quoted only where TypeScript says they go
//     straight into a pattern argument; all others become 'single-quoted'
//     (and `${}` templates become concatenation, since strudel.cc's
//     transpiler would replace a template with its first chunk)
//   - knob(name, value, min, max, step) → slider(value, min, max, step)
//   - sections and visualization as a comment / all(x => x.pianoroll())
//
// Warnings (stderr) flag what won't carry over.

import "./quiet.mjs";
import { writeFileSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import MagicString from "magic-string";
import { parse as acornParse } from "acorn";
import { root, loadSong, isPattern } from "./runtime.mjs";
import { codeToUrl, urlToCode, appSampleMaps, STRUDEL_CC_PREBAKED, SAMPLE_BASE } from "./shared.mjs";
import { createSongProgram, ts } from "./tsproject.mjs";

const RESERVED = new Set(
  ("break case catch class const continue debugger default delete do else enum export extends false finally for " +
    "function if import in instanceof new null return super switch this throw true try typeof var void while with " +
    "yield let static implements interface package private protected public await async").split(" ")
);

/** Can `name` be a strudel.cc label that plays (not muted, not anonymised)? */
export function isPlainLabel(name) {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name) && !name.endsWith("_") && !RESERVED.has(name);
}

function resolveSongFile(arg) {
  if (arg.endsWith(".ts")) return resolve(arg);
  return join(root, "src/songs", `${arg}.ts`);
}

const skipOuter = (e) => {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e))
    e = e.expression;
  return e;
};

const SINGLE_QUOTE_ESCAPES = {
  "\\": "\\\\",
  "'": "\\'",
  "\n": "\\n",
  "\r": "\\r",
  [String.fromCharCode(0x2028)]: "\\u2028",
  [String.fromCharCode(0x2029)]: "\\u2029",
};

export function singleQuote(s) {
  return `'${s.replace(/[\\'\n\r\u2028\u2029]/g, (c) => SINGLE_QUOTE_ESCAPES[c])}'`;
}

const doubleQuote = (s) => JSON.stringify(s);

/** Is `type` (or a member of its union) the Strudel Pattern interface? */
function acceptsPattern(type, depth = 0) {
  if (!type || depth > 4) return false;
  if (type.isUnion() || type.isIntersection()) return type.types.some((t) => acceptsPattern(t, depth + 1));
  const sym = type.getSymbol() ?? type.aliasSymbol;
  return sym?.getName() === "Pattern";
}

/** Inside a type annotation (or a type-only construct)? */
function inType(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) return true;
    if (ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isImportDeclaration(n)) return true;
    if (ts.isStatement(n)) return false;
  }
  return false;
}

function isAmbientGlobal(symbol) {
  const decls = symbol?.declarations ?? [];
  return decls.length > 0 && decls.every((d) => d.getSourceFile().isDeclarationFile);
}

function lineIndent(text, pos) {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  return text.slice(lineStart, pos).match(/^[ \t]*/)[0];
}

function dedent(text, indent) {
  if (!indent) return text;
  return text
    .split("\n")
    .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.replace(/^[ \t]+/, (ws) => ws.slice(Math.min(ws.length, indent.length)))))
    .join("\n");
}

/**
 * @param {string} songArg song id or path
 * @returns {Promise<{ code: string, warnings: string[], name: string, file: string }>}
 */
export async function exportSong(songArg) {
  const file = resolveSongFile(songArg);
  if (!existsSync(file)) throw new Error(`No song file ${file}`);
  const id = basename(file, ".ts");
  const warnings = [];
  const warn = (msg) => warnings.includes(msg) || warnings.push(msg);

  // Runtime facts: bpm, sections, track names (whatever expressions produced them)
  const song = await loadSong(file);
  const bpm = song.bpm ?? 120;
  const result = song.createPattern();
  const runtimeTracks = isPattern(result) ? null : Object.keys(result);

  const { checker, sourceFile: sf } = createSongProgram(file);
  const text = sf.text;
  const ms = new MagicString(text);

  // ─── find the song object and createPattern ──────────────────────────────
  const exportAssign = sf.statements.find((s) => ts.isExportAssignment(s) && !s.isExportEquals);
  if (!exportAssign) throw new Error(`${file}: no default export`);
  let songObj = skipOuter(exportAssign.expression);
  let songStmt = null;
  if (ts.isIdentifier(songObj)) {
    const decl = checker.getSymbolAtLocation(songObj)?.valueDeclaration;
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) throw new Error(`${file}: can't find the song declaration`);
    songObj = skipOuter(decl.initializer);
    songStmt = decl.parent.parent;
  }
  if (!ts.isObjectLiteralExpression(songObj)) throw new Error(`${file}: the default export is not an object literal`);
  const cpProp = songObj.properties.find((p) => p.name && p.name.getText(sf) === "createPattern");
  if (!cpProp) throw new Error(`${file}: no createPattern`);
  let cpFn = cpProp;
  if (ts.isPropertyAssignment(cpProp)) cpFn = skipOuter(cpProp.initializer);
  if (!cpFn.body) throw new Error(`${file}: createPattern has no body`);
  const visualization = song.visualization;

  // ─── which top-level statements does createPattern need? ─────────────────
  const topLevel = sf.statements.filter(
    (s) =>
      s !== songStmt &&
      s !== exportAssign &&
      !ts.isImportDeclaration(s) &&
      !ts.isTypeAliasDeclaration(s) &&
      !ts.isInterfaceDeclaration(s) &&
      !(ts.canHaveModifiers(s) && ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword))
  );
  const declaredBy = new Map(); // symbol → top-level statement
  const topSymbols = new Map(); // name → symbol
  for (const s of topLevel) {
    const names = [];
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        const collect = (n) => {
          if (ts.isIdentifier(n)) names.push(n);
          else n.elements?.forEach((e) => !ts.isOmittedExpression(e) && collect(e.name));
        };
        collect(d.name);
      }
    } else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isEnumDeclaration(s)) && s.name) {
      names.push(s.name);
    }
    for (const n of names) {
      const sym = checker.getSymbolAtLocation(n);
      if (sym) {
        declaredBy.set(sym, s);
        topSymbols.set(n.text, sym);
      }
    }
  }

  const symbolOf = (id) => {
    if (ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id)
      return checker.getShorthandAssignmentValueSymbol(id.parent);
    return checker.getSymbolAtLocation(id);
  };

  const included = new Set();
  const queue = [cpFn];
  while (queue.length) {
    const node = queue.pop();
    const visit = (n) => {
      if (ts.isIdentifier(n) && !inType(n)) {
        const st = declaredBy.get(symbolOf(n));
        if (st && !included.has(st)) {
          included.add(st);
          queue.push(st);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  }
  for (const s of topLevel) {
    if (!ts.isVariableStatement(s) && !ts.isFunctionDeclaration(s) && !ts.isClassDeclaration(s) && !ts.isEnumDeclaration(s)) {
      included.add(s);
      warn(`top-level statement kept as is (side effects?): ${s.getText(sf).split("\n")[0].slice(0, 60)}`);
    }
  }
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) && !s.importClause?.isTypeOnly) {
      const spec = s.moduleSpecifier.getText(sf);
      warn(`import ${spec} can't be inlined: copy what the song uses from it by hand`);
    }
  }
  const includedTop = topLevel.filter((s) => included.has(s));

  // ─── body: tracks, inlining and the return ───────────────────────────────
  const isBlockBody = ts.isBlock(cpFn.body);
  const bodyStatements = isBlockBody ? [...cpFn.body.statements] : [];
  let returnStmt = isBlockBody ? bodyStatements[bodyStatements.length - 1] : null;
  let returnExpr = isBlockBody ? (returnStmt && ts.isReturnStatement(returnStmt) ? returnStmt.expression : null) : cpFn.body;
  let returnCount = 0;
  if (isBlockBody) {
    const countReturns = (n) => {
      if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
      if (ts.isReturnStatement(n)) returnCount++;
      ts.forEachChild(n, countReturns);
    };
    countReturns(cpFn.body);
  }
  const simpleReturn = !isBlockBody || (returnExpr && returnCount === 1 && ts.isReturnStatement(returnStmt));

  /** @type {{ name: string, label: string, expr?: ts.Expression, inline?: ts.VariableStatement, init?: ts.Expression }[]} */
  let tracks = [];
  let fallback = false;
  let singlePattern = null;
  let tracksExpr = null;
  if (simpleReturn && returnExpr) {
    const ret = skipOuter(returnExpr);
    if (ts.isObjectLiteralExpression(ret) && ret.properties.every((p) => (ts.isShorthandPropertyAssignment(p) || ts.isPropertyAssignment(p)) && !ts.isComputedPropertyName(p.name))) {
      for (const p of ret.properties) {
        const name = ts.isShorthandPropertyAssignment(p) ? p.name.text : p.name.text ?? p.name.getText(sf);
        const expr = ts.isShorthandPropertyAssignment(p) ? p.name : p.initializer;
        tracks.push({ name, expr });
      }
    } else if (!runtimeTracks) {
      singlePattern = ret;
    } else {
      // e.g. `return mixdown({ kick, … })` or `return tracks`: keep the
      // expression, then one label per track it produced
      tracksExpr = ret;
    }
  } else {
    fallback = true;
  }

  // labels
  const usedLabels = new Set();
  for (const t of tracks) {
    if (isPlainLabel(t.name) && !usedLabels.has(t.name)) {
      t.label = t.name;
      usedLabels.add(t.name);
    } else {
      t.label = "$";
      warn(`track "${t.name}" can't be a strudel.cc label (labels starting/ending with _ are muted, $ is anonymous): exported as "$:"`);
    }
  }

  // inline `const kick = …` → `kick: …` when kick is used only in the return
  if (isBlockBody && !fallback) {
    const refs = new Map(); // symbol → count of references outside the return
    const visit = (n) => {
      if (n === returnStmt) return;
      if (ts.isIdentifier(n) && !inType(n)) {
        const sym = symbolOf(n);
        if (sym && !(ts.isVariableDeclaration(n.parent) && n.parent.name === n)) refs.set(sym, (refs.get(sym) ?? 0) + 1);
      }
      ts.forEachChild(n, visit);
    };
    visit(cpFn.body);
    const retRefs = new Map();
    const visitRet = (n) => {
      if (ts.isIdentifier(n) && !inType(n)) {
        const sym = symbolOf(n);
        if (sym) retRefs.set(sym, (retRefs.get(sym) ?? 0) + 1);
      }
      ts.forEachChild(n, visitRet);
    };
    if (returnStmt) visitRet(returnStmt);
    for (const t of tracks) {
      if (t.label === "$" || !ts.isIdentifier(t.expr)) continue;
      const sym = symbolOf(t.expr);
      const decl = sym?.valueDeclaration;
      if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const stmt = decl.parent.parent;
      if (!ts.isVariableStatement(stmt) || stmt.parent !== cpFn.body || stmt.declarationList.declarations.length !== 1) continue;
      if ((refs.get(sym) ?? 0) > 0 || retRefs.get(sym) !== 1) continue;
      t.inline = stmt;
      t.init = decl.initializer;
    }
  }

  // ─── conflicting names: body declarations shadowing included top-level ones
  // (both end up in one scope in strudel.cc)
  const bodyNames = new Set();
  for (const s of bodyStatements) {
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        const collect = (n) => {
          if (ts.isIdentifier(n)) bodyNames.add(n.text);
          else n.elements?.forEach((e) => !ts.isOmittedExpression(e) && collect(e.name));
        };
        collect(d.name);
      }
    } else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) bodyNames.add(s.name.text);
  }
  const renames = new Map(); // symbol → new name
  for (const [name, sym] of topSymbols) {
    if (!included.has(declaredBy.get(sym))) continue;
    if (bodyNames.has(name)) {
      let n = `${name}2`;
      for (let i = 3; topSymbols.has(n) || bodyNames.has(n); i++) n = `${name}${i}`;
      renames.set(sym, n);
      warn(`renamed top-level "${name}" to "${n}" (createPattern() declares its own "${name}")`);
    }
  }

  // ─── edits: erase types, requote strings, knob → slider, renames ────────
  const skip = new Set(); // nodes whose subtree is already rewritten
  const knobsSeen = [];

  const erase = (from, to) => from < to && ms.remove(from, to);

  const edit = (node) => {
    if (skip.has(node)) return;

    // types
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      erase(node.getStart(sf), node.end);
      return;
    }
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node)) && node.type) {
      erase(node.type.pos - 1, node.type.end);
    }
    if (ts.isParameter(node) && node.questionToken) erase(node.questionToken.getStart(sf), node.questionToken.end);
    if (ts.isVariableDeclaration(node) && node.exclamationToken) erase(node.exclamationToken.getStart(sf), node.exclamationToken.end);
    if (ts.isFunctionLike(node) && node.type && !ts.isFunctionTypeNode(node)) erase(node.type.pos - 1, node.type.end);
    if (ts.isFunctionLike(node) && node.typeParameters) erase(node.typeParameters.pos - 1, node.typeParameters.end + 1);
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.typeArguments)
      erase(node.typeArguments.pos - 1, node.typeArguments.end + 1);
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) erase(node.expression.end, node.end);
    if (ts.isNonNullExpression(node)) erase(node.expression.end, node.end);
    if (ts.isTypeAssertionExpression(node)) erase(node.getStart(sf), node.expression.getStart(sf));
    if (ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) warn(`TypeScript-only syntax left as is: ${node.getText(sf).split("\n")[0]}`);
    if (ts.canHaveModifiers(node)) {
      for (const m of ts.getModifiers(node) ?? []) {
        if ([ts.SyntaxKind.ExportKeyword, ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.ReadonlyKeyword, ts.SyntaxKind.OverrideKeyword].includes(m.kind)) {
          let end = m.end;
          while (/\s/.test(text[end])) end++;
          erase(m.getStart(sf), end);
        }
      }
    }
    // knob(name, value, min, max, step) → slider(value, min, max, step)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "knob") {
      const sym = checker.getSymbolAtLocation(node.expression);
      if (!sym || isAmbientGlobal(sym)) {
        const [nameArg, value, min, max, step] = node.arguments;
        const name = nameArg && ts.isStringLiteralLike(nameArg) ? nameArg.text : nameArg?.getText(sf);
        knobsSeen.push(name);
        ms.overwrite(node.expression.getStart(sf), node.expression.end, "slider");
        if (nameArg && value) ms.remove(nameArg.getStart(sf), value.getStart(sf));
        if (nameArg) skip.add(nameArg);
        if (value && !ts.isNumericLiteral(value) && !(ts.isPrefixUnaryExpression(value) && ts.isNumericLiteral(value.operand)))
          warn(`knob "${name}": the value isn't a number literal, so strudel.cc can't show a slider for it`);
        if (!min || !max) warn(`knob "${name}": strudel.cc's slider defaults to 0..1 without min/max`);
        if (step && ts.isObjectLiteralExpression(step)) {
          const stepProp = step.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === "step");
          const logProp = step.properties.find((p) => p.name?.getText(sf) === "log");
          if (logProp) warn(`knob "${name}": log travel has no strudel.cc equivalent (the slider is linear)`);
          ms.overwrite(step.getStart(sf), step.end, stepProp ? stepProp.initializer.getText(sf) : "");
          if (!stepProp) ms.remove(max.end, step.getStart(sf));
          skip.add(step);
        }
        ms.appendLeft(node.getStart(sf), `/* ${name} */ `);
      }
    }

    // renamed identifiers
    if (ts.isIdentifier(node) && renames.size) {
      const sym = symbolOf(node);
      const to = renames.get(sym);
      if (to) {
        if (ts.isShorthandPropertyAssignment(node.parent)) ms.appendLeft(node.end, `: ${to}`);
        else ms.overwrite(node.getStart(sf), node.end, to);
      }
    }

    // app-only globals
    if (ts.isIdentifier(node) && !inType(node) && node.text !== "knob" && appOnly.has(node.text)) {
      const sym = checker.getSymbolAtLocation(node);
      if (sym && isAmbientGlobal(sym)) warn(`${node.text}() is a Strudel IDE global; strudel.cc doesn't have it`);
    }

    // strings
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      if (ts.isImportDeclaration(node.parent) || ts.isLiteralTypeNode(node.parent) || inType(node)) return;
      if (ts.isTaggedTemplateExpression(node.parent)) {
        warn(`tagged template ${node.parent.tag.getText(sf)}\`…\` left as is`);
        return;
      }
      const isKey = (ts.isPropertyAssignment(node.parent) || ts.isPropertyDeclaration(node.parent) || ts.isMethodDeclaration(node.parent)) && node.parent.name === node;
      const pattern = !isKey && acceptsPattern(checker.getContextualType(node));
      if (ts.isTemplateExpression(node)) {
        templateToConcat(node, pattern);
        return; // spans are visited by the caller's forEachChild
      }
      const raw = node.getText(sf);
      if (pattern) {
        if (raw[0] !== '"') ms.overwrite(node.getStart(sf), node.end, doubleQuote(node.text));
      } else if (raw[0] !== "'") {
        ms.overwrite(node.getStart(sf), node.end, singleQuote(node.text));
      }
    }
  };

  const needsParens = (e) =>
    !(ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e) || ts.isStringLiteral(e) || ts.isNumericLiteral(e) || ts.isParenthesizedExpression(e));

  const templateToConcat = (node, _pattern) => {
    const outerParens = !(
      ts.isCallExpression(node.parent) ||
      ts.isVariableDeclaration(node.parent) ||
      ts.isReturnStatement(node.parent) ||
      ts.isArrowFunction(node.parent) ||
      ts.isArrayLiteralExpression(node.parent) ||
      ts.isPropertyAssignment(node.parent) ||
      ts.isParenthesizedExpression(node.parent) ||
      ts.isTemplateSpan(node.parent)
    );
    const spans = node.templateSpans;
    const firstParen = needsParens(spans[0].expression);
    ms.overwrite(node.head.getStart(sf), node.head.end, `${outerParens ? "(" : ""}${singleQuote(node.head.text)} + ${firstParen ? "(" : ""}`);
    spans.forEach((span, i) => {
      const closeParen = needsParens(span.expression) ? ")" : "";
      const lit = span.literal;
      if (ts.isTemplateTail(lit)) {
        const tail = lit.text ? ` + ${singleQuote(lit.text)}` : "";
        ms.overwrite(lit.getStart(sf), lit.end, `${closeParen}${tail}${outerParens ? ")" : ""}`);
      } else {
        const nextParen = needsParens(spans[i + 1].expression) ? "(" : "";
        const mid = lit.text ? ` + ${singleQuote(lit.text)}` : "";
        ms.overwrite(lit.getStart(sf), lit.end, `${closeParen}${mid} + ${nextParen}`);
      }
    });
  };

  const appOnly = await appOnlyGlobals();

  const walk = (n) => {
    if (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) return; // erased by its parent
    edit(n);
    if (!skip.has(n)) ts.forEachChild(n, walk);
  };
  for (const s of includedTop) walk(s);
  walk(cpFn.body);

  // ─── assemble ────────────────────────────────────────────────────────────
  const out = [];
  const firstStmt = sf.statements[0];
  const fileHeader = firstStmt ? text.slice(0, firstStmt.getStart(sf)).trimEnd() : "";
  if (fileHeader) out.push(fileHeader, "");

  out.push(`// @title ${song.name ?? id}`);
  out.push(`// Exported from Strudel IDE (src/songs/${id}.ts) with \`npm run export\`.`);
  const sections = normalizeSections(song.sections);
  if (sections.length) {
    let at = 0;
    const parts = sections.map(([name, bars]) => {
      const s = `${name} ${bars} (@${at})`;
      at += bars;
      return s;
    });
    out.push(`// Sections — name, bars, (starting cycle); 1 bar = 1 cycle, ${at} bars in all:`);
    out.push(...wrapComment(parts, 76));
  }
  out.push("");
  out.push(`setcpm(${bpm}/4) // ${bpm} bpm, 1 cycle = 1 bar of 4/4`);
  out.push(`miniAllStrings() // like Strudel IDE: every string a pattern function gets is mini-notation`);
  const missingPacks = appSampleMaps().filter((m) => !STRUDEL_CC_PREBAKED.includes(m));
  // strudel.cc preloads every pack the app loads today; a new one gets a line
  for (const m of missingPacks) out.push(`samples('${SAMPLE_BASE}/${m}.json')`);

  // A statement with its own comments: the leading ones (minus the previous
  // statement's same-line comment) and its same-line trailing comment
  const stmtRange = (s) => {
    let start = s.pos;
    const lead = ts.getTrailingCommentRanges(text, s.pos) ?? [];
    if (lead.length) start = lead[lead.length - 1].end;
    const trail = ts.getTrailingCommentRanges(text, s.end) ?? [];
    return [start, trail.length ? trail[trail.length - 1].end : s.end];
  };
  const group = (chunks) => chunks.join("").replace(/^\s*\n/, "");
  if (includedTop.length) out.push("", group(includedTop.map((s) => ms.slice(...stmtRange(s)))));

  const bodyIndent = bodyStatements.length ? lineIndent(text, bodyStatements[0].getStart(sf)) : "";
  const labelLines = [];
  const labelFor = (t, exprText) => `${t.label}: ${exprText}`;
  const freshName = (base) => {
    let n = base;
    for (let i = 2; bodyNames.has(n) || topSymbols.has(n); i++) n = `${base}${i}`;
    return n;
  };
  /** one label per runtime track name: `kick: tracks.kick` */
  const labelsFrom = (obj) => {
    for (const name of runtimeTracks) {
      const ok = isPlainLabel(name);
      if (!ok) warn(`track "${name}" can't be a strudel.cc label: exported as "$:"`);
      labelLines.push(`${ok ? name : "$"}: ${obj}${/^[A-Za-z_$][\w$]*$/.test(name) ? `.${name}` : `[${singleQuote(name)}]`}`);
    }
  };

  if (fallback) {
    warn("createPattern() returns from more than one place: wrapped it in a function");
    const obj = freshName("tracks");
    const fnText = isBlockBody ? ms.slice(cpFn.body.getStart(sf), cpFn.body.end) : `{ return ${ms.slice(cpFn.body.getStart(sf), cpFn.body.end)} }`;
    out.push("", `const ${obj} = (() => ${dedent(fnText, bodyIndent.slice(2))})()`, "");
    if (runtimeTracks) labelsFrom(obj);
    else labelLines.push(`$: ${obj}`);
  } else {
    const bodyChunks = [];
    for (const s of bodyStatements) {
      if (s === returnStmt) continue;
      const t = tracks.find((t) => t.inline === s);
      if (t) {
        // keep the statement's leading comments, swap `const kick = ` for `kick: `
        ms.overwrite(s.getStart(sf), t.init.getStart(sf), `${t.label}: `);
        if (s.end > t.init.end) ms.remove(t.init.end, s.end);
      }
      bodyChunks.push(dedent(ms.slice(...stmtRange(s)), bodyIndent));
    }
    if (bodyChunks.length) out.push("", group(bodyChunks));
    if (returnStmt && ts.isReturnStatement(returnStmt)) {
      const lead = text.slice(stmtRange(returnStmt)[0], returnStmt.getStart(sf));
      const comments = lead.trim() ? dedent(lead, bodyIndent).replace(/\s+$/, "") : "";
      if (comments) labelLines.push(comments.replace(/^\n+/, "\n"));
    }
    if (singlePattern) {
      labelLines.push(`$: ${dedent(ms.slice(singlePattern.getStart(sf), singlePattern.end), bodyIndent)}`);
    }
    if (tracksExpr) {
      let obj = ts.isIdentifier(tracksExpr) ? tracksExpr.text : null;
      if (!obj) {
        obj = freshName("tracks");
        labelLines.push(`const ${obj} = ${dedent(ms.slice(tracksExpr.getStart(sf), tracksExpr.end), bodyIndent)}`, "");
      }
      labelsFrom(obj);
    }
    for (const t of tracks) {
      if (t.inline) continue;
      labelLines.push(labelFor(t, dedent(ms.slice(t.expr.getStart(sf), t.expr.end), bodyIndent)));
    }
  }
  if (labelLines.length) out.push("", ...labelLines);

  const viz = typeof visualization === "string" ? { type: visualization } : visualization;
  if (viz && viz.type && viz.type !== "none") {
    const opts = viz.options && Object.keys(viz.options).length ? jsLiteral(viz.options) : "";
    out.push("", `all(x => x.${viz.type}(${opts})) // Strudel IDE shows a ${viz.type}`);
  }

  let code = out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";

  // ─── validate: strudel.cc parses with acorn (ES2022) ─────────────────────
  try {
    acornParse(code, { ecmaVersion: 2022, allowAwaitOutsideFunction: true, sourceType: "script" });
  } catch (e) {
    throw new Error(`export produced invalid JavaScript (${e.message}). This is a bug in the exporter.\n${numbered(code, e.loc?.line)}`);
  }

  if (knobsSeen.length) warnings.push(`${knobsSeen.length} knob(s) became slider(…): ${knobsSeen.join(", ")}`);
  return { code, warnings, name: song.name ?? id, file };
}

/** A plain value as JS source (single-quoted strings, so strudel.cc leaves them alone) */
function jsLiteral(v) {
  if (typeof v === "string") return singleQuote(v);
  if (Array.isArray(v)) return `[${v.map(jsLiteral).join(", ")}]`;
  if (v && typeof v === "object")
    return `{ ${Object.entries(v).map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : singleQuote(k)}: ${jsLiteral(x)}`).join(", ")} }`;
  return String(v);
}

function numbered(code, line) {
  const lines = code.split("\n");
  const from = Math.max(0, (line ?? 1) - 4);
  return lines.slice(from, from + 8).map((l, i) => `${String(from + i + 1).padStart(4)} | ${l}`).join("\n");
}

function normalizeSections(sections) {
  if (!Array.isArray(sections)) return [];
  return sections.map((s) => (Array.isArray(s) ? [String(s[0]), Number(s[1])] : [String(s.name), Number(s.bars)]));
}

/** Comment lines listing `parts` separated by " · ", wrapped at `width` */
function wrapComment(parts, width) {
  const lines = [];
  let cur = "//";
  for (const p of parts) {
    if (cur !== "//" && cur.length + 3 + p.length > width) {
      lines.push(`${cur} ·`);
      cur = "//";
    }
    cur += cur === "//" ? ` ${p}` : ` · ${p}`;
  }
  if (cur !== "//") lines.push(cur);
  return lines;
}

/** Globals declared for the app that the Strudel runtime (hence strudel.cc) doesn't define */
let appOnlyCache;
async function appOnlyGlobals() {
  if (appOnlyCache) return appOnlyCache;
  const { runtimeGlobals } = await import("../lib/strudel-runtime.mjs");
  const runtime = runtimeGlobals();
  const out = new Set(["initStrudel"]);
  const { program } = createSongProgram(join(root, "src/songs/_template.ts"));
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(join(root, "src"))) continue;
    if (!sf.isDeclarationFile) continue;
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name && !runtime.has(st.name.text)) out.add(st.name.text);
      if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && !runtime.has(d.name.text)) out.add(d.name.text);
    }
  }
  appOnlyCache = out;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

async function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
  if (!positional.length || flag("--help")) {
    console.error("Usage: npm run export -- <song-id | file.ts> [--url] [--out file.js] [--json]");
    process.exit(positional.length ? 0 : 1);
  }
  const { code, warnings, name } = await exportSong(positional[0]);
  if (flag("--json")) {
    // for tools (a stage button, an editor command): everything in one object
    const url = codeToUrl(code);
    if (urlToCode(url) !== code) throw new Error("share link doesn't round-trip (bug)");
    console.log(JSON.stringify({ name, code, url, warnings }));
    return;
  }
  for (const w of warnings) console.error(`⚠️  ${w}`);
  const outFile = value("--out");
  if (outFile) {
    writeFileSync(outFile, code);
    console.error(`✅ ${name} → ${outFile}`);
  }
  if (flag("--url")) {
    const url = codeToUrl(code);
    // check the link decodes back to the same code, the way strudel.cc reads it
    if (urlToCode(url) !== code) throw new Error("share link doesn't round-trip (bug)");
    if (url.length > 8000) console.error(`ℹ️  The link is ${url.length} characters long; fine for browsers, too long for some chat apps.`);
    console.log(url);
  } else if (!outFile) {
    process.stdout.write(code);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
}
