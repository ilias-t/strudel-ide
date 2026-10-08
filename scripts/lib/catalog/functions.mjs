// functions.json: Strudel's functions and Pattern methods, one entry per name, parsed from
// src/strudel.generated.d.ts with the TypeScript parser. Pure: takes the d.ts text.
//
// The d.ts declares a name up to three ways: a Pattern member (a method, or a property such as
// `readonly add: PatternOperator`), global overloads (`add(value, pat): Pattern` + the curried
// `add(value): PatternFunc`), or a `declare const` value (signals: sine, saw, perlin, ...).
// gen-strudel-types adds notes to the JSDoc ("Alias of `x`.", "Curried form: ...", "Synonyms: ...",
// "_SuperDirt only — ..._"); they are moved out of the description into fields here.

import ts from "typescript";
import { byCodePoint } from "./util.mjs";
import { ideExample } from "./examples.mjs";

const NOTE_ALIAS = /^Alias of `([^`]+)`\.$/;
const NOTE_CURRIED = /^Curried form: /;
const NOTE_SYNONYMS = /^Synonyms: (.*)$/;
const NOTE_SUPERDIRT = /^_SuperDirt only\b.*_$/;

/** Raw JSDoc text → lines without the comment frame (indentation after "* " kept) */
function jsDocLines(raw) {
  const body = raw.replace(/^\/\*\*/, "").replace(/\*\/$/, "");
  if (!body.includes("\n")) return [body.trim()]; // /** one line */
  return body
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, "").replace(/\s+$/, ""));
}

const trimBlank = (lines) => {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
};

/**
 * @typedef {{ description: string, aliasOf?: string, synonyms: string[], superdirtOnly: boolean,
 *   params: { name: string, description: string }[], examples: string[], deprecated?: string | true }} Doc
 */

/** @returns {Doc} */
function parseJsDoc(raw) {
  const lines = jsDocLines(raw);
  const doc = { description: "", synonyms: [], superdirtOnly: false, params: [], examples: [] };
  const descLines = [];
  /** @type {{ tag: string, lines: string[] }[]} */
  const tags = [];
  for (const line of lines) {
    const m = line.match(/^@(\w+)\s?(.*)$/);
    if (m) tags.push({ tag: m[1], lines: [m[2]] });
    else if (tags.length) tags[tags.length - 1].lines.push(line);
    else descLines.push(line);
  }

  const kept = [];
  for (const line of descLines) {
    const t = line.trim();
    let m;
    if ((m = t.match(NOTE_ALIAS))) doc.aliasOf = m[1];
    else if (NOTE_CURRIED.test(t)) continue;
    else if ((m = t.match(NOTE_SYNONYMS))) doc.synonyms.push(...[...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]));
    else if (NOTE_SUPERDIRT.test(t)) doc.superdirtOnly = true;
    else kept.push(line);
  }
  doc.description = trimBlank(kept)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  for (const { tag, lines: tl } of tags) {
    if (tag === "example") {
      const ex = trimBlank(tl).join("\n");
      if (ex) doc.examples.push(ex);
    } else if (tag === "param") {
      const [first, ...rest] = tl;
      const m = first.match(/^(?:\{[^}]*\}\s*)?\[?([\w$.]+)(?:=[^\]]*)?\]?\s*(?:-\s*)?(.*)$/);
      if (!m) continue;
      const description = trimBlank([m[2], ...rest].map((l) => l.trim())).join("\n");
      doc.params.push({ name: m[1], description });
    } else if (tag === "deprecated") {
      const text = trimBlank(tl).join(" ").trim();
      doc.deprecated = text || true;
    }
  }
  return doc;
}

const ABBREVIATIONS = /\b(e\.g|i\.e|etc|vs|approx|cf)\.$/i;

/** First sentence of the description's first paragraph, on one line */
export function firstSentence(description) {
  const para = description.split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, " ").trim();
  const re = /[.!?](?=\s|$)/g;
  let m;
  while ((m = re.exec(para))) {
    const upTo = para.slice(0, m.index + 1);
    if (!ABBREVIATIONS.test(upTo)) return upTo;
  }
  return para;
}

const oneLine = (text) => text.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/,\s*\)/g, ")").trim();

/**
 * @param {string} dtsText
 * @returns {Array<{ name: string, kind: "function" | "method" | "both" | "value", signatures: string[], summary: string,
 *   description: string, params: { name: string, description: string }[], examples: string[], synonyms: string[],
 *   aliasOf?: string, superdirtOnly?: true, deprecated?: string | true }>}
 */
export function buildFunctions(dtsText) {
  const sf = ts.createSourceFile("strudel.d.ts", dtsText, ts.ScriptTarget.Latest, true);
  /** @type {Map<string, { method: boolean, global: boolean, value: boolean, signatures: string[], docs: Doc[] }>} */
  const byName = new Map();

  const add = (name, where, signature, node) => {
    if (name.startsWith("_")) return; // internals (Pattern._steps)
    const entry = byName.get(name) ?? { method: false, global: false, value: false, signatures: [], docs: [] };
    byName.set(name, entry);
    entry[where] = true;
    entry.signatures.push(oneLine(signature));
    for (const jsDoc of node.jsDoc ?? []) entry.docs.push(parseJsDoc(sf.text.slice(jsDoc.pos, jsDoc.end)));
  };
  const text = (node) => sf.text.slice(node.getStart(sf), node.end).replace(/;$/, "");

  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === "Pattern") {
      for (const member of stmt.members) {
        if (!member.name || !ts.isIdentifier(member.name)) continue;
        const sig = text(member).replace(/^readonly\s+/, "");
        add(member.name.text, "method", "." + sig, member);
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      add(stmt.name.text, "global", text(stmt).replace(/^declare\s+function\s+/, ""), stmt);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        add(decl.name.text, "value", "const " + text(decl), stmt);
      }
    }
  }

  return [...byName.keys()].sort(byCodePoint).map((name) => {
    const e = byName.get(name);
    const kind = e.value ? "value" : e.method && e.global ? "both" : e.method ? "method" : "function";
    const primary = e.docs.find((d) => d.description || d.params.length || d.examples.length) ?? e.docs[0];
    const description = primary?.description ?? "";
    const examples = [...new Set(e.docs.flatMap((d) => d.examples).map(ideExample))];
    const synonyms = [...new Set(e.docs.flatMap((d) => d.synonyms))];
    const aliasOf = e.docs.find((d) => d.aliasOf)?.aliasOf;
    const deprecated = e.docs.find((d) => d.deprecated)?.deprecated;
    return {
      name,
      kind,
      signatures: e.signatures,
      summary: firstSentence(description),
      description,
      params: primary?.params ?? [],
      examples,
      synonyms,
      ...(aliasOf ? { aliasOf } : {}),
      ...(e.docs.some((d) => d.superdirtOnly) ? { superdirtOnly: true } : {}),
      ...(deprecated ? { deprecated } : {}),
    };
  });
}
