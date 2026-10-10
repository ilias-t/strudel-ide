// How much each function is used, for completions.json's `rank` and `after`. Two halves:
//
//   countUsage(sources, functions)  → the counts (scripts/lib/catalog/usage.json, a committed snapshot
//                                     refreshed by hand with `node scripts/gen-catalog.mjs --recount`,
//                                     so editing a song never makes the catalog stale)
//   buildRanking(usage, functions)  → { rank, after } from those counts and the CORE list below
//
// Counting uses the TypeScript parser, never a regex: a use is a call `name(…)` or `.name(…)` whose
// name is a catalog function. A plain `name(…)` (and a chain head) is skipped when the file declares
// that name itself (`x => x.add(1)`, `const swing = …`): it's the file's own, not Strudel's.
//
// A chain is a(…).b(…).c(…) read from its head: the call or value it starts from (`s("bd")`,
// `note(…)`, `mini(…)`, `sine`). Arguments hold chains of their own (`.lpf(sine.range(…))`).

import ts from "typescript";
import { byCodePoint, sortKeys } from "./util.mjs";

/** Where counted code comes from (usage.json keeps each kind apart, so weights can change without a recount) */
export const SOURCE_KINDS = ["songs", "starters", "snippets", "examples"];

/**
 * The curated head of the global rank, in order: what a method list should open with even when songs
 * rarely use it (fast, struct, jux, every, sometimes, off, ply, euclid…). Seeded from the design's
 * prototype list, checked against the counts.
 */
export const CORE = `s n note bank gain lpf hpf room delay pan speed fast slow struct euclid every sometimes jux rev
  scale chord voicing arp off ply degradeBy vowel crush shape distort attack decay sustain release legato clip
  orbit postgain velocity segment range add sub mul iter chop striate begin end loopAt fm vib phaser
  roomsize delaytime delayfeedback mask stack cat seq sound lpq lpenv superimpose echo`
  .trim()
  .split(/\s+/);

/** after: how many methods to keep per head, and how many chains a head needs to get a list */
const AFTER_TOP = 20;
const AFTER_MIN_USES = 10;

/**
 * What a call counts for, by source kind. strudel.cc's examples weigh a quarter: they document
 * strudel.cc's idiom (s("bd").room(…) demos), not how songs here chain, but they still cover heads
 * songs rarely start from (mini(…).note()).
 */
export const WEIGHTS = { songs: 1, starters: 1, snippets: 1, examples: 0.25 };

/** Names a file declares itself: variables, parameters, functions, classes, imports */
function declaredNames(sf) {
  const names = new Set();
  const bind = (name) => {
    if (!name) return;
    if (ts.isIdentifier(name)) names.add(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
      for (const el of name.elements) if (!ts.isOmittedExpression(el)) bind(el.name);
  };
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) bind(node.name);
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node)) && node.name) bind(node.name);
    else if (ts.isImportClause(node) && node.name) bind(node.name);
    else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) bind(node.name);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/** a(…).b.c(…) → its head (an identifier) and the names called on it, in order; null when the head isn't a name */
function chainOf(node) {
  const methods = [];
  let cur = node;
  for (;;) {
    if (ts.isCallExpression(cur)) cur = cur.expression;
    else if (ts.isPropertyAccessExpression(cur)) {
      if (ts.isCallExpression(cur.parent) && cur.parent.expression === cur) methods.unshift(cur.name.text);
      cur = cur.expression;
    } else if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
    else break;
  }
  return ts.isIdentifier(cur) ? { head: cur.text, methods } : null;
}

const bump = (obj, key, n = 1) => (obj[key] = (obj[key] ?? 0) + n);

/**
 * Counts calls per source kind.
 * @param {{ kind: string, code: string }[]} sources
 * @param {{ name: string, kind: string }[]} functions
 * @returns {{ usage: Record<string, Record<string, number>>, after: Record<string, Record<string, Record<string, number>>> }}
 *   usage[kind][name] = calls; after[kind][head][method] = calls of method in chains that start at head
 */
