// The method list after a dot (src/ui/complete/members.ts): TypeScript's entries re-ranked and
// labelled with completions.json: the chain's common methods first, aliases folded, the ones that
// don't work here at the bottom with their reason (never struck through).
// Run: node --test test/complete-members.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { callChainBefore } from "../src/ui/complete/context.ts";
import { AFTER_TOP, COMMON_RANK, compactRange, isPatternMemberList, memberDocLine, rankMembers, type TsEntry } from "../src/ui/complete/members.ts";
import type { CompletionsCatalog } from "../src/ui/discover/catalog.ts";

const catalog = JSON.parse(readFileSync(new URL("../src/catalog/completions.json", import.meta.url), "utf8")) as CompletionsCatalog;
const fns = catalog.functions;
/** The catalog's entry (not Object.prototype's toString) */
const meta = (n: string) => (Object.hasOwn(fns, n) ? fns[n] : undefined);

/** What TypeScript lists after `pattern.`: every catalog name, plus members the catalog doesn't know */
const ENTRIES: TsEntry[] = [
  ...Object.keys(fns).map((name) => ({ name, kind: "method", sortText: "11" })),
  { name: "toString", kind: "method", sortText: "11" },
  { name: "zzOldThing", kind: "method", sortText: "11", kindModifiers: "deprecated" },
];

/** "|" marks the caret */
function chainAt(src: string) {
  const at = src.indexOf("|");
  return callChainBefore(src.slice(0, at) + src.slice(at + 1), at);
}

const order = (src: string, typed = "", entries = ENTRIES) => {
  const list = rankMembers(entries, catalog, { chain: chainAt(src), typed });
  const rows = [...list.rows].sort((a, b) => (a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : 0));
  return { ...list, rows, names: rows.map((r) => r.label) };
};

test("callChainBefore: the chain a dot continues, up to its receiver", () => {
  assert.deepEqual(chainAt('s("bd").|')!.map((c) => c.name), ["s"]);
  assert.deepEqual(chainAt('s("bd").bank("X").ga|')!.map((c) => c.name), ["s", "bank"]);
  assert.deepEqual(chainAt('note("c")\n  .s("piano")\n  .|')!.map((c) => c.name), ["note", "s"]);
  assert.deepEqual(chainAt('s("bd").|.gain(1)')!.map((c) => c.name), ["s"]);
  assert.equal(chainAt('pat.|'), null);
  assert.equal(chainAt('s("bd")|'), null);
});

test('after s("bd").: the common methods songs use after s() first (the top of completions.json after.s), then the global rank', () => {
  const { names } = order('s("bd").|');
  const expected = catalog.after.s.filter((n) => fns[n]?.availability === "ok" && fns[n].rank < COMMON_RANK).slice(0, AFTER_TOP);
  assert.deepEqual(names.slice(0, expected.length), expected);
  // what that is today
  assert.deepEqual(names.slice(0, 6), ["gain", "bank", "hpf", "pan", "room", "lpf"]);
  // a niche control a few songs use a lot (ducking) does not jump the everyday ones
  const top = names.slice(0, 16);
  for (const n of ["note", "delay", "speed", "fast"]) assert.ok(top.includes(n), n + " in " + top.join(" "));
  for (const n of ["duckattack", "duckorbit", "duckdepth"]) assert.ok(!top.includes(n), n + " in " + top.join(" "));
});

test('after note("c").: s first, then what follows note() in songs', () => {
  const { names } = order('note("c").|');
  assert.deepEqual(names.slice(0, 5), ["s", "gain", "lpf", "sustain", "decay"]);
});

