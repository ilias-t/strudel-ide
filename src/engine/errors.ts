// ═══════════════════════════════════════════════════════════════════════════
// Player errors: turn exceptions into PlayerErrors that point at the song file
// ═══════════════════════════════════════════════════════════════════════════

import type { PlayerError } from "./types";

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

async function locateInSongFile(
  stack: string | undefined
): Promise<Pick<PlayerError, "file" | "line" | "column"> | null> {
  const match = stack?.match(SONG_FRAME);
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

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeVlq(segment: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const ch of segment) {
    const digit = B64.indexOf(ch);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      out.push(value & 1 ? -(value >> 1) : value >> 1);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

/** Map a 0-based generated position to a 0-based source position using source-map v3 mappings */
function mapPosition(mappings: string, line: number, column: number) {
  let srcLine = 0;
  let srcCol = 0;
  let best: { line: number; column: number } | null = null;
  const lines = mappings.split(";");
  for (let l = 0; l <= line && l < lines.length; l++) {
    let genCol = 0;
    for (const segment of lines[l].split(",")) {
      if (!segment) continue;
      const fields = decodeVlq(segment);
      genCol += fields[0];
      if (fields.length < 4) continue;
      srcLine += fields[2];
      srcCol += fields[3];
      if (l === line && (genCol <= column || best === null)) best = { line: srcLine, column: srcCol };
    }
  }
  return best;
}
