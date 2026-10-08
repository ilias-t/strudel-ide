// The track builder's sound/bank customizing of a snippet (src/ui/discover/snippet-sound.ts).
// Run: node --test test/discover-snippet-sound.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import ts from "typescript";
import { drumParts, withSound } from "../src/ui/discover/snippet-sound.ts";

describe("bank", () => {
  test("replaces the argument of an existing .bank()", () => {
    assert.equal(withSound('s("bd*4").bank("RolandTR909").gain(0.9)', { bank: "RolandTR808" }), 's("bd*4").bank("RolandTR808").gain(0.9)');
  });
  test("keeps the quote style", () => {
    assert.equal(withSound("s('bd').bank('RolandTR909')", { bank: "AkaiLinn" }), "s('bd').bank('AkaiLinn')");
  });
  test("is appended when there is none", () => {
    assert.equal(withSound('s("cb*4").gain(0.3)', { bank: "RolandTR808" }), 's("cb*4").gain(0.3).bank("RolandTR808")');
  });
  test("a .bank() inside a string or another method name doesn't count", () => {
    assert.equal(withSound('s(".bank(x)").banks("A")', { bank: "B" }), 's(".bank(x)").banks("A").bank("B")');
  });
  test("a .bank() with a non-literal argument gets a new .bank() after the chain", () => {
    assert.equal(withSound("s(\"bd\").bank(DRUMS)", { bank: "B" }), 's("bd").bank(DRUMS).bank("B")');
  });
});

describe("sound", () => {
  test("replaces a single-word .s()", () => {
    assert.equal(withSound('note("a1").s("sawtooth").lpf(500)', { sound: "square" }), 'note("a1").s("square").lpf(500)');
  });
  test("replaces a single-word s() and .sound()", () => {
    assert.equal(withSound('s("piano").note("c3")', { sound: "kalimba" }), 's("kalimba").note("c3")');
    assert.equal(withSound('note("c3").sound("piano")', { sound: "sax" }), 'note("c3").sound("sax")');
  });
  test("appends .s() when the value is a pattern, not one word", () => {
    assert.equal(withSound('s("vibraphone*8").n(irand(8))', { sound: "kalimba" }), 's("vibraphone*8").n(irand(8)).s("kalimba")');
  });
  test("appends .s() when there are several sound calls", () => {
    const code = 'stack(s("sd").gain(0.75), s("hh")).bank("RolandTR909")';
    assert.equal(withSound(code, { sound: "piano" }), `${code}.s("piano")`);
  });
  test("appends .s() when there is no sound call", () => {
    assert.equal(withSound('note("c3 e3")', { sound: "piano" }), 'note("c3 e3").s("piano")');
  });
  test("other calls ending in s aren't sound calls", () => {
    assert.equal(withSound('note("c3").pans("x").s("saw")', { sound: "sine" }), 'note("c3").pans("x").s("sine")');
  });
});

describe("both, neither", () => {
  test("a bank and a sound together", () => {
    assert.equal(withSound('note("a1").s("sawtooth").gain(0.4)', { bank: "RolandTR808", sound: "square" }), 'note("a1").s("square").gain(0.4).bank("RolandTR808")');
    assert.equal(withSound('s("hh*8").gain(0.4)', { bank: "RolandTR808", sound: "oh" }), 's("hh*8").gain(0.4).bank("RolandTR808").s("oh")');
  });
  test("no choice: the code as written", () => {
    const code = 's("bd*4").bank("RolandTR909")';
    assert.equal(withSound(code, {}), code);
  });
  test("appending goes before trailing whitespace and comments", () => {
    assert.equal(withSound('s("cb")  // cowbell', { bank: "X" }), 's("cb").bank("X")  // cowbell');
  });
});

describe("drumParts", () => {
  test("the sound names in s() mini-notation", () => {
    assert.deepEqual(drumParts('s("bd*4").bank("RolandTR909")'), ["bd"]);
    assert.deepEqual(drumParts('s("[bd ~ bd ~ sd ~ ~ sd], hh*8").bank("AkaiXR10")'), ["bd", "sd", "hh"]);
    assert.deepEqual(drumParts('s("rim(3,8)")'), ["rim"]);
    assert.deepEqual(drumParts('s("<~ ~ ~ [~ ht ht mt lt]>")'), ["ht", "mt", "lt"]);
    assert.deepEqual(drumParts('note("c3").s("piano")'), ["piano"]);
    assert.deepEqual(drumParts('note("c3")'), []);
  });
});

/** `code` is exactly one expression, per TypeScript */
function assertOneExpression(code: string, label: string) {
  const wrapped = `(${code});`;
  const sf = ts.createSourceFile("x.ts", wrapped, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diags = (sf as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
  assert.deepEqual(diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), [], label);
  assert.equal(sf.statements.length, 1, label);
  const st = sf.statements[0];
  assert.ok(ts.isExpressionStatement(st) && ts.isParenthesizedExpression(st.expression), label);
  const inner = st.expression.expression;
  assert.ok(!(ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.CommaToken), `${label}: no comma operator`);
}

describe("every snippet in snippets.json", () => {
  const { snippets } = JSON.parse(readFileSync(resolve(import.meta.dirname, "../src/catalog/snippets.json"), "utf8")) as {
    snippets: { id: string; code: string }[];
  };
  for (const { id, code } of snippets) {
    test(`${id}: still one expression with a bank, a sound, both`, () => {
      for (const choice of [{ bank: "RolandTR707" }, { sound: "piano" }, { bank: "RolandTR707", sound: "piano" }]) {
        const out = withSound(code, choice);
        assertOneExpression(out, `${id} ${JSON.stringify(choice)}`);
        if (choice.bank) assert.match(out, /\.bank\("RolandTR707"\)/);
        if (choice.sound) assert.match(out, /\b(s|sound)\("piano"\)/);
      }
      assert.equal(withSound(code, {}), code);
    });
  }
});
