// The catalog's phase-3 data (completions.json, theory.json and the fields functions.json gained):
// rank and `after` (scripts/lib/catalog/ranking.mjs over the usage.json snapshot), availability,
// ranges (ranges.mjs), strudel.cc doc links (doc-links.mjs over strudel-docs.json) and theory
// (theory.mjs). Unit tests on tiny inputs first, then the real generated catalog.
//
// Run: node --test test/catalog-data.test.mjs   (needs the sample-map cache, like catalog.test.mjs)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { CORE, countUsage, buildRanking } from "../scripts/lib/catalog/ranking.mjs";
import { RANGES, buildRanges } from "../scripts/lib/catalog/ranges.mjs";
import { headingNames, docUrls, DOC_OVERRIDES, NO_ANCHOR, CATEGORY_PAGES } from "../scripts/lib/catalog/doc-links.mjs";
import { availabilityOf, UNSAFE_BUCKETS } from "../scripts/lib/catalog/completions.mjs";
import { buildTheory, COMMON_SCALES } from "../scripts/lib/catalog/theory.mjs";
import { loadCatalogInputs } from "../scripts/lib/catalog/inputs.mjs";
import { generateCatalog } from "../scripts/lib/catalog/generate.mjs";

const root = resolve(import.meta.dirname, "..");

// ─────────────────────────────────────────────────────────────────────────────
// ranking: unit
// ─────────────────────────────────────────────────────────────────────────────

const FNS = ["s", "note", "gain", "bank", "lpf", "add", "x", "sine", "range", "slow", "fast"].map((name) => ({
  name,
  kind: name === "x" ? "method" : name === "sine" ? "value" : "both",
}));

describe("countUsage", () => {
  test("counts name(…) and .name(…) calls of catalog functions, per source kind", () => {
    const { usage } = countUsage(
      [
        { kind: "songs", code: 's("bd").gain(0.5).bank("tr909"); note("c").gain(1); foo(1).lpf(300)' },
        { kind: "examples", code: 's("hh").fast(2)' },
      ],
      FNS,
    );
    assert.deepEqual(usage.songs, { bank: 1, gain: 2, lpf: 1, note: 1, s: 1 });
    assert.deepEqual(usage.examples, { fast: 1, s: 1 });
  });

  test("a name the file declares itself is its own, not Strudel's", () => {
    const { usage, after } = countUsage([{ kind: "songs", code: "const slow = (p) => p; slow(1); mini(1).apply((x) => x.add(1)); .5" }], FNS);
    assert.equal(usage.songs.slow, undefined);
    assert.equal(usage.songs.add, 1); // .add( is a method call: always Strudel's
    assert.deepEqual(after.songs, {});
  });

  test("after: the methods of each chain, counted against its head (a call or a value)", () => {
    const { after } = countUsage(
      [{ kind: "songs", code: 's("bd").gain(1).lpf(sine.range(200, 900).slow(4)).bank("x"); s("hh").gain(0.5)' }],
      FNS,
    );
    assert.deepEqual(after.songs, { s: { bank: 1, gain: 2, lpf: 1 }, sine: { range: 1, slow: 1 } });
  });
});

