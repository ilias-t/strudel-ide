// The string-context scanner (src/ui/complete/context.ts) on real cases, and its latency on the biggest songs.
// Run: node --test test/complete-context.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stringContextAt, allStringContexts, trackNameAt, lex } from "../src/ui/complete/context.ts";

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

// ── the contract ────────────────────────────────────────────────────────────

test("the result is exactly a StringContext (no scanner internals)", () => {
  const src = `const hats = s("bd hh").bank("RolandTR909").gain(0.5);`;
  const c = stringContextAt(src, src.indexOf("hh"))!;
  assert.deepEqual(Object.keys(c).sort(), ["argIndex", "banks", "call", "chain", "role", "roleFrom", "soundsInChain", "string", "token", "trackName", "value"]);
  assert.deepEqual(c.string, { start: src.indexOf('"'), end: src.indexOf('"', src.indexOf('"') + 1) + 1 });
  assert.deepEqual(c.call, { name: "s", method: false });
  assert.deepEqual(c.chain, [
    { name: "s", method: false },
    { name: "bank", method: true },
    { name: "gain", method: true },
  ]);
  assert.equal(c.value, "bd hh");
  assert.equal(c.argIndex, 0);
  assert.deepEqual(c.token, { start: src.indexOf("hh"), end: src.indexOf("hh") + 2, text: "hh", prefix: "", before: " " });
});

// ── roles ───────────────────────────────────────────────────────────────────

test("every role-giving call, as a function and as a method", () => {
  const cases: [string, string, string][] = [
    [`s("b|d")`, "sound", "s(…)"],
    [`note("c").s("b|d")`, "sound", ".s(…)"],
    [`sound("b|d")`, "sound", "sound(…)"],
    [`note("c").sound("pi|ano")`, "sound", ".sound(…)"],
    [`s("bd").bank("Roland|")`, "bank", ".bank(…)"],
    [`note("c|3 e3")`, "note", "note(…)"],
    [`n("0 2").scale("C:major").note("c|")`, "note", ".note(…)"],
    [`n("0 |2")`, "number", "n(…)"],
    [`s("bd").n("0 |1")`, "number", ".n(…)"],
    [`n("0 2").scale("C:mi|nor")`, "scale", ".scale(…)"],
    [`chord("<Am|7>")`, "chord", "chord(…)"],
    [`chord("Am7").dict("lefth|and")`, "voicingDict", ".dict(…)"],
    [`chord("Am7").voicings("lefth|and")`, "voicingDict", ".voicings(…)"],
    [`s("saw").vowel("<a |e>")`, "vowel", ".vowel(…)"],
    [`s("bd").struct("x ~ |x")`, "struct", ".struct(…)"],
    [`s("bd*8").mask("1 0 |1")`, "struct", ".mask(…)"],
    [`chord("Am7").voicing().arp("0 |2")`, "number", ".arp(…)"],
    [`chord("Am7").anchor("c|4").voicing()`, "note", ".anchor(…)"],
    [`s("bd").gain("0.5 |1")`, "mini", ".gain(…)"],
    [`knob("cut|off", 1200, 200, 5000)`, "mini", "knob(…)"],
  ];
  for (const [src, role, from] of cases) {
    const c = ctx(src);
    assert.ok(c, src);
    assert.equal(c.role, role, src);
    assert.equal(c.roleFrom, from, src);
  }
});

test("carriers take their role from the first argument-less role method after them", () => {
  for (const carrier of ["mini", "m", "seq", "sequence", "cat", "fastcat", "slowcat", "stack", "h", "pure"]) {
    const c = ctx(`${carrier}("c |e").note().s("piano")`)!;
    assert.equal(c.role, "note", carrier);
    assert.equal(c.roleFrom, `${carrier}(…).note()`, carrier);
  }
  // a role method with arguments sets that control, it doesn't say what the carrier's string is
  const c = ctx(`mini("c |e").s("piano").note()`)!;
  assert.equal(c.role, "note");
  assert.equal(ctx(`seq("bd |sd").s()`)!.role, "sound");
  assert.equal(ctx(`cat("0 2", "4 |5").n()`)!.argIndex, 1);
  assert.equal(ctx(`cat("0 2", "4 |5").n()`)!.role, "number");
  // no role method after it: plain mini-notation
  const plain = ctx(`mini("<0 |2>").add(3)`)!;
  assert.equal(plain.role, "mini");
  assert.equal(plain.roleFrom, "mini(…)");
});