test("then the global rank, then names the catalog doesn't know, then the demoted ones", () => {
  const { names, rows } = order('s("bd").|');
  const after = catalog.after.s.filter((n) => fns[n]?.availability === "ok" && fns[n].rank < COMMON_RANK).slice(0, AFTER_TOP).length;
  // past the after list: global rank order (s n note … are the most used)
  const rest = names.slice(after).filter((n) => meta(n));
  const ranked = rest.filter((n) => meta(n)!.availability === "ok");
  const ranks = ranked.map((n) => fns[n].rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.deepEqual(ranked.slice(0, 3), ["s", "n", "note"]);
  // unknown names after every ranked one, demoted ones last
  const unknown = names.indexOf("toString");
  assert.ok(unknown > names.indexOf(ranked[ranked.length - 1]));
  const firstDemoted = names.findIndex((n) => meta(n) && meta(n)!.availability !== "ok");
  assert.ok(firstDemoted > unknown);
  assert.ok(names.slice(firstDemoted).every((n) => meta(n) && meta(n)!.availability !== "ok"));
  // with the reason, never the Deprecated tag
  const byName = (n: string) => rows.find((r) => r.label === n)!;
  assert.equal(byName("scope").description, "visuals");
  assert.equal(byName("squiz").description, "SuperDirt only");
  assert.equal(byName("midichan").description, "MIDI/OSC");
  assert.equal(byName("withValue").description, "internal");
  for (const r of rows) if (meta(r.label)) assert.equal(r.deprecated, false, r.label);
  assert.equal(byName("zzOldThing").deprecated, true, "TypeScript's own deprecation stays for names we don't know");
});

test("a method already in the chain loses its after-boost", () => {
  const { names } = order('s("bd").gain(0.5).|');
  assert.equal(names[0], "bank");
  assert.ok(names.indexOf("gain") >= AFTER_TOP, "gain falls back to its global rank");
});

test("no chain (an identifier receiver): the global rank", () => {
  assert.deepEqual(order('pat.|').names.slice(0, 5), ["s", "n", "note", "bank", "gain"]);
});

test("labels: range or best-known alias, category on the right", () => {
  const { rows } = order('s("bd").|');
  const lpf = rows.find((r) => r.label === "lpf")!;
  assert.equal(lpf.detail, " 20–20k Hz");
  assert.equal(lpf.description, "effects");
  const s = rows.find((r) => r.label === "s")!;
  assert.equal(s.detail, " sound");
  assert.equal(compactRange({ min: 0, max: 1.5 }), "0–1.5");
  assert.equal(compactRange({ min: 20, max: 1500, unit: "Hz" }), "20–1.5k Hz");
  assert.equal(compactRange({ min: 0, unit: "s" }), "≥0 s");
  assert.equal(compactRange(undefined), undefined);
});

test("aliases fold under their target; typing one that only fits the alias shows it, and asks again", () => {
  const plain = order('s("bd").|');
  assert.ok(!plain.names.includes("cutoff"));
  assert.ok(!plain.names.includes("sound"), "sound folds under s");
  assert.equal(plain.folded, true, "something folded: Monaco must re-query as you type");
  const cuto = order('s("bd").cuto|', "cuto");
  const row = cuto.rows.find((r) => r.label === "cutoff")!;
  assert.ok(row);
  assert.equal(row.detail, " → lpf");
  assert.equal(row.insertText, "cutoff");
  // a word that fits the target too keeps the alias folded
  assert.ok(!order('s("bd").l|', "l").names.includes("lp"));
  // nothing to fold: no re-query
  const few: TsEntry[] = ["lpf", "gain", "toString"].map((name) => ({ name, kind: "method", sortText: "11" }));
  assert.equal(order('s("bd").|', "", few).folded, false);
});

test("isPatternMemberList: a member list that holds Pattern methods", () => {
  assert.equal(isPatternMemberList({ isMemberCompletion: true, entries: ENTRIES }, catalog), true);
  assert.equal(isPatternMemberList({ isMemberCompletion: false, entries: ENTRIES }, catalog), false);
  assert.equal(isPatternMemberList({ isMemberCompletion: true, entries: [{ name: "length", kind: "property", sortText: "11" }] }, catalog), false);
});

test("the details pane's line: category, full range, aliases, the strudel.cc link", () => {
  assert.equal(memberDocLine("lpf", catalog), "effects · 20–20000 Hz · also cutoff, ctf, lp · [strudel.cc ↗](https://strudel.cc/learn/effects/#lpf)");
  assert.match(memberDocLine("scope", catalog)!, /^visuals: no sound here · visual/);
  assert.equal(memberDocLine("notAThing", catalog), undefined);
});

test("cheap: ranking ~800 entries well under a frame", () => {
  const chain = chainAt('s("bd").|');
  let best = Infinity;
  for (let b = 0; b < 5; b++) {
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) rankMembers(ENTRIES, catalog, { chain, typed: "" });
    best = Math.min(best, (performance.now() - t0) / 10);
  }
  console.log(`member ranking: ${best.toFixed(2)} ms for ${ENTRIES.length} entries`);
  assert.ok(best < 8, `${best} ms`);
});
