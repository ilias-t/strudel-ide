// Completions inside strings (src/ui/complete/values.ts): what the list holds for each kind of
// string, over the fake live registry (test/fixtures/complete/sound-map.ts) and the real theory.json.
// Run: node --test test/complete-values.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stringContextAt } from "../src/ui/complete/context.ts";
import { valueItems, type ValueEnv, type ValueItem } from "../src/ui/complete/values.ts";
import type { Theory } from "../src/ui/complete/types.ts";
import { fakeRegistry } from "./fixtures/complete/sound-map.ts";

const theory = JSON.parse(readFileSync(new URL("../src/catalog/theory.json", import.meta.url), "utf8")) as Theory;
const reg = fakeRegistry();
const env: ValueEnv = { registry: reg, theory };

/** "|" marks the caret; the list as Monaco shows it with nothing typed: by sortText */
function list(src: string, e: ValueEnv = env) {
  const at = src.indexOf("|");
  const text = src.slice(0, at) + src.slice(at + 1);
  const ctx = stringContextAt(text, at);
  assert.ok(ctx, `no string context in ${src}`);
  const out = valueItems(ctx, at, e);
  const sorted = [...out.items].sort((a, b) => (a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : 0));
  return { ...out, sorted, text, at, labels: sorted.map((i) => i.label) };
}

const byLabel = (items: ValueItem[], label: string) => {
  const it = items.find((i) => i.label === label);
  assert.ok(it, `no ${label} in ${items.map((i) => i.label).slice(0, 30).join(" ")}`);
  return it;
};
const sounds = (items: ValueItem[]) => items.filter((i) => i.kind === "sound");
const operators = (items: ValueItem[]) => items.filter((i) => i.kind === "operator");

describe("sounds", () => {
  test('a space in s("bd |"): registered sounds only, with counts and kinds; accepting replaces only the token', () => {
    const { items, at } = list('s("bd |")');
    const names = new Set(sounds(items).map((i) => i.label));
    assert.deepEqual([...names].sort(), [...reg.unbanked()].sort());
    assert.ok(!names.has("rolandtr909_bd"), "bank keys need their bank");
    const bd = byLabel(items, "bd");
    assert.equal(bd.detail, " ×8");
    assert.equal(bd.description, "kick");
    assert.deepEqual(bd.range, { start: at, end: at });
    assert.equal(bd.insertEnd, at);
    assert.deepEqual(bd.strudel, { sound: "bd" });
    assert.equal(byLabel(items, "piano").description, "keys · pitched");
    assert.equal(byLabel(items, "piano").detail ?? "", "", "no variant count for a pitched sample");
    assert.equal(byLabel(items, "sawtooth").description, "synth");
    assert.deepEqual(byLabel(items, "sawtooth").strudel, { sound: "sawtooth", pitched: true });
  });

  test('s("bd h|h"): the range is the token, the insert range ends at the caret', () => {
    const { items, text, at } = list('s("bd h|h sd")');
    const hh = byLabel(items, "hh");
    assert.equal(text.slice(hh.range.start, hh.range.end), "hh");
    assert.equal(hh.insertEnd, at);
  });

  test("the track's name ranks fitting kinds first, then drums, then the rest", () => {
    const hats = list('const hats = s("|");');
    assert.equal(reg.kind(sounds(hats.sorted)[0].label), "hat");
    const kick = list('const x = { kick: s("|") };');
    assert.equal(reg.kind(sounds(kick.sorted)[0].label), "kick");
    const plain = list('s("|")');
    const first = sounds(plain.sorted)[0];
    assert.equal(reg.kind(first.label), "kick", "drums first without a hint");
    const order = sounds(plain.sorted).map((i) => i.label);
    assert.ok(order.indexOf("hh") < order.indexOf("piano"));
    const pads = list('const pads = s("|");');
    assert.ok(["keys", "organ", "strings", "synth", "wavetable", "wind"].includes(reg.kind(sounds(pads.sorted)[0].label)!));
  });

  test('with a bank: only that machine' + 's parts, each with its own count', () => {
    const { items } = list('s("bd |").bank("TR909")');
    assert.deepEqual(sounds(items).map((i) => i.label).sort(), [...reg.bankParts("TR909")].sort());
    const bd = byLabel(items, "bd");
    assert.equal(bd.detail, " ×4");
    assert.deepEqual(bd.strudel, { sound: "bd", bank: "TR909" });
    // a const bank
    const c = list('const D = "RolandTR808";\ns("|").bank(D)');
    assert.deepEqual(sounds(c.items).map((i) => i.label).sort(), [...reg.bankParts("RolandTR808")].sort());
  });

  test('bd: → the real variant numbers, 0 … 7 (0 … 3 on a TR909)', () => {
    const { items, labels } = list('s("bd:|")');
    assert.deepEqual(labels, ["0", "1", "2", "3", "4", "5", "6", "7"]);
    assert.deepEqual(byLabel(items, "3").strudel, { sound: "bd", n: 3 });
    assert.equal(byLabel(items, "3").description, "bd:3");
    const tr = list('s("bd:|").bank("RolandTR909")');
    assert.deepEqual(tr.labels, ["0", "1", "2", "3"]);
    assert.deepEqual(byLabel(tr.items, "2").strudel, { sound: "bd", bank: "RolandTR909", n: 2 });
    assert.deepEqual(list('s("nope:|")').labels, []);
  });

  test("while samples load: a first row says how far", () => {
    const loading = { registry: fakeRegistry({ ready: false }), theory, loading: { count: 412, total: 1510 } };
    const out = list('s("bd |")', loading);
    assert.equal(out.sorted[0].kind, "loading");
    assert.equal(out.sorted[0].label, "loading samples…");
    assert.equal(out.sorted[0].detail, " (412 of ~1500)");
    assert.equal(out.sorted[0].strudel, undefined);
    assert.equal(out.incomplete, true, "re-query as sounds arrive");
    assert.equal(list('s("bd |")').items.some((i) => i.kind === "loading"), false);
    assert.equal(list('s("bd |")').incomplete, false);
  });

  test("a pitched sound's preview plays the chain's scale root", () => {
    const { items } = list('n("0 2").scale("D:minor").s("|")');
    assert.deepEqual(byLabel(items, "piano").strudel, { sound: "piano", pitched: true, note: "D" });
    assert.deepEqual(byLabel(items, "bd").strudel, { sound: "bd" });
  });

  test("sound rows carry the preview hint for the details pane", () => {
    const { items } = list('s("|")', { ...env, previewHint: "⌥P to hear sounds as you browse" });
    assert.match(byLabel(items, "cp").documentation!, /\*\*cp\*\* · clap · 2 variants/);
    assert.match(byLabel(items, "cp").documentation!, /⌥P to hear sounds as you browse/);
  });
});

