// The cheat sheet's pure parts (src/ui/discover/cheatsheet-data.ts): the
// curated mini-notation and function rows, their strudel.cc links, the sound
// families, the rows joined with the catalog's optional ranges and doc URLs,
// and search across every tab and the intent table.
// Every example is checked the way snippets are (test/catalog.test.mjs): it
// passes previewable(), evaluates headlessly to a pattern with events, plays
// only known sounds and keeps gain ≤ 1.
// Run: node --test test/discover-cheatsheet.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import * as core from "@strudel/core";
import * as mini from "@strudel/mini";
import * as tonal from "@strudel/tonal";
// @ts-expect-error -- a JSDoc-typed .mjs helper with no .d.ts (check-songs' and test/catalog.test.mjs' rule for known sounds)
import { knownSoundsFromCatalog, soundKey } from "../scripts/lib/catalog/known-sounds.mjs";
import type { CompletionsCatalog, FunctionsCatalog, Intent, SoundsCatalog } from "../src/ui/discover/catalog.ts";
import { previewable } from "../src/ui/discover/previewable.ts";
import {
  FUNCTION_GROUPS,
  MINI,
  TABS,
  buildIndex,
  docHref,
  formatRange,
  functionRows,
  searchSheet,
  soundFamilies,
  type DocLink,
  type KeyRow,
} from "../src/ui/discover/cheatsheet-data.ts";

const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")) as T;
const sounds = read<SoundsCatalog>("../src/catalog/sounds.json");
const functions = read<FunctionsCatalog>("../src/catalog/functions.json");
type DocsPage = { title: string; anchors?: string[]; headings?: { id: string }[] };
const docs = read<{ base: string; pages: Record<string, DocsPage> }>("../scripts/lib/catalog/strudel-docs.json");
/** A page's heading ids, from either snapshot shape (anchors: string[], or headings: { id }[]) */
const anchorsOf = (page: DocsPage): string[] => page.anchors ?? page.headings?.map((h) => h.id) ?? [];

const completions: CompletionsCatalog = {
  functions: {
    lpf: {
      category: "effects",
      rank: 4,
      availability: "ok",
      synonyms: ["cutoff", "ctf", "lp"],
      range: { min: 20, max: 20000, unit: "Hz", log: true },
      docUrl: "https://strudel.cc/learn/effects/#lpf",
    },
    room: { category: "effects", rank: 7, availability: "ok", range: { min: 0, max: 1 }, docUrl: "/learn/effects/#room" },
  },
  after: {},
};

const wetter: Intent = {
  id: "wetter",
  phrases: ["wetter", "more reverb", "spacious"],
  functions: ["room", "size", "delay"],
  recipe: 'note("c3 e3 g3").s("piano").room(0.8).size(4)',
  tip: "room 0–1 is the send; size grows the space",
};
const wobble: Intent = { id: "wobble", phrases: ["wobble", "wub"], functions: ["lpf", "sine", "range"] };

const keys: KeyRow[] = [
  { keys: "Space", what: "Play / stop" },
  { keys: "Ctrl/⌘ + K", what: "Command palette: sounds, functions, snippets, songs, actions" },
];

const allExamples = () => [
  ...MINI.map((r) => ({ where: `mini ${r.id}`, code: r.example })),
  ...FUNCTION_GROUPS.flatMap((g) => g.fns.map((f) => ({ where: `${g.id}/${f.name}`, code: f.example }))),
  { where: "fixture intent recipe", code: wetter.recipe! },
];

const allLinks = (): { where: string; link: DocLink }[] => [
  ...MINI.map((r) => ({ where: `mini ${r.id}`, link: r.doc })),
  ...FUNCTION_GROUPS.flatMap((g) => g.fns.filter((f) => f.doc).map((f) => ({ where: f.name, link: f.doc! }))),
];

describe("tabs", () => {
  test("Mini-notation · Functions · Sounds · Keys, in that order", () => {
    assert.deepEqual(
      TABS.map((t) => [t.id, t.label]),
      [
        ["mini", "Mini-notation"],
        ["functions", "Functions"],
        ["sounds", "Sounds"],
        ["keys", "Keys"],
      ]
    );
  });
});

