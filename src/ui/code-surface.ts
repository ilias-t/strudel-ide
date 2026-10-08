// ═══════════════════════════════════════════════════════════════════════════
// What the stage drives in the code unit: the read-only CodeView (boot) or the
// Monaco editor (edit mode, a lazy chunk). Both take the same signals.
// ═══════════════════════════════════════════════════════════════════════════

import type { Range } from "../live/highlights";

export interface CodeSurface {
  /** Show `text` (no-op when unchanged). `otherFile`: a different song (scroll to top, follow the music). */
  setSource(text: string, version: string | undefined, otherFile: boolean): void;
  setEnabled(on: boolean): void;
  /** How to colour a range (the track that plays it) */
  setColorResolver(fn: (start: number, end: number) => string | undefined): void;
  /** The tokens sounding now (offsets into the shown text). Applied on the next frame(). */
  setRanges(ranges: Range[]): void;
  /** Chip elements per knob name (data-testid="knob-chip"; the stage sets data-value / data-dirty) */
  knobChips(): ReadonlyMap<string, HTMLElement[]>;
  /** Current lit ranges (for tests) */
  litRanges(): Range[];
  /** A hap started on [start, end): pulse it on the next frame */
  flash(start: number, end: number, color: string): void;
  setErrorLine(line: number | null): void;
  revealLine(line: number): void;
  setFollowing(on: boolean): void;
  /** Apply pending ranges/flashes. Called once per animation frame. */
  frame(now: number): void;
}
