// Offset → line/character mapping for highlight ranges (pure, no vscode).

export interface Pos {
  line: number;
  character: number;
}

export interface Span {
  start: Pos;
  end: Pos;
}

/**
 * Line-start table for a text, built once per document version. Offsets are
 * UTF-16 code units (JS string indices), the same unit VS Code positions use.
 * Line breaks: \n, \r\n and lone \r (as VS Code).
 */
export class LineIndex {
  readonly length: number;
  private readonly starts: number[] = [0];
  /** end of each line's content (before its line break) */
  private readonly ends: number[] = [];

  constructor(text: string) {
    this.length = text.length;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10 /* \n */) {
        this.ends.push(i);
        this.starts.push(i + 1);
      } else if (c === 13 /* \r */) {
        this.ends.push(i);
        if (text.charCodeAt(i + 1) === 10) i++;
        this.starts.push(i + 1);
      }
    }
    this.ends.push(text.length);
  }

  get lineCount(): number {
    return this.starts.length;
  }

  positionAt(offset: number): Pos {
    const o = Math.max(0, Math.min(this.length, Math.floor(offset)));
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= o) lo = mid;
      else hi = mid - 1;
    }
    // An offset inside a line break (e.g. between \r and \n) maps to line end.
    return { line: lo, character: Math.min(o, this.ends[lo]) - this.starts[lo] };
  }
}

/**
 * Validate, clamp to [0, length], drop empty, sort and merge overlapping
 * ranges (identical ranges from several haps at the same location collapse,
 * so outlines aren't drawn twice). Adjacent-but-not-overlapping ranges stay
 * separate.
 */
export function normalizeRanges(ranges: unknown, length: number): [number, number][] {
  if (!Array.isArray(ranges)) return [];
  const valid: [number, number][] = [];
  for (const r of ranges) {
    if (!Array.isArray(r) || r.length < 2) continue;
    const [a, b] = r as unknown[];
    if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    const start = Math.max(0, Math.min(length, Math.floor(a)));
    const end = Math.max(0, Math.min(length, Math.floor(b)));
    if (end > start) valid.push([start, end]);
  }
  valid.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: [number, number][] = [];
  for (const r of valid) {
    const last = out[out.length - 1];
    if (last && r[0] < last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

export function toSpans(index: LineIndex, ranges: unknown): Span[] {
  return normalizeRanges(ranges, index.length).map(([s, e]) => ({
    start: index.positionAt(s),
    end: index.positionAt(e),
  }));
}

/** Offsets of `createPattern(` method definitions/calls, for CodeLens placement. */
export function findCreatePattern(text: string): number[] {
  const out: number[] = [];
  const re = /\bcreatePattern\s*\(/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m.index);
  return out;
}
