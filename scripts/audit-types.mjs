// Audits the Strudel type declarations against the real runtime.
//
// Loads @strudel/core, mini, tonal, webaudio (+ draw) in Node exactly like @strudel/web's
// initStrudel() does, lists the globals and Pattern.prototype members, parses the .d.ts files
// with the TypeScript compiler API, and reports:
//   - public runtime API missing from the declarations
//   - declarations that don't exist at runtime (phantoms)
//   - kind mismatches (e.g. `silence` declared as a function but it is a Pattern; getters declared as methods)
//   - String.prototype members declared but absent at runtime
//   - JSDoc / @example coverage
//
// Usage:
//   node scripts/audit-types.mjs                 # audit src/strudel*.d.ts
//   node scripts/audit-types.mjs old.d.ts ...    # audit other declaration files (e.g. a git revision)
//   --verbose   list every name, including globals excluded by policy
//   --strict    exit 1 on missing public API, phantoms or kind mismatches
//   --quiet     one line when everything matches (full report otherwise)

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { runtimeGlobals, runtimePatternMethods, mini } from "./lib/strudel-runtime.mjs";
import { sourceFiles, parseDocs, parseSignatures, docLookup } from "./lib/strudel-source.mjs";
import { globalPolicy } from "./lib/type-overrides.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const strict = args.includes("--strict");
let declFiles = args.filter((a) => !a.startsWith("--"));
if (!declFiles.length) {
  declFiles = readdirSync(join(root, "src"))
    .filter((f) => /^strudel.*\.d\.ts$/.test(f))
    .map((f) => join(root, "src", f));
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime
// ─────────────────────────────────────────────────────────────────────────────

const globals = runtimeGlobals();
const methods = runtimePatternMethods();
methods.set("play", { name: "play", kind: "method" }); // added by @strudel/web in the browser
const files = sourceFiles(join(root, "node_modules"));
const { docs, synonymOf } = parseDocs(files);
const docFor = docLookup(docs, synonymOf, parseSignatures(files).aliases);

const publicGlobals = new Map();
const excluded = [];
for (const g of globals.values()) {
  const p = globalPolicy(g, { doc: docFor(g.name).doc, isMethodTwin: methods.has(g.name) });
  if (p.public) publicGlobals.set(g.name, g);
  else excluded.push(`${g.name} — ${p.reason}`);
}
const publicMethods = new Map([...methods].filter(([n]) => !n.startsWith("_") || n === "_steps"));

mini.miniAllStrings();

// ─────────────────────────────────────────────────────────────────────────────
// Declarations
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Map<string, {kind: "function"|"const"|"var", jsdoc: boolean, example: boolean}>} */
const declGlobals = new Map();
/** @type {Map<string, {kind: "method"|"property", jsdoc: boolean, example: boolean}>} */
const declMethods = new Map();
const declString = new Set();

function docInfo(node) {
  const docsOf = ts.getJSDocCommentsAndTags(node);
  const jsdoc = docsOf.length > 0;
  const example = ts.getJSDocTags(node).some((t) => t.tagName.text === "example");
  return { jsdoc, example };
}
function mergeDecl(map, name, info) {
  const prev = map.get(name);
  map.set(name, prev ? { ...prev, jsdoc: prev.jsdoc || info.jsdoc, example: prev.example || info.example } : info);
}