describe("banks", () => {
  test('.bank("|") after s("bd ~ cp"): only machines with every part (41 of 71), aliases after canonical names', () => {
    const { sorted } = list('s("bd ~ cp").bank("|")');
    const all = reg.banks();
    const fits = all.filter((b) => b.parts.includes("bd") && b.parts.includes("cp"));
    assert.deepEqual(sorted.map((i) => i.label).sort(), fits.map((b) => b.name).sort());
    const canonical = sorted.filter((i) => !i.detail);
    assert.equal(canonical.length, fits.filter((b) => b.name === b.canonical).length);
    assert.equal(canonical.length, 41);
    assert.equal(all.filter((b) => b.name === b.canonical).length, 71);
    // canonical names first, aliases after
    const firstAlias = sorted.findIndex((i) => !!i.detail);
    assert.ok(firstAlias >= canonical.length);
    const tr = byLabel(sorted, "TR909");
    assert.equal(tr.detail, " → RolandTR909");
    assert.equal(byLabel(sorted, "RolandTR909").description, `${reg.bankParts("RolandTR909").length} parts`);
    assert.deepEqual(byLabel(sorted, "RolandTR909").strudel, { sound: "bd", bank: "RolandTR909" });
  });

  test("none fits: every machine, each saying what it lacks", () => {
    const { sorted } = list('s("bd zzpart").bank("|")');
    assert.equal(sorted.length, reg.banks().length);
    for (const i of sorted) assert.match(i.description!, /^no (bd, )?zzpart$/);
  });
});

