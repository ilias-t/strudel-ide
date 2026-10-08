// Reads Strudel's *source* files (node_modules/@strudel/*/*.mjs, superdough/*.mjs)
// and extracts:
//   - JSDoc blocks (description, @param, @example, @synonyms, ...) keyed by the name they document
//   - parameter lists of register()'d functions, exported functions and Pattern methods
//
// The runtime (dist builds) tells us *what exists*; the source tells us *how it is documented
// and how many arguments it takes*.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const SOURCE_DIRS = [
  "@strudel/core",
  "@strudel/mini",
  "@strudel/tonal",
  "@strudel/draw",
  "@strudel/webaudio",
  "@strudel/web",
  "superdough",
];

export function sourceFiles(nodeModules) {
  const files = [];
  for (const dir of SOURCE_DIRS) {
    const abs = join(nodeModules, dir);
    for (const f of readdirSync(abs)) {
      if (f.endsWith(".mjs") && !f.includes(".test.")) files.push(join(abs, f));
    }
  }
  return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSDoc blocks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {{ type?: string, name: string, optional: boolean, rest: boolean, description: string }} DocParam
 * @typedef {{
 *   name: string, description: string, params: DocParam[], examples: string[],
 *   synonyms: string[], returns?: string, deprecated?: string, noAutocomplete: boolean,
 *   memberof?: string, file: string, superdirtOnly: boolean
 * }} DocEntry
 */

function cleanBlock(raw) {
  return raw
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, "").replace(/\s+$/, ""));
}

function parseParam(text) {
  // {type} name description  |  {type} [name=default] description
  let type;
  let rest = text.trim();
  if (rest.startsWith("{")) {
    let depth = 0;
    let i = 0;
    for (; i < rest.length; i++) {
      if (rest[i] === "{") depth++;
      else if (rest[i] === "}" && --depth === 0) break;
    }
    type = rest.slice(1, i).trim();
    rest = rest.slice(i + 1).trim();
  }
  let optional = false;
  let name;
  const m = rest.match(/^\[([^\]=]+)(?:=[^\]]*)?\]\s*(.*)$/s) ?? rest.match(/^(\S+)\s*(.*)$/s);
  if (m) {
    optional = rest.startsWith("[");
    name = m[1].trim();
    rest = m[2];
  } else {
    name = "";
  }
  rest = rest.replace(/^-\s*/, "");
  const isRest = type?.startsWith("...") ?? false;
  if (isRest) type = type.slice(3);
  return { type, name, optional, rest: isRest, description: rest.trim() };
}

