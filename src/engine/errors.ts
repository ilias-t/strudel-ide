// ═══════════════════════════════════════════════════════════════════════════
// Player errors: turn exceptions into PlayerErrors that point at the song file
// ═══════════════════════════════════════════════════════════════════════════

import type { PlayerError } from "./types";
import { mapPosition } from "../compile/sourcemap.ts";

/**
 * Build a PlayerError from an exception. The song-file location is resolved
 * asynchronously (it needs the module's source map); `onLocated` is called with
 * the same object once file/line/column have been filled in.
 */
export function errorFrom(
  kind: PlayerError["kind"],
  err: unknown,
  songId: string | undefined,
  keptPrevious: boolean,
  onLocated: (error: PlayerError) => void
): PlayerError {
  const e = err instanceof Error ? err : new Error(String(err));
  const result: PlayerError = { kind, message: e.message || String(err), songId, keptPrevious };
  void locateInSongFile(e.stack).then((loc) => {
    if (loc) {
      Object.assign(result, loc);
      onLocated(result);
    }
  });
  return result;
}

// Stack frames look like `.../src/songs/jynx.ts?t=1712:14:9`. Vite's dev transform
// shifts lines, so map the generated position back through the module's inline
// source map to the line/column you see in the editor.
const SONG_FRAME = /(https?:\/\/[^\s()]+\/src\/songs\/([\w.-]+\.ts)(?:\?[^\s():]*)?):(\d+):(\d+)/;

// ─────────────────────────────────────────────────────────────────────────────
// Compiled songs (src/compile/evaluate.ts): modules imported from blob: URLs
// with an in-memory source map back to the song text
// ─────────────────────────────────────────────────────────────────────────────

/** Compiled modules kept for locating errors (a song may throw long after it was imported) */
const MAX_COMPILED = 16;
const compiled = new Map<string, { file: string; mappings: string }>();

/**
 * Locate errors from a compiled song module: frames at `url` map back to
 * `file` through `map` (source map v3 JSON, generated → song text). The
 * newest MAX_COMPILED modules are kept.
 */
export function registerCompiledModule(url: string, module: { file: string; map: string }): void {
  compiled.delete(url);
  compiled.set(url, { file: module.file, mappings: (JSON.parse(module.map) as { mappings: string }).mappings });
  for (const old of compiled.keys()) {
    if (compiled.size <= MAX_COMPILED) break;
    compiled.delete(old);
  }
}

/**
 * The first stack frame in a registered compiled module that maps into the
 * song text, with its index in `stack`. Frames in injected helpers (e.g. the
 * knob() wrapper appended to the module) map nowhere, so the song's call site
 * further down wins; if no frame maps, the first one (file only).
 */
function compiledFrame(stack: string | undefined) {
  if (!stack || !compiled.size) return null;
  const frames: { index: number; url: string; line: number; column: number }[] = [];
  for (const url of compiled.keys()) {
    for (let index = stack.indexOf(`${url}:`); index >= 0; index = stack.indexOf(`${url}:`, index + 1)) {
      const pos = /^:(\d+):(\d+)/.exec(stack.slice(index + url.length, index + url.length + 24));
      if (pos) frames.push({ index, url, line: Number(pos[1]), column: Number(pos[2]) });
    }
  }
  frames.sort((a, b) => a.index - b.index);
  return frames.find((f) => locateFrame(f).line !== undefined) ?? frames[0] ?? null;
}

/** Map a compiled frame back to the song file (1-based line/column) */
function locateFrame(frame: { url: string; line: number; column: number }): Pick<PlayerError, "file" | "line" | "column"> {
  const module = compiled.get(frame.url)!;
  const pos = mapPosition(module.mappings, frame.line - 1, frame.column - 1);
  return pos ? { file: module.file, line: pos.line + 1, column: pos.column + 1 } : { file: module.file };
}

/** The song-file location of the first compiled-module frame in `stack`, or null */
export function locateCompiled(stack: string | undefined): Pick<PlayerError, "file" | "line" | "column"> | null {
  const frame = compiledFrame(stack);
  return frame && locateFrame(frame);
}

async function locateInSongFile(
  stack: string | undefined
): Promise<Pick<PlayerError, "file" | "line" | "column"> | null> {
  const match = stack?.match(SONG_FRAME);
  const frame = compiledFrame(stack);
  if (frame && (!match || frame.index < match.index!)) return locateFrame(frame);
  if (!match) return null;
  const [, url, file, lineStr, colStr] = match;
  const generated = { line: Number(lineStr), column: Number(colStr) };
  try {
    const code = await (await fetch(url)).text();
    const map = code.match(/sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)/);
    if (!map) return { file, ...generated };
    const { mappings } = JSON.parse(atob(map[1])) as { mappings: string };
    const pos = mapPosition(mappings, generated.line - 1, generated.column - 1);
    return pos ? { file, line: pos.line + 1, column: pos.column + 1 } : { file, ...generated };
  } catch {
    return { file, ...generated };
  }
}
