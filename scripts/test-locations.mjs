// Tests for vite-plugins/strudel-locations.ts and src/live/highlights.ts (Node, no browser).
//
// For every song in src/songs/ plus scripts/fixtures/*.ts:
//   (a) the transformed TS still compiles (ts.transpileModule, syntactic diagnostics)
//   (b) the transformed song yields the same haps (whole, part, value) as the
//       untransformed one for N cycles
//   (c) every hap location is exactly a mini-notation leaf token of a rewritten
//       literal: [start, end) matches @strudel/mini's own leaf locations for that
//       literal at that file offset (so source.slice(start, end) is "bd", "c3", …)
// and reports the % of haps that carry locations. Also checks the fixture's
// rewrite selection, the version hash, and createHighlighter() on real songs.
//
// Usage: node scripts/test-locations.mjs [--cycles 16] [--verbose]

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import ts from "typescript";
import * as core from "@strudel/core";
import * as mini from "@strudel/mini";
import * as tonal from "@strudel/tonal";
import { transformSong, loadStrudelNames, contentVersion, isSongFile } from "../vite-plugins/strudel-locations.ts";
import { createHighlighter, stripImplicitLocations } from "../src/live/highlights.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "node_modules/.cache/strudel-locations");
mkdirSync(outDir, { recursive: true });

const args = process.argv.slice(2);
const cyclesIdx = args.indexOf("--cycles");
const CYCLES = cyclesIdx >= 0 ? Number(args[cyclesIdx + 1]) : 16;
const verbose = args.includes("--verbose");

// ─────────────────────────────────────────────────────────────────────────────
// Strudel globals (same as scripts/check-songs.mjs)
// ─────────────────────────────────────────────────────────────────────────────

const { log, warn } = console;
console.log = console.warn = () => {};
await core.evalScope(core, mini, tonal);
console.log = log;
console.warn = warn;
mini.miniAllStrings();
for (const m of ["pianoroll", "punchcard", "scope", "tscope", "fscope", "spectrum", "spiral", "wordfall", "color", "markcss"]) {
  if (!core.Pattern.prototype[m]) core.Pattern.prototype[m] = function () { return this; };
}
for (const fn of ["samples", "initStrudel", "aliasBank", "soundAlias"]) globalThis[fn] ??= async () => {};

