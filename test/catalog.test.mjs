// The discovery catalog (src/catalog/*.json, written by scripts/gen-catalog.mjs):
//   - unit tests of the builders on tiny synthetic inputs
//   - integration tests over the real inputs: the cached sample maps, the generated d.ts files,
//     the snippets (each one evaluated headlessly, with every sound checked against the maps)
//   - freshness: the committed JSON matches what the generator produces now
//
// Run: node --test test/catalog.test.mjs   (needs the sample-map cache: run `npm run check:songs` or
// `npm run gen:catalog` once online; the tests never fetch)

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import * as core from "@strudel/core";
import * as mini from "@strudel/mini";
import * as tonal from "@strudel/tonal";
import { KnobRegistry, installKnobGlobals } from "../src/engine/knobs.ts";
import { buildSounds } from "../scripts/lib/catalog/sounds.mjs";
import { buildFunctions } from "../scripts/lib/catalog/functions.mjs";
import { ideExample } from "../scripts/lib/catalog/examples.mjs";
import ts from "typescript";
import { CATEGORIES } from "../scripts/lib/catalog/function-categories.mjs";
import { SNIPPETS } from "../scripts/lib/catalog/snippets.mjs";
import { knownSounds, soundKey } from "../scripts/lib/catalog/known-sounds.mjs";
import { loadCatalogInputs } from "../scripts/lib/catalog/inputs.mjs";
import { generateCatalog, CATALOG_FILES } from "../scripts/lib/catalog/generate.mjs";

const root = resolve(import.meta.dirname, "..");
const catalogDir = join(root, "src/catalog");

// ─────────────────────────────────────────────────────────────────────────────
// sounds: unit
// ─────────────────────────────────────────────────────────────────────────────

const FAKE_MAPS = {
  "tidal-drum-machines": {
    _base: "https://example/",
    RolandTR909_bd: ["a.wav", "b.wav"],
    RolandTR909_hh: ["a.wav"],
    RolandTR808_bd: ["a.wav"],
    OberheimDMX_: ["stray.wav"],
  },
  "uzu-drumkit": { _base: "https://example/", bd: ["1", "2", "3"], brk: ["x"], oh: ["1"] },
  vcsl: { _base: "https://example/", glockenspiel: { c4: "x", e4: "y" }, conga: ["a", "b"] },
  "uzu-wavetables": { wt_digital: ["a"] },
  piano: { piano: { a0: "x", c1: "y", e1: ["z", "w"] } },
  mridangam: { mridangam_ta: ["a"] },
};
const FAKE_ALIASES = { RolandTR909: "TR909", RolandTR808: ["TR808", "808"], NotLoaded: "NL" };
const FAKE_SYNTHS = ["sine", "saw", "white", "zzfx", "sbd"];

