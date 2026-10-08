// What the library / palette insert at the editor's caret (src/ui/discover/insert.ts).
// Run: node --test test/discover-insert.test.ts

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { defaultInsertSpot, insertionFor, type InsertItem } from "../src/ui/discover/insert.ts";

/** Insert at the "|" in `src`; returns the new text with "|" where the caret lands */
function apply(src: string, item: InsertItem): string {
  const at = src.indexOf("|");
  const text = src.slice(0, at) + src.slice(at + 1);
  const ins = insertionFor(text, at, item);
  assert.ok(ins, "refused");
  const out = text.slice(0, at) + ins.text + text.slice(at);
  const caret = at + ins.caret;
  return out.slice(0, caret) + "|" + out.slice(caret);
}

const bd: InsertItem = { type: "sound", name: "bd" };
const piano: InsertItem = { type: "sound", name: "piano", pitched: true };
const tr909: InsertItem = { type: "bank", name: "RolandTR909", part: "bd" };
const lpf: InsertItem = { type: "function", name: "lpf", kind: "both", params: 1 };
const rev: InsertItem = { type: "function", name: "rev", kind: "both", params: 0 };
const fastMethod: InsertItem = { type: "function", name: "fast", kind: "method", params: 1 };
const stackFn: InsertItem = { type: "function", name: "stack", kind: "function", params: 1 };
const sine: InsertItem = { type: "function", name: "sine", kind: "value", params: 0 };

describe("sounds", () => {
  test("a new expression: s(\"bd\")", () => {
    assert.equal(apply("const kick = |;", bd), 'const kick = s("bd")|;');
    assert.equal(apply("return |", bd), 'return s("bd")|');
  });
  test("after an expression: chained as .s()", () => {
    assert.equal(apply('note("c e g")|', bd), 'note("c e g").s("bd")|');
    assert.equal(apply('note("c e g")\n  |', bd), 'note("c e g")\n  .s("bd")|');
  });
  test("inside a string: the bare name, spaced from its neighbours", () => {
    assert.equal(apply('s("|")', bd), 's("bd|")');
    assert.equal(apply('s("hh|")', bd), 's("hh bd|")');
    assert.equal(apply('s("|hh")', bd), 's("bd| hh")');
    assert.equal(apply('s("hh | sd")', bd), 's("hh bd| sd")');
    assert.equal(apply('s("[hh |]")', bd), 's("[hh bd|]")');
    assert.equal(apply("s(`hh |`)", bd), "s(`hh bd|`)");
  });
  test("a pitched sample plays a note", () => {
    assert.equal(apply("const keys = |", piano), 'const keys = note("c3").s("piano")|');
    assert.equal(apply('n("0 2").scale("C:major")|', piano), 'n("0 2").scale("C:major").s("piano")|');
  });
  test("an argument list or an operator starts a new expression", () => {
    assert.equal(apply("stack(|)", bd), 'stack(s("bd")|)');
    assert.equal(apply('stack(s("hh"), |)', bd), 'stack(s("hh"), s("bd")|)');
    assert.equal(apply("const k = cond ? |", bd), 'const k = cond ? s("bd")|');
  });
});

describe("bank-only sounds (no unbanked samples) carry their bank", () => {
  const perc: InsertItem = { type: "sound", name: "perc", bank: "RolandTR909" };
  test("as an expression, chained, and inside a string", () => {
    assert.equal(apply("const p = |", perc), 'const p = s("perc").bank("RolandTR909")|');
    assert.equal(apply('n("0 1")|', perc), 'n("0 1").s("perc").bank("RolandTR909")|');
    assert.equal(apply('s("hh |")', perc), 's("hh perc|")');
  });
});

describe("banks", () => {
  test("after an expression: .bank()", () => {
    assert.equal(apply('s("bd*4")|', tr909), 's("bd*4").bank("RolandTR909")|');
  });
  test("a new expression: one of its parts on the bank", () => {
    assert.equal(apply("const kick = |", tr909), 'const kick = s("bd").bank("RolandTR909")|');
  });
  test("inside a string: the bare name", () => {
    assert.equal(apply('.bank("|")', tr909), '.bank("RolandTR909|")');
  });
});

