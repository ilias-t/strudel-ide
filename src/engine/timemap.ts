// ═══════════════════════════════════════════════════════════════════════════
// Time map: scheduler cycle → song position (section jumps and loops)
// ═══════════════════════════════════════════════════════════════════════════
//
// The scheduler's clock only ever moves forward. Jumping to a section or
// looping one is a remapping of *pattern* time: from scheduler cycle `from`
// on, the song plays at `t + off` (linear), or wraps inside a loop
// `[start, start + len)`. The map is a list of segments sorted by `from`:
//
//   from -∞: off 0             (normal playback)
//   from 40: off -8            (jump at bar 41 back to bar 33)
//   from 52: loop 32..40       (loop the section)
//
// `apply()` turns a pattern into one that follows the map; the query is split
// at segment and loop boundaries and each piece is read from `pattern.early(o)`.
// Offsets are whole bars, so everything stays exact (Fractions).
//
// Haps are cut at the boundaries: a note that started before a jump does not
// continue after it (its tail has no onset, so it isn't re-triggered), which is
// exactly how a DJ-style jump sounds.

import { engine, internals, makeSpan, type Hap, type QueryState, type Span } from "./strudel";
import type { SongSections } from "../songs";
import type { SectionInfo } from "./types";

export interface Segment {
  /** First scheduler cycle this segment applies to (-Infinity for the first one) */
  from: number;
  /** Linear offset: song position = t + off (before looping) */
  off: number;
  /** Loop [start, start + len) in song time (pattern cycles) */
  loop?: { start: number; len: number };
}

const IDENTITY: Segment[] = [{ from: -Infinity, off: 0 }];

const mod = (a: number, n: number) => ((a % n) + n) % n;

export function normalizeSections(sections: SongSections | undefined): SectionInfo[] | null {
  if (!sections || !Array.isArray(sections) || sections.length === 0) return null;
  let start = 0;
  const out: SectionInfo[] = [];
  for (const section of sections as readonly unknown[]) {
    const [name, bars] = Array.isArray(section)
      ? (section as [string, number])
      : [(section as { name: string }).name, (section as { bars: number }).bars];
    if (!(bars > 0)) continue;
    out.push({ index: out.length, name: String(name), start, bars });
    start += bars;
  }
  return out.length ? out : null;
}

export function songLength(sections: SectionInfo[] | null): number {
  if (!sections?.length) return 0;
  const last = sections[sections.length - 1];
  return last.start + last.bars;
}

/** The section containing song position `pos` (wrapped to the song length) */
export function sectionAt(sections: SectionInfo[] | null, pos: number): SectionInfo | null {
  const total = songLength(sections);
  if (!sections || !total) return null;
  const p = mod(pos, total);
  for (const s of sections) if (p >= s.start && p < s.start + s.bars) return s;
  return sections[sections.length - 1];
}

export class TimeMap {
  segments: Segment[] = IDENTITY;
  /** Bumped on every change, so the player knows to rebuild */
  version = 0;

  /** Start over: scheduler cycle 0 plays song position `startAt` (looping `loop` if given) */
  reset(startAt = 0, loop?: { start: number; len: number }) {
    this.segments = startAt || loop ? [{ from: -Infinity, off: startAt, loop }] : IDENTITY;
    this.version++;
  }

  get identity(): boolean {
    return this.segments.length === 1 && this.segments[0].off === 0 && !this.segments[0].loop;
  }

  segmentAt(t: number): Segment {
    const segs = this.segments;
    for (let i = segs.length - 1; i > 0; i--) if (t >= segs[i].from) return segs[i];
    return segs[0];
  }

  /** Song position (pattern cycle) at scheduler cycle t */
  position(t: number): number {
    const seg = this.segmentAt(t);
    const p = t + seg.off;
    return seg.loop ? seg.loop.start + mod(p - seg.loop.start, seg.loop.len) : p;
  }

  /** Is scheduler cycle t inside a loop segment? */
  loopingAt(t: number): boolean {
    return !!this.segmentAt(t).loop;
  }

  /** From scheduler cycle `at` on, play song position `to` (optionally looping `loop`) */
  set(at: number, to: number, loop?: { start: number; len: number }, keepBefore = -Infinity) {
    const kept = this.segments.filter((s) => s.from < at);
    // forget segments that ended before `keepBefore` (they can't be queried any more)
    while (kept.length > 1 && kept[1].from <= keepBefore) kept.shift();
    if (kept.length && kept[0].from !== -Infinity) kept[0] = { ...kept[0], from: -Infinity };
    kept.push({ from: at, off: to - at, loop });
    this.segments = kept.length ? kept : [{ from: -Infinity, off: to - at, loop }];
    this.version++;
  }

  /** A pattern that plays `pattern` along this map (returns `pattern` itself for the identity) */
  apply(pattern: Pattern): Pattern {
    if (this.identity) return pattern;
    const segments = this.segments;
    const shifted = new Map<number, Pattern>();
    const shift = (o: number): Pattern => {
      let p = shifted.get(o);
      if (!p) {
        if (shifted.size > 64) shifted.clear();
        p = o === 0 ? pattern : pattern.early(o);
        shifted.set(o, p);
      }
      return p;
    };

    return new engine.Pattern((state: QueryState) => {
      const span = state.span;
      const b = span.begin.valueOf();
      const e = span.end.valueOf();
      const out: Hap[] = [];
      const zeroWidth = b === e;
      /** Query the piece [from, to) of the query span, shifted by o */
      const piece = (from: number, to: number, o: number) => {
        if (zeroWidth ? !(b >= from && b < to) : to <= b || from >= e) return;
        // clip to [from, to), keeping the query's own Fractions at open ends
        const sub: Span | undefined = span.intersection(
          makeSpan(span, from > b ? from : span.begin, to < e ? to : span.end)
        );
        if (!sub) return;
        const haps = internals(shift(o)).query(state.setSpan(sub));
        for (const hap of haps) out.push(hap);
      };

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const segEnd = i + 1 < segments.length ? segments[i + 1].from : Infinity;
        if (seg.from > e) break;
        if (segEnd < b) continue;
        if (!seg.loop) {
          piece(seg.from, segEnd, seg.off);
          continue;
        }
        // loop: chunk k covers t in [t0 + k·len, t0 + (k+1)·len) with offset off - k·len
        const { start, len } = seg.loop;
        const t0 = start - seg.off; // scheduler cycle where the loop phase is 0
        const lo = Math.max(b, seg.from);
        const hi = Math.min(e, segEnd);
        for (let k = Math.floor((lo - t0) / len); t0 + k * len <= hi; k++) {
          piece(Math.max(t0 + k * len, seg.from), Math.min(t0 + (k + 1) * len, segEnd), seg.off - k * len);
        }
      }
      return out;
    });
  }
}
