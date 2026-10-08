/// <reference path="../src/strudel.d.ts" />
/// <reference path="../src/strudel.generated.d.ts" />
/// <reference path="../src/strudel.sounds.generated.d.ts" />
// The browser song compiler without a browser: compileSong (src/compile/compile.ts)
// with Node's `typescript`, evaluateSong (src/compile/evaluate.ts) importing the
// JS from a data: URL, and runtime errors located through src/engine/errors.ts.
//
// Run: node --test test/compile.test.ts   (Node ≥ 22.18 strips TS types)

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { before, describe, test } from "node:test";
import ts from "typescript";
import * as core from "@strudel/core";
import * as mini from "@strudel/mini";
import * as tonal from "@strudel/tonal";
import { compileSong, type CompileResult } from "../src/compile/compile.ts";
import { evaluateSong, SongEvaluationError } from "../src/compile/evaluate.ts";
import { originalPosition } from "../src/compile/sourcemap.ts";
import { errorFrom } from "../src/engine/errors.ts";
import type { PlayerError } from "../src/engine/types.ts";
import { KnobRegistry, installKnobGlobals } from "../src/engine/knobs.ts";
import { stripImplicitLocations } from "../src/live/highlights.ts";
import { contentVersion } from "../src/live/protocol.ts";
import type { Song } from "../src/songs/index.ts";
import { transformKnobs } from "../vite-plugins/strudel-knobs.ts";
import { isSongFile, loadStrudelNames, transformSong, type StrudelNames } from "../vite-plugins/strudel-locations.ts";

const root = resolve(import.meta.dirname, "..");
const songsDir = join(root, "src/songs");
const songFiles = readdirSync(songsDir).filter((f) => isSongFile(join(songsDir, f), root));

