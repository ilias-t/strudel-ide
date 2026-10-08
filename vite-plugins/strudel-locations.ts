// ═══════════════════════════════════════════════════════════════════════════
// strudel-locations — give mini-notation strings in song files source locations
// ═══════════════════════════════════════════════════════════════════════════
//
// strudel.cc highlights the characters of the mini-notation token that is
// sounding right now. It can do that because its transpiler rewrites every
// "mini string" into `m("...", offset)`, so each hap carries
// `hap.context.locations = [{ start, end }]` (absolute offsets into the code).
//
// This plugin does the same for `src/songs/*.ts` (not index.ts, not `_*.ts`),
// using the TypeScript parser for exact positions and magic-string so the
// sourcemap still points at the original text:
//
//     s("bd*4").bank("RolandTR808")
//  →  s(__strudel_m("bd*4", 123)).bank(__strudel_m("RolandTR808", 140))
//
// `offset` is the UTF-16 position of the opening quote in the file as read
// from disk, which is exactly what `m` from @strudel/mini expects (it parses
// `"${str}"`, so token positions are relative to the quote).
//
// WHICH STRINGS ARE REWRITTEN (least-surprise rule: a string only becomes a
// Pattern where strudel would have turned it into a Pattern anyway)
//   ✔ string literals ('…' or "…") and backtick literals without `${}`
//   ✔ that are a DIRECT argument of a call expression (not `new`, not inside
//     arrays/objects, not property values like `name: "Jynx"`, not imports,
//     not types, not object keys)
//   ✔ whose callee is a strudel function:
//       - bare call `note("…")`: a function strudel exports that is also a
//         Pattern method (s, note, n, stack, cat, seq, lpf, …) or a known
//         pattern constructor (arrange, polymeter, timeCat, …), and that is not
//         declared anywhere in the file (a local `s`/helper shadows it)
//       - method call `x.scale("…")`: any Pattern.prototype method, minus a
//         denylist of names that also exist on strings/arrays/functions and
//         typically take plain strings (join, bind, apply, …) or strudel
//         methods that need plain strings (p, q, log, markcss, …); calls on
//         console/JSON/Math/document/… or on string literals are never touched
//   ✔ whose raw source text equals its cooked value (no escapes, no CRLF in
//     templates — otherwise offsets would drift) and which parses as mini
//     notation (an unparsable string is left alone, so runtime is unchanged)
//   ✔ special case: `mini("a b", …)` with only such literals becomes
//     `__strudel_mini(__strudel_m("a b", o), …)` (= sequence(m(…)), what mini builds)
// Everything else is left exactly as written. With `miniAllStrings()` those
// strings still become patterns at runtime, just without file locations: the
// highlighter installs location-free versions of the string parser and of the
// global `mini`/`h` (src/live/highlights.ts, stripImplicitLocations), so only
// __strudel_m patterns carry offsets.
//
// Names are introspected from the installed @strudel/core|mini|tonal, so new
// controls work without touching this file.
//
// `__strudel_m` calls the global `m` (installed by initStrudel()/evalScope),
// NOT an import from "@strudel/mini": @strudel/web is a self-contained bundle,
// and patterns from a second copy of @strudel/core would lack the methods
// tonal/webaudio/draw register on the bundled Pattern prototype.
//
// Each transformed module also exports
//   __strudel_file    — workspace-relative path, e.g. "src/songs/jynx.ts"
//   __strudel_version — contentVersion(original text): FNV-1a 32-bit over the
//                       UTF-16 code units, hex (same as src/live/protocol.ts)
// All injected code is appended after the original text, so line numbers in
// the transformed output are unchanged even without the sourcemap.
// ═══════════════════════════════════════════════════════════════════════════

import path from "node:path";
import ts from "typescript";
import type { Plugin } from "vite";
import { contentVersion } from "../src/live/protocol.ts";
import { strudelNamesFrom, type StrudelModules, type StrudelNames } from "../src/compile/names.ts";
import { transformLocations, type LocationsResult, type Rewrite } from "../src/compile/locations.ts";

// The transform itself lives in src/compile/ (locations.ts, names.ts), shared
// with the browser compiler so local and hosted highlighting can't drift.
export type { StrudelNames, Rewrite };
export type TransformResult = LocationsResult;

let namesPromise: Promise<StrudelNames> | undefined;

/** Introspect the installed strudel packages (once, lazily) */
export function loadStrudelNames(): Promise<StrudelNames> {
  return (namesPromise ??= (async () => {
    // @strudel/core logs a banner and a "not in browser" warning on import
    const { log, warn } = console;
    console.log = console.warn = () => {};
    let modules: StrudelModules;
    try {
      const [core, mini, tonal] = await Promise.all([
        import("@strudel/core"),
        import("@strudel/mini"),
        import("@strudel/tonal"),
      ]);
      modules = { core, mini, tonal } as unknown as StrudelModules;
    } finally {
      console.log = log;
      console.warn = warn;
    }
    return strudelNamesFrom(modules);
  })());
}

// Version hash: contentVersion() from the shared protocol (FNV-1a 32-bit over
// UTF-16 code units, 8 hex digits), so editors compute the identical value
export { contentVersion };

/**
 * Rewrite mini-notation literals in a song file. `file` is the
 * workspace-relative path that ends up in `__strudel_file`.
 */
export function transformSong(code: string, file: string, names: StrudelNames): TransformResult {
  return transformLocations(ts, code, file, names);
}

/** Is this module id a song file the transform applies to? */
export function isSongFile(id: string, root: string): boolean {
  const [file, query = ""] = id.split("?");
  if (/(^|&)(raw|url|worker|sharedworker|inline)(&|=|$)/.test(query)) return false;
  const rel = path.relative(root, file).split(path.sep).join("/");
  const m = /^src\/songs\/([^/]+)\.ts$/.exec(rel);
  return !!m && m[1] !== "index" && !m[1].startsWith("_");
}

// ─────────────────────────────────────────────────────────────────────────────
// Vite plugin
// ─────────────────────────────────────────────────────────────────────────────

export default function strudelLocations(): Plugin {
  let root = process.cwd();
  return {
    name: "strudel-locations",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
    },
    async transform(code, id) {
      if (!isSongFile(id, root)) return null;
      const file = path.relative(root, id.split("?")[0]).split(path.sep).join("/");
      const result = transformSong(code, file, await loadStrudelNames());
      return { code: result.code, map: result.map.toString() };
    },
  };
}
