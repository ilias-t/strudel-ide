// Generates src/strudel.generated.d.ts: ambient declarations (with JSDoc + examples) for every
// Strudel global and Pattern method that exists at runtime under @strudel/web.
//
//   what exists      → the runtime (scripts/lib/strudel-runtime.mjs, loads the real modules)
//   docs & arity     → Strudel's source JSDoc + AST (scripts/lib/strudel-source.mjs)
//   tuned signatures → scripts/lib/type-overrides.mjs
//
// Usage: node scripts/gen-strudel-types.mjs   (then `npm run check`)

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeGlobals, runtimePatternMethods } from "./lib/strudel-runtime.mjs";
import { sourceFiles, parseDocs, parseSignatures, docLookup } from "./lib/strudel-source.mjs";
import {
  globalPolicy,
  CONTROL_TYPES,
  METHOD_SIGNATURES,
  GLOBAL_SIGNATURES,
  EXTRA_NOTES,
  EXTRA_DOCS,
} from "./lib/type-overrides.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = join(root, "src/strudel.generated.d.ts");

const files = sourceFiles(join(root, "node_modules"));
const { docs, synonymOf } = parseDocs(files);
const src = parseSignatures(files);
const globals = runtimeGlobals();
const methods = runtimePatternMethods();

// Methods @strudel/web adds in the browser (web.mjs can't be imported in Node)
methods.set("play", { name: "play", kind: "method", arity: 0 });

// ─────────────────────────────────────────────────────────────────────────────
// Docs
// ─────────────────────────────────────────────────────────────────────────────

const docFor = docLookup(docs, synonymOf, src.aliases);

