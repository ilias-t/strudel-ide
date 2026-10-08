// ═══════════════════════════════════════════════════════════════════════════
// Evaluate a compiled song (main thread, no TypeScript)
// ═══════════════════════════════════════════════════════════════════════════
//
// Imports the compiler's JS (./compile.ts) as an ES module from a blob: URL
// (short stack frames), with the source map inlined for devtools. The URL is
// registered with the player's error locator (src/engine/errors.ts) before the
// import, so errors thrown by the module (at top level, in createPattern() or
// while playing) map back to the song file's line and column. The blob URL is
// revoked once the import settles: the loaded module keeps working, and its
// stack frames still carry the URL the locator knows.
// ═══════════════════════════════════════════════════════════════════════════

import type { Song } from "../songs/index.ts";
import { locateCompiled, registerCompiledModule } from "../engine/errors.ts";
import type { CompileResult } from "./compile.ts";

/** Evaluating the module failed: thrown at its top level, or no default-exported song */
export class SongEvaluationError extends Error {
  /** The song file */
  readonly file: string;
  /** 1-based, in the original text, when the error could be located */
  readonly line?: number;
  readonly column?: number;
  /** What the module threw */
  readonly cause?: unknown;

  constructor(message: string, file: string, at?: { line?: number; column?: number } | null, cause?: unknown) {
    super(message);
    this.name = "SongEvaluationError";
    this.file = file;
    if (at?.line !== undefined) this.line = at.line;
    if (at?.column !== undefined) this.column = at.column;
    if (cause !== undefined) this.cause = cause;
  }
}

export interface EvaluateOptions {
  /** The URL to import the module from (default: a blob: URL, revoked after the import) */
  toUrl?(js: string): string;
}

/** UTF-8 safe base64 (the map holds the song text, emoji and all) */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const isSong = (value: unknown): value is Song =>
  !!value && typeof value === "object" && typeof (value as Song).createPattern === "function";

/** Import a compiled song. Throws SongEvaluationError (located when possible). */
export async function evaluateSong(
  result: Extract<CompileResult, { ok: true }>,
  opts: EvaluateOptions = {}
): Promise<{ song: Song; file: string; version: string }> {
  const { file, version } = result;
  const js = `${result.js}//# sourceMappingURL=data:application/json;base64,${base64(result.map)}\n`;
  const blob = !opts.toUrl;
  const url = opts.toUrl ? opts.toUrl(js) : URL.createObjectURL(new Blob([js], { type: "text/javascript" }));
  registerCompiledModule(url, { file, map: result.map });
  let mod: { default?: unknown };
  try {
    mod = await import(/* @vite-ignore */ url);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    throw new SongEvaluationError(e.message || String(err), file, locateCompiled(e.stack), err);
  } finally {
    if (blob) URL.revokeObjectURL(url);
  }
  if (!isSong(mod.default)) {
    throw new SongEvaluationError(`${file} must \`export default\` a song with createPattern()`, file);
  }
  return { song: mod.default, file, version };
}
