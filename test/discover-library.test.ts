// The library's pure parts (src/ui/discover/library-data.ts): search, ranking,
// meta text, what a ▶ plays and what insert inserts, the doc text's markup.
// Run: node --test test/discover-library.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { FunctionInfo, FunctionsCatalog, SoundsCatalog } from "../src/ui/discover/catalog.ts";
import {
  bankPart,
  docBlocks,
  filterBanks,
  filterSoundGroups,
  functionInsert,
  searchFunctions,
  soundAudition,
  soundInsert,
  soundMeta,
  terms,
} from "../src/ui/discover/library-data.ts";

const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(`../src/catalog/${file}`, import.meta.url), "utf8")) as T;
const sounds = read<SoundsCatalog>("sounds.json");
const functions = read<FunctionsCatalog>("functions.json");

const soundNames = (query: string) => filterSoundGroups(sounds, query).flatMap((g) => g.kinds.flatMap((k) => k.sounds));
const fnNames = (query: string) => searchFunctions(functions, query).map((f) => f.name);

describe("terms", () => {
  test("splits on whitespace, lowercased, empty for a blank query", () => {
    assert.deepEqual(terms("  Kick  TR909 "), ["kick", "tr909"]);
    assert.deepEqual(terms("   "), []);
  });
});

describe("sounds by kind", () => {
  test("an empty query keeps every group, kind and sound in catalog order", () => {
    assert.deepEqual(filterSoundGroups(sounds, ""), sounds.groups);
  });

  test("a name matches its sound, and drops kinds and groups left empty", () => {
    const groups = filterSoundGroups(sounds, "piano");
    assert.ok(soundNames("piano").includes("piano"));
    for (const g of groups) for (const k of g.kinds) assert.ok(k.sounds.length > 0, `${g.id}/${k.id} is empty`);
    assert.ok(!groups.some((g) => g.id === "drums"), "no drums match piano");
  });

  test("a kind's label matches every sound of that kind", () => {
    const kick = sounds.groups.find((g) => g.id === "drums")!.kinds.find((k) => k.id === "kick")!;
    for (const name of kick.sounds) assert.ok(soundNames("kick").includes(name), name);
  });

  test("every term has to match (kick + bd narrows to bd-like kicks)", () => {
    const names = soundNames("kick bd");
    assert.ok(names.includes("bd"));
    assert.ok(names.every((n) => sounds.sounds[n].kind === "kick"));
  });

  test("an alias's target matches it (saw is sawtooth)", () => {
    assert.ok(soundNames("sawtooth").includes("saw"));
  });

  test("a drum machine's name or alias finds the parts it has (909 → bd, sd…, not piano)", () => {
    const names = soundNames("909");
    for (const part of ["bd", "sd", "hh", "oh", "cp"]) assert.ok(names.includes(part), part);
    assert.ok(!names.includes("piano"));
    assert.ok(names.every((n) => Object.keys(sounds.sounds[n].banks ?? {}).some((b) => /909/.test(b))));
    assert.ok(soundNames("tr909").includes("bd"), "by alias");
  });

  test("nothing matches nonsense", () => {
    assert.deepEqual(filterSoundGroups(sounds, "zzqqxx"), []);
  });
});

describe("banks", () => {
  test("an empty query lists every bank", () => {
    assert.equal(filterBanks(sounds, "").length, Object.keys(sounds.banks).length);
  });

  test("909 finds the RolandTR909 bank (name and alias TR909)", () => {
    assert.ok(filterBanks(sounds, "909").includes("RolandTR909"));
    assert.ok(filterBanks(sounds, "tr909").includes("RolandTR909"));
  });

  test("an alias alone finds its bank (Linn → AkaiLinn)", () => {
    assert.ok(filterBanks(sounds, "linn").includes("AkaiLinn"));
  });

  test("a part matches whole, not as a piece of a part (c finds no bank by its cp/cr/cb)", () => {
    for (const name of filterBanks(sounds, "cb")) {
      const b = sounds.banks[name];
      assert.ok(b.parts.includes("cb") || [name, ...b.aliases].some((a) => /cb/i.test(a)), name);
    }
    assert.ok(filterBanks(sounds, "cb").includes("AJKPercusyn"), "has a cb part");
    const byName = (n: string) => [n, ...sounds.banks[n].aliases].some((a) => /c/i.test(a));
    for (const name of filterBanks(sounds, "c")) assert.ok(byName(name), name);
  });
});

