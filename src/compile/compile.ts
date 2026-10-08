// ═══════════════════════════════════════════════════════════════════════════
// The browser song compiler: song text → an ES module the player can import
// ═══════════════════════════════════════════════════════════════════════════
//
// Exactly the pipeline Vite runs on a song file, with the same shared code:
//
//   syntaxError         ./syntax.ts     (1-based line/column, nothing compiled)
//   transformLocations  ./locations.ts  mini literals → __strudel_m("…", offset)
//   transformKnobs      ./knobs.ts      knob( → __strudel_knob( (skipped when the
//                                       file declares its own knob)
//   ts.transpileModule                  types stripped (target ES2022, ESNext)
//   imports                             see below
//
// so highlight offsets index into `text` exactly as they would into the file.
//
// IMPORTS. The compiled module runs from a blob: URL, which can't resolve
// relative or bare specifiers. Type-only imports (`import type { Song } from "."`,
// or any import used only as a type) are erased by TS. Value imports from the
// song registry (".", "./index", "./index.ts", "./index.js") become reads of
// `globalThis.__strudelSongsIndex` (the player sets it to the songs index
// module): `import { isPattern as p } from "."` → `const { isPattern: p } = …;`,
// `import * as songs from "."` → `const songs = …;`. Every other value import,
// re-export, or a default import from the registry (it has none) is a compile
// error naming the specifier and its line. Dynamic `import()` is left as written:
// absolute URLs work, relative ones fail at runtime (a blob: URL is no base).
//
// LINES. Both transforms keep every line where it was; TS doesn't (erased
// interfaces, reprinted statements). `map` composes TS's map with the
// transforms' magic-string maps: JS → original text, so runtime errors and
// devtools point at the file as written. The import rewrite keeps the JS's
// line count, so the map stays valid.
//
// Pure: takes the `typescript` instance as a parameter, no browser APIs. Runs
// in the compiler worker (./worker.ts) and in Node tests.
// ═══════════════════════════════════════════════════════════════════════════

import type TS from "typescript";
import { SourceMap } from "magic-string";
import { transformKnobs } from "./knobs.ts";
import { transformLocations } from "./locations.ts";
import type { StrudelNames } from "./names.ts";
import { composeMappings, lookup, type Segment } from "./sourcemap.ts";
import { syntaxError } from "./syntax.ts";

type Ts = typeof TS;

export interface CompileError {
  message: string;
  /** 1-based, in the original text */
  line?: number;
  /** 1-based, in the original text */
  column?: number;
}

export type CompileResult =
  | {
      ok: true;
      /** The song file the text stands for (`src/songs/<id>.ts`), as passed in */
      file: string;
      /** contentVersion(text) (src/live/protocol.ts) */
      version: string;
      /** The ES module, without a sourceMappingURL comment */
      js: string;
      /** Source map v3 JSON: js → text (sources: [file], sourcesContent: [text]) */
      map: string;
    }
  | { ok: false; error: CompileError };

/** The global the player sets to the songs index module (src/songs/index.ts) */
export const SONGS_INDEX_GLOBAL = "__strudelSongsIndex";

/** Specifiers that name the song registry */
const INDEX_SPECIFIERS = new Set([".", "./index", "./index.ts", "./index.js"]);

/** Compile a song's text (see the header). Never throws. */
export function compileSong(ts: Ts, names: StrudelNames, text: string, file: string): CompileResult {
  const syntax = syntaxError(ts, text, file);
  if (syntax) return { ok: false, error: { message: syntax.message, line: syntax.line, column: syntax.column } };
  try {
    const located = transformLocations(ts, text, file, names);
    const knobbed = transformKnobs(ts, located.code, file);
    const out = ts.transpileModule(knobbed?.code ?? located.code, {
      fileName: file,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, sourceMap: true },
    });
    // TS's trailing `//# sourceMappingURL=x.js.map` names a file that doesn't exist
    const js = out.outputText.replace(/\n\/\/# sourceMappingURL=.*\s*$/, "\n");
    const tsMap = JSON.parse(out.sourceMapText!) as { mappings: string };
    const mappings = composeMappings(
      tsMap.mappings,
      knobbed ? [knobbed.map.mappings, located.map.mappings] : [located.map.mappings]
    );
    const imports = rewriteImports(ts, js, file, mappings);
    if ("error" in imports) return { ok: false, error: imports.error };
    const map = new SourceMap({ file, sources: [file], sourcesContent: [text], names: [], mappings });
    return { ok: true, file, version: located.version, js: imports.js, map: map.toString() };
  } catch (err) {
    return { ok: false, error: { message: `Compile error: ${err instanceof Error ? err.message : String(err)}` } };
  }
}

/** Rewrite the registry's value imports in the emitted JS (line count unchanged), or the first unsupported one */
function rewriteImports(
  ts: Ts,
  js: string,
  file: string,
  mappings: Segment[][]
): { js: string } | { error: CompileError } {
  const sf = ts.createSourceFile(file.replace(/\.ts$/, ".js"), js, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits: { start: number; end: number; text: string }[] = [];
  const fail = (node: TS.Node, what: string, why: string): { error: CompileError } => {
    const gen = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const pos = lookup(mappings, gen.line, gen.character);
    const where = pos ? ` (line ${pos.line + 1})` : "";
    return {
      error: { message: `${what}${where}: ${why}`, ...(pos && { line: pos.line + 1, column: pos.column + 1 }) },
    };
  };
  const onlyIndex = `a song can only import values from its registry "." (src/songs/index.ts)`;

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const spec = stmt.moduleSpecifier.text;
      if (!INDEX_SPECIFIERS.has(spec)) return fail(stmt, `Unsupported import "${spec}"`, onlyIndex);
      const clause = stmt.importClause;
      if (clause?.name) {
        return fail(
          stmt,
          `Unsupported default import from "${spec}"`,
          `src/songs/index.ts has no default export; use import { … } from "${spec}" or import * as songs from "${spec}"`
        );
      }
      const bindings = clause?.namedBindings;
      let decl = "";
      if (bindings && ts.isNamespaceImport(bindings)) {
        decl = `const ${bindings.name.text} = globalThis.${SONGS_INDEX_GLOBAL};`;
      } else if (bindings && ts.isNamedImports(bindings)) {
        const parts = bindings.elements
          .filter((el) => !el.isTypeOnly)
          .map((el) => (el.propertyName ? `${el.propertyName.getText(sf)}: ${el.name.text}` : el.name.text));
        if (parts.length) decl = `const { ${parts.join(", ")} } = globalThis.${SONGS_INDEX_GLOBAL};`;
      }
      const start = stmt.getStart(sf);
      const end = stmt.getEnd();
      // keep every line break, so the lines after it (and the map) don't move
      edits.push({ start, end, text: decl + "\n".repeat(js.slice(start, end).split("\n").length - 1) });
    } else if (ts.isImportDeclaration(stmt)) {
      return fail(stmt, "Unsupported import", onlyIndex);
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
      const spec = ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : stmt.moduleSpecifier.getText(sf);
      return fail(stmt, `Unsupported re-export from "${spec}"`, "a compiled song can't re-export modules");
    } else if (ts.isImportEqualsDeclaration(stmt)) {
      return fail(stmt, "Unsupported import", onlyIndex);
    }
  }
  let out = js;
  for (const { start, end, text } of edits.reverse()) out = out.slice(0, start) + text + out.slice(end);
  return { js: out };
}
