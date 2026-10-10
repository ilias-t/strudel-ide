// Calm warnings for unknown sounds, banks and scales (src/ui/complete/diagnostics.ts), over the fake
// live registry (test/fixtures/complete/sound-map.ts) and a fixture theory.
// Run: node --test test/complete-diagnostics.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { diagnose, TONAL_SCALE_ALIASES, type DiagnoseOptions, type Diagnostic } from "../src/ui/complete/diagnostics.ts";
import type { Theory } from "../src/ui/complete/types.ts";
import { fakeRegistry } from "./fixtures/complete/sound-map.ts";

const theory = JSON.parse(readFileSync(new URL("./fixtures/complete/theory.json", import.meta.url), "utf8")) as Theory;
const emptyTheory: Theory = { scales: [], chords: {}, vowels: [], voicingDicts: [] };
const reg = fakeRegistry();

const run = (text: string, opts: DiagnoseOptions = {}) => diagnose(text, reg, { theory, ...opts });
/** The text a diagnostic covers */
const covered = (text: string, d: Diagnostic) => text.slice(d.start, d.end);
const brief = (text: string, ds: Diagnostic[]) => ds.map((d) => `${d.severity} ${covered(text, d)}: ${d.message}`);

describe("unknown sounds", () => {
  test('s("bdd") → one warning on the word, "did you mean bd", a fix', () => {
    const text = 's("bd bdd hh")';
    const ds = run(text);
    assert.equal(ds.length, 1);
    const [d] = ds;
    assert.equal(d.severity, "warning");
    assert.equal(d.kind, "sound");
    assert.equal(covered(text, d), "bdd");
    assert.equal(d.message, 'No sound "bdd" — did you mean "bd"?');
    assert.equal(d.fixes[0], "bd");
    assert.ok(d.fixes.length <= 3);
  });

  test("sound() too, and pianno → piano", () => {
    const text = 'sound("pianno")';
    assert.deepEqual(brief(text, run(text)), ['warning pianno: No sound "pianno" — did you mean "piano"?']);
  });

  test("nothing close: just says so", () => {
    const text = 's("xylophonics")';
    assert.deepEqual(brief(text, run(text)), ['warning xylophonics: No sound "xylophonics"']);
    assert.deepEqual(run(text)[0].fixes, []);
  });

  test("bank-aware: checks <bank>_<word>, names the bank as written", () => {
    assert.deepEqual(run('s("bd sd hh").bank("TR909")'), []);
    const text = 's("bd bdd").bank("TR909")';
    assert.deepEqual(brief(text, run(text)), ['warning bdd: No sound "bdd" in TR909 — did you mean "bd"?']);
  });

  test("an unbanked sound under a bank doesn't play there", () => {
    const text = 's("piano").bank("RolandTR909")';
    const ds = run(text);
    assert.equal(ds.length, 1);
    assert.match(ds[0].message, /^No sound "piano" in RolandTR909/);
  });

  test("a bank const counts like a literal", () => {
    assert.deepEqual(run('const D = "TR909";\ns("rd").bank(D)'), []);
    const text = 'const D = "RolandTR808";\ns("rd").bank(D)';
    assert.deepEqual(brief(text, run(text)).length, 1);
  });

  test("a bank we can't read (not a literal) → the chain's sounds aren't checked", () => {
    assert.deepEqual(run('s("perc bdd").bank(pickBank())'), []);
    assert.deepEqual(run('let D = pick(); s("perc bdd").bank(D)'), []);
  });

  test("case doesn't matter, as in superdough", () => {
    assert.deepEqual(run('s("BD Sd").bank("tr909")'), []);
  });

  test("carriers that become sounds: mini(…).s()", () => {
    const text = 'mini("bd bdd").s()';
    assert.equal(run(text).length, 1);
  });
});

describe("drum-machine-only parts", () => {
  test("perc without a bank → add .bank(…)", () => {
    const text = 's("bd perc")';
    const ds = run(text);
    assert.equal(ds.length, 1);
    assert.equal(ds[0].kind, "bank-only");
    assert.equal(ds[0].severity, "warning");
    assert.equal(covered(text, ds[0]), "perc");
    assert.match(ds[0].message, /^"perc" plays only from a drum machine — add \.bank\("[A-Za-z0-9]+"\)/);
  });

  test("with a bank that has it: fine", () => {
    assert.deepEqual(run('s("bd perc").bank("RolandTR808")'), []);
  });
});