test("mini(…).note() across lines, with comments in between", () => {
  const c = ctx(`const lead = mini("<c e g |b>") // the riff\n  /* up an octave */ .add(12)\n  .note()\n  .s("triangle");`)!;
  assert.equal(c.role, "note");
  assert.equal(c.roleFrom, "mini(…).note()");
  assert.deepEqual(
    c.chain.map((x) => x.name),
    ["mini", "add", "note", "s"],
  );
});

// ── chains, banks, sounds ───────────────────────────────────────────────────

test("nested stack(s(), s()).bank(): the bank reaches the nested strings", () => {
  const src = `stack(s("bd*4"), s("~ sd")).bank("RolandTR808")`;
  const inner = stringContextAt(src, src.indexOf("sd"))!;
  assert.equal(inner.role, "sound");
  assert.deepEqual(inner.chain, [{ name: "s", method: false }]);
  assert.deepEqual(inner.banks, ["RolandTR808"]);
  const bank = stringContextAt(src, src.indexOf("Roland"))!;
  assert.deepEqual(bank.soundsInChain, ["bd", "sd"]);
  assert.deepEqual(
    bank.chain.map((x) => x.name),
    ["stack", "bank"],
  );
  // a sibling without a bank keeps none
  const sib = `stack(s("bd").bank("RolandTR909"), s("pi|ano"))`;
  assert.deepEqual(ctx(sib)!.banks, []);
});

test(".bank(CONST): with a type annotation, and banks in a pattern", () => {
  const tour = `const KIT: DrumMachineBank = "RolandTR909";\nconst kick = s("b|d*4").bank(KIT);`;
  assert.deepEqual(ctx(tour)!.banks, ["RolandTR909"]);
  assert.deepEqual(ctx(`let D = 'RolandTR808';\ns("b|d").bank(D)`)!.banks, ["RolandTR808"]);
  assert.deepEqual(ctx(`s("b|d").bank("<RolandTR909 RolandTR808>")`)!.banks, ["RolandTR909", "RolandTR808"]);
  assert.deepEqual(ctx(`s("b|d").bank(UNKNOWN)`)!.banks, []);
});

test("soundsInChain: s(CONST) and sound() count too", () => {
  const c = ctx(`const BEAT = "bd ~ sd";\ns(BEAT).bank("|")`)!;
  assert.deepEqual(c.soundsInChain, ["bd", "sd"]);
  assert.deepEqual(ctx(`sound("hh*8 oh").bank("|")`)!.soundsInChain, ["hh", "oh"]);
});

test("the argument index counts top-level commas only", () => {
  const c = ctx(`arrange([4, s("bd")], [4, s("hh")]).pan(sine.range(0, 1), "0 |1")`)!;
  assert.equal(c.argIndex, 1);
  assert.deepEqual(c.call, { name: "pan", method: true });
});

// ── strings ─────────────────────────────────────────────────────────────────

test("unclosed strings", () => {
  const eof = ctx(`s("bd |`)!;
  assert.equal(eof.role, "sound");
  assert.equal(eof.value, "bd ");
  assert.equal(eof.string.end, 6); // `s("bd ` is 6 characters
  assert.equal(ctx(`s('bd sd|\n.gain(1)`)!.value, "bd sd");
  assert.equal(ctx(`s("bd").bank("Rol|`)!.role, "bank");
  assert.equal(ctx(`s("bd").bank("Rol|`)!.token.text, "Rol");
  assert.equal(ctx("s(`bd |")!.role, "sound");
  // a caret just past a closed string is outside it
  assert.equal(stringContextAt(`s("bd")`, 6), null);
  assert.equal(stringContextAt(`s("bd")`, 5)?.token.text, "bd");
  assert.equal(stringContextAt(`s("bd")`, 2), null); // on the opening quote
});

test("templates: plain backticks work, ${} gives null", () => {
  const plain = ctx("s(`bd [hh |hh]\n  sd`)")!;
  assert.equal(plain.role, "sound");
  assert.equal(plain.value, "bd [hh hh]\n  sd");
  assert.equal(ctx("s(`bd ${X} |`)"), null);
  assert.equal(ctx("n(`0 2`).scale(`${KEY}|:minor`)"), null);
  // a template with nested templates inside ${…} doesn't throw the lexer off
  const nested = "const riffs = (...bars) => `<${bars.map((r) => `[${r}]`).join(\" \")}>`;\nconst x = s(\"bd |\");";
  assert.equal(ctx(nested)!.role, "sound");
  assert.equal(ctx(nested)!.trackName, "x");
  const inSubst = "const r = `<${bars.join(\"| \")}>`;";
  assert.deepEqual(ctx(inSubst)!.call, { name: "join", method: true });
});

