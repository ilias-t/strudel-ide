// ═══════════════════════════════════════════════════════════════════════════
// The editor's TypeScript: Strudel's globals, the Song types, the compiler
// ═══════════════════════════════════════════════════════════════════════════
//
// Only the lazily loaded Monaco module (code-editor.ts) imports this, so the
// ~0.5 MB of declaration text below never lands in the boot bundle.
//
// Song models live at file:///src/songs/<id>.ts and the declaration files are
// extra libs at their real paths, so a song's `import type { Song } from "."`
// resolves (to file:///src/songs/index.d.ts) as it does on disk.

import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";
import strudelHelpers from "../strudel.d.ts?raw";
import strudelGenerated from "../strudel.generated.d.ts?raw";
import strudelSounds from "../strudel.sounds.generated.d.ts?raw";
import knobs from "../knobs.d.ts?raw";
// The Song types as a declaration-only copy of src/songs/index.ts (a test
// keeps them in sync). Not index.ts?raw itself: Vite's glob plugin would see
// its import.meta.glob, make it an importer of every song and turn each song
// save into a full page reload once the editor has loaded.
import songTypes from "./editor-song-types.d.ts?raw";
import { formatDocComments } from "./editor-docs";

const LIBS: [path: string, text: string][] = [
  ["src/strudel.d.ts", strudelHelpers],
  ["src/strudel.generated.d.ts", strudelGenerated],
  ["src/strudel.sounds.generated.d.ts", strudelSounds],
  ["src/knobs.d.ts", knobs],
  ["src/songs/index.d.ts", songTypes],
];

const configured = new WeakSet<object>();

/** Idempotent. Registers compiler options, the extraLibs and the docs formatting. */
export function setupLanguage(monaco: typeof Monaco): void {
  if (configured.has(monaco)) return;
  configured.add(monaco);

  const ts = monaco.languages.typescript;
  const defaults = ts.typescriptDefaults;

  // tsconfig.json's options, as far as they matter for a song. `bundler`
  // resolution isn't in Monaco's typings; NodeJs resolves `from "."` the same.
  defaults.setCompilerOptions({
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    lib: ["es2020", "dom", "dom.iterable"],
    strict: true,
    noEmit: true,
    allowNonTsExtensions: true,
    skipLibCheck: true,
    // Half-typed code is the normal state of a live-coded song: don't nag.
    noUnusedLocals: false,
    noUnusedParameters: false,
  });
  // Syntax and type errors, like `tsc`. Not TS's suggestion diagnostics, which
  // tsc never reports: they'd strike through songs that pass `npm run check`
  // (jynx and tour use the @deprecated `DrumMachineBank` alias). Completions
  // still strike through deprecated names.
  defaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false, noSuggestionDiagnostics: true });
  // Sync every model to the worker up front, so cross-file types are ready
  // before the first hover rather than after the first request.
  defaults.setEagerModelSync(true);

  for (const [path, text] of LIBS) {
    // @example tags → fenced ```ts blocks, so hovers and completion details
    // show the examples as code (see editor-docs.ts).
    defaults.addExtraLib(path.endsWith(".d.ts") ? formatDocComments(text) : text, `file:///${path}`);
  }
}

/** The model URI for a song file path like "src/songs/jynx.ts" → file:///src/songs/jynx.ts */
export function songModelUri(monaco: typeof Monaco, file: string): Monaco.Uri {
  return monaco.Uri.file(`/${file.replace(/^\.?\/+/, "")}`);
}