const names = await loadStrudelNames();

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`   ❌ ${msg}`);
};
const check = (name, fn) => {
  try {
    fn();
  } catch (e) {
    fail(`${name}: ${e.message}`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Unit checks
// ─────────────────────────────────────────────────────────────────────────────

console.log("unit");
check("contentVersion vectors", () => {
  assert.equal(contentVersion(""), "811c9dc5");
  assert.equal(contentVersion("a"), "e40c292c");
  assert.equal(contentVersion("foobar"), "bf9cf968");
});
check("isSongFile", () => {
  assert.equal(isSongFile(join(root, "src/songs/jynx.ts"), root), true);
  assert.equal(isSongFile(join(root, "src/songs/jynx.ts?t=123"), root), true);
  assert.equal(isSongFile(join(root, "src/songs/jynx.ts?raw"), root), false);
  assert.equal(isSongFile(join(root, "src/songs/index.ts"), root), false);
  assert.equal(isSongFile(join(root, "src/songs/_template.ts"), root), false);
  assert.equal(isSongFile(join(root, "src/main.ts"), root), false);
  assert.equal(isSongFile(join(root, "src/songs/sub/x.ts"), root), false);
});
check("injected code keeps line numbers", () => {
  const src = 'const a = s("bd");\nconst b = note(\'c3\');\n';
  const { code } = transformSong(src, "src/songs/x.ts", names);
  const lines = code.split("\n");
  assert.match(lines[0], /^const a = s\(__strudel_m\("bd", 12\)\);$/);
  assert.match(lines[1], /^const b = note\(__strudel_m\('c3', 34\)\);$/);
  assert.match(code, /export const __strudel_file = "src\/songs\/x.ts";/);
  assert.match(code, new RegExp(`export const __strudel_version = "${contentVersion(src)}";`));
});
check("mini() with literal args → __strudel_mini", () => {
  const src = 'const a = mini("bd sd", "hh");\nconst b = mini(X, "hh");\n';
  const { code, rewrites } = transformSong(src, "src/songs/x.ts", names);
  assert.match(code.split("\n")[0], /^const a = __strudel_mini\(__strudel_m\("bd sd", 15\), __strudel_m\("hh", 24\)\);$/);
  assert.match(code.split("\n")[1], /^const b = mini\(X, "hh"\);$/); // mixed args: left alone
  assert.equal(rewrites.length, 2);
});
check("stripImplicitLocations covers string parser, mini and h", () => {
  restoreStockParsers();
  assert.ok(core.reify("bd sd").queryArc(0, 1)[0].context.locations?.length, "stock strudel should add relative locations");
  assert.ok(stripImplicitLocations());
  for (const [what, pat] of [["reify", core.reify("bd sd")], ["mini", globalThis.mini("bd sd")], ["h", globalThis.h('"bd sd"')], ["s", globalThis.s("bd sd")]]) {
    const haps = pat.queryArc(0, 1);
    assert.equal(haps.length, 2, what);
    for (const hap of haps) assert.equal(hap.context.locations?.length ?? 0, 0, `${what} still adds locations`);
  }
  assert.equal(globalThis.m("bd", 10).queryArc(0, 1)[0].context.locations[0].start, 11, "m(str, offset) must keep locations");
  restoreStockParsers();
});
check("local declarations shadow strudel names", () => {
  const src = 'const s = (x: string) => x;\ns("bd");\nnote("c3");\n';
  const { rewrites } = transformSong(src, "src/songs/x.ts", names);
  assert.deepEqual(rewrites.map((r) => r.value), ["c3"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Song runs
// ─────────────────────────────────────────────────────────────────────────────

const isPattern = (v) => typeof v?.queryArc === "function";
function toPattern(result) {
  if (isPattern(result)) return result;
  if (result && typeof result === "object" && Object.values(result).every(isPattern)) return core.stack(...Object.values(result));
  throw new Error("createPattern() must return a Pattern or a record of named Patterns");
}

const frac = (f) => (f ? f.toFraction() : "-");
const hapKey = (h) => `${frac(h.whole?.begin)}..${frac(h.whole?.end)} [${frac(h.part.begin)}..${frac(h.part.end)}] ${JSON.stringify(h.value)}`;

function queryAll(pattern) {
  const haps = [];
  for (let c = 0; c < CYCLES; c++) haps.push(...pattern.queryArc(c, c + 1));
  return haps;
}

function restoreStockParsers() {
  core.setStringParser(mini.mini);
  globalThis.mini = mini.mini;
  globalThis.h = mini.h;
}

let seq = 0;
async function load(code, name) {
  const out = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: false },
    reportDiagnostics: true,
    fileName: `${name}.ts`,
  });
  const diags = (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  const file = join(outDir, `${name}.${seq++}.mjs`);
  writeFileSync(file, out.outputText);
  return { mod: await import(pathToFileURL(file).href), diags };
}

/** All legit leaf locations of the rewritten literals, as "start:end" */
function leafSet(source, rewrites) {
  const set = new Set();
  for (const r of rewrites) {
    for (const [a, b] of mini.getLeafLocations(`"${r.value.replace(/[\n\r\t\xA0]/g, " ")}"`, r.start, source)) set.add(`${a}:${b}`);
  }
  return set;
}

const songsDir = join(root, "src/songs");
const fixturesDir = join(root, "scripts/fixtures");
const files = [
  ...readdirSync(songsDir).filter((f) => isSongFile(join(songsDir, f), root)).map((f) => join(songsDir, f)),
  ...readdirSync(fixturesDir).filter((f) => f.endsWith(".ts")).map((f) => join(fixturesDir, f)),
];

const results = [];
for (const path of files) {
  const id = basename(path, ".ts");
  const rel = path.slice(root.length + 1);
  const source = readFileSync(path, "utf8");
  console.log(rel);
  let xf;
  try {
    xf = transformSong(source, rel, names);
  } catch (e) {
    fail(`transform threw: ${e.stack}`);
    continue;
  }

  // (a) compiles
  const orig = await load(source, `${id}.orig`).catch((e) => ({ err: e }));
  const trans = await load(xf.code, `${id}.xf`).catch((e) => ({ err: e }));
  if (trans.err) { fail(`(a) transformed module failed to load: ${trans.err.message}`); continue; }
  if (orig.err) { fail(`original module failed to load: ${orig.err.message}`); continue; }
  if (trans.diags.length) fail(`(a) transformed code has diagnostics: ${trans.diags.join("; ")}`);
  check("(a) exports", () => {
    assert.equal(trans.mod.__strudel_file, rel);
    assert.equal(trans.mod.__strudel_version, contentVersion(source));
  });

  // (b) same haps — original with stock strudel (string parser, mini, h),
  // transformed with the location-free versions the highlighter installs (as
  // in the browser). Those stay installed afterwards: patterns may parse
  // strings lazily at query time (e.g. inside callbacks), so the highlighter
  // checks below must query under the same setup as the browser.
  restoreStockParsers();
  let origHaps, xfHaps, xfPattern;
  try {
    origHaps = queryAll(toPattern(orig.mod.default.createPattern()));
    assert.ok(stripImplicitLocations(), "stripImplicitLocations failed");
    xfPattern = toPattern(trans.mod.default.createPattern());
    xfHaps = queryAll(xfPattern);
  } catch (e) {
    fail(`(b) evaluation threw: ${e.stack}`);
    continue;
  }
  check("(b) same haps", () => {
    const a = origHaps.map(hapKey);
    const b = xfHaps.map(hapKey);
    assert.equal(b.length, a.length, `hap count ${b.length} ≠ ${a.length}`);
    for (let i = 0; i < a.length; i++) assert.equal(b[i], a[i], `hap #${i} differs`);
  });

  // (c) every location is a leaf token of a rewritten literal
  const leaves = leafSet(source, xf.rewrites);
  let withLoc = 0;
  let valueMatch = 0;
  const bad = new Map();
  const tokens = new Map();
  for (const hap of xfHaps) {
    const locs = hap.context.locations ?? [];
    if (locs.length) withLoc++;
    let matched = false;
    for (const { start, end } of locs) {
      const text = source.slice(start, end);
      if (!leaves.has(`${start}:${end}`) || !text || /[\s"'`]/.test(text)) bad.set(`${start}:${end} ${JSON.stringify(text)}`, 1);
      tokens.set(text, (tokens.get(text) ?? 0) + 1);
      if (!matched && hap.value && typeof hap.value === "object") {
        matched = Object.values(hap.value).some((v) => String(v) === text);
      } else if (!matched) matched = String(hap.value) === text;
    }
    if (matched) valueMatch++;
  }
  if (bad.size) fail(`(c) ${bad.size} locations are not leaf tokens of rewritten literals: ${[...bad.keys()].slice(0, 8).join(", ")}`);

  const pct = (n) => (xfHaps.length ? ((100 * n) / xfHaps.length).toFixed(1) : "0.0");
  const top = [...tokens.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t).join(" ");
  console.log(
    `   ${xf.rewrites.length} literals rewritten · ${xfHaps.length} haps / ${CYCLES} cycles · ` +
      `${pct(withLoc)}% with locations · ${pct(valueMatch)}% have a value equal to a highlighted token`,
  );
  if (verbose) console.log(`   tokens: ${top}`);
  results.push({ id, rel, source, xf, pattern: xfPattern, leaves });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture: which literals are rewritten
// ─────────────────────────────────────────────────────────────────────────────

console.log("fixture selection");
const tricky = results.find((r) => r.id === "tricky-song");
check("tricky-song rewrites", () => {
  assert.ok(tricky, "fixture missing");
  const got = tricky.xf.rewrites.map((r) => r.value).sort();
  const want = [
    "bd*2 [~ bd]", "RolandTR909", "~ sd:2", "RolandTR808", "<c3 e3\n      g3 b3>", "triangle",
    "0 [2 4]", "A:minor", "48 52", "<0 12>", "bd(3,8)", "0.5 .8", "hh*4", "0.5", "2", "c3 e3", "g3",
    "hh*8", "bd sd", "~ hh", "cp*2",
  ].sort();
  assert.deepEqual(got, want);
  for (const r of tricky.xf.rewrites) {
    const q = tricky.source[r.start];
    assert.ok(`"'\``.includes(q) && tricky.source[r.end - 1] === q, `offset ${r.start} is not a quote`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// createHighlighter on real patterns
// ─────────────────────────────────────────────────────────────────────────────

console.log("highlighter");
for (const r of results) {
  check(`${r.id}`, () => {
    let t = 0;
    let pattern = r.pattern;
    const calls = [];
    const hl = createHighlighter({
      getPattern: () => pattern,
      getTime: () => t,
      getCps: () => 0.5,
      latency: 0,
      stripImplicitLocations: false,
      onRanges: (ranges) => calls.push(ranges),
    });
    let frames = 0;
    for (t = 0; t < 8; t += 1 / 60) {
      hl.tick();
      frames++;
    }
    assert.ok(calls.length > 0, "never emitted");
    assert.ok(calls.length < frames, "emitted on every frame (no change detection)");
    for (const ranges of calls) {
      for (let i = 0; i < ranges.length; i++) {
        const [a, b] = ranges[i];
        assert.ok(r.leaves.has(`${a}:${b}`), `range ${a}:${b} is not a leaf`);
        if (i) assert.ok(ranges[i - 1][0] < a || (ranges[i - 1][0] === a && ranges[i - 1][1] < b), "not sorted/deduped");
      }
    }
    // same time twice → no new emit
    hl.tick();
    const n = calls.length;
    hl.tick();
    assert.equal(calls.length, n);
    // a new pattern (hot-swap) re-emits even when the ranges are identical
    pattern = r.pattern.withValue((v) => v);
    hl.tick();
    assert.equal(calls.length, n + 1, "no re-emit after a pattern swap");
    assert.deepEqual(calls.at(-1), calls.at(-2));
    calls.pop();
    // stopping → one empty emit, then silence
    pattern = null;
    hl.tick();
    assert.deepEqual(calls.at(-1), []);
    hl.tick();
    assert.equal(calls.length, n + 1);
  });
}

// ─────────────────────────────────────────────────────────────────────────────

console.log(failures ? `\n❌ ${failures} failure(s)` : "\n✅ locations OK");
process.exit(failures ? 1 : 0);
