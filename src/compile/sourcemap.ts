// Source-map v3 helpers: decode `mappings`, map a generated position back,
// and compose a chain of maps into one. Used by the browser compiler
// (./compile.ts: TS's map ∘ knobs map ∘ locations map) and by the player's
// error locator (src/engine/errors.ts).
//
// Pure: no imports. Node type stripping loads this file as is.

/** A decoded segment with absolute values: [generatedColumn] or [generatedColumn, source, line, column] (0-based) */
export type Segment = [number] | MappedSegment;
export type MappedSegment = [number, number, number, number];

const isMapped = (seg: Segment): seg is MappedSegment => seg.length === 4;

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

/** Decode `mappings` into absolute segments, one array per generated line */
export function decodeMappings(mappings: string): Segment[][] {
  let source = 0;
  let srcLine = 0;
  let srcCol = 0;
  return mappings.split(";").map((line) => {
    let genCol = 0;
    const segments: Segment[] = [];
    for (const segment of line.split(",")) {
      if (!segment) continue;
      const fields = decodeVlq(segment);
      genCol += fields[0];
      if (fields.length < 4) {
        segments.push([genCol]);
        continue;
      }
      source += fields[1];
      srcLine += fields[2];
      srcCol += fields[3];
      segments.push([genCol, source, srcLine, srcCol]);
    }
    return segments;
  });
}

/**
 * The source position of a 0-based generated position: the last mapped
 * segment at or before `column` on that line (or the line's first one when
 * `column` comes before all of them), else null.
 */
export function lookup(decoded: Segment[][], line: number, column: number): { line: number; column: number } | null {
  let best: { line: number; column: number } | null = null;
  for (const seg of decoded[line] ?? []) {
    if (!isMapped(seg)) continue;
    if (seg[0] <= column || best === null) best = { line: seg[2], column: seg[3] };
    if (seg[0] > column) break;
  }
  return best;
}

/** Map a 0-based generated position to a 0-based source position using source-map v3 mappings */
export function mapPosition(mappings: string, line: number, column: number): { line: number; column: number } | null {
  return lookup(decodeMappings(mappings), line, column);
}

/** Same as mapPosition, for a parsed source map */
export function originalPosition(map: { mappings: string }, line: number, column: number) {
  return mapPosition(map.mappings, line, column);
}

/**
 * Compose maps: `outer` maps the final code to an intermediate text, each of
 * `inner` maps that text one step further back (outermost first). Returns
 * decoded segments from the final code to the original text (source index 0).
 * Segments that land nowhere in the original are dropped.
 */
export function composeMappings(outer: string, inner: string[]): MappedSegment[][] {
  const chain = inner.map(decodeMappings);
  return decodeMappings(outer).map((line) => {
    const out: MappedSegment[] = [];
    for (const seg of line) {
      if (!isMapped(seg)) continue;
      let pos: { line: number; column: number } | null = { line: seg[2], column: seg[3] };
      for (const map of chain) if (pos) pos = lookup(map, pos.line, pos.column);
      if (pos) out.push([seg[0], 0, pos.line, pos.column]);
    }
    return out;
  });
}
