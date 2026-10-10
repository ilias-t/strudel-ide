// The string-context scanner (src/ui/complete/context.ts) on real cases, and its latency on the biggest songs.
// Run: node --test test/complete-context.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stringContextAt, lex } from "../src/ui/complete/context.ts";

/** "|" marks the caret */
function ctx(src: string) {
  const at = src.indexOf("|");
  return stringContextAt(src.slice(0, at) + src.slice(at + 1), at);
}

test("s() and its token", () => {
  const c = ctx(`const k = s("bd sd [hh h|h]").gain(0.5);`)!;
  assert.equal(c.role, "sound");
  assert.equal(c.token.prefix, "h");
  assert.equal(c.token.text, "hh");
  assert.equal(c.token.before, " ");
});

test("variant after a colon", () => {
  const c = ctx(`s("bd:|")`)!;
  assert.equal(c.role, "sound");
  assert.equal(c.token.before, ":");
  assert.equal(c.token.head, "bd");
});

test(".bank sees the parts and a const bank", () => {
  const c = ctx(`const D = "RolandTR909";\ns("bd*4, ~ cp").bank("|")`)!;
  assert.equal(c.role, "bank");
  assert.deepEqual(c.soundsInChain, ["bd", "cp"]);
  const d = ctx(`const D = "RolandTR909";\ns("bd*4 s|").bank(D).gain(1)`)!;
  assert.equal(d.role, "sound");
  assert.deepEqual(d.banks, ["RolandTR909"]);
});

test("mini(…).note(): the role comes after the string", () => {
  const c = ctx(`mini("<c e g |>").note().s("piano")`)!;
  assert.equal(c.role, "note");
  assert.equal(c.roleFrom, "mini(…).note()");
  const multi = ctx(`mini("c e |")\n  .add(12)\n  .note()`)!;
  assert.equal(multi.role, "note");
});

test("scale, chord, vowel, struct, n", () => {
  assert.equal(ctx(`n("0 2 4").scale("C:m|")`)!.role, "scale");
  assert.equal(ctx(`n("0 2 4").scale("C:m|")`)!.token.head, "C");
  assert.equal(ctx(`chord("<C^7 D|>").voicing()`)!.role, "chord");
  assert.equal(ctx(`s("sawtooth").vowel("<a |>")`)!.role, "vowel");
  assert.equal(ctx(`note("c").struct("x ~ |")`)!.role, "struct");
  assert.equal(ctx(`n("0 |").s("bd")`)!.role, "number");
});

test("unclosed code while typing", () => {
  const c = ctx(`const x = s("bd |\nconst y = 1;`);
  assert.equal(c?.role, "sound");
  assert.equal(ctx(`const name = "Jy|nx";`), null); // not a call argument
  assert.equal(ctx(`foo({ a: "b|" })`), null);
});

test("stack(...).bank(): parts from nested s() strings", () => {
  const c = ctx(`stack(s("bd*4"), s("~ sd")).bank("|")`)!;
  assert.deepEqual(c.soundsInChain, ["bd", "sd"]);
});

test("latency on the biggest songs", () => {
  for (const id of ["tour", "jungle-pressure", "acid-rain"]) {
    const text = readFileSync(new URL(`../src/songs/${id}.ts`, import.meta.url), "utf8");
    const offsets: number[] = [];
    for (const t of lex(text)) if (t.kind === "str") offsets.push(t.start + 1);
    // cold (lex every call: a new text each keystroke)
    let t0 = performance.now();
    const N = 200;
    for (let i = 0; i < N; i++) stringContextAt(text + " ".repeat(i % 2), offsets[i % offsets.length]);
    const cold = (performance.now() - t0) / N;
    t0 = performance.now();
    let found = 0;
    for (const o of offsets) if (stringContextAt(text, o)) found++;
    const warm = (performance.now() - t0) / offsets.length;
    console.log(`${id}: ${text.length} chars, ${offsets.length} strings (${found} in calls), cold ${cold.toFixed(3)} ms, warm ${warm.toFixed(3)} ms`);
    assert.ok(cold < 5);
  }
});