const toDataUrl = (js: string) => `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
const evaluate = (result: CompileResult) => {
  assert.ok(result.ok, result.ok ? "" : `compile failed: ${result.error.message}`);
  return evaluateSong(result, { toUrl: toDataUrl });
};

type Ok = Extract<CompileResult, { ok: true }>;
const assertOk: (r: CompileResult) => asserts r is Ok = (r) => {
  assert.ok(r.ok, r.ok ? "" : `compile failed: ${r.error.message}`);
};

/** 0-based line/column of a UTF-16 offset */
function lineCol(text: string, offset: number) {
  const before = text.slice(0, offset).split("\n");
  return { line: before.length - 1, column: before.at(-1)!.length };
}

/** The 1-based line of the first occurrence of `needle` */
const lineOf = (text: string, needle: string) => lineCol(text, text.indexOf(needle)).line + 1;

let names: StrudelNames;

before(async () => {
  // Strudel globals as scripts/test-locations.mjs installs them
  const { log, warn } = console;
  console.log = console.warn = () => {};
  try {
    await core.evalScope(core, mini, tonal);
  } finally {
    console.log = log;
    console.warn = warn;
  }
  mini.miniAllStrings();
  const proto = core.Pattern.prototype as Record<string, unknown>;
  for (const m of ["pianoroll", "punchcard", "scope", "tscope", "fscope", "spectrum", "spiral", "wordfall", "color", "markcss"]) {
    proto[m] ??= function (this: unknown) {
      return this;
    };
  }
  const g = globalThis as Record<string, unknown>;
  for (const fn of ["samples", "initStrudel", "aliasBank", "soundAlias"]) g[fn] ??= async () => {};
  installKnobGlobals(new KnobRegistry(), core.pure);
  // only __strudel_m patterns carry locations, as in the browser
  assert.ok(stripImplicitLocations());
  names = await loadStrudelNames();
});

// ─────────────────────────────────────────────────────────────────────────────
// Every song: same transform as the Vite plugins, runs, highlights the file
// ─────────────────────────────────────────────────────────────────────────────

describe("songs", () => {
  for (const f of songFiles) {
    const file = `src/songs/${f}`;
    const text = readFileSync(join(songsDir, f), "utf8");

    test(`${f}: the same JS as the Vite plugins (locations → knobs → TS)`, () => {
      const result = compileSong(ts, names, text, file);
      assertOk(result);
      assert.equal(result.file, file);
      assert.equal(result.version, contentVersion(text));
      const located = transformSong(text, file, names).code;
      const knobbed = transformKnobs(located, file)?.code ?? located;
      const plugin = ts.transpileModule(knobbed, {
        fileName: file,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, sourceMap: true },
      }).outputText.replace(/\n\/\/# sourceMappingURL=.*\s*$/, "\n");
      assert.equal(result.js, plugin);
    });

    test(`${f}: JS has no import/export type leftovers and parses as JS`, () => {
      const result = compileSong(ts, names, text, file);
      assertOk(result);
      assert.doesNotMatch(result.js, /^\s*import\s/m);
      assert.doesNotMatch(result.js, /\bexport\s+type\b/);
      assert.doesNotMatch(result.js, /sourceMappingURL/);
      const check = ts.transpileModule(result.js, { fileName: "x.js", reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext } });
      assert.deepEqual(check.diagnostics?.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
    });

    test(`${f}: the source map points each mini literal at its exact place in the file`, () => {
      const result = compileSong(ts, names, text, file);
      assertOk(result);
      const map = JSON.parse(result.map);
      assert.deepEqual(map.sources, [file]);
      assert.deepEqual(map.sourcesContent, [text]);
      const { rewrites } = transformSong(text, file, names);
      assert.ok(rewrites.length > 0);
      for (const r of rewrites) {
        // __strudel_m(<literal>, <start>) in the JS: the literal maps back to <start>
        const call = `${text.slice(r.start, r.end)}, ${r.start})`;
        const at = result.js.indexOf(call);
        assert.ok(at >= 0, `literal at ${r.start} missing from the JS`);
        const gen = lineCol(result.js, at);
        assert.deepEqual(originalPosition(map, gen.line, gen.column), lineCol(text, r.start), `literal at ${r.start}`);
      }
    });

    test(`${f}: evaluates, and its haps' locations slice the file to mini tokens`, async () => {
      const result = compileSong(ts, names, text, file);
      const { song, file: evaluatedFile, version } = await evaluate(result);
      assert.equal(evaluatedFile, file);
      assert.equal(version, contentVersion(text));
      assert.equal(typeof song.createPattern, "function");
      const built = song.createPattern();
      const pattern = typeof (built as Pattern).queryArc === "function" ? (built as Pattern) : core.stack(...Object.values(built));
      const leaves = new Set<string>();
      for (const r of transformSong(text, file, names).rewrites) {
        for (const [a, b] of mini.getLeafLocations(`"${r.value.replace(/[\n\r\t\xA0]/g, " ")}"`, r.start, text)) leaves.add(`${a}:${b}`);
      }
      let located = 0;
      for (let c = 0; c < 8; c++) {
        for (const hap of pattern.queryArc(c, c + 1)) {
          const locs: { start: number; end: number }[] = hap.context?.locations ?? [];
          if (locs.length) located++;
          for (const { start, end } of locs) {
            assert.ok(leaves.has(`${start}:${end}`), `${start}:${end} ${JSON.stringify(text.slice(start, end))} is not a mini token`);
            assert.match(text.slice(start, end), /^[^\s"'`]+$/);
          }
        }
      }
      assert.ok(located > 0, "no hap carries a location");
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

describe("syntax errors", () => {
  test("are reported with a 1-based line and column", () => {
    const text = `import type { Song } from ".";\n\nconst a = ;\nexport default { name: "x", createPattern: () => s("bd") } satisfies Song;\n`;
    const result = compileSong(ts, names, text, "src/songs/broken.ts");
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.match(result.error.message, /^Syntax error: Expression expected/);
    assert.equal(result.error.line, 3);
    assert.equal(result.error.column, 11);
  });
});

describe("imports", () => {
  test("value imports from the song registry read globalThis.__strudelSongsIndex", async () => {
    const index = { isPattern: () => true, toPattern: (x: unknown) => x, marker: 42 };
    (globalThis as Record<string, unknown>).__strudelSongsIndex = index;
    try {
      const text = [
        `import type { Song } from ".";`,
        `import { isPattern, toPattern as tp } from "./index";`,
        `import * as songs from "./index.ts";`,
        `import {`,
        `  marker,`,
        `} from "./index.js";`,
        `const song = {`,
        `  name: "imports",`,
        `  helpers: { isPattern, tp, songs, marker },`,
        `  createPattern() {`,
        `    throw new Error("boom");`,
        `  },`,
        `};`,
        `export default song;`,
      ].join("\n");
      const result = compileSong(ts, names, text, "src/songs/imports.ts");
      assertOk(result);
      assert.doesNotMatch(result.js, /^\s*import\s/m);
      const { song } = await evaluate(result);
      const helpers = (song as Song & { helpers: Record<string, unknown> }).helpers;
      assert.equal(helpers.isPattern, index.isPattern);
      assert.equal(helpers.tp, index.toPattern);
      assert.equal(helpers.songs, index);
      assert.equal(helpers.marker, 42);
      // the rewrite kept the lines: the throw is still reported on line 11
      const err = await new Promise<PlayerError>((done) => {
        try {
          song.createPattern();
        } catch (e) {
          errorFrom("build", e, "imports", false, done);
        }
      });
      assert.deepEqual([err.file, err.line], ["src/songs/imports.ts", lineOf(text, "throw new")]);
    } finally {
      delete (globalThis as Record<string, unknown>).__strudelSongsIndex;
    }
  });

  test("imports used only as types are erased, so they are allowed", () => {
    const text = `import { Song } from "./other";\nconst song: Song = { name: "t", createPattern: () => s("bd") };\nexport default song;\n`;
    assertOk(compileSong(ts, names, text, "src/songs/t.ts"));
  });

  for (const [what, line, used, expected] of [
    ["a default import from the registry", `import index from ".";`, "index", /default import.*"\."/],
    ["another song", `import { x } from "./jynx";`, "x", /"\.\/jynx"/],
    ["a package", `import { note as n2 } from "@strudel/core";`, "n2", /"@strudel\/core"/],
    ["a URL", `import * as lib from "https://example.com/lib.js";`, "lib", /"https:\/\/example\.com\/lib\.js"/],
    ["a side-effect import", `import "./setup";`, "0", /"\.\/setup"/],
    ["a re-export", `export { isPattern } from ".";`, "0", /"\."/],
  ] as const) {
    test(`${what} is a compile error naming the specifier and its line`, () => {
      const text = `// a song\n\n${line}\nexport default { name: "t", used: ${used}, createPattern: () => s("bd") };\n`;
      const result = compileSong(ts, names, text, "src/songs/t.ts");
      assert.ok(!result.ok, "should not compile");
      assert.match(result.error.message, expected);
      assert.match(result.error.message, /line 3/);
      assert.equal(result.error.line, 3);
    });
  }
});

describe("runtime errors", () => {
  // TS erases the interface, so the JS lines differ from the file's: only the
  // source map gets these right.
  const text = [
    `import type { Song } from ".";`,
    ``,
    `interface Extra {`,
    `  a: number;`,
    `  b: string;`,
    `}`,
    `type Alias = Extra;`,
    ``,
    `const song: Song & { extra?: Alias } = {`,
    `  name: "Thrower",`,
    `  createPattern() {`,
    `    const kick = s("bd*4");`,
    `    return { kick: kick.gain((undefined as any).level) };`,
    `  },`,
    `};`,
    `export default song;`,
  ].join("\n");

  test("an error thrown in createPattern() points at the file's line and column", async () => {
    const result = compileSong(ts, names, text, "src/songs/thrower.ts");
    assertOk(result);
    assert.notEqual(lineOf(result.js, ".level"), lineOf(text, ".level"), "the test needs TS to shift lines");
    const { song } = await evaluate(result);
    const err = await new Promise<PlayerError>((done) => {
      try {
        song.createPattern();
        assert.fail("createPattern() should throw");
      } catch (e) {
        errorFrom("build", e, "thrower", false, done);
      }
    });
    const want = lineCol(text, text.indexOf(".level"));
    assert.equal(err.file, "src/songs/thrower.ts");
    assert.equal(err.line, want.line + 1);
    // V8 reports the property access; anywhere within `(undefined as any).level` is fine
    assert.ok(err.column! >= text.split("\n")[want.line].indexOf("(undefined") + 1 && err.column! <= want.column + 2, `column ${err.column}`);
  });

  test("an error thrown inside injected helper code points at the song's call site", async () => {
    // knob() runs through the appended __strudel_knob helper, which has no place in the file
    const bad = text.replace(`const kick = s("bd*4");`, `const kick = s("bd*4").gain(knob("level", "loud" as any, 0, 1));`);
    const result = compileSong(ts, names, bad, "src/songs/badknob.ts");
    const { song } = await evaluate(result);
    const err = await new Promise<PlayerError>((done) => {
      try {
        song.createPattern();
        assert.fail("createPattern() should throw");
      } catch (e) {
        errorFrom("build", e, "badknob", false, done);
      }
    });
    assert.match(err.message, /value must be a number/);
    assert.deepEqual([err.file, err.line], ["src/songs/badknob.ts", lineOf(bad, `knob("level"`)]);
  });

  test("an error thrown at module top level is located on the SongEvaluationError", async () => {
    const top = text.replace(`const song:`, `if (Math.max(1) > 0) throw new RangeError("top level");\nconst song:`);
    const result = compileSong(ts, names, top, "src/songs/top.ts");
    await assert.rejects(evaluate(result), (e: unknown) => {
      assert.ok(e instanceof SongEvaluationError, String(e));
      assert.equal(e.message, "top level");
      assert.equal(e.file, "src/songs/top.ts");
      assert.equal(e.line, lineOf(top, "throw new RangeError"));
      assert.ok(e.cause instanceof RangeError);
      return true;
    });
  });

  test("a module without a default-exported song is rejected clearly", async () => {
    const result = compileSong(ts, names, `export const song = { name: "x" };\n`, "src/songs/nodefault.ts");
    await assert.rejects(evaluate(result), /export default.*createPattern/);
  });
});
