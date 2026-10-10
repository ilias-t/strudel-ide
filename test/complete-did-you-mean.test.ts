// "Did you mean" for unknown sounds, banks and scales (src/ui/complete/did-you-mean.ts).
// Run: node --test test/complete-did-you-mean.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { didYouMean, distance } from "../src/ui/complete/did-you-mean.ts";
import { SOUND_KEYS, fakeRegistry, soundsCatalog } from "./fixtures/complete/sound-map.ts";

test("distance: Damerau (adjacent swaps cost one), case-insensitive", () => {
  assert.equal(distance("bd", "bd"), 0);
  assert.equal(distance("bdd", "bd"), 1);
  assert.equal(distance("pinao", "piano"), 1);
  assert.equal(distance("BD", "bd"), 0);
  assert.equal(distance("", "abc"), 3);
  assert.equal(distance("kitten", "sitting"), 3);
});

test("the closest first, at most n", () => {
  assert.deepEqual(didYouMean("bdd", ["sd", "bd", "hh", "bass"], 3), ["bd"]);
  assert.deepEqual(didYouMean("pianno", ["piano", "pan", "organ"]), ["piano"]);
  assert.equal(didYouMean("hh", ["hh2", "hh3", "hh4", "hh5"], 2).length, 2);
});

test("ties keep the caller's order (it puts the preferred kind first)", () => {
  assert.deepEqual(didYouMean("sx", ["sd", "sh"]), ["sd", "sh"]);
  assert.deepEqual(didYouMean("sx", ["sh", "sd"]), ["sh", "sd"]);
});

test("a tie-break rank wins over the caller's order, but never over distance", () => {
  const rank = (c: string) => (c === "sh" ? 0 : 1);
  assert.deepEqual(didYouMean("sx", ["sd", "sh"], 3, rank), ["sh", "sd"]);
  assert.deepEqual(didYouMean("sdd", ["sh", "sd"], 3, rank), ["sd"]);
});

test("nothing close → nothing (no wild guesses)", () => {
  assert.deepEqual(didYouMean("xylophone", ["bd", "sd", "hh"]), []);
  assert.deepEqual(didYouMean("zq", ["bd", "sd"]), []);
});

test("real names: sounds and banks", () => {
  const r = fakeRegistry();
  assert.equal(didYouMean("bdd", r.unbanked())[0], "bd");
  assert.equal(didYouMean("pianno", r.unbanked())[0], "piano");
  assert.equal(didYouMean("sawtoth", r.unbanked())[0], "sawtooth");
  assert.equal(didYouMean("bdd", r.bankParts("TR909"))[0], "bd");
  const banks = r.banks().map((b) => b.name);
  assert.equal(didYouMean("RolandTR90", banks)[0], "RolandTR909");
  assert.equal(didYouMean("TR8O8", banks)[0], "TR808");
  assert.ok(Object.keys(soundsCatalog().banks).length > 50);
});

test("sub-millisecond over every key of the live map (~1500)", () => {
  const names = [...SOUND_KEYS];
  assert.ok(names.length > 1400);
  didYouMean("warm", names);
  // the best of a few batches: a busy machine (e2e running alongside) shouldn't fail it
  let per = Infinity;
  for (let batch = 0; batch < 5; batch++) {
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) didYouMean(i % 2 ? "pianno" : "RolandTR90", names);
    per = Math.min(per, (performance.now() - t0) / 50);
  }
  assert.ok(per < 1, `${per.toFixed(3)} ms per call`);
});