describe("unknown banks", () => {
  test('.bank("RolandTR90") → did you mean RolandTR909, with fixes', () => {
    const text = 's("bd sd").bank("RolandTR90")';
    const ds = run(text);
    assert.deepEqual(brief(text, ds), ['warning RolandTR90: No drum machine "RolandTR90" — did you mean "RolandTR909"?']);
    assert.equal(ds[0].kind, "bank");
    assert.equal(ds[0].fixes[0], "RolandTR909");
  });

  test("its chain's sounds aren't flagged twice", () => {
    const text = 's("bdd perc").bank("RolandTR90")';
    assert.equal(run(text).length, 1);
  });

  test("an alias is a bank; any case", () => {
    assert.deepEqual(run('s("bd").bank("tr909")'), []);
    assert.deepEqual(run('s("bd").bank("<TR909 TR808>")'), []);
  });
});

describe("nested chains: the outer .bank() wins (the last bank listed)", () => {
  test("own TR808, outer TR909 → plays TR909: rd is fine", () => {
    assert.deepEqual(run('stack(s("rd").bank("TR808")).bank("TR909")'), []);
  });
  test("own TR909, outer TR808 → plays TR808: rd isn't there", () => {
    const text = 'stack(s("rd").bank("TR909")).bank("TR808")';
    assert.deepEqual(brief(text, run(text)).map((m) => m.split(" —")[0]), ['warning rd: No sound "rd" in TR808']);
  });
  test("stack(s(…), s(…)).bank(…): the bank reaches every s()", () => {
    assert.deepEqual(run('stack(s("bd*4"), s("~ perc")).bank("TR808")'), []);
  });
});

describe("variants past the end wrap: an info, never a warning", () => {
  test("bd:12 with 8 files → plays bd:4", () => {
    const text = 's("bd:12")';
    const ds = run(text);
    assert.equal(ds.length, 1);
    assert.equal(ds[0].severity, "info");
    assert.equal(ds[0].kind, "variant");
    assert.equal(covered(text, ds[0]), "bd:12");
    assert.equal(ds[0].message, "bd:12 plays bd:4 — bd has 8");
  });
  test("under a bank: its own count", () => {
    const text = 's("bd:5").bank("TR909")';
    assert.deepEqual(brief(text, run(text)), ["info bd:5: bd:5 plays bd:1 — bd has 4 in TR909"]);
  });
  test("in range, pitched or synth: nothing", () => {
    assert.deepEqual(run('s("bd:7 bd:0 piano:40 sawtooth:3")'), []);
  });
});

describe("never", () => {
  test("rests, elongation, numbers and operator arguments", () => {
    assert.deepEqual(run('s("~ bd - _ [bd sd]*2 bd(3,8) bd@3 bd!2 bd? <bd sd>/2 bd . sd 3 -1 .5")'), []);
  });

  test("strings whose call gives no sound role", () => {
    assert.deepEqual(run('mini("bdd")'), []);
    assert.deepEqual(run('seq("bdd", "pianno")'), []);
    assert.deepEqual(run('knob("cutoff", 1, 0, 2)'), []);
    assert.deepEqual(run('note("c3 e3 bdd")'), []);
    assert.deepEqual(run('n("0 1 bdd").vowel("xyz")'), []);
  });

  test("strings built by code: only literals the scanner sees", () => {
    assert.deepEqual(run("s(`${kick} bdd`)"), []);
    assert.deepEqual(run('const P = "bdd";\ns(P)'), []);
    assert.deepEqual(run('s("bd " + "bdd")'), []);
  });

  test("the word at the caret (being typed); onSkip says which", () => {
    const text = 's("bd bdd")';
    const at = text.indexOf("bdd");
    for (const caret of [at, at + 1, at + 3]) {
      let skipped: [number, number] | null = null;
      assert.deepEqual(run(text, { caret, onSkip: (a, b) => (skipped = [a, b]) }), [], `caret ${caret}`);
      assert.deepEqual(skipped, [at, at + 3]);
    }
    assert.equal(run(text, { caret: 1 }).length, 1);
    assert.equal(run(text, { caret: text.length }).length, 1);
  });

  test("before samples are ready", () => {
    const notReady = fakeRegistry({ ready: false });
    assert.deepEqual(diagnose('s("bdd").bank("RolandTR90").scale("C:majr")', notReady, { theory }), []);
  });

  test("a failed sample map: names the catalog knows aren't flagged; unknown ones still are", () => {
    const degraded = fakeRegistry({ omit: (k) => k === "piano" || k.startsWith("rolandtr909_") || k.startsWith("tr909_") });
    assert.equal(degraded.degraded(), true);
    const fallback = { has: degraded.catalogHas, isBank: degraded.catalogHasBank };
    assert.deepEqual(diagnose('s("piano")', degraded, { fallback }), []);
    assert.deepEqual(diagnose('s("bd rd").bank("TR909")', degraded, { fallback }), []);
    assert.equal(diagnose('s("pianno")', degraded, { fallback }).length, 1);
    assert.equal(diagnose('s("bd bdd").bank("TR909")', degraded, { fallback }).length, 1);
    // without the fallback the missing map's names would be flagged
    assert.equal(diagnose('s("piano")', degraded).length, 1);
  });

  test("severity is only ever warning or info, and no message says error", () => {
    const text = 's("bdd perc bd:99").bank("TR9O9")\ns("pianno bd:40")\nn("0").scale("X:majr")';
    for (const d of run(text)) {
      assert.ok(d.severity === "warning" || d.severity === "info", d.severity);
      assert.doesNotMatch(d.message, /error/i);
    }
  });
});