describe("buildRanking", () => {
  const names = [...new Set([...CORE.slice(0, 5), "zebra", "yak", "aardvark"])].map((name) => ({ name }));
  const counts = {
    usage: { songs: { zebra: 1000, yak: 3, [CORE[3]]: 2 }, starters: {}, snippets: {}, examples: { aardvark: 8 } },
    after: { songs: {}, starters: {}, snippets: {}, examples: {} },
  };

  test("every function gets a rank; the core opens in its order, a heavily used name interleaves, the rarely used follow", () => {
    const { rank } = buildRanking(counts, names);
    assert.deepEqual(Object.keys(rank).sort(), names.map((n) => n.name).sort());
    const order = Object.keys(rank).sort((a, b) => rank[a] - rank[b]);
    assert.deepEqual(order.slice(0, 6), [CORE[0], "zebra", ...CORE.slice(1, 5)]);
    // examples weigh a quarter: aardvark 8 × 0.25 = 2 < yak 3
    assert.deepEqual(order.slice(6), ["yak", "aardvark"]);
  });

  test("an alias head's chains count for its target, and the alias gets the same list", () => {
    const { after } = buildRanking(
      {
        usage: { songs: {}, starters: {}, snippets: {}, examples: {} },
        after: { songs: { zebra: { yak: 6 }, zeb: { aardvark: 7 } }, starters: {}, snippets: {}, examples: {} },
      },
      [...names, { name: "zeb", aliasOf: "zebra" }],
    );
    assert.deepEqual(after, { zeb: ["aardvark", "yak"], zebra: ["aardvark", "yak"] });
  });

  test("after keeps heads with enough uses, their top methods in order, unknown names dropped", () => {
    const { after } = buildRanking(
      {
        usage: { songs: {}, starters: {}, snippets: {}, examples: {} },
        after: {
          songs: { zebra: { yak: 6, aardvark: 6, gone: 50 }, yak: { zebra: 2 } },
          starters: {},
          snippets: {},
          examples: { zebra: { yak: 4 } },
        },
      },
      names,
    );
    assert.deepEqual(after, { zebra: ["yak", "aardvark"] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ranges, doc links, availability, theory: unit
// ─────────────────────────────────────────────────────────────────────────────

describe("buildRanges", () => {
  const fns = [{ name: "lpf" }, { name: "cutoff", aliasOf: "lpf" }, { name: "ctf", aliasOf: "cutoff" }, { name: "fast" }];

  test("aliases inherit their target's range, through chains", () => {
    const r = buildRanges(fns, { lpf: { min: 20, max: 20000, unit: "Hz", log: true } });
    assert.deepEqual(Object.keys(r), ["lpf", "cutoff", "ctf"]);
    assert.deepEqual(r.ctf, r.lpf);
  });

  test("rejects unknown names, aliases as keys, min ≥ max, log from 0", () => {
    assert.throws(() => buildRanges(fns, { nope: { min: 0, max: 1 } }), /not a function/);
    assert.throws(() => buildRanges(fns, { cutoff: { min: 0, max: 1 } }), /alias/);
    assert.throws(() => buildRanges(fns, { fast: { min: 1, max: 1 } }), /min ≥ max/);
    assert.throws(() => buildRanges(fns, { lpf: { min: 0, max: 9, log: true } }), /log/);
  });
});

describe("headingNames", () => {
  test("a heading names functions as code; prose headings name none", () => {
    assert.deepEqual(headingNames("lpf"), ["lpf"]);
    assert.deepEqual(headingNames("scale(name)"), ["scale"]);
    assert.deepEqual(headingNames("midi(outputName?,options?)"), ["midi"]);
    assert.deepEqual(headingNames("clip / legato"), ["clip", "legato"]);
    assert.deepEqual(headingNames("control, ccn && ccv"), ["control", "ccn", "ccv"]);
    assert.deepEqual(headingNames("progNum (Program Change)"), ["progNum"]);
    assert.deepEqual(headingNames("arpWith 🧪"), ["arpWith"]);
    assert.deepEqual(headingNames("Pattern.osc"), ["osc"]);
    assert.deepEqual(headingNames("Signals vs LFOs"), []);
  });
});

describe("docUrls", () => {
  const snapshot = {
    base: "https://x",
    pages: {
      "/learn/effects/": {
        title: "FX",
        headings: [
          { id: "delay", level: 2, text: "Delay" },
          { id: "delay-1", level: 3, text: "delay" },
          { id: "lpf", level: 2, text: "lpf" },
        ],
      },
      "/learn/lfo/": { title: "LFO", headings: [{ id: "shape", level: 2, text: "Shape" }] },
      "/learn/visual-feedback/": { title: "V", headings: [{ id: "scope", level: 2, text: "Scope" }] },
    },
  };
  const fns = [
    { name: "delay", category: "effects", synonyms: [] },
    { name: "lpf", category: "effects", synonyms: [] },
    { name: "cutoff", category: "effects", aliasOf: "lpf", synonyms: [] },
    { name: "shape", category: "effects", synonyms: [] },
    { name: "scope", category: "visual", synonyms: [] },
    { name: "tscope", category: "visual", synonyms: [] },
    { name: "foo", category: "other", synonyms: [] },
  ];
  const urls = docUrls(fns, snapshot, { overrides: {} });

  test("the function's heading, not the section's; aliases share their target's", () => {
    assert.equal(urls.delay, "https://x/learn/effects/#delay-1");
    assert.equal(urls.cutoff, urls.lpf);
  });

  test("a prose heading only counts on a page of the function's category", () => {
    assert.equal(urls.shape, "https://x/learn/effects/"); // not /learn/lfo/#shape: the category's page instead
    assert.equal(urls.scope, "https://x/learn/visual-feedback/#scope");
  });

  test("no heading: the category's page; no category page: nothing", () => {
    assert.equal(urls.tscope, "https://x/learn/visual-feedback/");
    assert.equal(urls.foo, undefined);
  });

  test("overrides must exist in the snapshot", () => {
    assert.throws(() => docUrls(fns, snapshot, { overrides: { foo: "/learn/effects/#nope" } }), /not in the snapshot/);
  });
});

describe("availabilityOf", () => {
  test("SuperDirt-only, then the visual/io/internal categories, then the preview-unsafe names", () => {
    assert.equal(availabilityOf({ name: "a", category: "effects", superdirtOnly: true }), "superdirt");
    assert.equal(availabilityOf({ name: "scope", category: "visual" }), "visual");
    assert.equal(availabilityOf({ name: "samples", category: "sound" }), "io");
    assert.equal(availabilityOf({ name: "lpf", category: "effects" }), "ok");
  });
});

describe("buildTheory", () => {
  const theory = buildTheory({
    scaleTypes: [
      { name: "minor", intervals: ["1P", "2M", "3m"] },
      { name: "major", intervals: ["1P", "2M", "3M"] },
      { name: "zzz", intervals: ["1P"] },
    ],
    chordTypes: [
      { name: "minor seventh", aliases: ["m7", "-7"], intervals: ["1P", "3m", "5P", "7m"] },
      { name: "major", aliases: ["M", "^", ""], intervals: ["1P", "3M", "5P"] },
    ],
    ireal: { "-7": ["3m 5P 7m 9M"], "": ["1P 3M 5P"], weird: ["1P 5P 6m 8P 10m"] },
    vowels: ["a", "e"],
    voicingDicts: ["ireal", "lefthand"],
    commonScales: ["major", "minor"],
  });

  test("common scales first, in curated order, flagged; the rest by name", () => {
    assert.deepEqual(theory.scales, [
      { name: "major", intervals: ["1P", "2M", "3M"], common: true },
      { name: "minor", intervals: ["1P", "2M", "3m"], common: true },
      { name: "zzz", intervals: ["1P"] },
    ]);
  });

  test("iReal symbols get tonal's intervals, else their first voicing folded into one octave", () => {
    assert.deepEqual(theory.chords["-7"], ["1P", "3m", "5P", "7m"]);
    assert.deepEqual(theory.chords[""], ["1P", "3M", "5P"]);
    assert.deepEqual(theory.chords.weird, ["1P", "3m", "5P", "6m"]);
  });

  test("an unknown common scale fails the build", () => {
    assert.throws(() => buildTheory({ scaleTypes: [], chordTypes: [], ireal: {}, vowels: [], voicingDicts: [], commonScales: ["nope"] }), /nope/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The real catalog
// ─────────────────────────────────────────────────────────────────────────────

const inputs = await loadCatalogInputs({ root, offline: true });
const catalog = generateCatalog(inputs);
const completions = JSON.parse(catalog["completions.json"]);
const { functions } = JSON.parse(catalog["functions.json"]);
const theory = JSON.parse(catalog["theory.json"]);
const byName = new Map(functions.map((f) => [f.name, f]));
const meta = completions.functions;
const byRank = Object.keys(meta).sort((a, b) => meta[a].rank - meta[b].rank);

describe("usage snapshot (scripts/lib/catalog/usage.json)", () => {
  test("names only real functions (else: node scripts/gen-catalog.mjs --recount)", () => {
    const stale = new Set();
    for (const kind of Object.keys(inputs.usage.usage)) {
      for (const name of Object.keys(inputs.usage.usage[kind])) if (!byName.has(name)) stale.add(name);
      for (const [head, methods] of Object.entries(inputs.usage.after[kind])) {
        if (!byName.has(head)) stale.add(head);
        for (const m of Object.keys(methods)) if (!byName.has(m)) stale.add(m);
      }
    }
    assert.deepEqual([...stale], []);
  });

  test("counts every source kind", () => {
    for (const kind of ["songs", "starters", "snippets", "examples"]) assert.ok(Object.keys(inputs.usage.usage[kind]).length > 10, kind);
  });
});

describe("rank and after", () => {
  test("ranks are 0…n-1, one per function", () => {
    assert.deepEqual(
      byRank.map((n) => meta[n].rank),
      byRank.map((_, i) => i),
    );
    assert.equal(byRank.length, functions.length);
  });

  test("the top 20 contain s note gain lpf", () => {
    const top = byRank.slice(0, 20);
    for (const name of ["s", "note", "gain", "lpf"]) assert.ok(top.includes(name), `${name} not in ${top.join(" ")}`);
  });

  test("the list opens like a method list should: s n note bank gain lpf hpf room delay pan speed fast", () => {
    assert.deepEqual(byRank.slice(0, 12), "s n note bank gain lpf hpf room delay pan speed fast".split(" "));
  });

  test("core names rank even when songs rarely use them", () => {
    for (const name of "fast struct jux every sometimes off ply euclid".split(" ")) assert.ok(meta[name].rank < 60, `${name}: ${meta[name].rank}`);
  });

  test("after.s starts with gain; note, n and chord have lists", () => {
    assert.equal(completions.after.s[0], "gain");
    assert.ok(completions.after.s.includes("bank"));
    // an alias head shares its target's list (sound(…) chains count towards s)
    assert.deepEqual(completions.after.sound, completions.after.s);
    for (const head of ["note", "n", "chord", "mini", "sine"]) assert.ok(completions.after[head]?.length >= 3, head);
    for (const list of Object.values(completions.after)) {
      assert.ok(list.length <= 20);
      for (const m of list) assert.ok(byName.has(m), m);
    }
  });
});

describe("availability", () => {
  test("scope is visual, the MIDI controls io, log internal, the SuperDirt-only ones superdirt", () => {
    assert.equal(meta.scope.availability, "visual");
    // .midi() itself isn't in the d.ts (src/strudel.generated.d.ts types no outputs); its controls are
    assert.equal(meta.midi, undefined);
    for (const name of ["midichan", "midicmd", "midiport", "ccn", "ccv"]) assert.equal(meta[name].availability, "io", name);
    assert.equal(meta.samples.availability, "io");
    assert.equal(meta.log.availability, "internal");
    const superdirt = functions.filter((f) => f.superdirtOnly).map((f) => f.name);
    assert.ok(superdirt.length >= 10);
    for (const name of superdirt) assert.equal(meta[name].availability, "superdirt", name);
    assert.equal(meta.lpf.availability, "ok");
    assert.equal(meta.mini.availability, "ok");
  });

  test("every catalog name previewable() refuses as a call is demoted (UNSAFE_BUCKETS covers it)", () => {
    const src = readFileSync(join(root, "src/ui/discover/previewable.ts"), "utf8");
    const unsafe = src.match(/const UNSAFE =\s*\/(.*)\/;/)?.[1];
    assert.ok(unsafe, "UNSAFE not found in previewable.ts");
    const names = new Set([...unsafe.matchAll(/\(([\w|]+)\)/g)].flatMap((m) => m[1].split("|")));
    const notDemoted = [...names].filter((n) => byName.has(n) && meta[n].availability === "ok" && !UNSAFE_BUCKETS.ok?.includes(n));
    assert.deepEqual(notDemoted, []);
  });
});

describe("ranges", () => {
  test("every key is a real, canonical function; min < max", () => {
    assert.ok(Object.keys(RANGES).length >= 60);
    for (const [name, r] of Object.entries(RANGES)) {
      assert.ok(byName.has(name), `${name} is not a function`);
      assert.equal(byName.get(name).aliasOf, undefined, `${name} is an alias`);
      if (r.min !== undefined && r.max !== undefined) assert.ok(r.min < r.max, name);
    }
  });

  test("spot checks", () => {
    assert.deepEqual(meta.lpf.range, { min: 20, max: 20000, unit: "Hz", log: true });
    assert.deepEqual(meta.room.range, { min: 0, max: 1 });
    assert.deepEqual(meta.gain.range, { min: 0, max: 1.5 });
  });

  test("aliases share their target's range and doc link; functions.json carries the same fields", () => {
    for (const f of functions) {
      const m = meta[f.name];
      assert.equal(f.rank, m.rank, f.name);
      assert.equal(f.availability, m.availability, f.name);
      assert.deepEqual(f.range, m.range, f.name);
      assert.equal(f.docUrl, m.docUrl, f.name);
      if (f.aliasOf && byName.has(f.aliasOf)) {
        assert.equal(m.availability, meta[f.aliasOf].availability, `${f.name} → ${f.aliasOf}`);
        assert.deepEqual(m.range, meta[f.aliasOf].range, `${f.name} → ${f.aliasOf}`);
        assert.equal(m.docUrl, meta[f.aliasOf].docUrl, `${f.name} → ${f.aliasOf}`);
      }
    }
  });
});

describe("doc links", () => {
  const snapshot = inputs.docs;
  const anchorOf = (url) => {
    assert.ok(url.startsWith(snapshot.base + "/"), url);
    const [path, anchor] = url.slice(snapshot.base.length).split("#");
    return { path, anchor };
  };

  test("every category page is in the snapshot", () => {
    for (const [category, pages] of Object.entries(CATEGORY_PAGES)) for (const p of pages) assert.ok(snapshot.pages[p], `${category}: ${p}`);
  });

  test("every link's page and anchor are in the snapshot", () => {
    for (const [name, m] of Object.entries(meta)) {
      if (!m.docUrl) continue;
      const { path, anchor } = anchorOf(m.docUrl);
      const page = snapshot.pages[path];
      assert.ok(page, `${name}: ${path} not in the snapshot`);
      if (anchor) assert.ok(page.headings.some((h) => h.id === anchor), `${name}: #${anchor} not on ${path}`);
    }
  });

  test("the core functions link to their heading (but for a few strudel.cc doesn't document)", () => {
    const missing = CORE.filter((n) => !NO_ANCHOR.includes(n) && !meta[n].docUrl?.includes("#"));
    assert.deepEqual(missing, []);
    for (const n of NO_ANCHOR) assert.ok(CORE.includes(n), `${n} in NO_ANCHOR but not in CORE`);
  });

  test("spot checks: collisions, prose headings, overrides", () => {
    assert.equal(meta.delay.docUrl, "https://strudel.cc/learn/effects/#delay-1");
    assert.equal(meta.lpf.docUrl, "https://strudel.cc/learn/effects/#lpf");
    assert.equal(meta.swingBy.docUrl, "https://strudel.cc/learn/time-modifiers/#swingby");
    assert.equal(meta.scale.docUrl, "https://strudel.cc/learn/tonal/#scalename");
    assert.equal(meta.clip.docUrl, "https://strudel.cc/learn/samples/#clip"); // its own heading, on its category's page
    assert.equal(meta.legato.docUrl, meta.clip.docUrl); // legato is an alias of clip
    assert.equal(meta.euclidLegato.docUrl, "https://strudel.cc/learn/time-modifiers/#euclidlegato");
    assert.equal(meta.ccv.docUrl, "https://strudel.cc/learn/input-output/#control-ccn--ccv");
    assert.equal(meta.every.docUrl, "https://strudel.cc/learn/conditional-modifiers/#firstof"); // via its synonym
    assert.ok(!meta.note.docUrl.includes("/learn/mini-notation/"));
    assert.ok(!meta.shape.docUrl.includes("/learn/lfo/"));
    for (const [name, url] of Object.entries(DOC_OVERRIDES)) assert.equal(meta[name].docUrl, snapshot.base + url, name);
  });
});

describe("theory", () => {
  test("92 scale types, the usual ones flagged common", () => {
    assert.equal(theory.scales.length, 92);
    const common = theory.scales.filter((s) => s.common).map((s) => s.name);
    assert.deepEqual(common, COMMON_SCALES);
    for (const name of ["major", "minor", "dorian", "mixolydian", "phrygian", "lydian", "locrian", "harmonic minor", "melodic minor", "major pentatonic", "minor pentatonic"])
      assert.ok(common.includes(name), name);
    assert.deepEqual(theory.scales.find((s) => s.name === "minor pentatonic").intervals, ["1P", "3m", "4P", "5P", "7m"]);
  });

  test("the 85 iReal chord symbols, each with intervals", () => {
    assert.equal(Object.keys(theory.chords).length, 85);
    assert.deepEqual(theory.chords.m7, ["1P", "3m", "5P", "7m"]);
    assert.deepEqual(theory.chords["^7"], ["1P", "3M", "5P", "7M"]);
    assert.deepEqual(theory.chords[""], ["1P", "3M", "5P"]);
    assert.deepEqual(theory.chords.o, ["1P", "3m", "5d"]);
    assert.deepEqual(theory.chords["7susadd3"], ["1P", "3M", "4P", "5P", "7m"]);
    for (const [sym, iv] of Object.entries(theory.chords)) assert.ok(iv.length >= 2 && iv[0] === "1P", `${sym}: ${iv}`);
  });

  test("the 15 vowels and the voicing dictionaries", () => {
    assert.deepEqual(theory.vowels, ["a", "e", "i", "o", "u", "ae", "aa", "oe", "ue", "y", "uh", "un", "en", "an", "on"]);
    for (const d of ["ireal", "lefthand", "triads", "guidetones", "legacy"]) assert.ok(theory.voicingDicts.includes(d), d);
  });
});

describe("completions.json", () => {
  test("lean: no empty or default-valued optional fields", () => {
    for (const [name, m] of Object.entries(meta)) {
      assert.deepEqual(Object.keys(m).slice(0, 3), ["category", "rank", "availability"], name);
      if ("synonyms" in m) assert.ok(m.synonyms.length, name);
      for (const k of Object.keys(m)) assert.ok(["category", "rank", "availability", "aliasOf", "synonyms", "range", "docUrl"].includes(k), `${name}.${k}`);
    }
  });

  test("the generator is deterministic", () => {
    assert.deepEqual(generateCatalog(inputs), catalog);
  });
});