test("object and array literals, and strings outside calls → null", () => {
  assert.equal(ctx(`foo({ a: "b|" })`), null);
  assert.equal(ctx(`arrange(["b|d", 4])`), null);
  assert.equal(ctx(`const x = ["b|d"]`), null);
  assert.equal(ctx(`const x = "b|d"`), null);
  assert.equal(ctx(`import type { Song } from ".|";`), null);
  assert.equal(ctx(`// s("b|d")`), null);
  assert.equal(ctx(`/* s("b|d") */`), null);
  assert.equal(ctx(`const song = { name: "My| Song" }`), null);
  // a call inside a record is still a call
  assert.equal(ctx(`const ch1 = { pulse: s("b|d*4") }`)!.role, "sound");
});

// ── tokens ──────────────────────────────────────────────────────────────────

test("tokens at the string's edges and after : * (", () => {
  const first = ctx(`s("|bd sd")`)!.token;
  assert.deepEqual([first.text, first.prefix, first.before], ["bd", "", ""]);
  const last = ctx(`s("bd sd|")`)!.token;
  assert.deepEqual([last.text, last.prefix, last.before], ["sd", "sd", " "]);
  const empty = ctx(`s("|")`)!.token;
  assert.deepEqual([empty.start, empty.end, empty.text, empty.before], [3, 3, "", ""]);
  const star = ctx(`s("bd*|")`)!.token;
  assert.deepEqual([star.text, star.before], ["", "*"]);
  const starNum = ctx(`s("bd*2|")`)!.token;
  assert.deepEqual([starNum.text, starNum.before], ["2", "*"]);
  const paren = ctx(`s("bd(|")`)!.token;
  assert.deepEqual([paren.text, paren.before], ["", "("]);
  const euclid = ctx(`s("bd(3,|")`)!.token;
  assert.deepEqual([euclid.text, euclid.before], ["", ","]);
  const variant = ctx(`s("sd:3|")`)!.token;
  assert.deepEqual([variant.text, variant.before, variant.head], ["3", ":", "sd"]);
  const bracket = ctx(`s("[bd sd]:|")`)!.token;
  assert.equal(bracket.head, undefined);
  const scale = ctx(`n("0").scale("C:|")`)!.token;
  assert.deepEqual([scale.text, scale.head], ["", "C"]);
  // never past the closing quote, never before the opening one
  const closed = ctx(`s("b|d").gain(1)`)!.token;
  assert.deepEqual([closed.start, closed.end], [3, 5]);
  const unclosed = ctx(`s("b|d`)!.token;
  assert.deepEqual([unclosed.start, unclosed.end], [3, 5]);
});

// ── track names ─────────────────────────────────────────────────────────────

test("trackName: from const x = …, or the record key the string sits under", () => {
  assert.equal(ctx(`const hats = s("h|h*8").gain(0.4);`)!.trackName, "hats");
  assert.equal(ctx(`let bass: Pattern = note("c|2").s("saw");`)!.trackName, "bass");
  // a record that isn't a call argument: its key is the track (tour's scenes)
  assert.equal(ctx(`const ch1: Scene = {\n  pulse: s("b|d*4"),\n  hats: s("hh*8"),\n};`)!.trackName, "pulse");
  assert.equal(ctx(`const ch1: Scene = {\n  pulse: s("bd*4"),\n  hats: s("h|h*8"),\n};`)!.trackName, "hats");
  assert.equal(ctx(`createPattern() {\n  return { kick: s("b|d*4"), "open-hat": s("oh") };\n}`)!.trackName, "kick");
  assert.equal(ctx(`createPattern() {\n  return { kick: s("bd*4"), "open-hat": s("o|h") };\n}`)!.trackName, "open-hat");
  // a section-keyed record passed to a helper: the const is the track (songs and starters)
  assert.equal(ctx(`const kick = track({\n  intro: s("b|d*4"),\n  drop: s("bd*4").gain(1),\n});`)!.trackName, "kick");
  assert.equal(ctx(`const kick = track({\n  intro: s("bd*4"),\n  drop: stack(s("bd*4"), s("~ c|p")),\n});`)!.trackName, "kick");
  // …and with no const around it, the call argument's key
  assert.equal(ctx(`return mixdown({ kick: s("b|d*4"), hats: s("hh*8") });`)!.trackName, "kick");
  assert.equal(ctx(`return mixdown({ kick: s("bd*4"), hats: s("h|h*8") });`)!.trackName, "hats");
  // a non-call record beats an outer const
  assert.equal(ctx(`const ch1 = { pulse: track({ intro: s("b|d") }) };`)!.trackName, "pulse");
});

