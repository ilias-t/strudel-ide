// ════════════════════════════════════════════════════════════════════════════
// knob(): the Strudel IDE's live controls (not part of Strudel itself)
// ════════════════════════════════════════════════════════════════════════════
//
// Hand-written and kept out of src/strudel*.d.ts on purpose: those files are
// audited against the Strudel runtime (scripts/audit-types.mjs), and knob() is
// installed by this app (src/engine/knobs.ts), not by Strudel.
// Keep this file a script (no top-level import/export) so it stays global.

/** Options for `knob()`'s fifth argument. */
interface KnobOptions {
  /** Value step. Default: a round step giving 100–1000 positions (200…8000 → 10, 0…1 → 0.01). */
  step?: number;
  /** Logarithmic travel, for frequencies and times: every turn multiplies the value by the same ratio. Needs `min > 0`. */
  log?: boolean;
}

/**
 * A live control, like strudel.cc's `slider()`: a number you can turn on the
 * stage's knob panel while the music plays, without saving or hot-swapping.
 *
 * Use it wherever you'd write the number: it behaves exactly like the literal
 * `value` (one event per cycle), except that its value is read live each time
 * the pattern is queried. `value` is the knob's default; **Write to file** on
 * the stage rewrites that literal in this file. Editing the literal yourself
 * resets the knob to it.
 *
 * Knobs are per song and named; the same name in one song is the same knob.
 * In Node (`npm run check`) a knob simply plays its default.
 *
 * @param name Label on the knob panel (unique within the song)
 * @param value Default: the value written in the file (a number literal, so it can be written back)
 * @param min Lowest value the knob turns to
 * @param max Highest value the knob turns to
 * @param step Value step, or options `{ step, log }`
 * @example
 * const cutoff = knob("cutoff", 2200, 200, 8000, { log: true });
 * note("c3 e3 g3").s("sawtooth").lpf(cutoff)
 * @example
 * s("bd*4").gain(knob("drums", 0.8, 0, 1))
 * @example
 * // a discrete knob: whole steps, one note per cycle (like n(3))
 * n(knob("degree", 3, 0, 7, 1)).scale("C:minor").s("piano")
 * @example
 * // derived values work like any pattern
 * note("c2").lpf(cutoff.div(3))
 */
declare function knob(name: string, value: number, min: number, max: number, step?: number | KnobOptions): Pattern;
