// Hovers on names inside strings (src/ui/complete/hover.ts): what they say, and what their ▶ plays.
// Run: node --test test/complete-hover.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stringContextAt } from "../src/ui/complete/context.ts";
import { hoverFor, PLAY_COMMAND, type PlayArg } from "../src/ui/complete/hover.ts";
import type { Theory } from "../src/ui/complete/types.ts";
import { previewable } from "../src/ui/discover/previewable.ts";
import { fakeRegistry } from "./fixtures/complete/sound-map.ts";

const theory = JSON.parse(readFileSync(new URL("../src/catalog/theory.json", import.meta.url), "utf8")) as Theory;
const reg = fakeRegistry();
const env = { registry: reg, theory, banksWith: (p: string) => reg.banksWith(p) };

/** "|" marks the mouse */
function hover(src: string) {
  const at = src.indexOf("|");
  const text = src.slice(0, at) + src.slice(at + 1);
  const ctx = stringContextAt(text, at);
  return ctx ? hoverFor(ctx, at, env) : null;
}

/** The ▶ links in a hover, decoded */
function plays(md: string): PlayArg[] {
  const out: PlayArg[] = [];
  const re = new RegExp(`\\(command:${PLAY_COMMAND.replace(".", "\\.")}\\?([^)]+)\\)`, "g");
  for (const m of md.matchAll(re)) out.push(...(JSON.parse(decodeURIComponent(m[1])) as PlayArg[]));
  return out;
}

test("a sound: kind, variants, ▶ play, the drum machines that have it, strudel.cc", () => {
  const h = hover('s("bd c|p")')!;
  assert.equal(h.markdown.split("\n")[0], "**cp** · clap · 2 variants (cp:0–cp:1)");
  assert.match(h.markdown, /\[▶ play\]\(command:strudel\.play\?/);
  assert.match(h.markdown, /in 41 drum machines/);
  assert.match(h.markdown, /\[sounds on strudel\.cc ↗\]\(https:\/\/strudel\.cc\/learn\/samples\/\)/);
  assert.deepEqual(plays(h.markdown), [{ type: "sound", sound: "cp" }]);
  const text = 's("bd cp")';
  assert.equal(text.slice(h.range.start, h.range.end), "cp");
});

test("under a bank: the machine's own count, ▶ plays it on that machine", () => {
  const h = hover('s("b|d").bank("RolandTR909")')!;
  assert.equal(h.markdown.split("\n")[0], "**bd** · RolandTR909 · kick · 4 variants (bd:0–bd:3)");
  assert.doesNotMatch(h.markdown, /drum machines/);
  assert.deepEqual(plays(h.markdown), [{ type: "sound", sound: "bd", bank: "RolandTR909" }]);
});

test("synths, pitched samples, a variant; nothing for what isn't registered", () => {
  const saw = hover('s("saw|tooth")')!;
  assert.equal(saw.markdown.split("\n")[0], "**sawtooth** · synth");
  assert.deepEqual(plays(saw.markdown), [{ type: "sound", sound: "sawtooth", pitched: true }]);
  assert.match(hover('s("pia|no")')!.markdown, /^\*\*piano\*\* · keys · pitched/);
  const v = hover('s("bd:|3")')!;
  assert.equal(v.markdown.split("\n")[0], "**bd:3** · kick · file 4 of 8");
  assert.deepEqual(plays(v.markdown), [{ type: "sound", sound: "bd", n: 3 }]);
  assert.equal(hover('s("bd|d")'), null);
  assert.equal(hover('s("bd |~")'), null);
});

test("a note: MIDI and Hz; ▶ on the chain's sound (else a triangle)", () => {
  const h = hover('note("c|3 e")')!;
  assert.equal(h.markdown.split("\n")[0], "**c3** · MIDI 48 · 130.8 Hz");
  assert.deepEqual(plays(h.markdown), [{ type: "sound", sound: "triangle", pitched: true, note: "c3" }]);
  const piano = hover('note("a|4").s("piano")')!;
  assert.match(piano.markdown, /\*\*a4\*\* · MIDI 69 · 440\.0 Hz/);
  assert.deepEqual(plays(piano.markdown), [{ type: "sound", sound: "piano", pitched: true, note: "a4" }]);
});

test("a scale: its notes; ▶ plays it up", () => {
  const h = hover('n("0 2").scale("C:mi|nor")')!;
  assert.equal(h.markdown.split("\n")[0], "**C minor**: C D Eb F G Ab Bb");
  const [p] = plays(h.markdown);
  assert.deepEqual(p, { type: "code", code: 'note("48 50 51 53 55 56 58 60").s("triangle")', label: "C minor" });
  assert.ok(previewable((p as { code: string }).code));
  const pent = hover('n("0").scale("D:minor:pentat|onic").s("piano")')!;
  assert.equal(pent.markdown.split("\n")[0], "**D minor pentatonic**: D F G A C");
  assert.match((plays(pent.markdown)[0] as { code: string }).code, /\.s\("piano"\)$/);
});

test("a chord: its notes; ▶ plays it", () => {
  const h = hover('chord("<C^7 Dm|7>").voicing()')!;
  assert.equal(h.markdown.split("\n")[0], "**Dm7**: D F A C");
  const [p] = plays(h.markdown);
  assert.deepEqual(p, { type: "code", code: 'note("[50,53,57,60]").s("triangle")', label: "Dm7" });
  assert.ok(previewable((p as { code: string }).code));
});

test("a scale or chord with mini-notation modifiers after it: still its hover", () => {
  assert.equal(hover('n("0").scale("C:min|or*2")')?.markdown.split("\n")[0], "**C minor**: C D Eb F G Ab Bb");
  const h = hover('chord("<C^7 Dm|7@3>")')!;
  assert.equal(h.markdown.split("\n")[0], "**Dm7**: D F A C");
  const text = 'chord("<C^7 Dm7@3>")';
  assert.equal(text.slice(h.range.start, h.range.end), "Dm7");
});

test("a bank: its parts; ▶ plays bd on it", () => {
  const h = hover('s("sd").bank("TR9|09")')!;
  const parts = reg.bankParts("TR909");
  assert.equal(h.markdown.split("\n")[0], `**RolandTR909** (as TR909) · ${parts.length} parts: ${parts.join(" ")}`);
  assert.deepEqual(plays(h.markdown), [{ type: "sound", sound: "bd", bank: "TR909" }]);
  assert.equal(hover('s("sd").bank("NoSuch|Bank")'), null);
});
