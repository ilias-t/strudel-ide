// The genre starters (src/starters/) follow the house rules in CLAUDE.md:
// meta for the "new song" flow, a short loopable FORM, 2–3 knobs, track names
// that pick a role (colour + room lamp), a MASTER_DB / FADERS_DB mix block,
// and the right room. Sounds and events are checked by scripts/check-songs.mjs.
//
// Run: node --test test/starters.test.ts   (Node ≥ 22.18 strips TS types)

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, test } from "node:test";
import * as core from "@strudel/core";
import * as mini from "@strudel/mini";
import * as tonal from "@strudel/tonal";
import { KnobRegistry, installKnobGlobals } from "../src/engine/knobs.ts";

const root = resolve(import.meta.dirname, "..");
const dir = join(root, "src/starters");

await core.evalScope(core, mini, tonal);
mini.miniAllStrings();
for (const m of ["pianoroll", "punchcard", "scope", "tscope", "fscope", "spectrum", "spiral", "wordfall", "color", "markcss"]) {
  const proto = core.Pattern.prototype as unknown as Record<string, unknown>;
  if (!proto[m]) proto[m] = function (this: unknown) { return this; };
}
installKnobGlobals(new KnobRegistry(), core.pure);

/** The role table from src/engine/tracks.ts (read from its source: that module needs the browser build of Strudel) */
function rolePatterns(): [string, RegExp][] {
  const src = readFileSync(join(root, "src/engine/tracks.ts"), "utf8");
  const table = src.match(/const ROLE_PATTERNS[^=]*=\s*\[([\s\S]*?)\n\];/);
  assert.ok(table, "ROLE_PATTERNS not found in src/engine/tracks.ts");
  const rows = [...table[1].matchAll(/\["(\w+)",\s*\/(.+?)\/(\w*)\]/g)].map((m): [string, RegExp] => [m[1], new RegExp(m[2], m[3])]);
  assert.ok(rows.length >= 8, "could not parse ROLE_PATTERNS");
  return rows;
}
const ROLES = rolePatterns();
const roleOf = (name: string) => ROLES.find(([, re]) => re.test(name))?.[0] ?? "other";

/** The genres the "new song" flow offers, and which room each uses */
const GENRES: Record<string, "club" | "dusk"> = {
  house: "dusk",
  techno: "club",
  lofi: "dusk",
  ambient: "dusk",
  dnb: "club",
};

const ids = readdirSync(dir)
  .filter((f) => f.endsWith(".ts") && f !== "index.ts" && !f.startsWith("_"))
  .map((f) => f.replace(/\.ts$/, ""));

test("there is one starter per genre", () => {
  assert.deepEqual([...ids].sort(), Object.keys(GENRES).sort());
});

for (const id of ids) {
  describe(`starter ${id}`, async () => {
    const file = join(dir, `${id}.ts`);
    const source = readFileSync(file, "utf8");
    const mod = await import(pathToFileURL(file).href);
    const song = mod.default;

    test("meta: id matches the file, genre and blurb are set", () => {
      assert.equal(mod.meta?.id, id);
      assert.ok(typeof mod.meta.genre === "string" && mod.meta.genre.trim());
      assert.ok(typeof mod.meta.blurb === "string" && mod.meta.blurb.trim());
    });

    test("imports Song from ../songs (resolves from src/starters and src/songs alike)", () => {
      assert.match(source, /import type \{ Song \} from "\.\.\/songs";/);
    });

    test("a short loopable form: 3–5 sections from a FORM table", () => {
      assert.ok(Array.isArray(song.sections), "song.sections is missing");
      assert.ok(song.sections.length >= 3 && song.sections.length <= 5, `${song.sections.length} sections`);
      assert.match(source, /sections:\s*FORM\b/);
      for (const s of song.sections) {
        const bars = Array.isArray(s) ? s[1] : s.bars;
        assert.ok(Number.isInteger(bars) && bars > 0, `section ${JSON.stringify(s)}`);
      }
    });

    test("2–3 knobs worth turning", () => {
      const knobs = [...source.matchAll(/\bknob\(\s*"([^"]+)"/g)].map((m) => m[1]);
      assert.ok(knobs.length >= 2 && knobs.length <= 3, `knobs: ${knobs.join(", ")}`);
    });

    test("named tracks whose names pick a role", () => {
      const tracks = song.createPattern();
      assert.ok(tracks && typeof tracks === "object" && typeof tracks.queryArc !== "function", "createPattern() must return named tracks");
      const names = Object.keys(tracks);
      assert.ok(names.length >= 4, `only ${names.length} tracks`);
      for (const name of names) assert.notEqual(roleOf(name), "other", `track "${name}" matches no role in src/engine/tracks.ts`);
    });

    test("a MASTER_DB / FADERS_DB mix block applied with postgain", () => {
      assert.match(source, /const MASTER_DB = -?[\d.]+;/);
      assert.match(source, /const FADERS_DB\b/);
      assert.match(source, /postgain\(/);
    });

    test("the room suits the genre", () => {
      assert.equal(song.room ?? "dusk", GENRES[id] ?? "dusk");
    });

    test("has a bpm and a name", () => {
      assert.ok(typeof song.name === "string" && song.name.trim());
      assert.ok(typeof song.bpm === "number" && song.bpm >= 60 && song.bpm <= 200);
    });
  });
}
