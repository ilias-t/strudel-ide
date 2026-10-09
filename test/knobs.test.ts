// Knobs without a browser: the registry's live/default rules, the song
// transform (composed with strudel-locations, as Vite runs them) and the
// write-back rewrite.
//
// Run: node --test test/knobs.test.ts   (Node ≥ 22.18 strips TS types)

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import ts from "typescript";
import { KnobRegistry, knobPosition, knobValueAt, parseKnobArgs, snapKnob, type SavedKnobs } from "../src/engine/knobs.ts";
import { KnobWriteError, checkLiveBuffer, rewriteKnobValues, transformKnobs } from "../vite-plugins/strudel-knobs.ts";
import { isSongFile, loadStrudelNames, transformSong } from "../vite-plugins/strudel-locations.ts";

const root = resolve(import.meta.dirname, "..");
const spec = (name: string, def: number, min = 0, max = 1, step?: number) => parseKnobArgs([name, def, min, max, step]);

describe("registry", () => {
  test("keeps the live value across rebuilds; a new file default resets it", () => {
    const r = new KnobRegistry();
    r.build("song", () => r.define(null, spec("cutoff", 0.5)));
    assert.equal(r.set("song", "cutoff", 0.734), 0.73, "snapped to the 0.01 step");
    r.build("song", () => r.define(null, spec("cutoff", 0.5)));
    assert.deepEqual(r.get("song", "cutoff")?.value, 0.73, "same default: kept");
    assert.equal(r.get("song", "cutoff")?.dirty, true);
    r.build("song", () => r.define(null, spec("cutoff", 0.73)));
    assert.equal(r.get("song", "cutoff")?.dirty, false, "written to file: no longer dirty");
    r.build("song", () => r.define(null, spec("cutoff", 0.2)));
    assert.equal(r.get("song", "cutoff")?.value, 0.2, "edited in the file: reset");
  });

  test("a grabbed (mid-drag) knob isn't reset by a file edit", () => {
    const r = new KnobRegistry();
    r.build("song", () => r.define(null, spec("g", 0.5)));
    r.set("song", "g", 0.9);
    r.grab("song", "g", true);
    r.build("song", () => r.define(null, spec("g", 0.1)));
    assert.equal(r.get("song", "g")?.value, 0.9);
    assert.equal(r.get("song", "g")?.def, 0.1);
  });

  test("lists module-level and build knobs; a module re-evaluation forgets removed ones", () => {
    const r = new KnobRegistry();
    r.beginModule("song");
    r.define("song", spec("top", 0.5));
    r.define("song", spec("gone", 0.5));
    r.build("song", () => r.define(null, spec("inner", 0.5)));
    assert.deepEqual(r.list("song").map((k) => k.name), ["top", "gone", "inner"]);
    r.beginModule("song");
    r.define("song", spec("top", 0.5));
    r.build("song", () => r.define(null, spec("inner", 0.5)));
    assert.deepEqual(r.list("song").map((k) => k.name), ["top", "inner"]);
    r.build("other", () => {});
    assert.deepEqual(r.list("other"), []);
  });

  test("restores saved values only if the file still says the same", () => {
    const store: Record<string, SavedKnobs> = { a: { x: { value: 0.9, base: 0.5 } }, b: { x: { value: 0.9, base: 0.4 } } };
    const r = new KnobRegistry({ load: (id) => store[id] ?? null });
    r.build("a", () => r.define(null, spec("x", 0.5)));
    r.build("b", () => r.define(null, spec("x", 0.5)));
    assert.equal(r.get("a", "x")?.value, 0.9);
    assert.equal(r.get("b", "x")?.value, 0.5);
  });

  test("a module's top-level knobs can be re-declared from its snapshot (revert to the file's module)", () => {
    const saved: Record<string, SavedKnobs> = {};
    const r = new KnobRegistry({ save: (id, s) => (saved[id] = s) });
    // the file's module: its top level declares cutoff = 2200; its pattern reads that entry
    r.beginModule("song");
    const entry = r.define("song", parseKnobArgs(["cutoff", 2200, 200, 8000, { log: true }]));
    r.define("song", spec("send", 0.3));
    const read = r.reader(entry);
    const file = r.moduleSpecs("song");
    assert.deepEqual(file.map((k) => [k.name, k.def]), [["cutoff", 2200], ["send", 0.3]]);
    r.set("song", "send", 0.6); // a live tweak on a knob the edit doesn't change

    // an evaluated edit of the module (browser eval): cutoff's literal is now 7000, and it adds a knob
    r.beginModule("song");
    r.define("song", parseKnobArgs(["cutoff", 7000, 200, 8000, { log: true }]));
    r.define("song", spec("send", 0.3));
    r.define("song", spec("extra", 0.5));
    assert.equal(read(), 7000, "the file module's pattern reads the same entry");

    // revert: the file module's specs are declared again
    r.restoreModule("song", file);
    assert.equal(r.get("song", "cutoff")?.def, 2200);
    assert.equal(r.get("song", "cutoff")?.value, 2200, "default changed back: the live value resets");
    assert.equal(read(), 2200, "the file module's pattern plays the file's value again");
    assert.equal(r.get("song", "send")?.value, 0.6, "unchanged default: the live tweak is kept");
    assert.deepEqual(r.list("song").map((k) => k.name), ["cutoff", "send"], "the edit's extra knob is gone");
    assert.deepEqual(r.moduleSpecs("song"), file, "the snapshot is the module's again");
    r.flush("song");
    assert.deepEqual(saved.song, { send: { value: 0.6, base: 0.3 } }, "persisted against the file's defaults");
  });

  test("snapping, log travel and argument errors", () => {
    const cutoff = parseKnobArgs(["cutoff", 2200, 200, 8000, { log: true }]);
    assert.equal(cutoff.step, 10);
    assert.equal(snapKnob(cutoff, 99999), 8000);
    assert.equal(snapKnob(cutoff, 2204.9), 2200);
    assert.ok(Math.abs(knobValueAt(cutoff, knobPosition(cutoff, 2200)) - 2200) < 1e-9);
    assert.ok(Math.abs(knobValueAt(cutoff, 0.5) - Math.sqrt(200 * 8000)) < 1e-9);
    assert.equal(snapKnob(spec("s", 0.15, 0, 0.33, 0.01), 0.1 + 0.2), 0.3);
    assert.throws(() => parseKnobArgs(["", 1, 0, 1]), /name/);
    assert.throws(() => parseKnobArgs(["x", "1", 0, 1]), /value must be a number/);
  });
});

