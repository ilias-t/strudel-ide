// The palette's fuzzy matcher (src/ui/discover/fuzzy.ts).
// Run: node --test test/discover-fuzzy.test.ts

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fuzzyMatch, rank, type Candidate } from "../src/ui/discover/fuzzy.ts";

const score = (q: string, text: string) => {
  const m = fuzzyMatch(q, text);
  assert.ok(m, `"${q}" should match "${text}"`);
  return m.score;
};

describe("fuzzyMatch", () => {
  test("no match when the query isn't a subsequence of the text", () => {
    assert.equal(fuzzyMatch("xyz", "lpf"), null);
    assert.equal(fuzzyMatch("fpl", "lpf"), null);
  });

  test("case-insensitive, with the matched indices", () => {
    assert.deepEqual(fuzzyMatch("LPF", "lpf")?.indices, [0, 1, 2]);
    assert.deepEqual(fuzzyMatch("lf", "lpf")?.indices, [0, 2]);
  });

  test("spaces in the query are ignored, so words can be skipped", () => {
    assert.deepEqual(fuzzyMatch("jump b", "jump to section b")?.indices, [0, 1, 2, 3, 16]);
  });

  test("picks the best alignment, not the first one: a consecutive run at a word start", () => {
    assert.deepEqual(fuzzyMatch("hh", "hihat hh")?.indices, [6, 7]);
  });

  test("a prefix beats the same letters mid-word", () => {
    assert.ok(score("lp", "lpf") > score("lp", "clip"));
  });

  test("an exact match beats a longer prefix", () => {
    assert.ok(score("rev", "rev") > score("rev", "reverb"));
  });

  test("camelCase humps are word starts", () => {
    assert.ok(score("gap", "fastGap") > score("gap", "fastgap"));
    assert.deepEqual(fuzzyMatch("fg", "fastGap")?.indices, [0, 4]);
  });

  test("a letter-to-digit change is a word start (TR|909)", () => {
    assert.deepEqual(fuzzyMatch("909", "RolandTR909")?.indices, [8, 9, 10]);
    assert.ok(score("909", "RolandTR909") > score("909", "a1909"));
  });

  test("_ and - start words", () => {
    assert.ok(score("od", "kick_od") > score("od", "kickod"));
    assert.ok(score("od", "kick-od") > score("od", "kickod"));
  });

  test("consecutive letters beat scattered ones", () => {
    assert.ok(score("sine", "sine") > score("sine", "sawtooth in noise"));
    assert.ok(score("bank", "bank") > score("bank", "b_a_n_k"));
  });

  test("an empty query matches everything with no indices", () => {
    assert.deepEqual(fuzzyMatch("", "anything"), { score: 0, indices: [] });
  });
});

interface Item extends Candidate {
  id: string;
}

describe("rank", () => {
  test("by score, best first, and leaves out what doesn't match", () => {
    const items: Item[] = [{ id: "a", name: "clip" }, { id: "b", name: "lpf" }, { id: "c", name: "hpf" }];
    assert.deepEqual(rank(items, "lp").map((r) => r.item.id), ["b", "a"]);
  });

  test("equal scores: the lower kind weight first (actions and songs before the catalog)", () => {
    const items: Item[] = [
      { id: "fn", name: "stop", weight: 4 },
      { id: "action", name: "stop", weight: 0 },
    ];
    assert.deepEqual(rank(items, "stop").map((r) => r.item.id), ["action", "fn"]);
  });

  test("equal scores and weights: the shorter name first, then input order", () => {
    const items: Item[] = [
      { id: "long", name: "lpfx" },
      { id: "short", name: "lpf" },
      { id: "twin", name: "lpf" },
    ];
    assert.deepEqual(rank(items, "lp").map((r) => r.item.id), ["short", "twin", "long"]);
  });

  test("matches alternative names (synonyms, aliases) and says which one matched", () => {
    const items: Item[] = [
      { id: "lpf", name: "lpf", alts: ["cutoff", "ctf"] },
      { id: "coarse", name: "coarse" },
    ];
    const [first] = rank(items, "cutoff");
    assert.equal(first.item.id, "lpf");
    assert.equal(first.via, "cutoff");
    assert.deepEqual(first.indices, [], "no highlight in the name for an alt match");
  });

  test("a match on the name beats the same match on an alternative name", () => {
    const items: Item[] = [
      { id: "alias", name: "RolandTR909", alts: ["TR909"] },
      { id: "name", name: "TR909" },
    ];
    assert.deepEqual(rank(items, "tr909").map((r) => r.item.id), ["name", "alias"]);
    assert.equal(rank(items, "tr909")[0].via, undefined);
  });

  test("phrases match like alternative names, a little lower, and say they're phrases", () => {
    const items: Item[] = [
      { id: "lpf", name: "lpf", phrases: ["darker"] },
      { id: "dark", name: "x", alts: ["darker"] },
    ];
    const [first, second] = rank(items, "darker");
    assert.equal(first.item.id, "dark");
    assert.equal(first.field, "alt");
    assert.equal(second.via, "darker");
    assert.equal(second.field, "phrase");
  });

  test("description words: a whole word or a word's start finds the item, well below a name or an alternative name", () => {
    const items: Item[] = [
      { id: "room", name: "room", words: ["sets", "the", "level", "of", "reverb"] },
      { id: "rev", name: "reverbish" },
      { id: "alt", name: "x", alts: ["reverb"] },
    ];
    const ranked = rank(items, "reverb");
    assert.deepEqual(ranked.map((r) => r.item.id), ["alt", "rev", "room"]);
    assert.equal(ranked[2].field, "words");
    assert.deepEqual(ranked[2].indices, []);
    assert.equal(rank(items, "rev")[2]?.item.id, "room", "a word's start");
    assert.deepEqual(rank([items[0]], "everb"), [], "not inside a word");
    assert.deepEqual(rank([items[0]], "re"), [], "not for one or two letters");
  });

  test("every query word has to start a description word", () => {
    const items: Item[] = [{ id: "hpf", name: "hpf", words: ["applies", "the", "high", "pass", "filter"] }];
    assert.equal(rank(items, "high filter").length, 1);
    assert.equal(rank(items, "high-pass").length, 1);
    assert.equal(rank(items, "high reverb").length, 0);
  });

  test("a real word match beats a fuzzy fit scattered across a long title", () => {
    const items: Item[] = [
      { id: "crash", name: "Crash every 4 bars" },
      { id: "room", name: "room", words: ["sets", "the", "level", "of", "reverb"] },
    ];
    assert.deepEqual(rank(items, "reverb").map((r) => r.item.id), ["room", "crash"]);
  });

  test("caps the results", () => {
    const items: Item[] = Array.from({ length: 200 }, (_, i) => ({ id: String(i), name: `sound${i}` }));
    assert.equal(rank(items, "s", { limit: 80 }).length, 80);
    assert.equal(rank(items, "s").length, 80, "80 by default");
  });

  test("an empty query keeps the input order", () => {
    const items: Item[] = [{ id: "b", name: "b" }, { id: "a", name: "a" }];
    assert.deepEqual(rank(items, "  ").map((r) => r.item.id), ["b", "a"]);
  });
});
