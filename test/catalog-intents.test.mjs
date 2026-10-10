// Search by sound: the intent table (scripts/lib/catalog/intents.mjs → src/catalog/intents.json).
// Every intent ties a way people describe a sound to real functions, a call the palette inserts
// after an expression, and a recipe the palette plays (Shift+Enter) and inserts where an expression
// starts. Each recipe is evaluated headlessly in check-songs' scope, like the snippets.
//
// Run: node --test test/catalog-intents.test.mjs   (reads the committed catalog JSON; never fetches)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import * as core from "@strudel/core";
import * as mini from "@strudel/mini";
import * as tonal from "@strudel/tonal";
import { KnobRegistry, installKnobGlobals } from "../src/engine/knobs.ts";
import { INTENTS } from "../scripts/lib/catalog/intents.mjs";
import { knownSoundsFromCatalog, soundKey } from "../scripts/lib/catalog/known-sounds.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (file) => JSON.parse(readFileSync(join(root, "src/catalog", file), "utf8"));
const functions = new Map(read("functions.json").functions.map((f) => [f.name, f]));
const snippets = new Map(read("snippets.json").snippets.map((s) => [s.id, s]));
const known = knownSoundsFromCatalog(read("sounds.json"));

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

/** previewable() from src/ui/discover/previewable.ts, built from its own regex */
function previewableFromSource() {
  const src = readFileSync(join(root, "src/ui/discover/previewable.ts"), "utf8");
  const m = src.match(/const UNSAFE =\s*\/(.+)\/([a-z]*);\n/);
  assert.ok(m, "UNSAFE not found in src/ui/discover/previewable.ts");
  const unsafe = new RegExp(m[1], m[2]);
  assert.match(src, /return code\.trim\(\)\.length > 0 && !UNSAFE\.test\(code\);/, "previewable() changed: update this mirror");
  return (code) => code.trim().length > 0 && !unsafe.test(code);
}
const previewable = previewableFromSource();

const evaluate = (code) => new Function(`return (${code})`)();

describe("intents: the table", () => {
  test("the JSON is the curated source, copied", () => {
    assert.deepEqual(read("intents.json").intents, INTENTS);
  });

  test("60–100 intents", () => {
    assert.ok(INTENTS.length >= 60 && INTENTS.length <= 100, `${INTENTS.length} intents`);
  });

  test("ids are unique, lowercase and kebab-case", () => {
    const ids = INTENTS.map((i) => i.id);
    assert.equal(ids.length, new Set(ids).size, "duplicate ids");
    for (const id of ids) assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, id);
  });

  test("phrases are unique across intents, lowercase, trimmed, single-spaced", () => {
    const seen = new Map();
    for (const i of INTENTS) {
      assert.ok(Array.isArray(i.phrases) && i.phrases.length > 0, `${i.id}: no phrases`);
      for (const p of i.phrases) {
        assert.equal(p, p.toLowerCase(), `${i.id}: "${p}" isn't lowercase`);
        assert.match(p, /^\S+( \S+)*$/, `${i.id}: "${p}" has stray spaces`);
        assert.ok(!seen.has(p), `"${p}" is in ${seen.get(p)} and ${i.id}`);
        seen.set(p, i.id);
      }
    }
  });

  test("every function exists in functions.json; the main one (first) chains as a method", () => {
    for (const i of INTENTS) {
      assert.ok(i.functions.length > 0, `${i.id}: no functions`);
      for (const f of i.functions) assert.ok(functions.has(f), `${i.id}: no function "${f}"`);
      const main = functions.get(i.functions[0]);
      assert.ok(main.kind === "method" || main.kind === "both", `${i.id}: ${main.name} is a ${main.kind}, not a method`);
      assert.equal(new Set(i.functions).size, i.functions.length, `${i.id}: a function twice`);
    }
  });

  test("a tip on every intent: one short line", () => {
    for (const i of INTENTS) {
      assert.ok(typeof i.tip === "string" && i.tip.trim(), `${i.id}: no tip`);
      assert.ok(!i.tip.includes("\n") && i.tip.length <= 110, `${i.id}: tip too long (${i.tip.length})`);
    }
  });

  test("snippet ids exist; a role is a TrackRole and comes with a snippet of that role (the track builder takes it)", () => {
    const roles = trackRoles();
    for (const i of INTENTS) {
      for (const id of i.snippets ?? []) assert.ok(snippets.has(id), `${i.id}: no snippet "${id}"`);
      if (i.role === undefined) continue;
      assert.ok(roles.includes(i.role), `${i.id}: role "${i.role}" is not a TrackRole`);
      const first = snippets.get(i.snippets?.[0]);
      assert.ok(first, `${i.id}: a role needs a snippet for the track builder`);
      assert.equal(first.role, i.role, `${i.id}: snippet ${first.id} is a ${first.role}, not a ${i.role}`);
    }
  });

  test("the people-words the palette promises", () => {
    const by = new Map(INTENTS.map((i) => [i.id, i]));
    const has = (id, ...phrases) => {
      const i = by.get(id);
      assert.ok(i, `no intent "${id}"`);
      for (const p of phrases) assert.ok(i.phrases.includes(p), `${id}: no phrase "${p}"`);
    };
    has("wetter", "wetter", "more reverb", "reverb", "spacious", "roomy", "wash");
    assert.deepEqual(by.get("wetter").functions.slice(0, 3), ["room", "size", "delay"]);
    has("wobble", "wobble");
    has("acid-bass", "acid", "acid bass", "303", "squelch");
    has("lofi-drums", "lo-fi drums", "dusty", "crunchy");
    has("swing", "swing");
  });
});

describe("intents: the call (Enter after an expression)", () => {
  for (const i of INTENTS) {
    test(`${i.id}: .${i.call} chains onto a pattern`, () => {
      assert.ok(typeof i.call === "string", `${i.id}: no call`);
      assert.ok(i.call.startsWith(`${i.functions[0]}(`) && i.call.endsWith(")"), `${i.id}: call "${i.call}" isn't ${i.functions[0]}(…)`);
      assert.ok(previewable(`s("bd").${i.call}`), "not previewable");
      const pattern = evaluate(`note("c3 e3").s("triangle").${i.call}`);
      assert.ok(pattern instanceof core.Pattern, "not a Pattern");
      pattern.queryArc(0, 2);
    });
  }
});

describe("intents: the recipe (Shift+Enter plays it, Enter inserts it where an expression starts)", () => {
  for (const i of INTENTS) {
    test(`${i.id}: one expression that plays known sounds at sane levels`, () => {
      const code = i.recipe;
      assert.ok(typeof code === "string" && code.trim(), `${i.id}: no recipe`);
      assert.ok(!/[`;]/.test(code), "template literal or statement");
      assert.ok(!/["']\s*\.\w/.test(code), "method called on a string literal");
      assert.ok(code.includes(`${i.functions[0]}(`), `the recipe doesn't use ${i.functions[0]}`);
      assert.ok(previewable(code), "previewable() refuses it");
      const pattern = evaluate(code);
      assert.ok(pattern instanceof core.Pattern, "not a Pattern");
      assert.ok(pattern.queryArc(0, 1).some((h) => h.hasOnset()), "silent in the first bar (the palette plays two)");
      const haps = pattern.queryArc(0, 4);
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
