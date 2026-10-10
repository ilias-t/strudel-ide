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
import { insertionFor } from "../src/ui/discover/insert.ts";
import { intentItems } from "../src/ui/discover/palette-items.ts";
import { readFileSync } from "node:fs";
import type { FunctionsCatalog, IntentsCatalog, SnippetsCatalog, SoundsCatalog } from "../src/ui/discover/catalog.ts";

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

  test("sound previews: the name says the current state (off unless told), Enter flips it", () => {
    const off = byId(actionItems(stopped), "previews");
    assert.equal(off.name, "sound previews: off");
    assert.deepEqual(off.run, { type: "action", action: "previews" });
    assert.match(off.detail, /turn them on/);
    assert.ok(off.alts?.includes("previews"));
    const on = byId(actionItems({ ...stopped, previews: true }), "previews");
    assert.equal(on.name, "sound previews: on");
    assert.match(on.detail, /turn them off/);
    assert.equal(rank(actionItems(stopped), "previews")[0].item.id, "previews");
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

  test("a song that didn't build is marked ⚠ like the picker, and still opens (to be fixed)", () => {
    const items = songItems(
      [
        { id: "draft", song: { name: "Draft" }, broken: true },
        { id: "dusk", song: { name: "Dusk", bpm: 90 } },
      ],
      "dusk"
    );
    assert.match(byId(items, "draft").detail ?? "", /^⚠ didn't build/);
    assert.equal(byId(items, "draft").name, "Draft");
    assert.deepEqual(byId(items, "draft").run, { type: "song", id: "draft" });
    assert.doesNotMatch(byId(items, "dusk").detail ?? "", /⚠/);
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

// ── search by sound: intents (the real catalog) ───────────────────────────────

const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(`../src/catalog/${file}`, import.meta.url), "utf8")) as T;
const realIntents = read<IntentsCatalog>("intents.json");
const realItems: PaletteItem[] = [
  ...actionItems(stopped),
  ...soundItems(read<SoundsCatalog>("sounds.json")),
  ...bankItems(read<SoundsCatalog>("sounds.json")),
  ...snippetItems(read<SnippetsCatalog>("snippets.json")),
  ...intentItems(realIntents),
  ...functionItems(read<FunctionsCatalog>("functions.json"), () => true, realIntents),
];
const top = (query: string, n = 5) => rank(realItems, query).slice(0, n).map((r) => `${r.item.kind}:${r.item.id}`);

describe("intents", () => {
  const intents: IntentsCatalog = {
    intents: [
      {
        id: "wetter",
        phrases: ["wetter", "more reverb", "reverb"],
        functions: ["room", "size", "delay"],
        call: "room(0.5)",
        recipe: 'note("c3 e3").s("piano").room(0.8)',
        tip: "room 0–1 is the send; size grows the space",
      },
      {
        id: "acid-bass",
        phrases: ["acid bass", "303"],
        functions: ["lpf", "lpq"],
        call: "lpf(400).lpq(12)",
        recipe: 'note("a1*8").s("sawtooth").lpf(400).lpq(12)',
        tip: "resonance and a moving cutoff",
        snippets: ["acid-303-line"],
        role: "acid",
      },
    ],
  };

  test("a row per intent: the first phrase, an arrow to its functions, the tip", () => {
    const wetter = byId(intentItems(intents), "wetter");
    assert.equal(wetter.kind, "intent");
    assert.equal(wetter.name, "wetter");
    assert.equal(wetter.suffix, " → room · size · delay");
    assert.equal(wetter.detail, "room 0–1 is the send; size grows the space");
    assert.ok(wetter.alts?.includes("more reverb") && wetter.alts.includes("reverb"));
  });

  test("Shift+Enter plays the recipe (two bars); Enter inserts the call or the recipe; ⌥Enter only with a role", () => {
    const [wetter, acid] = intentItems(intents);
    assert.deepEqual(wetter.play, { type: "code", code: 'note("c3 e3").s("piano").room(0.8)', cycles: 2 });
    assert.deepEqual(wetter.run, { type: "insert", item: { type: "intent", call: "room(0.5)", code: 'note("c3 e3").s("piano").room(0.8)' } });
    assert.equal(wetter.track, undefined);
    assert.deepEqual(acid.track, { role: "acid", snippet: "acid-303-line" });
  });

  test("Enter: the call after an expression, the recipe where an expression starts, nothing inside a string", () => {
    const { run } = byId(intentItems(intents), "wetter");
    assert.equal(run.type, "insert");
    if (run.type !== "insert") return;
    const after = 's("bd")';
    assert.deepEqual(insertionFor(after, after.length, run.item), { text: ".room(0.5)", caret: ".room(0.5)".length });
    const start = "const pad = ";
    const recipe = 'note("c3 e3").s("piano").room(0.8)';
    assert.deepEqual(insertionFor(start, start.length, run.item), { text: recipe, caret: recipe.length });
    assert.equal(insertionFor('s("bd ")', 6, run.item), null);
    // on a line of its own (no caret placed yet): always the recipe
    assert.equal(insertionFor(after, 0, run.item, 0, { ownLine: true })?.text, recipe);
  });

  test("an intent's phrases find its main function too, marked as a phrase match", () => {
    const fns = functionItems(read<FunctionsCatalog>("functions.json"), () => true, intents);
    assert.ok(byId(fns, "room").phrases?.includes("reverb"));
    assert.equal(byId(fns, "size").phrases, undefined, "only the main function");
    const [r] = rank(fns.filter((f) => f.id === "room"), "more reverb");
    assert.equal(r.via, "more reverb");
    assert.equal(r.field, "phrase");
  });

  test('"wetter" ranks the intent first', () => {
    assert.equal(top("wetter")[0], "intent:wetter");
  });

  test('"reverb": the intent, then room and roomsize near the top; no fuzzy fluke among them', () => {
    const t = top("reverb", 8);
    assert.equal(t[0], "intent:wetter", t.join(", "));
    assert.ok(t.slice(0, 3).includes("function:room"), t.join(", "));
    assert.ok(t.includes("function:roomsize"), t.join(", "));
    assert.ok(!t.some((id) => id.startsWith("snippet:")), t.join(", "));
    const roomRank = rank(realItems, "reverb").findIndex((r) => r.item.id === "room" && r.item.kind === "function");
    const crash = rank(realItems, "reverb").findIndex((r) => r.item.id === "fx-crash-on-one");
    assert.ok(crash === -1 || crash > roomRank + 5, `the crash snippet at ${crash}`);
  });

  test('"acid bass", "wobble", "lo-fi drums", "swing": the matching intent first', () => {
    assert.equal(top("acid bass")[0], "intent:acid-bass");
    assert.equal(top("wobble")[0], "intent:wobble");
    assert.equal(top("lo-fi drums")[0], "intent:lofi-drums");
    assert.equal(top("swing")[0], "intent:swing");
    assert.ok(top("swing", 3).includes("function:swing"), top("swing").join(", "));
  });

  test("a summary word finds a function, below its name matches (room's summary says reverb, dry's is SuperDirt only)", () => {
    const fns = functionItems(read<FunctionsCatalog>("functions.json"), () => true);
    const found = rank(fns, "reverb").map((r) => r.item.id);
    assert.ok(found.includes("room") && found.includes("roomsize"), found.slice(0, 10).join(", "));
    assert.ok(found.indexOf("room") < found.indexOf("dry"), "SuperDirt-only sinks");
    assert.equal(rank(fns, "lpf")[0].item.id, "lpf", "names still win");
  });
});
