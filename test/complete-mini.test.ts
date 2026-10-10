// Mini-notation words with file offsets (src/ui/complete/mini.ts): what diagnostics check, word by word.
// Run: node --test test/complete-mini.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { soundWords, soundWordsWithOffsets } from "../src/ui/complete/mini.ts";

/** The words of `value` as [text, variant?] pairs */
const words = (value: string) => soundWordsWithOffsets(value, 0).map((w) => (w.variant === undefined ? w.text : `${w.text}:${w.variant}`));

test("offsets point at the words in the file", () => {
  const file = `const d = s("bd*2 [sd:3 hh]").bank("RolandTR909");`;
  const base = file.indexOf('"') + 1;
  const value = file.slice(base, file.indexOf('"', base));
  const ws = soundWordsWithOffsets(value, base);
  assert.deepEqual(
    ws.map((w) => w.text),
    ["bd", "sd", "hh"],
  );
  for (const w of ws) assert.equal(file.slice(w.start, w.end), w.text);
  assert.equal(ws[1].variant, 3);
  assert.equal(ws[0].variant, undefined);
});

test("rests, elongation and feet are not words", () => {
  assert.deepEqual(words("bd ~ - _ sd"), ["bd", "sd"]);
  assert.deepEqual(words("bd . sd sd . hh"), ["bd", "sd", "sd", "hh"]);
  assert.deepEqual(words("bd _ _ sd"), ["bd", "sd"]);
  assert.deepEqual(words("~ ~"), []);
});

test("numbers and operator arguments are skipped", () => {
  assert.deepEqual(words("bd*2 hh/2 cp!3 sd@2 rim?0.3 oh(3,8)"), ["bd", "hh", "cp", "sd", "rim", "oh"]);
  assert.deepEqual(words("bd(<3 5>,8,<0 2>) hh*<2 4> cp/[2 3]"), ["bd", "hh", "cp"]);
  assert.deepEqual(words("bd! bd!! sd? sd@ hh!3"), ["bd", "bd", "sd", "sd", "hh"]);
  assert.deepEqual(words("0 2 4 -1 .5 1e3"), []);
});

test("brackets, stacks, choices and polymeters", () => {
  assert.deepEqual(words("<a b>"), ["a", "b"]);
  assert.deepEqual(words("[a b]"), ["a", "b"]);
  assert.deepEqual(words("{a b}%4"), ["a", "b"]);
  assert.deepEqual(words("{a b c}%<4 8>"), ["a", "b", "c"]);
  assert.deepEqual(words("a,b"), ["a", "b"]);
  assert.deepEqual(words("a, b , c"), ["a", "b", "c"]);
  assert.deepEqual(words("a|b"), ["a", "b"]);
  assert.deepEqual(words("a . b"), ["a", "b"]);
  assert.deepEqual(words("[bd [sd sd]]*2, <hh oh>"), ["bd", "sd", "sd", "hh", "oh"]);
});

test("variants: only a plain integer after the colon", () => {
  assert.deepEqual(words("sd:3 bd:12 hh:<0 2> cp:1?"), ["sd:3", "bd:12", "hh", "cp:1"]);
  assert.deepEqual(words("bd:0*4"), ["bd:0"]);
});

test("names keep their inner punctuation", () => {
  assert.deepEqual(words("gm_acoustic_bass c#3 eb4 C^7 tr909_bd"), ["gm_acoustic_bass", "c#3", "eb4", "C^7", "tr909_bd"]);
});

test("half-typed strings never throw", () => {
  for (const v of ["bd*", "bd(3,", "[bd sd", "<a b", "bd:", "{a b}%", "bd(", "a .", "bd?", "@", "*", "(", ")", "]]", ":3"]) {
    assert.doesNotThrow(() => soundWordsWithOffsets(v, 5), v);
  }
  assert.deepEqual(words("[bd sd"), ["bd", "sd"]);
  assert.deepEqual(words("bd(3,"), ["bd"]);
});

test("soundWords keeps returning strings", () => {
  assert.deepEqual(soundWords("bd*2 [sd:3 hh]"), ["bd", "sd", "hh"]);
  assert.deepEqual(soundWords("RolandTR909"), ["RolandTR909"]);
});