const cleanText = (s) =>
  s
    .replace(/\{@link\s+(?:Pattern#)?([\w.]+)\s*\}/g, "`$1`")
    .replace(/\*\//g, "*\\/")
    .trim();

/**
 * @param {string} name
 * @param {string[]} paramNames names used in the emitted signature (for @param lines)
 */
function jsdoc(name, paramNames, indent, { partial = false } = {}) {
  const { doc, aliasOf } = docFor(name);
  const lines = [];
  if (EXTRA_NOTES[name]) lines.push(EXTRA_NOTES[name], "");
  if (aliasOf && aliasOf !== name) lines.push(`Alias of \`${aliasOf}\`.`, "");
  if (partial) {
    lines.push(
      `Curried form: \`${name}(${paramNames.join(", ")})\` returns a function that applies it to a pattern, e.g. \`.every(4, ${name}(...))\` or \`.jux(${name}(...))\`.`,
      "",
    );
  }
  if (doc?.description) lines.push(cleanText(doc.description));
  else if (EXTRA_DOCS[name]) lines.push(EXTRA_DOCS[name]);
  const synonyms = doc ? [doc.name, ...doc.synonyms, ...(doc.subjectSynonyms ?? [])].filter((s) => s !== name) : [];
  const uniq = [...new Set(synonyms)].filter((s) => s !== aliasOf);
  if (uniq.length) lines.push("", `Synonyms: ${uniq.map((s) => `\`${s}\``).join(", ")}`);
  if (doc?.superdirtOnly) lines.push("", "_SuperDirt only — has no effect with the built-in WebAudio output._");
  if (doc) {
    // @param lines: match by position (signature names may differ from upstream names)
    const docParams = doc.params.filter((p) => p.name && !/^pat(tern)?$/.test(p.name) || doc.params.length === paramNames.length);
    paramNames.forEach((pn, i) => {
      const dp = docParams[i];
      if (dp?.description) lines.push(`@param ${pn} ${cleanText(dp.description)}`);
    });
    for (const ex of doc.examples) {
      lines.push("@example", ...cleanText(ex).split("\n"));
    }
    if (doc.deprecated) lines.push(`@deprecated ${doc.deprecated === "deprecated" ? "" : doc.deprecated}`.trim());
  }
  if (!lines.length) return "";
  while (lines[0] === "") lines.shift();
  const flat = lines.flatMap((l) => l.split("\n"));
  return `${indent}/**\n${flat.map((l) => `${indent} *${l ? ` ${l}` : ""}`).join("\n")}\n${indent} */\n`;
}

const hasDoc = (name) => !!docFor(name).doc || !!EXTRA_DOCS[name];

// ─────────────────────────────────────────────────────────────────────────────
// Type inference from JSDoc types / param names
// ─────────────────────────────────────────────────────────────────────────────

const RESERVED = new Set(["function", "in", "default", "new", "delete", "var", "let", "class", "this", "switch", "case", "return", "with", "enum", "for", "if", "do", "else", "const", "void", "typeof", "instanceof", "while", "break", "continue", "try", "catch", "finally", "throw", "export", "import", "super", "extends", "yield", "await", "static", "package", "interface", "private", "protected", "public", "implements", "arguments", "eval"]);
const safeName = (n, i) => {
  n = (n || `arg${i}`).replace(/[^\w$]/g, "");
  if (!n || /^\d/.test(n)) n = `arg${i}`;
  if (RESERVED.has(n)) n = n === "function" ? "func" : `${n}_`;
  return n;
};

const FUNC_NAMES = /^(func|fn|f|function|transform|funcs|fns|callback)$/i;

function mapDocType(type, paramName) {
  const t = (type ?? "").replace(/\s+/g, " ").trim();
  const lower = t.toLowerCase();
  if (!t) return FUNC_NAMES.test(paramName ?? "") ? "PatternFunc" : "NumberInput";
  if (lower.includes("function")) return lower.endsWith("[]") ? "PatternFunc[]" : "PatternFunc";
  if (/^(number|integer|fraction|offset|octave)( \| (pattern|fraction|number|string))*$/.test(lower) || /^pattern \| number$/.test(lower) || lower === "string | number")
    return "NumberInput";
  if (/^string( \| pattern)?$/.test(lower)) return "StringInput";
  if (lower === "pattern") return "PatternInput";
  if (lower === "boolean") return "boolean | NumberInput";
  if (lower === "object" || lower === "!object") return "Record<string, any>";
  if (lower.endsWith("[]") || lower === "array" || lower.includes("array")) return "any[]";
  return "any";
}

/**
 * Build typed params for a function from source params (+ optional trailing pattern param removed)
 * and doc params.
 * @returns {{ sig: string, names: string[] }}
 */
function buildParams(srcParams, doc, { dropLast = false, isControl = false } = {}) {
  let sp = srcParams ? [...srcParams] : undefined;
  if (sp && dropLast) sp = sp.slice(0, -1);
  const dps = doc?.params ?? [];
  const count = sp ? sp.length : dps.length;
  const names = [];
  const parts = [];
  for (let i = 0; i < count; i++) {
    const s = sp?.[i];
    const d = dps[i];
    const name = safeName(d?.name && !d.name.includes(".") ? d.name : s?.name, i);
    names.push(name);
    const rest = s?.rest ?? d?.rest ?? false;
    const optional = !rest && ((s?.optional ?? false) || (d?.optional ?? false));
    const type = mapDocType(d?.type, s?.name ?? d?.name);
    parts.push(rest ? `...${name}: ${type.includes(" ") ? `(${type})` : type}[]` : `${name}${optional ? "?" : ""}: ${type}`);
  }
  // A required param may not follow an optional one
  let seenOptional = false;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].includes("?:")) seenOptional = true;
    else if (seenOptional && !parts[i].startsWith("...")) parts[i] = parts[i].replace(/^(\w+):/, "$1?:");
  }
  return { sig: parts.join(", "), names };
}

const paramNamesOf = (sig) =>
  // "(a: X, b?: Y)" → ["a", "b"]; good enough for our hand-written signatures
  [...sig.replace(/^<[^>]*>/, "").matchAll(/(?:^\(|, )(?:\.\.\.)?(\w+)\??:/g)].map((m) => m[1]);

// ─────────────────────────────────────────────────────────────────────────────
// Pattern interface
// ─────────────────────────────────────────────────────────────────────────────

const stats = { methods: 0, methodsDoc: 0, globals: 0, globalsDoc: 0, excluded: [], untyped: [] };
const out = [];
const I = "  ";

out.push(`// ════════════════════════════════════════════════════════════════════════════
// AUTO-GENERATED by scripts/gen-strudel-types.mjs — do not edit by hand.
// Source of truth: the Strudel runtime + JSDoc in node_modules/@strudel/* and superdough.
// Hand-tuned signatures live in scripts/lib/type-overrides.mjs; helper types (NumberInput,
// PatternFunc, ...) live in src/strudel.d.ts; sound/scale names in src/strudel.sounds.generated.d.ts.
//
// Note: doc examples come from strudel.cc, where the transpiler turns "strings" into patterns, so
// they sometimes call methods on string literals ("0 2".add(..)). In this IDE strings have no
// pattern methods — wrap them first: n("0 2").add(...), or seq/mini("0 2").
// ════════════════════════════════════════════════════════════════════════════
`);

out.push("interface Pattern {");
const methodNames = [...methods.keys()].filter((n) => !n.startsWith("_") || n === "_steps").sort((a, b) => a.localeCompare(b));
for (const name of methodNames) {
  const m = methods.get(name);
  const { doc } = docFor(name);
  let line;
  let names = [];
  const override = METHOD_SIGNATURES[name];
  if (m.kind === "getter") {
    const type = override ?? "any";
    if (!override) stats.untyped.push(`.${name}`);
    out.push(jsdoc(name, [], I) + `${I}readonly ${name}: ${type};`);
    stats.methods++;
    if (hasDoc(name)) stats.methodsDoc++;
    continue;
  }
  if (override) {
    for (const sig of [override].flat()) {
      names = paramNamesOf(sig);
      out.push(jsdoc(name, names, I) + `${I}${name}${sig};`);
    }
  } else if (m.kind === "control") {
    // Control values are reified, and upstream @param types are often too narrow
    // ({string} on numeric controls), so default to NumberInput (number | string | Pattern).
    const type = CONTROL_TYPES[name] ?? "NumberInput";
    const pname = safeName(doc?.params?.[0]?.name ?? "value", 0);
    names = [pname];
    out.push(jsdoc(name, names, I) + `${I}${name}(${pname}?: ${type}): Pattern;`);
  } else {
    const reg = src.registered.get(name) ?? src.registered.get(src.aliases.get(name) ?? "");
    let built;
    if (reg) built = buildParams(reg, doc, { dropLast: true });
    else if (src.methods.has(name)) built = buildParams(src.methods.get(name), doc);
    else if (doc) built = buildParams(undefined, doc, { dropLast: doc.params.at(-1)?.name === "pat" });
    else {
      built = { sig: "...args: any[]", names: [] };
      stats.untyped.push(`.${name}`);
    }
    names = built.names;
    line = `${I}${name}(${built.sig}): Pattern;`;
    out.push(jsdoc(name, names, I) + line);
  }
  stats.methods++;
  if (hasDoc(name)) stats.methodsDoc++;
}
out.push("}\n");

// ─────────────────────────────────────────────────────────────────────────────
// Globals
// ─────────────────────────────────────────────────────────────────────────────

const declaredGlobals = [];
for (const g of [...globals.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  const { name, kind } = g;
  const { doc } = docFor(name);
  const isMethodTwin = methods.has(name);
  const policy = globalPolicy(g, { doc, isMethodTwin });
  if (!policy.public) {
    stats.excluded.push(`${name} (${policy.reason})`);
    continue;
  }
  stats.globals++;
  if (hasDoc(name)) stats.globalsDoc++;
  declaredGlobals.push(name);

  if (kind === "pattern") {
    out.push(jsdoc(name, [], "") + `declare const ${name}: Pattern;`);
    continue;
  }
  const override = GLOBAL_SIGNATURES[name];
  if (override) {
    for (const sig of [override].flat()) {
      const names = paramNamesOf(sig);
      const partial = /\): PatternFunc$/.test(sig) && names.length > 0;
      out.push(jsdoc(name, names, "", { partial }) + `declare function ${name}${sig};`);
    }
    continue;
  }
  if (kind === "control") {
    const type = CONTROL_TYPES[name] ?? "NumberInput";
    const pname = safeName(doc?.params?.[0]?.name ?? "value", 0);
    out.push(jsdoc(name, [pname], "") + `declare function ${name}(${pname}: ${type}): Pattern;`);
    continue;
  }
  const reg = src.registered.get(name) ?? src.registered.get(src.aliases.get(name) ?? "");
  if (reg || (isMethodTwin && METHOD_SIGNATURES[name]?.startsWith("("))) {
    // register()'d: global takes the method's args + the pattern last, and is curried
    let params, names;
    if (METHOD_SIGNATURES[name]?.startsWith("(")) {
      const msig = [METHOD_SIGNATURES[name]].flat()[0];
      params = msig.slice(1, msig.lastIndexOf("):"));
      names = paramNamesOf(msig);
    } else {
      ({ sig: params, names } = buildParams(reg, doc, { dropLast: true }));
    }
    if (params.includes("...")) {
      // variadic method (e.g. layer(...funcs)): global is (…, pat) only in principle; keep loose
      out.push(jsdoc(name, names, "") + `declare function ${name}(...args: any[]): Pattern;`);
      continue;
    }
    const sep = params ? ", " : "";
    const required = params.replace(/\?:/g, ":");
    out.push(jsdoc(name, [...names, "pat"], "") + `declare function ${name}(${required}${sep}pat: PatternInput): Pattern;`);
    if (params) {
      out.push(jsdoc(name, names, "", { partial: true }) + `declare function ${name}(${params}): PatternFunc;`);
    }
    continue;
  }
  const fnParams = src.functions.get(name) ?? src.functions.get(src.aliases.get(name) ?? "");
  if (fnParams || doc) {
    const { sig, names } = buildParams(fnParams, doc);
    const returns = /pattern/i.test(doc?.returns ?? "") || isMethodTwin || kind === "curried" ? "Pattern" : "any";
    out.push(jsdoc(name, names, "") + `declare function ${name}(${sig}): ${returns};`);
    continue;
  }
  stats.untyped.push(name);
  out.push(jsdoc(name, [], "") + `declare function ${name}(...args: any[]): any;`);
}

writeFileSync(outFile, out.join("\n") + "\n");

console.log(`wrote ${outFile.replace(root + "/", "")}`);
console.log(`  Pattern members: ${stats.methods} (${stats.methodsDoc} with JSDoc)`);
console.log(`  globals:         ${stats.globals} (${stats.globalsDoc} with JSDoc)`);
console.log(`  excluded:        ${stats.excluded.length} runtime globals (internal; see audit-types --verbose)`);
if (stats.untyped.length) console.log(`  untyped (any):   ${stats.untyped.join(", ")}`);