describe("function search", () => {
  test("an empty query finds nothing (categories are browsed instead)", () => {
    assert.deepEqual(searchFunctions(functions, " "), []);
  });

  test("the exact name ranks first, then names starting with it", () => {
    const names = fnNames("lpf");
    assert.equal(names[0], "lpf");
    const firstOther = names.findIndex((n) => !n.startsWith("lpf"));
    assert.ok(names.slice(0, firstOther).every((n) => n.startsWith("lpf")));
  });

  test("a synonym finds the function (cutoff → lpf), after names that contain it", () => {
    const names = fnNames("cutoff");
    assert.equal(names[0], "cutoff");
    assert.ok(names.includes("lpf"));
  });

  test("the summary is searched, below name matches", () => {
    const names = fnNames("low-pass");
    assert.ok(names.includes("lpf"));
  });

  test("a category's label finds its functions", () => {
    const envelope = functions.functions.filter((f) => f.category === "envelope").map((f) => f.name);
    const names = fnNames("envelopes");
    for (const n of envelope) assert.ok(names.includes(n), n);
  });

  test("every term must match", () => {
    for (const f of searchFunctions(functions, "filter high")) {
      const label = functions.categories.find((c) => c.id === f.category)!.label;
      const hay = [f.name, ...f.synonyms, f.aliasOf, f.summary.replace(/[*`]/g, ""), f.category, label].join(" ").toLowerCase();
      assert.ok(hay.includes("filter") && hay.includes("high"), f.name);
    }
    assert.ok(fnNames("filter high").includes("hpf"));
    assert.ok(!fnNames("filter high").includes("lpf"));
  });

  test("ties are sorted by name", () => {
    const names = fnNames("lp").filter((n) => n.startsWith("lp") && n !== "lp");
    assert.deepEqual(names, [...names].sort());
  });
});

describe("sound rows", () => {
  test("meta: files, source, banks for a drum part", () => {
    assert.deepEqual(soundMeta(sounds.sounds.bd), ["8 files", "uzu-drumkit", `${Object.keys(sounds.sounds.bd.banks!).length} banks`]);
  });

  test("meta: one file reads singular; pitched samples say so", () => {
    assert.deepEqual(soundMeta({ kind: "keys", source: "piano", count: 1, pitched: true }), ["1 file", "piano", "pitched"]);
  });

  test("meta: a built-in synth, an alias", () => {
    assert.deepEqual(soundMeta(sounds.sounds.sawtooth), ["built-in synth"]);
    assert.deepEqual(soundMeta(sounds.sounds.saw), ["built-in synth", "= sawtooth"]);
  });

  test("meta: a bank-only sound", () => {
    assert.deepEqual(soundMeta({ kind: "fx", banks: { KorgKRZ: 2, RolandMC303: 2 } }), ["only in banks", "2 banks"]);
  });

  test("▶ plays the unbanked sound", () => {
    assert.deepEqual(soundAudition("bd", sounds.sounds.bd), { name: "bd", opts: {} });
  });

  test("▶ plays a pitched sample and a waveform synth on a note", () => {
    assert.deepEqual(soundAudition("piano", sounds.sounds.piano), { name: "piano", opts: { pitched: true } });
    assert.deepEqual(soundAudition("sawtooth", sounds.sounds.sawtooth), { name: "sawtooth", opts: { pitched: true } });
  });

  test("▶ plays a bank-only sound from its first bank", () => {
    assert.deepEqual(soundAudition("fx", { kind: "fx", banks: { KorgKRZ: 2, RolandMC303: 2 } }), { name: "fx", opts: { bank: "KorgKRZ" } });
  });

  test("insert: a sound, pitched when it plays notes", () => {
    assert.deepEqual(soundInsert("bd", sounds.sounds.bd), { type: "sound", name: "bd", pitched: false });
    assert.deepEqual(soundInsert("piano", sounds.sounds.piano), { type: "sound", name: "piano", pitched: true });
  });

  test("insert: a bank-only sound brings the bank it plays from (alone it doesn't exist)", () => {
    assert.deepEqual(soundInsert("perc", sounds.sounds.perc), {
      type: "sound",
      name: "perc",
      pitched: false,
      bank: soundAudition("perc", sounds.sounds.perc).opts.bank,
    });
    assert.ok(soundInsert("perc", sounds.sounds.perc).type === "sound");
  });
});

describe("bank rows", () => {
  test("the part a bank plays and inserts: bd when it has one, else its first", () => {
    assert.equal(bankPart({ aliases: [], parts: ["bd", "sd"] }), "bd");
    assert.equal(bankPart({ aliases: [], parts: ["cp", "hh"] }), "cp");
  });
});

describe("function insert", () => {
  test("kind and parameter count go to the insert", () => {
    const lpf = functions.functions.find((f) => f.name === "lpf")!;
    assert.deepEqual(functionInsert(lpf), { type: "function", name: "lpf", kind: "both", params: 1 });
  });

  test("a function without params", () => {
    const fn: FunctionInfo = { ...functions.functions[0], name: "rev", kind: "both", params: [] };
    assert.deepEqual(functionInsert(fn), { type: "function", name: "rev", kind: "both", params: 0 });
  });
});

describe("doc text", () => {
  test("paragraphs split on blank lines; bold, italic and code spans", () => {
    assert.deepEqual(docBlocks("Applies the **l**ow pass.\n\nUse `lpq` for *more*."), [
      { type: "p", spans: [{ kind: "text", text: "Applies the " }, { kind: "strong", text: "l" }, { kind: "text", text: "ow pass." }] },
      {
        type: "p",
        spans: [
          { kind: "text", text: "Use " },
          { kind: "code", text: "lpq" },
          { kind: "text", text: " for " },
          { kind: "em", text: "more" },
          { kind: "text", text: "." },
        ],
      },
    ]);
  });

  test("a link keeps its label only", () => {
    assert.deepEqual(docBlocks("More info [here](https://example.com)."), [
      { type: "p", spans: [{ kind: "text", text: "More info " }, { kind: "text", text: "here" }, { kind: "text", text: "." }] },
    ]);
  });

  test("list lines become items; single newlines inside a paragraph become spaces", () => {
    assert.deepEqual(docBlocks("Legend:\n\n- a letter\n- an accidental\nwrapped"), [
      { type: "p", spans: [{ kind: "text", text: "Legend:" }] },
      { type: "li", spans: [{ kind: "text", text: "a letter" }] },
      { type: "li", spans: [{ kind: "text", text: "an accidental wrapped" }] },
    ]);
  });

  test("an unmatched marker stays literal", () => {
    assert.deepEqual(docBlocks("2 * 3 and a ` tick"), [{ type: "p", spans: [{ kind: "text", text: "2 * 3 and a ` tick" }] }]);
  });
});