describe("write-back rewrite", () => {
  const code = `const a = knob("cutoff", 2200, 200, 8000, { log: true });\nconst b = s("x").gain(knob('level', -0.5, -1, 1));\nconst c = knob("expr", 1 / 3, 0, 1);\n`;

  test("rewrites exactly the value literal, all knobs in one go", () => {
    const { code: out, changes } = rewriteKnobValues(code, "x.ts", [
      { name: "cutoff", value: 1830 },
      { name: "level", value: 0.25 },
    ]);
    assert.equal(
      out,
      `const a = knob("cutoff", 1830, 200, 8000, { log: true });\nconst b = s("x").gain(knob('level', 0.25, -1, 1));\nconst c = knob("expr", 1 / 3, 0, 1);\n`
    );
    assert.deepEqual(changes, [
      { name: "cutoff", literal: "1830", line: 1 },
      { name: "level", literal: "0.25", line: 2 },
    ]);
    assert.match(rewriteKnobValues(code, "x.ts", [{ name: "level", value: -1 }]).code, /knob\('level', -1, -1, 1\)/);
  });

  test("refuses a missing call or a non-literal value, writing nothing", () => {
    assert.throws(() => rewriteKnobValues(code, "x.ts", [{ name: "nope", value: 1 }]), (e: KnobWriteError) => e.status === 404);
    assert.throws(
      () => rewriteKnobValues(code, "x.ts", [{ name: "cutoff", value: 1 }, { name: "expr", value: 0.5 }]),
      (e: KnobWriteError) => e.status === 422 && /not a number literal/.test(e.message)
    );
    assert.throws(() => rewriteKnobValues(code, "x.ts", [{ name: "cutoff", value: NaN }]), /finite/);
  });

  test("refuses (409) while an unsaved, evaluated buffer of the file plays", () => {
    const writes = [{ name: "cutoff", value: 1 }];
    // no buffer, or the buffer is what's on disk: fine
    checkLiveBuffer(code, "x.ts", writes, null);
    checkLiveBuffer(code, "x.ts", writes, { text: code });
    const buffer = code.replace("const c", 'const d = knob("width", 0.5, 0, 1);\nconst c');
    assert.throws(
      () => checkLiveBuffer(code, "x.ts", [{ name: "width", value: 0.2 }], { text: buffer }),
      (e: KnobWriteError) => e.status === 409 && /only in the unsaved editor buffer of x\.ts/.test(e.message)
    );
    assert.throws(
      () => checkLiveBuffer(code, "x.ts", writes, { text: buffer }),
      (e: KnobWriteError) => e.status === 409 && /unsaved changes that are playing/.test(e.message)
    );
  });
});

describe("song transform", async () => {
  const names = await loadStrudelNames();
  const dir = join(root, "src/songs");
  for (const f of readdirSync(dir).filter((f) => isSongFile(join(dir, f), root))) {
    test(`${f}: locations + knobs still compile, line numbers unchanged`, () => {
      const source = readFileSync(join(dir, f), "utf8");
      const file = `src/songs/${f}`;
      const located = transformSong(source, file, names).code;
      const out = transformKnobs(located, file);
      assert.ok(out, "transformed");
      const result = ts.transpileModule(out.code, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
      assert.deepEqual(result.diagnostics?.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
      assert.ok(!/(^|[^_.\w])knob\(/.test(out.code.replace(/\/\/.*$/gm, "")), "every knob( call is routed");
      const lines = source.split("\n");
      const outLines = out.code.split("\n");
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].includes("knob(")) continue;
        assert.match(outLines[i], /__strudel_knob\(/, `line ${i + 1} stays line ${i + 1}`);
      }
    });
  }
  test("a file that declares its own knob is left alone", () => {
    assert.equal(transformKnobs(`const knob = (x: number) => x;\nknob(1);\n`, "src/songs/x.ts"), null);
  });
});