for (const file of declFiles) {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      mergeDecl(declGlobals, stmt.name.text, { kind: "function", ...docInfo(stmt) });
    } else if (ts.isVariableStatement(stmt)) {
      const kind = stmt.declarationList.flags & ts.NodeFlags.Const ? "const" : "var";
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) mergeDecl(declGlobals, d.name.text, { kind, ...docInfo(stmt) });
      }
    } else if (ts.isInterfaceDeclaration(stmt) && (stmt.name.text === "Pattern" || stmt.name.text === "Signal" || stmt.name.text === "String")) {
      for (const m of stmt.members) {
        if (!m.name || !(ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) continue;
        const name = m.name.text;
        if (stmt.name.text === "String") {
          declString.add(name);
          continue;
        }
        if (stmt.name.text === "Signal" && declMethods.has(name)) continue;
        mergeDecl(declMethods, name, { kind: ts.isMethodSignature(m) ? "method" : "property", ...docInfo(m) });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff
// ─────────────────────────────────────────────────────────────────────────────

const missingGlobals = [...publicGlobals.keys()].filter((n) => !declGlobals.has(n)).sort();
const phantomGlobals = [...declGlobals.keys()].filter((n) => !globals.has(n)).sort();
const missingMethods = [...publicMethods.keys()].filter((n) => !declMethods.has(n)).sort();
const phantomMethods = [...declMethods.keys()].filter((n) => !methods.has(n)).sort();
const phantomString = [...declString].filter((n) => typeof ""[n] === "undefined").sort();

const kindMismatches = [];
for (const [name, d] of declGlobals) {
  const g = globals.get(name);
  if (!g) continue;
  if (g.kind === "pattern" && d.kind === "function") kindMismatches.push(`${name}: declared as a function, but it is a Pattern constant`);
  if (g.kind !== "pattern" && d.kind !== "function" && typeof g.kind === "string" && /function|curried|control/.test(g.kind))
    kindMismatches.push(`${name}: declared as a ${d.kind}, but it is a function`);
}
for (const [name, d] of declMethods) {
  const m = methods.get(name);
  if (!m) continue;
  if (m.kind === "getter" && d.kind === "method" && !/^(set|keep|keepif|add|sub|mul|div|mod|pow|log2|band|bor|bxor|blshift|brshift|lt|gt|lte|gte|eq|eqt|ne|net|and|or|func)$/.test(name))
    kindMismatches.push(`.${name}: declared as a method, but it is a getter (property)`);
  if (m.kind !== "getter" && d.kind === "property") kindMismatches.push(`.${name}: declared as a property, but it is a method`);
}

const count = (map, key) => [...map.values()].filter((v) => v[key]).length;
const declaredPublicGlobals = [...publicGlobals.keys()].filter((n) => declGlobals.has(n)).length;
const declaredPublicMethods = [...publicMethods.keys()].filter((n) => declMethods.has(n)).length;

const list = (xs, max = verbose ? Infinity : 40) =>
  xs.length ? "\n    " + xs.slice(0, max).join(", ") + (xs.length > max ? `, … (+${xs.length - max}, --verbose)` : "") : "";

const problems = missingGlobals.length + phantomGlobals.length + missingMethods.length + phantomMethods.length + phantomString.length + kindMismatches.length;
const quiet = args.includes("--quiet");
if (quiet && !problems) {
  console.log(`✅ types match the runtime: ${declaredPublicGlobals} globals, ${declaredPublicMethods} Pattern members declared`);
  process.exit(0);
}

console.log(`Declarations: ${declFiles.map((f) => f.replace(root + "/", "")).join(", ")}
Runtime: ${globals.size} globals (${publicGlobals.size} public, ${excluded.length} excluded by policy), ${publicMethods.size} Pattern members (excluding _internal)

Globals
  declared:            ${declGlobals.size} (${declaredPublicGlobals}/${publicGlobals.size} public runtime globals)
  with JSDoc:          ${count(declGlobals, "jsdoc")}  (with @example: ${count(declGlobals, "example")})
  missing (public):    ${missingGlobals.length}${list(missingGlobals)}
  phantom (no runtime):${phantomGlobals.length}${list(phantomGlobals)}

Pattern members
  declared:            ${declMethods.size} (${declaredPublicMethods}/${publicMethods.size} runtime members)
  with JSDoc:          ${count(declMethods, "jsdoc")}  (with @example: ${count(declMethods, "example")})
  missing:             ${missingMethods.length}${list(missingMethods)}
  phantom (no runtime):${phantomMethods.length}${list(phantomMethods)}

String.prototype members declared but absent at runtime: ${phantomString.length}${list(phantomString)}

Kind mismatches: ${kindMismatches.length}${kindMismatches.length ? "\n    " + kindMismatches.join("\n    ") : ""}`);

if (verbose) console.log(`\nExcluded by policy (${excluded.length}):\n    ${excluded.sort().join("\n    ")}`);

if (strict && problems) {
  console.error(`\n✗ ${problems} problem(s) — regenerate with \`npm run gen:types\` or fix scripts/lib/type-overrides.mjs`);
  process.exit(1);
}