test("trackName: none outside a binding or record, and a method body stops the search", () => {
  assert.equal(ctx(`foo(s("b|d"));`)!.trackName, undefined);
  assert.equal(ctx(`const song = {\n  createPattern() {\n    play(s("b|d"));\n  },\n};`)!.trackName, undefined);
  assert.equal(ctx(`const a = 1;\nplay(s("b|d"));`)!.trackName, undefined);
  // arrow functions: the const they're bound to
  assert.equal(ctx(`const fill = (x) => x.s("c|p");`)!.trackName, "fill");
  // comparisons and arrows aren't bindings
  assert.equal(ctx(`if (a == b) play(s("b|d"));`)!.trackName, undefined);
});

test("trackNameAt works anywhere, not just in strings", () => {
  const src = `const hats = s("hh*8").gain(0.4);\nconst kick = s("bd*4");`;
  assert.equal(trackNameAt(src, src.indexOf("0.4")), "hats");
  assert.equal(trackNameAt(src, src.indexOf("bd")), "kick");
  assert.equal(trackNameAt(src, 0), undefined);
  assert.equal(trackNameAt("", 0), undefined);
});

// ── a whole song ────────────────────────────────────────────────────────────

test("allStringContexts: every call-argument string, in order, from one lex", () => {
  const song = [
    `import type { Song } from ".";`,
    `const KIT = "RolandTR808";`,
    `const song: Song = {`,
    `  name: "Small",`,
    `  createPattern() {`,
    `    const kick = s("bd*4").bank(KIT);`,
    `    const lead = mini("c e g").note().s("triangle");`,
    "    const pad = chord(`<Am F>`).voicing();",
    "    const skip = s(`bd ${X}`);",
    `    return { kick, lead, pad, hats: s("hh*8").gain("0.3 0.5") };`,
    `  },`,
    `};`,
    `export default song;`,
  ].join("\n");
  const all = allStringContexts(song);
  assert.deepEqual(
    all.map((c) => [c.value, c.call.name, c.role, c.trackName]),
    [
      ["bd*4", "s", "sound", "kick"],
      ["c e g", "mini", "note", "lead"],
      ["triangle", "s", "sound", "lead"],
      ["<Am F>", "chord", "chord", "pad"],
      ["hh*8", "s", "sound", "hats"],
      ["0.3 0.5", "gain", "mini", "hats"],
    ],
  );
  assert.deepEqual(all[0].banks, ["RolandTR808"]);
  // each one's token sits at the start of its string
  for (const c of all) assert.equal(c.token.start, c.string.start + 1);
  // and matches what stringContextAt says at that offset
  for (const c of all) assert.deepEqual(stringContextAt(song, c.string.start + 1), c);
  assert.deepEqual(allStringContexts(""), []);
});

test("latency guard: < 2 ms cold per call and allStringContexts < 10 ms on tour", () => {
  const text = readFileSync(new URL(`../src/songs/tour.ts`, import.meta.url), "utf8");
  const offsets: number[] = [];
  for (const t of lex(text)) if (t.kind === "str") offsets.push(t.start + 1);
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1];
  // cold: a new text every call (one keystroke each), so every call lexes
  const cold: number[] = [];
  for (let i = 0; i < 101; i++) {
    const t = text + " ".repeat((i % 7) + 1);
    const t0 = performance.now();
    stringContextAt(t, offsets[(i * 13) % offsets.length]);
    cold.push(performance.now() - t0);
  }
  const all: number[] = [];
  for (let i = 0; i < 21; i++) {
    const t = text + "\n".repeat((i % 5) + 1);
    const t0 = performance.now();
    allStringContexts(t);
    all.push(performance.now() - t0);
  }
  const c = median(cold);
  const a = median(all);
  console.log(`tour: stringContextAt cold median ${c.toFixed(3)} ms; allStringContexts median ${a.toFixed(3)} ms (${allStringContexts(text).length} contexts)`);
  assert.ok(c < 2, `cold ${c} ms`);
  assert.ok(a < 10, `allStringContexts ${a} ms`);
});