describe("notes, scales, chords, the rest", () => {
  test('mini("c |").note(): pitch classes; after a letter its notes with octaves, c3 first', () => {
    const { labels } = list('mini("c |").note()');
    assert.deepEqual(labels.slice(0, 5), ["c", "c#", "db", "d", "d#"]);
    const e = list('note("e|")');
    assert.equal(e.labels[0], "e3");
    for (const o of [1, 2, 4, 5, 6]) assert.ok(e.labels.includes(`e${o}`));
    assert.ok(e.labels.indexOf("e3") < e.labels.indexOf("e1"));
  });

  test('.scale("|") → roots that type the colon and reopen the list', () => {
    const { sorted } = list('n("0").scale("|")');
    assert.deepEqual(sorted.slice(0, 3).map((i) => i.label), ["C:", "C#:", "Db:"]);
    assert.ok(sorted.every((i) => i.retrigger && i.insertText.endsWith(":")));
  });

  test('.scale("C:|") → the types, common first, multi-word ones with colons', () => {
    const { sorted, at } = list('n("0").scale("C:|")');
    assert.equal(sorted.length, theory.scales.length);
    const common = theory.scales.filter((s) => s.common).map((s) => s.name);
    assert.deepEqual(sorted.slice(0, common.length).map((i) => i.label), common);
    const pent = byLabel(sorted, "minor pentatonic");
    assert.equal(pent.insertText, "minor:pentatonic");
    assert.equal(pent.filterText, "minor:pentatonic");
    assert.deepEqual(pent.range, { start: at, end: at });
    assert.match(byLabel(sorted, "minor").documentation!, /C D Eb F G Ab Bb/);
    // typing on: the range starts after the root
    const more = list('n("0").scale("C:minor:pe|")');
    const p2 = byLabel(more.sorted, "minor pentatonic");
    assert.equal(more.text.slice(p2.range.start, more.at), "minor:pe");
  });

  test('chord("|") → roots; chord("D|") → D and its iReal symbols', () => {
    assert.deepEqual(list('chord("|")').labels.slice(0, 3), ["C", "C#", "Db"]);
    const d = list('chord("<C^7 D|")');
    assert.ok(d.labels.includes("Dm7") && d.labels.includes("D^7") && d.labels.includes("D"));
    assert.match(byLabel(d.items, "Dm7").documentation!, /D F A C/);
  });

  test("vowels, voicing dictionaries, struct, n()", () => {
    const vowels = list('s("saw").vowel("|")').items.filter((i) => i.kind !== "operator");
    assert.deepEqual(vowels.map((i) => i.label), theory.vowels);
    assert.deepEqual(list('chord("C").dict("|")').labels, theory.voicingDicts);
    assert.deepEqual(list('s("bd").struct("|")').labels.slice(0, 4), ["x", "~", "t", "f"]);
    assert.deepEqual(list('n("0 |")').items.filter((i) => i.kind !== "operator"), [], "n(): syntax help only");
  });
});

describe("mini-notation help", () => {
  test("at a fresh step the list ends with ~ [ ] < > { } (snippets, at the caret)", () => {
    const { sorted, at } = list('s("bd |")');
    assert.deepEqual(sorted.slice(-4).map((i) => i.label), ["~", "[ ]", "< >", "{ }"]);
    const sub = byLabel(sorted, "[ ]");
    assert.equal(sub.snippet, true);
    assert.equal(sub.insertText, "[$0]");
    assert.deepEqual(sub.range, { start: at, end: at });
    assert.equal(sub.description, "mini-notation");
    assert.match(sub.documentation!, /strudel\.cc\/learn\/mini-notation\/#/);
    assert.equal(operators(list('s("bd:|")').items).length, 0, "not after a colon");
  });

  test("right after a complete value: the modifiers, at the caret", () => {
    const { sorted, at } = list('s("bd|")');
    assert.deepEqual(operators(sorted).map((i) => i.label), ["*2", "/2", "!", "@2", "?", ":", "(3,8)", ",", "|"]);
    for (const o of operators(sorted)) assert.deepEqual(o.range, { start: at, end: at });
    assert.equal(byLabel(sorted, ":").retrigger, true, "the variants come next");
    assert.equal(operators(list('s("bdd|")').items).length, 0, "not after an unknown word");
    assert.ok(!operators(list('note("c3|")').items).some((i) => i.label === ":"), "no variants for notes");
    assert.ok(operators(list('note("c3|")').items).some((i) => i.label === "*2"));
  });
});

test("fast: a sound list in a few milliseconds", () => {
  const src = 'const hats = s("bd hh |").gain(0.5);';
  const at = src.indexOf("|");
  const text = src.slice(0, at) + src.slice(at + 1);
  let best = Infinity;
  for (let batch = 0; batch < 5; batch++) {
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) valueItems(stringContextAt(text, at)!, at, env);
    best = Math.min(best, (performance.now() - t0) / 20);
  }
  console.log(`sound list: ${best.toFixed(2)} ms`);
  assert.ok(best < 5, `${best} ms`);
});
