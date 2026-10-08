// What the ⌘K palette lists (src/ui/discover/palette-items.ts): pure item builders.
// Run: node --test test/discover-palette.test.ts

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  actionItems,
  bankItems,
  compactSignature,
  functionItems,
  groupResults,
  plainText,
  snippetItems,
  songItems,
  soundItems,
  type ActionState,
  type PaletteItem,
} from "../src/ui/discover/palette-items.ts";
import { rank } from "../src/ui/discover/fuzzy.ts";
import type { FunctionsCatalog, SnippetsCatalog, SoundsCatalog } from "../src/ui/discover/catalog.ts";

const stopped: ActionState = { playing: false, loop: false, codeView: true, mode: "view", sections: null };
const ids = (items: PaletteItem[]) => items.map((i) => i.id);
const byId = (items: PaletteItem[], id: string) => {
  const found = items.find((i) => i.id === id);
  assert.ok(found, `no item "${id}" in ${ids(items).join(", ")}`);
  return found;
};

describe("actions", () => {
  test("play/stop is named after what it will do", () => {
    assert.equal(byId(actionItems(stopped), "play").name, "play");
    assert.equal(byId(actionItems({ ...stopped, playing: true }), "play").name, "stop");
  });

  test("section actions only when the song has sections: loop, one jump per section, next/previous", () => {
    assert.ok(!ids(actionItems(stopped)).some((id) => /section|loop/.test(id)));
    const items = actionItems({ ...stopped, sections: [{ name: "intro" }, { name: "drop" }] });
    assert.equal(byId(items, "loop").name, "loop this section");
    assert.equal(byId(items, "section:1").name, "jump to section drop");
    assert.deepEqual(byId(items, "section:1").run, { type: "action", action: "jump", section: 1 });
    assert.ok(ids(items).includes("next-section") && ids(items).includes("previous-section"));
    assert.equal(byId(actionItems({ ...stopped, loop: true, sections: [{ name: "a" }] }), "loop").name, "stop looping");
  });

  test("edit and code view say which way they go", () => {
    assert.equal(byId(actionItems(stopped), "edit").name, "edit the code");
    assert.equal(byId(actionItems({ ...stopped, mode: "edit" }), "edit").name, "stop editing");
    assert.equal(byId(actionItems(stopped), "code-view").name, "hide the code");
    assert.equal(byId(actionItems({ ...stopped, codeView: false }), "code-view").name, "show the code");
  });

  test("the library, its functions tab, the builder, follow, clear mutes and the shortcuts are always there", () => {
    const all = ids(actionItems(stopped));
    for (const id of ["library", "library-functions", "builder", "follow", "unmute", "help"]) assert.ok(all.includes(id), id);
  });

  test("actions carry the stage key that does the same thing", () => {
    assert.equal(byId(actionItems(stopped), "play").hint, "Space");
    assert.equal(byId(actionItems(stopped), "library").hint, "B");
  });
});

describe("songs", () => {
  test("one per song, the current one marked, findable by id too", () => {
    const items = songItems(
      [
        { id: "acid-rain", song: { name: "Acid Rain", bpm: 128 } },
        { id: "dusk", song: { name: "Dusk", bpm: 90 } },
      ],
      "dusk"
    );
    assert.deepEqual(ids(items), ["acid-rain", "dusk"]);
    assert.equal(items[1].current, true);
    assert.equal(items[0].current, undefined);
    assert.deepEqual(items[0].run, { type: "song", id: "acid-rain" });
    assert.ok(items[0].alts?.includes("acid-rain"));
  });
});

const sounds: SoundsCatalog = {
  groups: [
    { id: "drums", label: "Drums", kinds: [{ id: "kick", label: "Kick", sounds: ["bd"] }] },
    { id: "instruments", label: "Instruments", kinds: [{ id: "keys", label: "Keys", sounds: ["piano"] }] },
    { id: "synths", label: "Synths", kinds: [{ id: "synth", label: "Waveforms", sounds: ["sawtooth", "saw"] }] },
  ],
  banks: {
    RolandTR909: { aliases: ["TR909"], parts: ["bd", "cp", "hh"] },
    SimmonsSDS400: { aliases: [], parts: ["ht", "lt"] },
  },
  sounds: {
    bd: { kind: "kick", source: "uzu-drumkit", count: 8, banks: { RolandTR909: 4 } },
    piano: { kind: "keys", source: "piano", count: 29, pitched: true },
    sawtooth: { kind: "synth", source: "superdough" },
    saw: { kind: "synth", source: "superdough", aliasOf: "sawtooth" },
    perc: { kind: "perc", banks: { AkaiMPC60: 5, RolandTR909: 2 } },
  },
};

describe("sounds and banks", () => {
  test("a sound inserts itself (pitched ones say so) and auditions itself", () => {
    const piano = byId(soundItems(sounds), "piano");
    assert.deepEqual(piano.run, { type: "insert", item: { type: "sound", name: "piano", pitched: true } });
    assert.deepEqual(piano.play, { type: "sound", name: "piano", pitched: true });
    assert.match(piano.detail, /Keys/);
    assert.deepEqual(byId(soundItems(sounds), "bd").run, { type: "insert", item: { type: "sound", name: "bd" } });
  });

  test("a bank-only sound (perc, fx) inserts and plays from its first drum machine", () => {
    const bank = Object.keys(sounds.sounds.perc.banks!)[0];
    const perc = byId(soundItems(sounds), "perc");
    assert.deepEqual(perc.run, { type: "insert", item: { type: "sound", name: "perc", bank } });
    assert.deepEqual(perc.play, { type: "sound", name: "perc", bank });
  });

  test("a sound's detail names its kind; an alias names what it stands for", () => {
    assert.match(byId(soundItems(sounds), "bd").detail, /^Kick/);
    assert.match(byId(soundItems(sounds), "saw").detail, /sawtooth/);
  });

  test("a bank inserts with bd, or its first part when it has no bd, and is found by its aliases", () => {
    const banks = bankItems(sounds);
    const tr909 = byId(banks, "RolandTR909");
    assert.deepEqual(tr909.run, { type: "insert", item: { type: "bank", name: "RolandTR909", part: "bd" } });
    assert.deepEqual(tr909.play, { type: "sound", name: "bd", bank: "RolandTR909" });
    assert.deepEqual(tr909.alts, ["TR909"]);
    assert.deepEqual(byId(banks, "SimmonsSDS400").run, {
      type: "insert",
      item: { type: "bank", name: "SimmonsSDS400", part: "ht" },
    });
  });
});