describe("buildSounds", () => {
  const cat = buildSounds({ maps: FAKE_MAPS, aliasMap: FAKE_ALIASES, synths: FAKE_SYNTHS });

  test("lists each drum-machine bank with its aliases and part names", () => {
    assert.deepEqual(cat.banks.RolandTR909, { aliases: ["TR909"], parts: ["bd", "hh"] });
    assert.deepEqual(cat.banks.RolandTR808, { aliases: ["808", "TR808"], parts: ["bd"] });
  });

  test("skips stray keys and aliases of banks that are not loaded", () => {
    assert.deepEqual(Object.keys(cat.banks), ["RolandTR808", "RolandTR909"]);
    assert.equal(cat.sounds[""], undefined);
  });

  test("a drum part carries its unbanked count and a bank → count map", () => {
    assert.deepEqual(cat.sounds.bd, { kind: "kick", source: "uzu-drumkit", count: 3, banks: { RolandTR808: 1, RolandTR909: 2 } });
    assert.deepEqual(cat.sounds.hh, { kind: "hat", banks: { RolandTR909: 1 } });
  });

  test("pitched entries (keyed by note) count every file and say so", () => {
    assert.deepEqual(cat.sounds.glockenspiel, { kind: "mallets", source: "vcsl", count: 2, pitched: true });
    assert.deepEqual(cat.sounds.piano, { kind: "keys", source: "piano", count: 4, pitched: true });
  });

  test("gives every source a kind", () => {
    const kinds = Object.fromEntries(Object.entries(cat.sounds).map(([n, s]) => [n, s.kind]));
    assert.deepEqual(kinds, {
      bd: "kick",
      brk: "break",
      conga: "perc",
      glockenspiel: "mallets",
      hh: "hat",
      mridangam_ta: "perc",
      oh: "openhat",
      piano: "keys",
      saw: "synth",
      sbd: "kick",
      sine: "synth",
      white: "noise",
      wt_digital: "wavetable",
      zzfx: "zzfx",
    });
  });

  test("synths come from superdough, and short waveform names point at the long ones", () => {
    assert.deepEqual(cat.sounds.sine, { kind: "synth", source: "superdough" });
    assert.deepEqual(cat.sounds.saw, { kind: "synth", source: "superdough", aliasOf: "sawtooth" });
  });

  test("groups list kinds in a fixed order, each with its sounds sorted", () => {
    const drums = cat.groups.find((g) => g.id === "drums");
    assert.ok(drums);
    const kick = drums.kinds.find((k) => k.id === "kick");
    assert.deepEqual(kick?.sounds, ["bd", "sbd"]);
    // empty kinds are dropped
    assert.equal(drums.kinds.find((k) => k.id === "clap"), undefined);
    assert.deepEqual(
      cat.groups.map((g) => g.id),
      ["drums", "instruments", "synths"],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// functions: unit
// ─────────────────────────────────────────────────────────────────────────────

const FAKE_DTS = `
interface Pattern {
  readonly _steps: number | undefined;
  /**
   * Adds numbers, e.g. 1 + 2. More text.
   * Second line.
   * @param amount how much
   * @example
   * n("0 2").add(1)
   */
  readonly add: PatternOperator;
  /**
   * Alias of \`lpf\`.
   *
   * Low pass filter.
   * Synonyms: \`cutoff\`, \`ctf\`
   * @param f frequency
   *   in Hz
   */
  lp(f?: NumberInput): Pattern;
  /**
   * Like gain.
   *
   * _SuperDirt only — has no effect with the built-in WebAudio output._
   */
  amp(a?: NumberInput): Pattern;
  fast(
    factor: NumberInput
  ): Pattern;
}

/**
 * Adds numbers, e.g. 1 + 2. More text.
 * Second line.
 * @param value v
 * @param pat bogus
 * @example
 * n("0 2").add(1)
 */
declare function add(value: PatternInput, pat: PatternInput): Pattern;
/**
 * Curried form: \`add(value)\` returns a function that applies it to a pattern, e.g. \`.every(4, add(...))\` or \`.jux(add(...))\`.
 *
 * Adds numbers, e.g. 1 + 2. More text.
 * Second line.
 * @example
 * add(1)(n("0"))
 */
declare function add(value: PatternInput): PatternFunc;
/**
 * Stacks patterns.
 * @example
 * stack(s("bd"))
 * @example
 * stack(
 *   s("hh")
 * )
 */
declare function stack(...pats: PatternInput[]): Pattern;
/**
 * Plays at cycles per minute.
 * @deprecated
 */
declare function cpm(cpm: NumberInput): PatternFunc;
/**
 * @deprecated not used anywhere
 */
declare function getFreq(n: number): number;
/** A sine signal from 0 to 1. */
declare const sine: Pattern;
`;

describe("buildFunctions", () => {
  const fns = buildFunctions(FAKE_DTS);
  const by = Object.fromEntries(fns.map((f) => [f.name, f]));

  test("one entry per public name, sorted, internals (_x) left out", () => {
    assert.deepEqual(
      fns.map((f) => f.name),
      ["add", "amp", "cpm", "fast", "getFreq", "lp", "sine", "stack"],
    );
  });

  test("kind says where a name lives: Pattern method, global function, both, or a value", () => {
    assert.equal(by.add.kind, "both");
    assert.equal(by.lp.kind, "method");
    assert.equal(by.stack.kind, "function");
    assert.equal(by.sine.kind, "value");
  });

  test("signatures keep every declaration, methods prefixed with a dot, whitespace collapsed", () => {
    assert.deepEqual(by.add.signatures, [
      ".add: PatternOperator",
      "add(value: PatternInput, pat: PatternInput): Pattern",
      "add(value: PatternInput): PatternFunc",
    ]);
    assert.deepEqual(by.fast.signatures, [".fast(factor: NumberInput): Pattern"]);
    assert.deepEqual(by.sine.signatures, ["const sine: Pattern"]);
  });

  test("docs come from the method first; params are not merged with the global's", () => {
    assert.equal(by.add.description, "Adds numbers, e.g. 1 + 2. More text.\nSecond line.");
    assert.equal(by.add.summary, "Adds numbers, e.g. 1 + 2.");
    assert.deepEqual(by.add.params, [{ name: "amount", description: "how much" }]);
  });

  test("examples from every declaration, deduplicated, multi-line ones intact", () => {
    assert.deepEqual(by.add.examples, ['n("0 2").add(1)', 'add(1)(n("0"))']);
    assert.deepEqual(by.stack.examples, ['stack(s("bd"))', 'stack(\n  s("hh")\n)']);
  });

  test("generated notes move out of the description into fields", () => {
    assert.equal(by.lp.aliasOf, "lpf");
    assert.deepEqual(by.lp.synonyms, ["cutoff", "ctf"]);
    assert.equal(by.lp.description, "Low pass filter.");
    assert.deepEqual(by.lp.params, [{ name: "f", description: "frequency\nin Hz" }]);
    assert.equal(by.amp.superdirtOnly, true);
    assert.equal(by.amp.description, "Like gain.");
    assert.ok(!by.add.description.includes("Curried"));
  });

  test("deprecated is the tag's text, or true when it has none", () => {
    assert.equal(by.cpm.deprecated, true);
    assert.equal(by.getFreq.deprecated, "not used anywhere");
    assert.equal(by.add.deprecated, undefined);
  });

  test("undocumented names still get empty fields", () => {
    assert.deepEqual(
      { ...by.fast, signatures: undefined },
      { name: "fast", kind: "method", signatures: undefined, summary: "", description: "", params: [], examples: [], synonyms: [] },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Real inputs (cache only: tests never fetch)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// examples: strudel.cc form → IDE form
// ─────────────────────────────────────────────────────────────────────────────

/** Names on the Pattern interface of the generated d.ts (what ideExample() treats as pattern methods) */
function dtsPatternMembers() {
  const src = readFileSync(join(root, "src/strudel.generated.d.ts"), "utf8");
  const sf = ts.createSourceFile("d.ts", src, ts.ScriptTarget.Latest, true);
  const iface = sf.statements.find((s) => ts.isInterfaceDeclaration(s) && s.name.text === "Pattern");
  return new Set(iface.members.filter((m) => m.name && ts.isIdentifier(m.name)).map((m) => m.name.text));
}
const MEMBERS = dtsPatternMembers();

/** What the IDE can't run: a Pattern member on a string literal ("a".fast, "110".mul.out), or `._name` visuals */
function strudelCcOnly(code) {
  const sf = ts.createSourceFile("x.js", code, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      const r = node.expression;
      const name = node.name.text;
      if ((ts.isStringLiteral(r) || ts.isNoSubstitutionTemplateLiteral(r)) && MEMBERS.has(name)) found.push(node.getText(sf));
      if (name.startsWith("_") && MEMBERS.has(name.slice(1))) found.push(node.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("ideExample", () => {
  const members = new Set(["add", "slow", "fast", "note", "sub", "mul", "scope", "pianoroll"]);
  const ide = (code) => ideExample(code, members);

  test("wraps a string literal that receives a pattern method in mini()", () => {
    assert.equal(ide('n("0 2 4".add("<0 3 4 0>")).scale("C:major")'), 'n(mini("0 2 4").add("<0 3 4 0>")).scale("C:major")');
    assert.equal(ide('"<0 2>".slow(2).note()'), 'mini("<0 2>").slow(2).note()');
    assert.equal(ide("`c e g`.fast(2).note()"), "mini(`c e g`).fast(2).note()");
  });

  test("Pattern members win over String.prototype's legacy names (sub, …)", () => {
    assert.equal(ide('n("0 2 4".sub(1))'), 'n(mini("0 2 4").sub(1))');
  });

  test('wraps operator chains too: "110".mul.out(…)', () => {
    assert.equal(ide('freq("110".mul.out(".5 1.5"))'), 'freq(mini("110").mul.out(".5 1.5"))');
  });

  test("strudel.cc's inline visuals become the IDE's methods", () => {
    assert.equal(ide('note("c e")._scope()._pianoroll({ labels: true })'), 'note("c e").scope().pianoroll({ labels: true })');
    assert.equal(ide("x._unknown()"), "x._unknown()");
  });

  test("leaves everything else alone: arguments, JS string methods, comments, layout", () => {
    const code = '// "a b".fast(2) in a comment\nnote("c e")\n  .s("piano") // "x".y()\n"a b".split(" ")';
    assert.equal(ide(code), code);
  });

  test("handles nested and repeated receivers", () => {
    assert.equal(
      ide('note("c3 e3".add("<0 5>".fast(2))).stack("g3".note())'),
      'note(mini("c3 e3").add(mini("<0 5>").fast(2))).stack(mini("g3").note())'
    );
  });

  test("leaves code it can't parse unchanged", () => {
    assert.equal(ide('"a".fast(2'), '"a".fast(2');
  });
});

const inputs = await loadCatalogInputs({ root, offline: true });
const catalog = generateCatalog(inputs);
const parsed = Object.fromEntries(Object.entries(catalog).map(([f, text]) => [f, JSON.parse(text)]));

/** `type X = | "a" | "b";` unions from src/strudel.sounds.generated.d.ts */
function soundUnion(type) {
  const src = readFileSync(join(root, "src/strudel.sounds.generated.d.ts"), "utf8");
  const m = src.match(new RegExp(`type ${type} =\\n((?:\\s+\\| "[^"]*"\\n?)+);`));
  assert.ok(m, `type ${type} not found`);
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}

describe("sounds.json", () => {
  const { banks, sounds, groups } = parsed["sounds.json"];

  test("covers every SoundName from the generated sound types", () => {
    for (const type of ["SynthName", "DrumPartName", "SampleName"]) {
      const missing = soundUnion(type).filter((n) => !sounds[n]);
      assert.deepEqual(missing, [], `${type} missing from sounds.json`);
    }
  });

  test("covers every BankName and alias", () => {
    assert.deepEqual(soundUnion("DrumMachineBankName").filter((b) => !banks[b]), []);
    const aliases = new Set(Object.values(banks).flatMap((b) => b.aliases));
    assert.deepEqual(soundUnion("BankAliasName").filter((a) => !aliases.has(a)), []);
  });

  test("spot checks: TR909 parts and aliases, counts straight from the maps", () => {
    const tdm = inputs.maps["tidal-drum-machines"];
    assert.ok(banks.RolandTR909.parts.includes("bd"));
    assert.ok(banks.RolandTR909.aliases.includes("TR909"));
    assert.equal(sounds.bd.banks.RolandTR909, tdm.RolandTR909_bd.length);
    assert.equal(sounds.bd.count, inputs.maps["uzu-drumkit"].bd.length);
    assert.equal(sounds.conga.count, inputs.maps.vcsl.conga.length);
    assert.equal(sounds.brk.kind, "break");
    assert.equal(sounds.piano.pitched, true);
    assert.equal(sounds.hh.kind, "hat");
    assert.equal(sounds.oh.kind, "openhat");
  });

  test("every sample has a curated kind (no shape-based fallback in use)", () => {
    const fallback = Object.entries(sounds).filter(([, s]) => s.guessed).map(([n]) => n);
    assert.deepEqual(fallback, [], "add these to the kind tables in scripts/lib/catalog/sounds.mjs");
  });

  test("groups index every sound exactly once", () => {
    const listed = groups.flatMap((g) => g.kinds.flatMap((k) => k.sounds));
    assert.equal(listed.length, new Set(listed).size);
    assert.deepEqual([...listed].sort(), Object.keys(sounds).sort());
  });
});

/** Names the d.ts declares, found by a plain scan (independent of the TS-based parser) */
function dtsNames() {
  const src = readFileSync(join(root, "src/strudel.generated.d.ts"), "utf8");
  const start = src.indexOf("interface Pattern {");
  const end = src.indexOf("\n}\n", start);
  const members = [...src.slice(start, end).matchAll(/^  (?:readonly )?([A-Za-z_$][\w$]*)\s*[(:<?]/gm)].map((m) => m[1]);
  const globals = [...src.matchAll(/^declare (?:function|const) ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  return new Set([...members, ...globals].filter((n) => !n.startsWith("_")));
}

describe("functions.json", () => {
  const { functions } = parsed["functions.json"];

  test("every public name in the d.ts appears exactly once", () => {
    const names = functions.map((f) => f.name);
    assert.equal(names.length, new Set(names).size, "duplicate names");
    const expected = dtsNames();
    assert.deepEqual(names.filter((n) => !expected.has(n)), [], "names not in the d.ts");
    assert.deepEqual([...expected].filter((n) => !names.includes(n)), [], "d.ts names missing");
  });

  test("examples are in the IDE's form: no pattern methods on string literals, no ._visuals", () => {
    const left = functions.flatMap((f) => f.examples.flatMap((ex) => strudelCcOnly(ex).map((r) => `${f.name}: ${r}`)));
    assert.deepEqual(left, []);
    // the rewrite really ran (the d.ts has many strudel.cc-style examples)
    const add = functions.find((f) => f.name === "add");
    assert.ok(add.examples.some((ex) => ex.includes('n(mini("0 2 4").add("<0 3 4 0>"))')), add.examples.join("\n---\n"));
  });

  test("every function has a known category", () => {
    const ids = new Set(CATEGORIES.map((c) => c.id));
    assert.deepEqual(functions.filter((f) => !ids.has(f.category)).map((f) => f.name), []);
  });

  test('"other" stays small (≤ 10% of entries)', () => {
    const other = functions.filter((f) => f.category === "other").map((f) => f.name);
    console.log(`  "other" (${other.length}/${functions.length}): ${other.join(", ")}`);
    assert.ok(other.length <= functions.length * 0.1, `${other.length} entries in "other"`);
  });

  test("aliases share their target's category", () => {
    const by = new Map(functions.map((f) => [f.name, f]));
    const wrong = functions
      .filter((f) => f.aliasOf && by.has(f.aliasOf) && by.get(f.aliasOf).category !== f.category)
      .map((f) => `${f.name} (${f.category}) → ${f.aliasOf} (${by.get(f.aliasOf).category})`);
    assert.deepEqual(wrong, []);
  });

  test("spot checks", () => {
    const by = new Map(functions.map((f) => [f.name, f]));
    assert.equal(by.get("lpf").category, "effects");
    assert.equal(by.get("fast").category, "time");
    assert.equal(by.get("sine").kind, "value");
    assert.equal(by.get("sine").category, "signals");
    assert.equal(by.get("add").kind, "both");
    assert.ok(by.get("add").examples.length > 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Snippets: each one evaluates headlessly and plays known sounds
// ─────────────────────────────────────────────────────────────────────────────

await core.evalScope(core, mini, tonal);
mini.miniAllStrings();
installKnobGlobals(new KnobRegistry(), core.pure);

/** TrackRole from src/engine/tracks.ts (read from source: that module needs the browser build) */
function trackRoles() {
  const src = readFileSync(join(root, "src/engine/tracks.ts"), "utf8");
  const m = src.match(/export type TrackRole =([^;]+);/);
  assert.ok(m, "TrackRole not found in src/engine/tracks.ts");
  return [...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]).filter((r) => r !== "other");
}

describe("snippets", () => {
  const known = knownSounds(inputs);
  const roles = trackRoles();

  test("the JSON is the curated source, copied", () => {
    assert.deepEqual(parsed["snippets.json"].snippets, SNIPPETS);
  });

  test("ids are unique, every field is filled, every track role has snippets", () => {
    const ids = SNIPPETS.map((s) => s.id);
    assert.equal(ids.length, new Set(ids).size);
    for (const s of SNIPPETS) {
      for (const key of ["id", "role", "title", "description", "code"]) assert.ok(typeof s[key] === "string" && s[key].trim(), `${s.id}: ${key}`);
      assert.ok(roles.includes(s.role), `${s.id}: role "${s.role}" is not a TrackRole`);
      assert.ok(!s.description.includes("\n"), `${s.id}: description should be one line`);
    }
    assert.deepEqual(roles.filter((r) => !SNIPPETS.some((s) => s.role === r)), []);
    assert.ok(SNIPPETS.length >= 30 && SNIPPETS.length <= 50, `${SNIPPETS.length} snippets`);
  });

  test("code is one expression of plain string literals (no templates, no methods on strings)", () => {
    for (const s of SNIPPETS) {
      assert.ok(!/[`;]/.test(s.code), `${s.id}: template literal or statement`);
      assert.ok(!/["']\s*\.\w/.test(s.code), `${s.id}: method called on a string literal`);
    }
  });

  for (const s of SNIPPETS) {
    test(`${s.id} plays known sounds at sane levels`, () => {
      const pattern = new Function(`return (${s.code})`)();
      assert.ok(pattern instanceof core.Pattern, "not a Pattern");
      const haps = pattern.queryArc(0, 4);
      assert.ok(haps.some((h) => h.hasOnset()), "no events in 4 cycles");
      for (const hap of haps) {
        const key = soundKey(hap.value);
        assert.ok(!key || known.has(key), `unknown sound "${key}"`);
        for (const level of ["gain", "postgain"]) {
          const v = hap.value?.[level];
          assert.ok(v === undefined || v <= 1, `${level} ${v} > 1`);
        }
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Determinism + freshness
// ─────────────────────────────────────────────────────────────────────────────

describe("generator", () => {
  test("is deterministic", () => {
    assert.deepEqual(generateCatalog(inputs), catalog);
  });

  test("the committed files are fresh (else run npm run gen:catalog)", () => {
    for (const file of CATALOG_FILES) {
      const path = join(catalogDir, file);
      assert.ok(existsSync(path), `${file} missing`);
      assert.equal(readFileSync(path, "utf8"), catalog[file], `${file} is stale`);
    }
  });
});
