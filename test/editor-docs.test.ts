// The Monaco editor's doc formatting: Strudel's JSDoc `@example` tags become
// fenced code blocks in the description, so hovers and completion details show
// real code instead of Monaco's one-line `*@example* — …` paragraph.
//
// Run: node --test test/editor-docs.test.ts   (Node ≥ 22.18 strips TS types)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import ts from "typescript";
import { formatDocComment, formatDocComments } from "../src/ui/editor-docs.ts";

const root = resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

/** What TypeScript (and so Monaco's hover) makes of `member`'s JSDoc in `lib`. */
function quickInfo(lib: string, member: string): { doc: string; tags: { name: string; text: string }[] } {
  const files: Record<string, string> = { "/lib.d.ts": lib, "/main.ts": `p.${member};` };
  const ls = ts.createLanguageService({
    getScriptFileNames: () => Object.keys(files),
    getScriptVersion: () => "1",
    getScriptSnapshot: (f) => (files[f] === undefined ? undefined : ts.ScriptSnapshot.fromString(files[f])),
    getCurrentDirectory: () => "/",
    getCompilationSettings: () => ({ noLib: true }),
    getDefaultLibFileName: () => "/none.d.ts",
    fileExists: (f) => f in files,
    readFile: (f) => files[f],
  });
  const info = ls.getQuickInfoAtPosition("/main.ts", 2);
  assert.ok(info, `no quick info for ${member}`);
  return {
    doc: ts.displayPartsToString(info.documentation),
    tags: (info.tags ?? []).map((t) => ({ name: t.name, text: ts.displayPartsToString(t.text) })),
  };
}

const wrap = (members: string) => `interface P {\n${members}\n}\ndeclare const p: P;\n`;

