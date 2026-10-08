/// <reference path="../src/strudel.d.ts" />
/// <reference path="../src/strudel.generated.d.ts" />
/// <reference path="../src/strudel.sounds.generated.d.ts" />
// The track builder's planner (src/compile/add-track.ts): adding `const <name> = <code>;`
// and `<name>` to a song's returned track record, by the TypeScript AST, never
// corrupting the file. Targeted shapes, then every song and starter: the
// result compiles (compileSong) and createPattern() returns the new track.
//
// Run: node --test test/discover-add-track.test.ts

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import ts from "typescript";
import * as core from "@strudel/core";
import * as mini from "@strudel/mini";
import * as tonal from "@strudel/tonal";
import { freeTrackName, nameProblem, planAddTrack, trackNames, type AddTrackPlan } from "../src/compile/add-track.ts";
import { compileSong, type CompileResult } from "../src/compile/compile.ts";
import { evaluateSong } from "../src/compile/evaluate.ts";
import type { StrudelNames } from "../src/compile/names.ts";
import { KnobRegistry, installKnobGlobals } from "../src/engine/knobs.ts";
import { loadStrudelNames } from "../vite-plugins/strudel-locations.ts";

const HATS = 's("hh*8").gain(0.3)';

type Ok = Extract<AddTrackPlan, { ok: true }>;
function ok(plan: AddTrackPlan): Ok {
  assert.ok(plan.ok, plan.ok ? "" : `refused: ${plan.reason}`);
  return plan;
}