const functions: FunctionsCatalog = {
  categories: [{ id: "effects", label: "Effects & filters", count: 2 }],
  functions: [
    {
      name: "lpf",
      category: "effects",
      kind: "both",
      signatures: [".lpf(frequency?: NumberInput): Pattern", "lpf(frequency: NumberInput): Pattern"],
      summary: "Applies the cutoff frequency of the **l**ow-**p**ass **f**ilter.",
      description: "",
      params: [{ name: "frequency", description: "" }],
      examples: ['s("bd*4").lpf(800)'],
      synonyms: ["cutoff", "ctf"],
    },
    {
      name: "osc",
      category: "effects",
      kind: "method",
      signatures: [".osc(): Pattern"],
      summary: "",
      description: "",
      params: [],
      examples: ['s("bd").osc()'],
      synonyms: [],
    },
  ],
};

describe("functions", () => {
  test("found by synonyms, inserted in the right form, with a plain-text summary", () => {
    const lpf = byId(functionItems(functions, () => true), "lpf");
    assert.deepEqual(lpf.alts, ["cutoff", "ctf"]);
    assert.deepEqual(lpf.run, { type: "insert", item: { type: "function", name: "lpf", kind: "both", params: 1 } });
    assert.equal(lpf.detail, "Applies the cutoff frequency of the low-pass filter.");
    assert.equal(lpf.suffix, "(frequency?)");
  });

  test("auditions the first example only when it can be previewed", () => {
    const previewable = (code: string) => !code.includes(".osc(");
    const items = functionItems(functions, previewable);
    assert.deepEqual(byId(items, "lpf").play, { type: "code", code: 's("bd*4").lpf(800)' });
    assert.equal(byId(items, "osc").play, undefined);
  });

  test("an alias isn't found by its target's synonyms, and ranks after its target on ties", () => {
    const withAlias: FunctionsCatalog = {
      ...functions,
      functions: [
        ...functions.functions,
        { ...functions.functions[0], name: "lp", aliasOf: "lpf", synonyms: ["cutoff", "lpf"] },
      ],
    };
    const items = functionItems(withAlias, () => true);
    assert.equal(byId(items, "lp").alts, undefined);
    assert.ok((byId(items, "lp").weight ?? 0) > (byId(items, "lpf").weight ?? 0));
    assert.match(byId(items, "lp").detail, /^same as lpf/);
  });

  test("with no summary the detail falls back to the category", () => {
    assert.equal(byId(functionItems(functions, () => true), "osc").detail, "Effects & filters");
  });
});

describe("snippets", () => {
  const catalog: SnippetsCatalog = {
    snippets: [
      {
        id: "kick-four",
        role: "kick",
        title: "Four on the floor",
        description: "A kick on every beat.",
        code: 's("bd*4")',
        tags: ["house"],
      },
    ],
  };

  test("insert the code, audition it, or open the track builder with it", () => {
    const [s] = snippetItems(catalog);
    assert.equal(s.name, "Four on the floor");
    assert.deepEqual(s.run, { type: "insert", item: { type: "code", code: 's("bd*4")' } });
    assert.deepEqual(s.play, { type: "code", code: 's("bd*4")' });
    assert.deepEqual(s.track, { role: "kick", snippet: "kick-four" });
    assert.ok(s.alts?.includes("kick") && s.alts.includes("house"));
    assert.match(s.detail, /kick/);
  });
});

describe("helpers", () => {
  test("plainText drops markdown emphasis, code ticks and link targets", () => {
    assert.equal(plainText("the **l**ow `pass` [filter](https://x.y)"), "the low pass filter");
  });

  test("compactSignature keeps the parameter names", () => {
    assert.equal(compactSignature(".lpf(frequency?: NumberInput): Pattern"), "(frequency?)");
    assert.equal(compactSignature("stack(...pats: Pattern[]): Pattern"), "(...pats)");
    assert.equal(compactSignature(".pick(lookup: Record<string, Pattern>, fn?: (x: number) => any): Pattern"), "(lookup, fn?)");
    assert.equal(compactSignature("const sine: Pattern"), "");
  });

  test("groupResults: groups in the order of their best result, results in rank order inside", () => {
    const items: PaletteItem[] = [
      ...functionItems(functions, () => true),
      ...bankItems(sounds),
      ...soundItems(sounds),
    ];
    // "s": saw, sawtooth and SimmonsSDS400 start with it, osc has it inside
    const groups = groupResults(rank(items, "s"));
    assert.deepEqual(
      groups.map((g) => g.kind),
      ["sound", "bank", "function"]
    );
    assert.equal(groups[0].label, "Sounds");
    assert.deepEqual(
      groups[0].results.map((r) => r.item.id),
      ["saw", "sawtooth"]
    );
  });
});