function parseBlock(lines) {
  const entry = {
    name: undefined,
    description: "",
    params: [],
    examples: [],
    synonyms: [],
    returns: undefined,
    deprecated: undefined,
    noAutocomplete: false,
    memberof: undefined,
    superdirtOnly: false,
    alias: [],
  };
  const desc = [];
  let current = null; // { tag, lines }
  const flush = () => {
    if (!current) return;
    const text = current.lines.join("\n");
    switch (current.tag) {
      case "name":
        entry.name = text.trim();
        break;
      case "param":
        entry.params.push(parseParam(text.replace(/\n\s*/g, " ")));
        break;
      case "example": {
        const code = current.lines.join("\n").replace(/^\n+|\s+$/g, "");
        if (code) entry.examples.push(code);
        break;
      }
      case "synonyms":
        entry.synonyms.push(...text.split(/[,\s]+/).filter(Boolean));
        break;
      case "alias":
        entry.alias.push(...text.split(/[,\s]+/).filter(Boolean));
        break;
      case "returns":
      case "return":
        entry.returns = text.trim();
        break;
      case "deprecated":
        entry.deprecated = text.trim() || "deprecated";
        break;
      case "noAutocomplete":
        entry.noAutocomplete = true;
        break;
      case "memberof":
        entry.memberof = text.trim();
        break;
      case "superdirtOnly":
      case "superDirtOnly":
        entry.superdirtOnly = true;
        break;
    }
    current = null;
  };
  for (const line of lines) {
    const m = line.match(/^@(\w+)\s?(.*)$/);
    if (m) {
      flush();
      current = { tag: m[1], lines: m[2] ? [m[2]] : [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      desc.push(line);
    }
  }
  flush();
  entry.description = desc.join("\n").replace(/^\n+|\s+$/g, "");
  return entry;
}

/** Name(s) defined by the code right after a doc comment. */
function subjectNames(code) {
  code = code.replace(/^(\s|\/\/[^\n]*\n)*/, "");
  let m;
  if ((m = code.match(/^export\s+const\s*\{([^}]*)\}\s*=/))) {
    return m[1].split(",").map((s) => s.trim().split(/\s*:\s*/).pop()).filter(Boolean);
  }
  if ((m = code.match(/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/))) return [m[1]];
  if ((m = code.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/))) return [m[1]];
  if ((m = code.match(/^Pattern\.prototype\.(\w+)\s*=/))) return [m[1]];
  if ((m = code.match(/^(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/))) return [m[1]]; // class method
  if ((m = code.match(/^(?:get\s+)(\w+)\s*\(/))) return [m[1]];
  return [];
}

/** @returns {DocEntry[]} */
export function parseDocBlocks(file, text) {
  const out = [];
  const re = /\/\*\*[\s\S]*?\*\//g;
  let m;
  while ((m = re.exec(text))) {
    if (m[0].startsWith("/***")) continue;
    const entry = parseBlock(cleanBlock(m[0]));
    const subjects = subjectNames(text.slice(m.index + m[0].length, m.index + m[0].length + 400));
    if (!entry.name) entry.name = subjects[0];
    if (!entry.name) continue;
    // `export const { a, b } = register([...])` documents b as a synonym of a
    for (const s of subjects) if (s !== entry.name && !entry.synonyms.includes(s)) entry.subjectSynonyms = [...(entry.subjectSynonyms ?? []), s];
    entry.file = file;
    out.push(entry);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter lists from the AST
// ─────────────────────────────────────────────────────────────────────────────

/** @typedef {{ name: string, rest: boolean, optional: boolean }} SrcParam */

function paramsOf(fn) {
  return fn.parameters.map((p) => ({
    name: ts.isIdentifier(p.name) ? p.name.text : "options",
    rest: !!p.dotDotDotToken,
    optional: !!p.initializer || !!p.questionToken,
  }));
}

const isFn = (n) => n && (ts.isFunctionExpression(n) || ts.isArrowFunction(n));

function stringsOf(node) {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isArrayLiteralExpression(node)) return node.elements.filter(ts.isStringLiteralLike).map((e) => e.text);
  return [];
}

/**
 * @returns {{ registered: Map<string, SrcParam[]>, functions: Map<string, SrcParam[]>, methods: Map<string, SrcParam[]>, aliases: Map<string, string> }}
 *   registered: register()/stepRegister() callbacks (last param is the pattern)
 *   functions: exported/top-level functions and arrow consts
 *   methods: Pattern class methods and Pattern.prototype.x = function assignments
 *   aliases: `export const a = b` / `Pattern.prototype.a = Pattern.prototype.b` (a → b)
 */
export function parseSignatures(files) {
  const registered = new Map();
  const functions = new Map();
  const methods = new Map();
  const aliases = new Map();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^(register|stepRegister)$/.test(node.expression.text)) {
        const [names, fn] = node.arguments;
        if (names && isFn(fn)) for (const n of stringsOf(names)) if (!registered.has(n)) registered.set(n, paramsOf(fn));
      }
      if (ts.isFunctionDeclaration(node) && node.name && node.parent === sf) {
        if (!functions.has(node.name.text)) functions.set(node.name.text, paramsOf(node));
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isFn(node.initializer)) {
        if (!functions.has(node.name.text)) functions.set(node.name.text, paramsOf(node.initializer));
      }
      // export const timecat = stepcat;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isIdentifier(node.initializer)) {
        if (!aliases.has(node.name.text)) aliases.set(node.name.text, node.initializer.text);
      }
      // Pattern.prototype.steps = Pattern.prototype.pace;
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        /^Pattern\.prototype\.\w+$/.test(node.left.getText(sf)) &&
        /^Pattern\.prototype\.\w+$/.test(node.right.getText(sf))
      ) {
        const a = node.left.getText(sf).split(".").pop();
        if (!aliases.has(a)) aliases.set(a, node.right.getText(sf).split(".").pop());
      }
      if (ts.isClassDeclaration(node) && node.name?.text === "Pattern") {
        for (const member of node.members) {
          if ((ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member)) && member.name && ts.isIdentifier(member.name)) {
            methods.set(member.name.text, paramsOf(member));
          }
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        ts.isPropertyAccessExpression(node.left.expression) &&
        node.left.expression.getText(sf) === "Pattern.prototype" &&
        isFn(node.right)
      ) {
        if (!methods.has(node.left.name.text)) methods.set(node.left.name.text, paramsOf(node.right));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { registered, functions, methods, aliases };
}

/** All JSDoc entries across the source files, keyed by documented name (first one wins). */
export function parseDocs(files) {
  /** @type {Map<string, DocEntry>} */
  const docs = new Map();
  /** @type {Map<string, string>} synonym → documented name */
  const synonymOf = new Map();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const entry of parseDocBlocks(file, text)) {
      const existing = docs.get(entry.name);
      // Prefer the richer block when a name is documented twice
      if (!existing || (!existing.examples.length && entry.examples.length)) docs.set(entry.name, entry);
      for (const s of [...entry.synonyms, ...entry.alias, ...(entry.subjectSynonyms ?? [])]) {
        if (!synonymOf.has(s)) synonymOf.set(s, entry.name);
      }
    }
  }
  return { docs, synonymOf };
}

/**
 * @returns {(name: string) => { doc?: DocEntry, aliasOf?: string }} resolves a name's doc entry,
 *   following @synonyms and source aliases (`export const timecat = stepcat`).
 */
export function docLookup(docs, synonymOf, aliases) {
  return (name) => {
    if (docs.has(name)) return { doc: docs.get(name), aliasOf: undefined };
    const main = synonymOf.get(name) ?? aliases.get(name);
    if (main && docs.has(main)) return { doc: docs.get(main), aliasOf: main };
    const main2 = main && synonymOf.get(main);
    if (main2 && docs.has(main2)) return { doc: docs.get(main2), aliasOf: main2 };
    return { doc: undefined, aliasOf: main };
  };
}
