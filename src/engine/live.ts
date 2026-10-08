// ═══════════════════════════════════════════════════════════════════════════
// Live signals: highlighted ranges (→ editor bridge + code view) and onsets
// ═══════════════════════════════════════════════════════════════════════════
//
// Ranges come from one createHighlighter() (≤ 30 Hz, timer-driven so the
// editor keeps getting them while the tab is hidden). The same ranges go to the
// VS Code bridge and to the browser's code view.
//
// Onsets are for things that should flash *per hit* (mixer LEDs, code-view
// pulses): a token like "bd*4" stays lit across hits, so ranges alone can't
// show each kick. pollOnsets() is called from the UI's animation frame and
// reads the haps that started since the previous frame, at the same audible
// time the highlighter uses.

import { createHighlighter, fromScheduler, type Range } from "../live/highlights";
import type { BridgeClient } from "../live/bridge-client";
import type { Hap, Repl } from "./strudel";
import type { SongSource } from "../songs";
import { audibleCycle, playingSource } from "./player";

export type RangesListener = (ranges: Range[], source: SongSource | null) => void;

export interface Live {
  /** Latest ranges and the source they index into */
  ranges(): Range[];
  source(): SongSource | null;
  onRanges(listener: RangesListener): () => void;
  /** Haps (audible, with an onset) since the last call. Call once per frame. */
  pollOnsets(onHap: (hap: Hap) => void): void;
}

export function startLive(repl: Repl, bridge: BridgeClient): Live {
  const listeners = new Set<RangesListener>();
  let current: Range[] = [];
  let currentSource: SongSource | null = null;
  let highlightedFile: string | null = null;

  // Live highlights: the mini-notation tokens sounding now → the editor (≤ 30 Hz,
  // only on change, [] when stopped). Created after initStrudel(): it swaps in
  // location-free string parsing so only song literals carry offsets.
  createHighlighter({
    ...fromScheduler(repl.scheduler),
    onRanges: (ranges) => {
      const source = playingSource();
      if (highlightedFile && highlightedFile !== source?.file) bridge.sendHighlight(highlightedFile, []);
      highlightedFile = source?.file ?? null;
      if (source) bridge.sendHighlight(source.file, ranges, source.version);
      current = ranges;
      currentSource = source;
      for (const listener of listeners) listener(ranges, source);
    },
    // Per-hit pulses for the editor (≤ 30 Hz, only when something was hit)
    onOnsets: (ranges) => {
      const source = playingSource();
      if (source) bridge.sendOnsets(source.file, ranges, source.version);
    },
  }).start();

  let probeFrom = -1;
  return {
    ranges: () => current,
    source: () => currentSource,
    onRanges(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pollOnsets(onHap) {
      const scheduler = repl.scheduler;
      const pattern = scheduler.started ? scheduler.pattern : null;
      const to = audibleCycle();
      const from = probeFrom;
      probeFrom = to;
      // nothing playing, or a long gap (tab was hidden): skip, don't flash a backlog
      if (!pattern || from < 0 || to <= from || to - from > 0.5) return;
      let haps: Hap[];
      try {
        haps = pattern.queryArc(from, to) as unknown as Hap[];
      } catch {
        return; // the scheduler reports broken patterns
      }
      for (const hap of haps) {
        if (!hap.whole || !hap.hasOnset() || hap.context?.muted) continue;
        onHap(hap);
      }
    },
  };
}
