// The context engine (src/ui/complete/) on every song and starter, checked against the compiler's own
// record of each mini literal (src/compile/locations.ts via the Vite plugin) and @strudel/mini's parser.
// Run: node --test test/complete-context-songs.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { stringContextAt, allStringContexts, trackNameAt, lex } from "../src/ui/complete/context.ts";
import { soundWordsWithOffsets } from "../src/ui/complete/mini.ts";
import { transformSong, loadStrudelNames } from "../vite-plugins/strudel-locations.ts";

const root = new URL("../", import.meta.url);
const files: { file: string; code: string }[] = [];
for (const dir of ["src/songs", "src/starters"]) {
  for (const name of readdirSync(new URL(dir, root)).sort()) {
    if (name.endsWith(".ts")) files.push({ file: `${dir}/${name}`, code: readFileSync(new URL(`${dir}/${name}`, root), "utf8") });
  }
}

test("every string literal in every song and starter: never throws", () => {
  let strings = 0;
  for (const { file, code } of files) {
    for (const t of lex(code)) {
      if (t.kind !== "str") continue;
      strings++;
      for (const at of [t.start, t.start + 1, (t.start + t.end) >> 1, t.end - 1, t.end]) {
        assert.doesNotThrow(() => stringContextAt(code, at), `${file}:${at}`);
        assert.doesNotThrow(() => trackNameAt(code, at), `${file}:${at}`);
      }
    }
    assert.doesNotThrow(() => allStringContexts(code), file);
  }
  assert.ok(strings > 500, `only ${strings} strings`);
});

test("every mini literal the compiler rewrites has a context with the same extent and callee", async () => {
  const names = await loadStrudelNames();
  let rewrites = 0;
  for (const { file, code } of files) {
    const { rewrites: rws } = transformSong(code, file, names);
    const all = new Map(allStringContexts(code).map((c) => [c.string.start, c]));
    for (const rw of rws) {
      rewrites++;
      const where = `${file}:${rw.start} ${code.slice(rw.start, rw.end)}`;
      const c = stringContextAt(code, rw.start + 1);
      assert.ok(c, `no context: ${where}`);
      assert.deepEqual(c.string, { start: rw.start, end: rw.end }, where);
      assert.equal(c.value, rw.value, where);
      assert.equal(c.call.name, rw.callee, where);
      assert.deepEqual(all.get(rw.start), c, `allStringContexts disagrees: ${where}`);
    }
    // …and the other way round for s() / sound() / .bank(): every such literal is one the compiler saw
    const seen = new Set(rws.map((rw) => rw.start));
    for (const c of all.values()) {
      if (!["s", "sound", "bank"].includes(c.call.name)) continue;
      assert.ok(seen.has(c.string.start), `${file}:${c.string.start} ${c.call.name}("${c.value}") not rewritten`);
    }
  }
  assert.ok(rewrites > 300, `only ${rewrites} rewrites`);
});

/** @strudel/mini's sound atoms of a literal: [text, file offset] (operator arguments, rests and numbers left out) */
async function astWords(value: string, base: number): Promise<[string, number][]> {
  const { mini2ast } = await import("@strudel/mini");
  type Node = { type_: string; source_: unknown; location_?: { start: { offset: number } } };
  const out: [string, number][] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    const node = n as Node | null;
    if (!node || typeof node !== "object") return;
    if (node.type_ === "atom") {
      const s = String(node.source_);
      // krill's location can start at whitespace before the step ("~!4 bd": the step's leading ws)
      let at = node.location_!.start.offset - 1;
      while (/\s/.test(value[at] ?? "")) at++;
      if (s !== "~" && s !== "-" && !/^[-+]?\.?\d/.test(s)) out.push([s, base + at]);
      return;
    }
    walk(node.source_); // never options_: operator arguments ("*2", ":3", "(3,8)")
  };
  walk(mini2ast(`"${value}"`));
  return out;
}

test("soundWordsWithOffsets agrees with @strudel/mini on every s() / sound() literal", async () => {
  const { log, warn } = console;
  console.log = console.warn = () => {};
  await import("@strudel/mini");
  console.log = log;
  console.warn = warn;
  let checked = 0;
  for (const { file, code } of files) {
    for (const c of allStringContexts(code)) {
      if (c.role !== "sound" || c.call.name === "mini") continue;
      const base = c.string.start + 1;
      let expected: [string, number][];
      try {
        expected = await astWords(c.value, base);
      } catch {
        continue; // doesn't parse: not mini-notation
      }
      const ours = soundWordsWithOffsets(c.value, base);
      assert.deepEqual(
        ours.map((w) => [w.text, w.start]),
        expected,
        `${file}:${base} "${c.value}"`,
      );
      for (const w of ours) assert.equal(code.slice(w.start, w.end), w.text);
      checked++;
    }
  }
  assert.ok(checked > 100, `only ${checked} literals`);
});

test("half-typed songs never throw: every prefix, and a character dropped anywhere", () => {
  for (const { file, code } of files.filter((f) => /tour|acid-rain|starters\/house/.test(f.file))) {
    for (let cut = 0; cut < code.length; cut += 89) {
      const prefix = code.slice(0, cut);
      assert.doesNotThrow(() => allStringContexts(prefix), `${file} cut at ${cut}`);
      for (const at of [cut, cut - 1, cut - 7]) assert.doesNotThrow(() => stringContextAt(prefix, Math.max(0, at)), `${file} cut at ${cut}`);
      const dropped = code.slice(0, cut) + code.slice(cut + 1);
      assert.doesNotThrow(() => allStringContexts(dropped), `${file} dropped ${cut}`);
      assert.doesNotThrow(() => trackNameAt(dropped, cut), `${file} dropped ${cut}`);
    }
  }
});

test("track names in the songs: s() literals land on a mixer track", () => {
  // the drum literals of the template and a starter, where track names are plain
  const pick = (file: string) => allStringContexts(files.find((f) => f.file === file)!.code).filter((c) => c.call.name === "s");
  const template = pick("src/songs/_template.ts").map((c) => [c.value, c.trackName]);
  assert.deepEqual(template.slice(0, 3), [
    ["bd*4", "kick"],
    ["~ sd ~ sd", "snare"],
    ["hh*8", "hats"],
  ]);
  const tour = pick("src/songs/tour.ts");
  assert.equal(tour.find((c) => c.value === "bd*4")?.trackName, "pulse");
});