describe("scales", () => {
  test("an unknown type → did you mean, the fix in colon form", () => {
    const text = 'n("0 2").scale("C:majr")';
    const ds = run(text);
    assert.deepEqual(brief(text, ds), ['warning majr: No scale "majr" — did you mean "major"?']);
    assert.equal(ds[0].kind, "scale");
    assert.deepEqual(ds[0].fixes.slice(0, 1), ["major"]);
    const multi = 'n("0").scale("C4:minor:pentatonik")';
    const dm = run(multi);
    assert.equal(covered(multi, dm[0]), "minor:pentatonik");
    assert.equal(dm[0].fixes[0], "minor:pentatonic");
    assert.match(dm[0].message, /did you mean "minor:pentatonic"\?$/);
  });

  test("an unknown root", () => {
    const text = 'n("0").scale("X:major")';
    const ds = run(text);
    assert.equal(ds.length, 1);
    assert.equal(ds[0].kind, "scale-root");
    assert.equal(covered(text, ds[0]), "X");
    assert.match(ds[0].message, /^"X" isn't a note/);
  });

  test("forms Strudel plays: nothing", () => {
    for (const s of [
      "C:major",
      "c:minor",
      "D4:minor",
      "C4:minor:pentatonic",
      "Eb2:dorian",
      "C#3:lydian",
      "F##:major",
      "<C:major D:dorian>",
      "<C:major D:dorian>/2",
      "C:<major minor>/2",
      "C:<major minor>",
      "C:aeolian",
      "C:ionian",
      "A:pentatonic",
      "C:blues",
      "major",
      "C",
    ]) {
      assert.deepEqual(run(`n("0").scale("${s}")`), [], s);
    }
  });

  test("a type inside an alternation is checked too", () => {
    const text = 'n("0").scale("C:<major majr>")';
    assert.deepEqual(brief(text, run(text)).map((m) => m.split(" —")[0]), ['warning majr: No scale "majr"']);
  });

  test("no theory (theory.json not filled yet) → no scale warnings at all", () => {
    assert.deepEqual(diagnose('n("0").scale("C:majr")', reg, { theory: emptyTheory }), []);
    assert.deepEqual(diagnose('n("0").scale("C:majr")', reg, {}), []);
  });

  test("the alias table matches tonal's (aliases play even when theory.json lists only names)", () => {
    const require = createRequire(import.meta.url);
    const { ScaleType } = require("@tonaljs/tonal") as { ScaleType: { all(): { name: string; aliases: string[] }[] } };
    const expected: Record<string, string> = {};
    for (const s of ScaleType.all()) for (const a of s.aliases) expected[a] = s.name;
    assert.deepEqual(TONAL_SCALE_ALIASES, expected);
  });
});

describe("every song and starter: no warnings", () => {
  const root = new URL("../", import.meta.url);
  for (const dir of ["src/songs", "src/starters"]) {
    for (const name of readdirSync(new URL(dir, root)).sort()) {
      if (!name.endsWith(".ts") || name === "index.ts") continue;
      test(`${dir}/${name}`, () => {
        const text = readFileSync(new URL(`${dir}/${name}`, root), "utf8");
        assert.deepEqual(brief(text, run(text)), []);
      });
    }
  }
});

test("fast: a full pass over the biggest song", () => {
  const text = readFileSync(new URL("../src/songs/tour.ts", import.meta.url), "utf8");
  run(text);
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) run(text + " ".repeat(i)); // a new text each time: no scan cache
  const per = (performance.now() - t0) / 10;
  assert.ok(per < 15, `${per.toFixed(2)} ms per pass`);
});
