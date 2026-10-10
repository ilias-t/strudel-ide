// What an audition hands to superdough (src/ui/discover/audition-values.ts):
// a ▶ click is a bounded one-shot, a browse preview is quieter and shorter,
// pitched sounds play a note and drums never do.
//
// superdough plays a sample to its end unless the value carries `release`
// (or clip/loop): node_modules/superdough/sampler.mjs onTriggerSample. With
// `release` set, the voice stops at t + duration + release.
//
// Run: node --test test/discover-audition-values.test.ts

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AUDITION_ORBIT, AuditionBus } from "../src/ui/discover/audition-bus.ts";
import { DEFAULT_NOTE, PLAY, PREVIEW, previewsAllowed, soundValue } from "../src/ui/discover/audition-values.ts";

const db = (ratio: number) => 20 * Math.log10(ratio);
const near = (actual: number, expected: number, tolerance = 0.5) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual.toFixed(2)} dB, expected ${expected} dB ±${tolerance}`);

const click = (name: string, opts = {}, playing = false) => soundValue(name, opts, { playing });
const preview = (name: string, opts = {}, playing = false) => soundValue(name, { ...opts, preview: true }, { playing });

describe("loudness", () => {
  test("a preview is about 12 dB under a ▶ click", () => {
    near(db(Number(preview("bd").value.gain) / Number(click("bd").value.gain)), -12);
  });

  test("a preview drops 6 dB more while the song plays; a ▶ click doesn't", () => {
    near(db(Number(preview("bd", {}, true).value.gain) / Number(preview("bd").value.gain)), -6);
    near(db(Number(preview("bd", {}, true).value.gain) / Number(click("bd").value.gain)), -18);
    assert.equal(click("bd", {}, true).value.gain, click("bd").value.gain);
  });

  test("a ▶ click keeps today's level (0.8)", () => {
    assert.equal(click("bd").value.gain, 0.8);
  });
});

describe("length: every one-shot is bounded", () => {
  test("every value carries a release, so superdough doesn't play the whole sample", () => {
    for (const v of [click("bassdrum2"), preview("bassdrum2"), click("piano", { pitched: true }), preview("sawtooth", { pitched: true })]) {
      assert.equal(typeof v.value.release, "number");
      assert.ok(Number(v.value.release) > 0);
    }
  });

  test("a ▶ click lasts about 1–1.5 s, release included", () => {
    const { value, duration } = click("bassdrum2");
    const total = duration + Number(value.release);
    assert.ok(total >= 1 && total <= 1.5, `${total} s`);
    assert.equal(PLAY.duration, duration);
  });

  test("a preview lasts about 0.6 s with a short (~0.08 s) release", () => {
    const { value, duration } = preview("bassdrum2");
    assert.ok(duration <= 0.6 && duration >= 0.4, `${duration} s`);
    assert.ok(Number(value.release) >= 0.05 && Number(value.release) <= 0.12, `release ${String(value.release)}`);
    assert.equal(PREVIEW.duration, duration);
  });

  test("the record's bound is the same either way: duration + release, well under a long sample", () => {
    for (const v of [click("gong"), preview("gong")]) assert.ok(v.duration + Number(v.value.release) < 2);
  });
});

describe("notes", () => {
  test("pitched samples and synths play c3 (48) by default", () => {
    assert.equal(DEFAULT_NOTE, 48);
    assert.equal(click("piano", { pitched: true }).value.note, 48);
    assert.equal(preview("sawtooth", { pitched: true }).value.note, 48);
  });

  test("a preview plays the note it's given (the song's key root), as a number or a name", () => {
    assert.equal(preview("piano", { pitched: true, note: 50 }).value.note, 50);
    assert.equal(preview("piano", { pitched: true, note: "d3" }).value.note, "d3");
    assert.equal(preview("piano", { pitched: true, note: "Eb" }).value.note, "Eb");
  });

  test("a note that isn't one falls back to c3", () => {
    assert.equal(preview("piano", { pitched: true, note: "D:minor" }).value.note, 48);
    assert.equal(preview("piano", { pitched: true, note: Number.NaN }).value.note, 48);
    assert.equal(preview("piano", { pitched: true, note: "" }).value.note, 48);
  });

  test("drums never get a note, even when one is passed", () => {
    assert.equal("note" in click("bd").value, false);
    assert.equal("note" in preview("bd", { note: 50 }).value, false);
  });
});

describe("what's played", () => {
  test("the sound, its bank and its n pass through", () => {
    const { value } = click("sd", { bank: "RolandTR909", n: 2 });
    assert.equal(value.s, "sd");
    assert.equal(value.bank, "RolandTR909");
    assert.equal(value.n, 2);
    const plain = preview("bd").value;
    assert.equal("bank" in plain, false);
    assert.equal("n" in plain, false);
  });

  test("every sound audition shares one cut group, so a new one chokes one already sounding", () => {
    assert.ok(click("bd").value.cut != null);
    assert.equal(preview("piano", { pitched: true }).value.cut, click("bd").value.cut);
  });

  test("routing stays the bus's: on the audition orbit, in a cut group of the auditions' own", () => {
    const routed = new AuditionBus().route(preview("bd").value);
    assert.equal(routed.orbit, AUDITION_ORBIT);
    assert.match(String(routed.cut), /^audition:/);
    assert.equal(routed.release, preview("bd").value.release);
  });

  test("no orbit and no duration in the value: the bus routes it, superdough gets the duration as its own argument", () => {
    const { value } = click("bd");
    assert.equal("orbit" in value, false);
    assert.equal("duration" in value, false);
  });
});

describe("previewsAllowed()", () => {
  test("only when the setting is on and the pointer isn't coarse", () => {
    const fine = () => ({ matches: false });
    const coarse = () => ({ matches: true });
    assert.equal(previewsAllowed({ enabled: true, matchMedia: fine }), true);
    assert.equal(previewsAllowed({ enabled: false, matchMedia: fine }), false);
    assert.equal(previewsAllowed({ enabled: true, matchMedia: coarse }), false);
  });

  test("asks about a coarse pointer", () => {
    const asked: string[] = [];
    previewsAllowed({ enabled: true, matchMedia: (q) => (asked.push(q), { matches: false }) });
    assert.deepEqual(asked, ["(pointer: coarse)"]);
  });

  test("without matchMedia (Node), the setting decides", () => {
    assert.equal(previewsAllowed({ enabled: true, matchMedia: undefined }), true);
  });
});