describe("mini-notation rows", () => {
  test("one row per operator, ids unique", () => {
    const symbols = MINI.map((r) => r.symbol);
    for (const s of ["~", "[ ]", "< >", "{ }", ",", "*", "/", "!", "@", "_", "?", ":", "(3,8)", "|", "."]) {
      assert.ok(symbols.includes(s), `no row for ${s}`);
    }
    assert.equal(new Set(MINI.map((r) => r.id)).size, MINI.length);
    for (const r of MINI) {
      assert.ok(r.name.trim() && r.meaning.trim(), `${r.id}: name and meaning`);
      assert.ok(!r.meaning.includes("\n"), `${r.id}: one line`);
    }
  });

  test("each example uses its operator", () => {
    for (const r of MINI) {
      const parts = r.symbol === "(3,8)" ? ["(", ","] : r.symbol === "␣" ? [" "] : r.symbol.split(" ");
      const literal = /"([^"]*)"/.exec(r.example)?.[1] ?? "";
      for (const p of parts) assert.ok(literal.includes(p), `${r.id}: ${r.example} doesn't use ${p}`);
    }
  });
});

describe("function rows", () => {
  test("eight groups, about 60 functions, each named once and real", () => {
    assert.deepEqual(
      FUNCTION_GROUPS.map((g) => g.label),
      ["Rhythm", "Pitch", "Sound", "Filter", "Space", "Dynamics", "Modulation", "Randomness"]
    );
    const names = FUNCTION_GROUPS.flatMap((g) => g.fns.map((f) => f.name));
    assert.ok(names.length >= 55 && names.length <= 70, `${names.length} functions`);
    assert.equal(new Set(names).size, names.length, "a function listed twice");
    const real = new Set(functions.functions.map((f) => f.name));
    assert.deepEqual(names.filter((n) => !real.has(n)), [], "not in functions.json");
    const categories = new Set(functions.categories.map((c) => c.id));
    for (const g of FUNCTION_GROUPS) assert.ok(categories.has(g.library), `${g.id}: library category ${g.library}`);
    for (const g of FUNCTION_GROUPS)
      for (const f of g.fns) {
        assert.ok(f.text.trim() && !f.text.includes("\n"), `${f.name}: one sentence`);
        assert.ok(f.example.includes(`${f.name}(`) || new RegExp(`\\b${f.name}\\b`).test(f.example), `${f.name}: its example doesn't use it`);
      }
  });

  test("without catalog data: no range, the curated link, no synonyms", () => {
    const rows = functionRows(null);
    const lpf = rows.find((r) => r.name === "lpf")!;
    assert.equal(lpf.group, "filter");
    assert.equal(lpf.range, undefined);
    assert.equal(lpf.href, "https://strudel.cc/learn/effects/#lpf");
    assert.deepEqual(lpf.synonyms, []);
    assert.equal(lpf.display, ".lpf");
    const s = rows.find((r) => r.name === "sine")!;
    assert.equal(s.display, "sine", "a value isn't shown as a method");
  });

  test("with completions: its range, its doc URL (relative made absolute), its synonyms", () => {
    const rows = functionRows(completions);
    const lpf = rows.find((r) => r.name === "lpf")!;
    assert.equal(lpf.range, "20–20000 Hz");
    assert.equal(lpf.href, "https://strudel.cc/learn/effects/#lpf");
    assert.deepEqual(lpf.synonyms, ["cutoff", "ctf", "lp"]);
    const room = rows.find((r) => r.name === "room")!;
    assert.equal(room.range, "0–1");
    assert.equal(room.href, "https://strudel.cc/learn/effects/#room");
  });

  test("formatRange", () => {
    assert.equal(formatRange(undefined), undefined);
    assert.equal(formatRange({}), undefined);
    assert.equal(formatRange({ min: 0, max: 1 }), "0–1");
    assert.equal(formatRange({ min: 20, max: 20000, unit: "Hz" }), "20–20000 Hz");
    assert.equal(formatRange({ min: 0 }), "≥ 0");
    assert.equal(formatRange({ max: 1, unit: "s" }), "≤ 1 s");
    assert.equal(formatRange({ min: -1, max: 1 }), "-1–1");
  });
});