export function countUsage(sources, functions) {
  const names = new Set(functions.map((f) => f.name));
  /** heads: things a chain can start from (a global or a value, not a method-only name) */
  const heads = new Set(functions.filter((f) => f.kind !== "method").map((f) => f.name));
  const usage = Object.fromEntries(SOURCE_KINDS.map((k) => [k, {}]));
  const after = Object.fromEntries(SOURCE_KINDS.map((k) => [k, {}]));
  for (const { kind, code } of sources) {
    if (!usage[kind]) throw new Error(`countUsage: unknown source kind "${kind}"`);
    const sf = ts.createSourceFile("source.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const own = declaredNames(sf);
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? (own.has(callee.text) ? undefined : callee.text) : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
        if (name && names.has(name)) bump(usage[kind], name);
      }
      // a chain's outermost node: count its methods once, against its head
      const isChainPart = (n) => ts.isCallExpression(n) || ts.isPropertyAccessExpression(n);
      if (isChainPart(node) && !(node.parent && isChainPart(node.parent) && node.parent.expression === node)) {
        const chain = chainOf(node);
        if (chain && heads.has(chain.head) && !own.has(chain.head)) {
          for (const m of chain.methods) if (names.has(m)) bump((after[kind][chain.head] ??= {}), m);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  const sortDeep = (o) => sortKeys(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? v : sortDeep(v)])));
  return { usage: sortDeep(usage), after: sortDeep(after) };
}

/** Weighted sum over the source kinds ({ [kind]: { [name]: n } } → { [name]: score }) */
function total(byKind) {
  const out = {};
  for (const k of SOURCE_KINDS) for (const [name, n] of Object.entries(byKind[k] ?? {})) bump(out, name, n * WEIGHTS[k]);
  return out;
}

/**
 * rank: 0 = most used, every function gets one. Score = calls over all sources; for CORE[i] it is at
 * least floor + (top + 1 − floor) × (1 − i / CORE.length), where top is the highest count and floor
 * the 20th-highest. Ties: code point.
 * after: per head with a weighted AFTER_MIN_USES method calls in its chains, its AFTER_TOP
 * most-called methods (ties: code point). Both use WEIGHTS; names no longer in the catalog are skipped.
 * @param {{ usage: Record<string, Record<string, number>>, after: Record<string, Record<string, Record<string, number>>> }} counts
 * @param {{ name: string }[]} functions
 */
export function buildRanking(counts, functions) {
  const names = functions.map((f) => f.name);
  const known = new Set(names);
  const usage = total(counts.usage);
  const sorted = names.map((n) => usage[n] ?? 0).sort((a, b) => b - a);
  const top = sorted[0] ?? 0;
  const floor = sorted[Math.min(19, sorted.length - 1)] ?? 0;
  const coreAt = new Map(CORE.map((n, i) => [n, i]));
  const score = (n) => {
    const used = usage[n] ?? 0;
    const i = coreAt.get(n);
    // CORE[0] scores just above the most-used name, the last CORE name at the 20th-highest count,
    // linearly in between: the core opens the list in its curated order, and well-used names
    // (range, mask, orbit…) interleave with its tail
    return i === undefined ? used : Math.max(used, floor + (top + 1 - floor) * (1 - i / CORE.length));
  };
  const order = [...names].sort((a, b) => score(b) - score(a) || byCodePoint(a, b));
  const rank = Object.fromEntries(order.map((n, i) => [n, i]));

  const after = {};
  const heads = new Set(SOURCE_KINDS.flatMap((k) => Object.keys(counts.after[k] ?? {})));
  for (const head of [...heads].sort(byCodePoint)) {
    if (!known.has(head)) continue;
    const methods = {};
    for (const [m, n] of Object.entries(total(Object.fromEntries(SOURCE_KINDS.map((k) => [k, counts.after[k]?.[head] ?? {}])))))
      if (known.has(m)) methods[m] = n;
    const uses = Object.values(methods).reduce((a, b) => a + b, 0);
    if (uses < AFTER_MIN_USES) continue;
    after[head] = Object.entries(methods)
      .sort(([a, x], [b, y]) => y - x || byCodePoint(a, b))
      .slice(0, AFTER_TOP)
      .map(([m]) => m);
  }
  return { rank, after };
}