describe("functions", () => {
  test("after an expression: a method call with the caret in its parens", () => {
    assert.equal(apply('s("bd")|', lpf), 's("bd").lpf(|)');
    assert.equal(apply('s("bd")\n    |', fastMethod), 's("bd")\n    .fast(|)');
  });
  test("no parameters: the caret goes after the call", () => {
    assert.equal(apply('s("bd")|', rev), 's("bd").rev()|');
  });
  test("a new expression: a call", () => {
    assert.equal(apply("const x = |", stackFn), "const x = stack(|)");
    assert.equal(apply("const x = |", lpf), "const x = lpf(|)");
  });
  test("a method-only function outside a chain is still a method", () => {
    assert.equal(apply("|", fastMethod), ".fast(|)");
  });
  test("a value (signal) is its bare name", () => {
    assert.equal(apply(".pan(|)", sine), ".pan(sine|)");
  });
  test("after a keyword, a new expression starts", () => {
    assert.equal(apply("return |", lpf), "return lpf(|)");
  });
  test("a function that is only global is a call wherever it goes", () => {
    assert.equal(apply("stack(|)", stackFn), "stack(stack(|))");
  });
});

describe("code (snippets, examples)", () => {
  const code: InsertItem = { type: "code", code: 's("bd*4").bank("RolandTR909")' };
  test("goes in as written where an expression starts", () => {
    assert.equal(apply("const kick = |", code), 'const kick = s("bd*4").bank("RolandTR909")|');
    assert.equal(apply("stack(|)", code), 'stack(s("bd*4").bank("RolandTR909")|)');
  });
  test("is refused inside a string or right after an expression (it would break the file)", () => {
    const text = 's("hh ")';
    assert.equal(insertionFor(text, text.indexOf(" ") + 1, code), null);
    assert.equal(insertionFor('s("hh")', 7, code), null);
  });
});

describe("a selection is replaced", () => {
  test("the item's text stands in for the selected text", () => {
    const text = 'const kick = s("sd");';
    const start = text.indexOf("sd");
    const ins = insertionFor(text, start, bd, start + 2);
    assert.equal(ins?.text, "bd");
  });
});

describe("no caret placed yet (top of the file)", () => {
  const song = `// header
import type { Song } from ".";

const song: Song = {
  name: "x",
  createPattern() {
    const help = () => {
      return 1;
    };
    const kick = s("bd*4");
    return { kick };
  },
};

export default song;
`;
  test("goes on its own line above createPattern()'s return, indented like it", () => {
    const spot = defaultInsertSpot(song);
    assert.ok(spot);
    assert.equal(song.slice(spot.offset, spot.offset + 10), "    return");
    assert.equal(spot.indent, "    ");
  });
  test("only createPattern()'s own top-level return: not a helper after the song, not a nested function", () => {
    const text = song.replace("export default song;", 'function after() {\n  return "x";\n}\n\nexport default song;').replace(
      "    return { kick };",
      "    return { kick };\n    function late() {\n      return 2;\n    }"
    );
    const spot = defaultInsertSpot(text);
    assert.ok(spot);
    assert.equal(text.slice(spot.offset, spot.offset + 18), "    return { kick ");
  });
  test("every song and starter has one: its createPattern() return", () => {
    for (const dir of ["src/songs", "src/starters"]) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "index.ts")) {
        const text = readFileSync(join(dir, file), "utf8");
        const spot = defaultInsertSpot(text);
        assert.ok(spot, `${dir}/${file}`);
        assert.match(text.slice(spot.offset + spot.indent.length), /^return\b/, `${dir}/${file}`);
        assert.ok(spot.offset > text.indexOf("createPattern"), `${dir}/${file}`);
      }
    }
  });
  test("none without createPattern", () => {
    assert.equal(defaultInsertSpot("const x = 1;\n"), null);
  });
});