/** The plan's edits applied to `text` (must equal plan.text) */
function applyEdits(text: string, edits: Ok["edits"]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** Plan and check the invariants every ok plan has; returns the new text */
function add(text: string, name: string, code = HATS): string {
  const plan = ok(planAddTrack(ts, text, { name, code }));
  for (let i = 1; i < plan.edits.length; i++) {
    assert.ok(plan.edits[i].start > plan.edits[i - 1].end, "edits are in order, apart (no two at one offset)");
  }
  assert.equal(applyEdits(text, plan.edits), plan.text, "edits reproduce the result");
  assert.equal(plan.text.slice(...plan.constRange), `const ${name} = ${code};`, "constRange selects the new const");
  return plan.text;
}

function refused(text: string, name: string, reason: RegExp, code = HATS) {
  const plan = planAddTrack(ts, text, { name, code });
  assert.ok(!plan.ok, "should be refused");
  assert.match(plan.reason, reason);
  return plan.reason;
}

/** A song whose createPattern body is `body` (indented 4) */
const song = (body: string, head = "") =>
  `import type { Song } from ".";\n${head}\nconst song: Song = {\n  name: "t",\n  createPattern() {\n${body}\n  },\n};\n\nexport default song;\n`;

describe("the record", () => {
  test("a literal record on one line: const before the return, the name after the last track", () => {
    const text = song(`    const kick = s("bd*4");\n    const bass = note("c2").s("sawtooth");\n    return { kick, bass };`);
    assert.equal(
      add(text, "hats"),
      song(`    const kick = s("bd*4");\n    const bass = note("c2").s("sawtooth");\n    const hats = ${HATS};\n    return { kick, bass, hats };`)
    );
  });

  test("a trailing comma on one line is kept", () => {
    const text = song(`    const kick = s("bd*4");\n    return { kick, };`);
    assert.equal(add(text, "hats"), song(`    const kick = s("bd*4");\n    const hats = ${HATS};\n    return { kick, hats, };`));
  });

  test("a multi-line record with trailing commas gets a new line in the same style", () => {
    const text = song(`    const kick = s("bd*4");\n    const bass = s("bass");\n    return {\n      kick,\n      bass,\n    };`);
    assert.equal(
      add(text, "hats"),
      song(`    const kick = s("bd*4");\n    const bass = s("bass");\n    const hats = ${HATS};\n    return {\n      kick,\n      bass,\n      hats,\n    };`)
    );
  });

  test("a multi-line record without a trailing comma stays without one", () => {
    const text = song(`    const kick = s("bd*4");\n    return {\n      kick\n    };`);
    assert.equal(add(text, "hats"), song(`    const kick = s("bd*4");\n    const hats = ${HATS};\n    return {\n      kick,\n      hats\n    };`));
  });

  test("multi-line properties (key: value spanning lines) are followed, not split", () => {
    const text = song(`    const kick = s("bd*4");\n    return mixdown({\n      kick: kick.mask(\n        "<1 0>"\n      ),\n\n      bass: kick,\n    });`, "const mixdown = (t: Record<string, Pattern>) => t;");
    assert.equal(
      add(text, "hats"),
      song(
        `    const kick = s("bd*4");\n    const hats = ${HATS};\n    return mixdown({\n      kick: kick.mask(\n        "<1 0>"\n      ),\n\n      bass: kick,\n      hats,\n    });`,
        "const mixdown = (t: Record<string, Pattern>) => t;"
      )
    );
  });

  test("mixdown({ … }) on one line", () => {
    const head = "const mixdown = (t: Record<string, Pattern>) => t;";
    const text = song(`    const kick = s("bd*4");\n    return mixdown({ kick });`, head);
    assert.equal(add(text, "hats"), song(`    const kick = s("bd*4");\n    const hats = ${HATS};\n    return mixdown({ kick, hats });`, head));
  });

  test("parenthesised, `as` and `satisfies` records", () => {
    for (const [ret, expected] of [
      ["return ({ kick });", "return ({ kick, hats });"],
      ["return { kick } as Record<string, Pattern>;", "return { kick, hats } as Record<string, Pattern>;"],
      ["return { kick } satisfies Record<string, Pattern>;", "return { kick, hats } satisfies Record<string, Pattern>;"],
      ["return ({ kick } as const)!;", "return ({ kick, hats } as const)!;"],
    ]) {
      const text = song(`    const kick = s("bd*4");\n    ${ret}`);
      assert.equal(add(text, "hats"), song(`    const kick = s("bd*4");\n    const hats = ${HATS};\n    ${expected}`), ret);
    }
  });

  test("an empty record becomes { name }", () => {
    assert.equal(add(song(`    return {};`), "hats"), song(`    const hats = ${HATS};\n    return { hats };`));
    assert.equal(add(song(`    return {  };`), "hats"), song(`    const hats = ${HATS};\n    return { hats };`));
  });

  test("a comment after the last track stays where it is", () => {
    const text = song(`    const kick = s("bd*4");\n    return {\n      kick, // the pulse\n      // bass,\n    };`);
    assert.equal(
      add(text, "hats"),
      song(`    const kick = s("bd*4");\n    const hats = ${HATS};\n    return {\n      kick, // the pulse\n      hats,\n      // bass,\n    };`)
    );
    const inline = song(`    const kick = s("bd*4");\n    return { kick /* loud */ };`);
    assert.equal(add(inline, "hats"), song(`    const kick = s("bd*4");\n    const hats = ${HATS};\n    return { kick, hats /* loud */ };`));
  });

  test("a comment after the last track without a trailing comma", () => {
    const text = song(`    const kick = s("bd*4");\n    return {\n      kick // the pulse\n    };`);
    assert.equal(
      add(text, "hats"),
      song(`    const kick = s("bd*4");\n    const hats = ${HATS};\n    return {\n      kick, // the pulse\n      hats\n    };`)
    );
  });

  test("CRLF files get CRLF lines", () => {
    const lf = song(`    const kick = s("bd*4");\n    return {\n      kick,\n    };`);
    const crlf = lf.replace(/\n/g, "\r\n");
    const out = add(crlf, "hats");
    assert.doesNotMatch(out.replace(/\r\n/g, ""), /\n/, "no bare LF");
    assert.equal(out, add(lf, "hats").replace(/\n/g, "\r\n"));
  });

  test("the last top-level return is used; returns in nested functions are not", () => {
    const text = song(
      `    const kick = s("bd*4").withValue((v) => {\n      return v;\n    });\n    if (!kick) return { kick };\n    return { kick };`
    );
    assert.equal(
      add(text, "hats"),
      song(`    const kick = s("bd*4").withValue((v) => {\n      return v;\n    });\n    if (!kick) return { kick };\n    const hats = ${HATS};\n    return { kick, hats };`)
    );
  });

  test("createPattern as a function or block-bodied arrow property, export default literal with satisfies", () => {
    const fn = `import type { Song } from ".";\nexport default {\n  name: "t",\n  createPattern: function () {\n    return { kick: s("bd") };\n  },\n} satisfies Song;\n`;
    assert.match(add(fn, "hats"), /const hats = .*;\n    return \{ kick: s\("bd"\), hats \};/);
    const arrow = `import type { Song } from ".";\nconst song = {\n  name: "t",\n  createPattern: () => {\n    return { kick: s("bd") };\n  },\n} as Song;\nexport default song;\n`;
    assert.match(add(arrow, "hats"), /return \{ kick: s\("bd"\), hats \};/);
  });

  test("the original text is never changed in place (edits are offsets into it)", () => {
    const text = song(`    const kick = s("bd*4");\n    return { kick };`);
    const plan = ok(planAddTrack(ts, text, { name: "hats", code: HATS }));
    for (const e of plan.edits) assert.ok(e.start >= 0 && e.end <= text.length && e.start <= e.end);
  });
});

describe("refusals", () => {
  const unchanged = (text: string, name: string, reason: RegExp) => {
    const before = text;
    refused(text, name, reason);
    assert.equal(text, before);
  };

  test("return tracks (a variable) is refused", () => {
    unchanged(song(`    const tracks = { kick: s("bd") };\n    return tracks;`), "hats", /track list/);
  });

  test("return stack(…) is refused", () => {
    unchanged(song(`    return stack(s("bd"), s("hh"));`), "hats", /track list/);
  });

  test("a single pattern and a spread-only record are refused", () => {
    unchanged(song(`    return s("bd*4");`), "hats", /track list/);
    unchanged(song(`    const t = { kick: s("bd") };\n    return { ...t };`), "hats", /track list/);
  });

  test("an arrow createPattern with an expression body is refused", () => {
    const text = `import type { Song } from ".";\nexport default { name: "t", createPattern: () => ({ kick: s("bd") }) } satisfies Song;\n`;
    unchanged(text, "hats", /createPattern/);
  });

  test("no createPattern, no default export", () => {
    unchanged(`import type { Song } from ".";\nconst song: Song = { name: "t" } as Song;\nexport default song;\n`, "hats", /createPattern/);
    unchanged(`const x = 1;\n`, "hats", /song/);
  });

  test("a file with a syntax error is never touched", () => {
    unchanged(song(`    const kick = s("bd*4";\n    return { kick };`), "hats", /syntax/i);
  });

  test("names: invalid identifiers and reserved words", () => {
    const text = song(`    const kick = s("bd*4");\n    return { kick };`);
    for (const bad of ["", "2hats", "hats-2", "my hats", "const", "return", "let", "await", "yield", "class", "hats;evil()", "arguments", "eval"]) {
      refused(text, bad, /name/i);
    }
  });

  test("names: an existing track, a const in createPattern, a module binding", () => {
    const text = song(
      `    const kick = s("bd*4");\n    const bass = note("c2");\n    return { kick, lead: bass };`,
      `import { thing } from "./x";\nconst FADERS = {};\nfunction helper() {}`
    );
    refused(text, "kick", /already/);
    refused(text, "lead", /already/);
    refused(text, "bass", /already/);
    refused(text, "FADERS", /already/);
    refused(text, "helper", /already/);
    refused(text, "thing", /already/);
    refused(text, "song", /already/);
  });

  test("names the song or the snippet already uses (a const would shadow them)", () => {
    const text = song(`    const kick = s("bd*4");\n    return { kick };`);
    refused(text, "s", /already/); // createPattern calls s()
    refused(text, "note", /already/, 'note("c3")'); // the snippet calls note()
  });

  test("code that isn't one expression is refused", () => {
    const text = song(`    const kick = s("bd*4");\n    return { kick };`);
    for (const bad of ['s("hh"); evil()', 's("hh") // comment', "", "   ", 's("hh"', "})", 's("hh"),\n  x']) {
      refused(text, "hats", /snippet|code|expression|verify/i, bad);
    }
  });
});

describe("names", () => {
  const text = song(`    const kick = s("bd*4");\n    const hats2 = s("hh");\n    return { kick, hats: hats2 };`);

  test("freeTrackName picks base, base2, base3… past every taken name", () => {
    assert.equal(freeTrackName(ts, text, "bass"), "bass");
    assert.equal(freeTrackName(ts, text, "hats"), "hats3");
    assert.equal(freeTrackName(ts, text, "kick"), "kick2");
  });

  test("freeTrackName works on songs the planner can't add to", () => {
    assert.equal(freeTrackName(ts, song(`    const hats = s("hh");\n    return stack(hats);`), "hats"), "hats2");
    assert.equal(freeTrackName(ts, "this is { not a song", "hats"), "hats");
  });

  test("trackNames lists the tracks and the taken names, or says why it can't", () => {
    const names = trackNames(ts, text);
    assert.ok(names.ok);
    assert.deepEqual(names.tracks, ["kick", "hats"]);
    for (const n of ["kick", "hats", "hats2", "song", "s"]) assert.ok(names.taken.includes(n), n);
    const tour = trackNames(ts, song(`    const tracks = {};\n    return tracks;`));
    assert.ok(!tour.ok);
    assert.match(tour.reason, /track list/);
  });

  test("nameProblem (no TypeScript needed): identifiers, reserved words, taken", () => {
    assert.equal(nameProblem("hats", []), null);
    assert.equal(nameProblem("hats_2", ["kick"]), null);
    assert.match(nameProblem("", [])!, /name/);
    assert.match(nameProblem("2x", [])!, /name/);
    assert.match(nameProblem("return", [])!, /reserved/);
    assert.match(nameProblem("kick", ["kick"])!, /already/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Every song and starter: plan, compile, evaluate
// ─────────────────────────────────────────────────────────────────────────────

const root = resolve(import.meta.dirname, "..");
const corpus = ["src/songs", "src/starters"].flatMap((dir) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .map((f) => `${dir}/${f}`)
);
/** Songs whose createPattern doesn't end with a literal record (they return a variable) */
const UNRECOGNISED = new Set(["src/songs/tour.ts"]);

let names: StrudelNames;
const recognised: string[] = [];

before(async () => {
  const { log, warn } = console;
  console.log = console.warn = () => {};
  try {
    await core.evalScope(core, mini, tonal);
  } finally {
    console.log = log;
    console.warn = warn;
  }
  mini.miniAllStrings();
  const proto = core.Pattern.prototype as Record<string, unknown>;
  for (const m of ["pianoroll", "punchcard", "scope", "tscope", "fscope", "spectrum", "spiral", "wordfall", "color", "markcss"]) {
    proto[m] ??= function (this: unknown) {
      return this;
    };
  }
  const g = globalThis as Record<string, unknown>;
  for (const fn of ["samples", "initStrudel", "aliasBank", "soundAlias"]) g[fn] ??= async () => {};
  installKnobGlobals(new KnobRegistry(), core.pure);
  names = await loadStrudelNames();
});

after(() => {
  console.log(`  add-track recognises ${recognised.length}/${corpus.length}: ${recognised.join(", ")}`);
});

const toDataUrl = (js: string) => `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;

describe("every song and starter", () => {
  for (const file of corpus) {
    test(`${file}`, async () => {
      const text = readFileSync(join(root, file), "utf8");
      const name = freeTrackName(ts, text, "hats");
      const plan = planAddTrack(ts, text, { name, code: HATS }, file);
      if (UNRECOGNISED.has(file)) {
        assert.ok(!plan.ok, "should be refused");
        assert.match(plan.reason, /track list/);
        return;
      }
      const result = ok(plan);
      recognised.push(file.replace(/^src\//, ""));
      assert.equal(applyEdits(text, result.edits), result.text);
      const compiled: CompileResult = compileSong(ts, names, result.text, file);
      assert.ok(compiled.ok, compiled.ok ? "" : `compile failed: ${compiled.error.message}`);
      const { song: built } = await evaluateSong(compiled, { toUrl: toDataUrl });
      const tracks = built.createPattern() as Record<string, Pattern>;
      assert.equal(typeof (tracks as unknown as Pattern).queryArc, "undefined", "a record of tracks");
      assert.ok(name in tracks, `${name} in ${Object.keys(tracks).join(", ")}`);
      const before = trackNames(ts, text);
      assert.ok(before.ok);
      assert.deepEqual(Object.keys(tracks), [...before.tracks, name], "the new track comes last, the others unchanged");
      const haps = tracks[name].queryArc(0, 1);
      assert.ok(haps.some((h) => (h.value as { s?: string }).s === "hh"), "the new track plays hh");
    });
  }
});