describe("links", () => {
  test("every strudel.cc link is a page and anchor in the docs snapshot", () => {
    assert.ok(allLinks().length >= 60);
    for (const { where, link } of allLinks()) {
      const page = docs.pages[link.page];
      assert.ok(page, `${where}: page ${link.page} not in strudel-docs.json`);
      if (link.anchor) assert.ok(anchorsOf(page).includes(link.anchor), `${where}: #${link.anchor} not on ${link.page}`);
    }
  });

  test("docHref", () => {
    assert.equal(docHref({ page: "/learn/mini-notation/", anchor: "rests" }), "https://strudel.cc/learn/mini-notation/#rests");
    assert.equal(docHref({ page: "/learn/samples/" }), "https://strudel.cc/learn/samples/");
  });
});

// ── every example plays: previewable, one expression, a pattern with events, known sounds, gain ≤ 1 ──

await core.evalScope(core, mini, tonal);
mini.miniAllStrings();

describe("examples", () => {
  const known = knownSoundsFromCatalog(sounds);

  test("every example passes previewable() and is one expression of plain string literals", () => {
    for (const { where, code } of allExamples()) {
      assert.ok(previewable(code), `${where}: ${code} isn't previewable`);
      assert.ok(!/[`;]/.test(code), `${where}: template literal or statement`);
      assert.ok(!/["']\s*\.\w/.test(code), `${where}: method called on a string literal`);
    }
  });

  for (const { where, code } of allExamples()) {
    test(`${where}: ${code} plays known sounds at sane levels`, () => {
      const pattern = new Function(`return (${code})`)();
      assert.ok(pattern instanceof core.Pattern, "not a Pattern");
      const haps = pattern.queryArc(0, 2);
      assert.ok(haps.some((h: { hasOnset(): boolean }) => h.hasOnset()), "no events in 2 cycles");
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

describe("sound families", () => {
  const fixture: SoundsCatalog = {
    groups: [
      {
        id: "drums",
        label: "Drums",
        kinds: [
          { id: "kick", label: "Kick", sounds: ["bd"] },
          { id: "perc", label: "Percussion", sounds: ["cb"] },
        ],
      },
      { id: "instruments", label: "Instruments", kinds: [{ id: "keys", label: "Keys", sounds: ["piano"] }] },
      { id: "synths", label: "Synths", kinds: [{ id: "synth", label: "Waveforms", sounds: ["sawtooth"] }] },
    ],
    banks: { RolandTR909: { aliases: ["tr909", "909"], parts: ["bd", "sd", "hh"] }, LinnDrum: { aliases: [], parts: ["sd", "cb"] } },
    sounds: {
      bd: { kind: "kick", source: "uzu-drumkit", count: 8, banks: { RolandTR909: 4 } },
      cb: { kind: "perc", banks: { LinnDrum: 1 } },
      piano: { kind: "keys", source: "piano", count: 29, pitched: true },
      sawtooth: { kind: "synth", source: "superdough" },
    },
  };

  test("drums by kind, instruments, synths, then the drum machines", () => {
    const fams = soundFamilies(fixture);
    assert.deepEqual(
      fams.map((f) => [f.section, f.id, f.label]),
      [
        ["Drums", "kick", "Kick"],
        ["Drums", "perc", "Percussion"],
        ["Instruments", "keys", "Keys"],
        ["Synths", "synth", "Waveforms"],
        ["Drum machines", "banks", "Drum machines"],
      ]
    );
  });

  test("what ▶ plays: the sound, a note for pitched ones, a bank-only part on its bank, a machine's bd", () => {
    const fams = soundFamilies(fixture);
    const item = (name: string) => fams.flatMap((f) => f.items).find((i) => i.name === name)!;
    assert.deepEqual(item("bd").play, { name: "bd", opts: {} });
    assert.deepEqual(item("piano").play, { name: "piano", opts: { pitched: true } });
    assert.deepEqual(item("sawtooth").play, { name: "sawtooth", opts: { pitched: true } });
    assert.deepEqual(item("cb").play, { name: "cb", opts: { bank: "LinnDrum" } });
    assert.deepEqual(item("RolandTR909").play, { name: "bd", opts: { bank: "RolandTR909" } });
    assert.deepEqual(item("LinnDrum").play, { name: "sd", opts: { bank: "LinnDrum" } });
  });

  test("each family links into the library's Sounds tab", () => {
    const fams = soundFamilies(fixture);
    assert.deepEqual(fams[0].library, { tab: "sounds", query: "kick" });
    assert.deepEqual(fams.at(-1)!.library, { tab: "sounds", query: "" });
  });

  test("on the real catalog: every kind is a family, every bank a machine", () => {
    const fams = soundFamilies(sounds);
    const kinds = sounds.groups.flatMap((g) => g.kinds.map((k) => k.id));
    assert.deepEqual(fams.filter((f) => f.id !== "banks").map((f) => f.id), kinds);
    assert.equal(fams.at(-1)!.items.length, Object.keys(sounds.banks).length);
  });
});

describe("search", () => {
  const index = buildIndex({ completions, sounds, intents: { intents: [wobble, wetter] }, keys });

  test("an empty query finds nothing (the tabs show everything)", () => {
    assert.equal(searchSheet(index, "   ").total, 0);
  });

  test("a matching intent comes first, with the curated functions it names", () => {
    const r = searchSheet(index, "wetter");
    assert.equal(r.intents[0]?.id, "wetter");
    const fns = r.functions.map((f) => f.name);
    for (const name of ["room", "size", "delay"]) assert.ok(fns.includes(name), `${name} in ${fns}`);
  });

  test("intents match on any phrase, by word prefix", () => {
    assert.equal(searchSheet(index, "more rev").intents[0]?.id, "wetter");
    assert.equal(searchSheet(index, "wub").intents[0]?.id, "wobble");
    assert.deepEqual(searchSheet(index, "lpf").intents, [], "not on its functions: those are function rows");
  });

  test("functions by name, then by synonym (from completions)", () => {
    assert.equal(searchSheet(index, "lpf").functions[0]?.name, "lpf");
    assert.equal(searchSheet(index, "cutoff").functions[0]?.name, "lpf");
    assert.equal(searchSheet(index, "fast").functions[0]?.name, "fast");
    assert.equal(searchSheet(index, "reverb").functions[0]?.name, "room", "by its sentence");
  });

  test("mini-notation by name, symbol and meaning", () => {
    assert.equal(searchSheet(index, "rest").mini[0]?.id, "rest");
    assert.equal(searchSheet(index, "*").mini[0]?.symbol, "*");
    assert.equal(searchSheet(index, "<").mini[0]?.symbol, "< >");
    assert.equal(searchSheet(index, "euclid").mini[0]?.symbol, "(3,8)");
  });

  test("sounds by name and family; keys by key and by what they do", () => {
    const r = searchSheet(index, "bd");
    assert.equal(r.sounds[0]?.name, "bd");
    assert.ok(searchSheet(index, "909").sounds.some((s) => s.name === "RolandTR909"), "a machine by its alias");
    assert.equal(searchSheet(index, "palette").keys[0]?.keys, "Ctrl/⌘ + K");
    assert.equal(searchSheet(index, "space").keys[0]?.keys, "Space");
  });

  test("every word must match", () => {
    assert.deepEqual(
      searchSheet(index, "lpf zzzz").functions.map((f) => f.name),
      []
    );
  });

  test("without intents or completions it still searches", () => {
    const bare = buildIndex({ completions: null, sounds: null, intents: null, keys });
    assert.equal(searchSheet(bare, "lpf").functions[0]?.name, "lpf");
    assert.deepEqual(searchSheet(bare, "ctf").functions, [], "synonyms come from completions.json");
    assert.deepEqual(searchSheet(bare, "bd").sounds, []);
  });
});
