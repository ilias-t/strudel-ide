// Round-trip tests for the strudel.cc bridge (scripts/strudel-cc/):
//   1. export: every song, evaluated the way strudel.cc evaluates REPL code
//      (its transpiler + core's repl), plays the same haps as the song
//   2. import: real strudel.cc snippets (scripts/strudel-cc/fixtures/*.js)
//      become songs that type-check, pass check-songs and play the same haps
//      as the snippet does on strudel.cc
//   3. round trip: song → export → import → same haps
//   4. share links decode back to the exact code
//
// Usage: node scripts/test-strudel-cc.mjs [--cycles 16] [--verbose] [song-or-fixture ...]

import "./strudel-cc/quiet.mjs";
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { root, loadSong, songPattern, evalStrudelCc, hapKeys, diffHaps } from "./strudel-cc/runtime.mjs";
import { exportSong } from "./strudel-cc/export.mjs";
import { importCode } from "./strudel-cc/import.mjs";
import { codeToUrl, urlToCode } from "./strudel-cc/shared.mjs";
import { songDiagnostics } from "./strudel-cc/tsproject.mjs";

const args = process.argv.slice(2);
const cyclesIdx = args.indexOf("--cycles");
const CYCLES = cyclesIdx >= 0 ? Number(args[cyclesIdx + 1]) : 16;
const verbose = args.includes("--verbose");
const only = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--cycles");
const want = (name) => only.length === 0 || only.includes(name);

const songsDir = join(root, "src/songs");
const fixturesDir = join(root, "scripts/strudel-cc/fixtures");
const tmp = mkdtempSync(join(tmpdir(), "strudel-cc-"));

let failed = 0;
let passed = 0;

function report(name, problems, detail = "") {
  if (problems.length) {
    failed++;
    console.log(`❌ ${name}`);
    for (const p of problems) console.log(`   ${p.replace(/\n/g, "\n   ")}`);
  } else {
    passed++;
    console.log(`✅ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const close = (a, b) => Math.abs(a - b) < 1e-9;

/** Write an imported song where Node can import it and type-check it as if it lived in src/songs. */
async function checkImported(name, ts, problems) {
  const virtual = join(songsDir, `__strudel_cc_test_${name}.ts`);
  const diags = songDiagnostics(virtual, ts);
  for (const d of diags) problems.push(`type error line ${d.line + 1}: ${d.message}`);
  const file = join(tmp, `${name}.ts`);
  writeFileSync(file, ts);
  return loadSong(file);
}

// ─── 1. export every song ─────────────────────────────────────────────────

const songIds = readdirSync(songsDir)
  .filter((f) => f.endsWith(".ts") && f !== "index.ts" && !f.startsWith("_") && !f.startsWith("__"))
  .map((f) => f.replace(/\.ts$/, ""))
  .filter(want);

for (const id of songIds) {
  const problems = [];
  let detail = "";
  try {
    const song = await loadSong(join(songsDir, `${id}.ts`));
    const expected = hapKeys(songPattern(song), CYCLES);
    const { code, warnings } = await exportSong(id);
    if (verbose) for (const w of warnings) console.log(`   ⚠️  ${w}`);
    const { pattern, cps } = await evalStrudelCc(code);
    const diff = diffHaps(expected, hapKeys(pattern, CYCLES));
    if (diff) problems.push(`haps differ from the song:\n${diff}`);
    const bpm = song.bpm ?? 120;
    if (!close(cps, bpm / 240)) problems.push(`tempo: cps ${cps}, expected ${bpm / 240} (${bpm} bpm)`);
    if (urlToCode(codeToUrl(code)) !== code) problems.push("share link doesn't decode to the same code");
    detail = `${expected.length} haps / ${CYCLES} cycles, ${code.length} chars`;

    // ─── 3. round trip: export → import → same haps
    const { ts } = importCode(code, { id: `${id}-rt`, name: song.name });
    const back = await checkImported(`rt_${id.replace(/-/g, "_")}`, ts, problems);
    const rtDiff = diffHaps(expected, hapKeys(songPattern(back), CYCLES));
    if (rtDiff) problems.push(`round trip (export → import) haps differ:\n${rtDiff}`);
    if ((back.bpm ?? 120) !== bpm) problems.push(`round trip bpm ${back.bpm}, expected ${bpm}`);
  } catch (e) {
    problems.push(`threw: ${e?.stack ?? e}`);
  }
  report(`export ${id}`, problems, detail);
}

// ─── 2. import strudel.cc snippets ────────────────────────────────────────

const fixtures = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".js"))
  .map((f) => f.replace(/\.js$/, ""))
  .filter(want);

for (const fx of fixtures) {
  const problems = [];
  let detail = "";
  try {
    const code = readFileSync(join(fixturesDir, `${fx}.js`), "utf8");
    // import from the share link, like a user pasting one
    const url = codeToUrl(code);
    if (urlToCode(url) !== code) problems.push("share link doesn't decode to the same code");
    const { pattern, cps } = await evalStrudelCc(code);
    const expected = hapKeys(pattern, CYCLES);
    const { ts, warnings } = importCode(urlToCode(url), { id: fx, source: url });
    if (verbose) for (const w of warnings) console.log(`   ⚠️  ${w}`);
    const song = await checkImported(fx.replace(/-/g, "_"), ts, problems);
    const diff = diffHaps(expected, hapKeys(songPattern(song), CYCLES));
    if (diff) problems.push(`haps differ from strudel.cc's:\n${diff}`);
    if (!close((song.bpm ?? 120) / 240, cps)) problems.push(`tempo: bpm ${song.bpm}, strudel.cc cps ${cps}`);
    detail = `${expected.length} haps / ${CYCLES} cycles`;
  } catch (e) {
    problems.push(`threw: ${e?.stack ?? e}`);
  }
  report(`import ${fx}`, problems, detail);
}

// check-songs on the imported fixtures, run as is on a scratch copy of the
// project layout (scripts/check-songs.mjs + src/songs/<id>.ts + node_modules),
// so nothing appears in src/songs (where a running dev server would see it)
if (fixtures.length) {
  const problems = [];
  const scratch = join(tmp, "project");
  mkdirSync(join(scratch, "scripts"), { recursive: true });
  mkdirSync(join(scratch, "src/songs"), { recursive: true });
  copyFileSync(join(root, "scripts/check-songs.mjs"), join(scratch, "scripts/check-songs.mjs"));
  symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
  try {
    for (const fx of fixtures) {
      const code = readFileSync(join(fixturesDir, `${fx}.js`), "utf8");
      writeFileSync(join(scratch, "src/songs", `${fx}.ts`), importCode(code, { id: fx }).ts);
    }
    const res = spawnSync(process.execPath, [join(scratch, "scripts/check-songs.mjs")], { encoding: "utf8" });
    if (res.status !== 0) problems.push(res.stdout + res.stderr);
    else if (verbose) console.log(res.stdout.trimEnd().replace(/^/gm, "   "));
  } catch (e) {
    problems.push(`threw: ${e?.stack ?? e}`);
  }
  report(`check-songs on ${fixtures.length} imported fixtures`, problems);
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