describe("formatDocComment", () => {
  test("multiple @example tags become fenced ts blocks after the description", () => {
    const input = [
      "/**",
      "   * Low-pass filter.",
      "   *",
      "   * Synonyms: `cutoff`",
      "   * @param frequency audible between 0 and 20000",
      "   * @example",
      '   * s("bd").lpf(400)',
      "   * @example",
      '   * s("hh*8").lpf("1000:10")',
      "   */",
    ].join("\n");
    assert.equal(
      formatDocComment(input),
      [
        "/**",
        "   * Low-pass filter.",
        "   *",
        "   * Synonyms: `cutoff`",
        "   *",
        "   * ```ts",
        '   * s("bd").lpf(400)',
        "   * ```",
        "   *",
        "   * ```ts",
        '   * s("hh*8").lpf("1000:10")',
        "   * ```",
        "   * @param frequency audible between 0 and 20000",
        "   */",
      ].join("\n")
    );
  });

  test("keeps comment lines, indentation and inner blank lines; drops outer blank lines", () => {
    const lib = wrap(
      [
        "  /**",
        "   * Adds numbers.",
        "   * @example",
        "   *",
        "   * // Here, the triad 0, 2, 4 is shifted",
        '   * n("0 2 4".add("<0 3>"))',
        "   *",
        "   *   .scale(\"C:major\") // trailing comment",
        "   * // n(\"<[0 2 4] [3 5 7]>\")",
        "   *",
        "   */",
        "  add(x: number): P;",
      ].join("\n")
    );
    const { doc, tags } = quickInfo(formatDocComments(lib), "add");
    assert.equal(
      doc,
      [
        "Adds numbers.",
        "",
        "```ts",
        "// Here, the triad 0, 2, 4 is shifted",
        'n("0 2 4".add("<0 3>"))',
        "",
        '  .scale("C:major") // trailing comment',
        '// n("<[0 2 4] [3 5 7]>")',
        "```",
      ].join("\n")
    );
    assert.deepEqual(tags, []);
  });

  test("@param tags stay real tags (signature help reads them), in order", () => {
    const lib = wrap(
      [
        "  /**",
        "   * Cubic distortion.",
        "   * @param distortion amount of distortion to apply",
        "   * @param volume linear postgain",
        "   * @example",
        '   * s("bd").cubic(2, 0.5)',
        "   */",
        "  cubic(distortion: number, volume: number): P;",
      ].join("\n")
    );
    const { doc, tags } = quickInfo(formatDocComments(lib), "cubic");
    assert.equal(doc, 'Cubic distortion.\n\n```ts\ns("bd").cubic(2, 0.5)\n```');
    assert.deepEqual(tags, [
      { name: "param", text: "distortion amount of distortion to apply" },
      { name: "param", text: "volume linear postgain" },
    ]);
  });

  test("a block with no examples is left byte-for-byte unchanged", () => {
    const block = "/**\n   * Alias of `label`.\n   *\n   * @param label text to display\n   */";
    assert.equal(formatDocComment(block), block);
    assert.equal(formatDocComment("/** One line. */"), "/** One line. */");
    const lib = wrap(`  ${block}\n  activeLabel(label?: string): P;\n  /** @deprecated */\n  old(): P;`);
    assert.equal(formatDocComments(lib), lib);
  });

  test("inline tags like {@link x} survive untouched", () => {
    const input = [
      "/**",
      " * Like {@link fast}, but see {@link Pattern.slow | slow}.",
      " * @example",
      ' * s("bd").fast(2)',
      " */",
    ].join("\n");
    const out = formatDocComment(input);
    assert.ok(out.includes(" * Like {@link fast}, but see {@link Pattern.slow | slow}.\n"), out);
    const lib = wrap(`  ${out.replaceAll("\n", "\n  ")}\n  f(): P;\n  fast(): P;`);
    const { doc } = quickInfo(lib, "f");
    // (TS itself renders a `{@link a | text}` as `{@link a text}`.)
    assert.match(doc, /^Like \{@link fast ?\}, but see \{@link Pattern\.slow ?\|? ?slow\}\.\n\n```ts\ns\("bd"\)\.fast\(2\)\n```$/);
  });

  test("an example caption stays as a line above its block", () => {
    const out = formatDocComment(["/**", " * Desc.", " * @example Two kicks", ' * s("bd*2")', " */"].join("\n"));
    assert.equal(out, ["/**", " * Desc.", " *", " * Two kicks", " *", " * ```ts", ' * s("bd*2")', " * ```", " */"].join("\n"));
  });

  test("an already fenced example isn't fenced twice", () => {
    const out = formatDocComment(["/**", " * Desc.", " * @example", " * ```js", ' * s("bd")', " * ```", " */"].join("\n"));
    assert.equal(out, ["/**", " * Desc.", " *", " * ```js", ' * s("bd")', " * ```", " */"].join("\n"));
  });

  test("an example containing ``` gets a longer fence", () => {
    const out = formatDocComment(["/**", " * @example", " * mini(`", " * ```", " * `)", " */"].join("\n"));
    assert.equal(out, ["/**", " * ````ts", " * mini(`", " * ```", " * `)", " * ````", " */"].join("\n"));
  });

  test("a block whose example has a whitespace-preceded @ is left alone (TS would cut it into a tag)", () => {
    const block = ["/**", " * Desc.", " * @example", ' * s("bd") // @foo', " */"].join("\n");
    assert.equal(formatDocComment(block), block);
  });

  test("is idempotent", () => {
    const lib = read("src/knobs.d.ts");
    const once = formatDocComments(lib);
    assert.notEqual(once, lib);
    assert.equal(formatDocComments(once), once);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The real declaration files
// ─────────────────────────────────────────────────────────────────────────────

/** Every declaration's qualified name (`Pattern.lpf`, `note`, …) and its JSDoc tag names. */
function declarations(text: string) {
  const sf = ts.createSourceFile("lib.d.ts", text, ts.ScriptTarget.Latest, true);
  const out: { name: string; tags: string[]; comment: string }[] = [];
  const visit = (node: ts.Node, scope: string) => {
    const name = (node as { name?: ts.Node }).name;
    let next = scope;
    if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
      next = scope ? `${scope}.${name.text}` : name.text;
      const docs = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc);
      out.push({
        name: `${ts.SyntaxKind[node.kind]} ${next}`,
        tags: ts.getJSDocTags(node).map((t) => t.tagName.text),
        comment: docs.map((d) => ts.getTextOfJSDocComment(d.comment) ?? "").join("\n"),
      });
    }
    ts.forEachChild(node, (child) => visit(child, next));
  };
  visit(sf, "");
  return out;
}

function syntaxErrors(text: string): string[] {
  const file = "/lib.d.ts";
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true);
  const host = ts.createCompilerHost({});
  host.getSourceFile = (f) => (f === file ? sf : undefined);
  const program = ts.createProgram([file], { noLib: true, noResolve: true }, host);
  return program.getSyntacticDiagnostics(sf).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("the real Strudel declarations", () => {
  const original = read("src/strudel.generated.d.ts");
  const formatted = formatDocComments(original);

  test("still parse, with no syntax errors", () => {
    assert.deepEqual(syntaxErrors(formatted), []);
  });

  test("declare the same names, every one keeping its JSDoc", () => {
    const before = declarations(original);
    const after = declarations(formatted);
    assert.ok(before.length > 1000, `only ${before.length} declarations found`);
    assert.deepEqual(
      after.map((d) => d.name),
      before.map((d) => d.name)
    );
    before.forEach((b, i) => {
      assert.equal(after[i].comment.length > 0, b.comment.length > 0, `${b.name} lost or gained its doc`);
      assert.deepEqual(after[i].tags, b.tags.filter((t) => t !== "example"), `${b.name}'s tags`);
    });
  });

  test("turn every @example into a fenced block", () => {
    const examples = (original.match(/^\s*\* @example\b/gm) ?? []).length;
    assert.ok(examples > 1000, `only ${examples} examples`);
    assert.equal((formatted.match(/^\s*\* ```ts$/gm) ?? []).length, examples);
    assert.doesNotMatch(formatted, /@example/);
  });

  test("Pattern.lpf's doc reads description, then its examples as code", () => {
    const lpf = declarations(formatted).find((d) => d.name === "MethodSignature Pattern.lpf");
    assert.ok(lpf);
    assert.match(lpf.comment, /^Applies the cutoff frequency/);
    assert.ok(lpf.comment.includes('```ts\ns("bd sd [~ bd] sd,hh*6").lpf("<4000 2000 1000 500 200 100>")\n```'), lpf.comment);
    assert.deepEqual(lpf.tags, ["param"]);
  });

  test("the files without examples come through unchanged", () => {
    for (const file of ["src/strudel.d.ts", "src/strudel.sounds.generated.d.ts", "src/ui/editor-song-types.d.ts"]) {
      const text = read(file);
      assert.equal(formatDocComments(text), text, file);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The editor's copy of the Song types
// ─────────────────────────────────────────────────────────────────────────────

/** Each exported type alias / interface, printed without comments or formatting. */
function exportedTypes(file: string): Map<string, string> {
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const printer = ts.createPrinter({ removeComments: true });
  const out = new Map<string, string>();
  for (const node of sf.statements) {
    if (!ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node)) continue;
    if (!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    out.set(node.name.text, printer.printNode(ts.EmitHint.Unspecified, node, sf).replace(/\s+/g, " "));
  }
  return out;
}

describe("src/ui/editor-song-types.d.ts", () => {
  test("declares exactly the types src/songs/index.ts exports, member for member", () => {
    const real = exportedTypes("src/songs/index.ts");
    const copy = exportedTypes("src/ui/editor-song-types.d.ts");
    assert.ok(real.has("Song") && real.has("SongSections"), "index.ts's exports not found");
    assert.deepEqual([...copy.keys()].sort(), [...real.keys()].sort(), "exported type names drifted: copy them over");
    for (const [name, text] of real) assert.equal(copy.get(name), text, `${name} drifted: copy it over from src/songs/index.ts`);
  });

  test("is declarations only (no runtime code for Vite's glob plugin to see)", () => {
    const text = read("src/ui/editor-song-types.d.ts");
    assert.doesNotMatch(text, /import\.meta/);
    assert.deepEqual(syntaxErrors(text), []);
  });
});
