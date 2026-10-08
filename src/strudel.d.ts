// ════════════════════════════════════════════════════════════════════════════
// Strudel type declarations — hand-written part
// ════════════════════════════════════════════════════════════════════════════
//
// The Strudel API is split over three ambient (global) declaration files:
//
//   src/strudel.d.ts                  ← this file: helper types + the @strudel/web module
//   src/strudel.generated.d.ts        ← every global + Pattern method, with JSDoc/examples
//                                       (scripts/gen-strudel-types.mjs)
//   src/strudel.sounds.generated.d.ts ← SoundName / BankName / ScaleString unions
//                                       (scripts/gen-sound-types.mjs)
//
// To change a signature, edit scripts/lib/type-overrides.mjs and regenerate
// (`npm run gen:types`); `npm run audit:types` diffs the declarations against the runtime.
//
// Keep this file a script (no top-level import/export) so everything stays global.

// =============================================================================
// ARGUMENT TYPES
// Strudel "reifies" almost every argument: strings are parsed as mini-notation,
// other values become constant patterns. These aliases describe that.
// =============================================================================

/** A mini-notation string, e.g. `"<0 2> [4 7]*2"` or `"bd*2, hh*4"`. */
type Mini = string;

/** A number, a mini-notation string of numbers (`"<200 2000>"`) or a Pattern (e.g. a signal like `sine.range(200, 2000)`). */
type NumberInput = number | Mini | Pattern;

/** A string (mini-notation allowed) or a Pattern. `T` adds autocomplete suggestions without rejecting other strings. */
type StringInput<T extends string = never> = T | (string & {}) | Pattern;

/** Note names (`"c3 e3 g3"`, `"<a2 [c3,e3]>"`), MIDI numbers, or a Pattern of either. */
type NoteInput = number | Mini | Pattern;

/** Sound/sample names for s()/sound(); any mini-notation string is accepted (`"bd*2 [sd hh]"`). */
type SoundInput = StringInput<SoundName>;

/** Drum machine bank names for .bank(). */
type BankInput = StringInput<BankName>;

/** Scale for .scale(): `"C:minor"`, `"A4:minor:pentatonic"`, `"<C:major D:dorian>"`. */
type ScaleInput = StringInput<ScaleString>;

/** Anything `reify()` turns into a pattern: a Pattern, a mini-notation string, a number or a boolean. */
type PatternInput = Pattern | Mini | number | boolean;

/** Arguments of seq/cat/stack: patterns, or (nested) arrays which are sequenced like `[a b]` in mini-notation. */
type SequenceInput = PatternInput | readonly SequenceInput[];

/** A function that transforms a pattern, e.g. `x => x.fast(2)`, `rev`, or a curried global like `fast(2)`. */
type PatternFunc = (pat: Pattern) => Pattern;

/** Lookup for pick()/inhabit(): an array (picked by index) or a record (picked by name). */
type PatternLookup = PatternInput[] | Record<string, PatternInput>;

/** Signals (sine, saw, rand, perlin, ...) are ordinary continuous Patterns. Kept as an alias for readability. */
type Signal = Pattern;

/**
 * The value operators (`add`, `sub`, `mul`, `set`, ...) are callable and also expose
 * structure variants: `.add(2)` = `.add.in(2)`, `.add.out("0 7")`, `.add.squeeze("0 12")`, ...
 */
interface PatternOperator {
  /** Applies the operator, taking structure from the left (same as `.in`). Multiple args are sequenced. */
  (...values: PatternInput[]): Pattern;
  /** Structure comes from the left (this pattern). */
  in(...values: PatternInput[]): Pattern;
  /** Structure comes from the right (the argument). */
  out(...values: PatternInput[]): Pattern;
  /** Structure comes from both sides. */
  mix(...values: PatternInput[]): Pattern;
  /** Squeezes cycles of the argument into the events of this pattern. */
  squeeze(...values: PatternInput[]): Pattern;
  squeezein(...values: PatternInput[]): Pattern;
  /** Squeezes cycles of this pattern into the events of the argument. */
  squeezeout(...values: PatternInput[]): Pattern;
  /** Restarts/resets the argument's cycle at each event of this pattern. */
  reset(...values: PatternInput[]): Pattern;
  restart(...values: PatternInput[]): Pattern;
  /** Polymetric combination (steps are aligned). */
  poly(...values: PatternInput[]): Pattern;
}

// =============================================================================
// CORE DATA TYPES
// =============================================================================

/** A time span within the cycle timeline (begin/end are Fractions at runtime). */
interface TimeSpan {
  begin: any;
  end: any;
}

/** An event: a value active over a span of time. */
interface Hap {
  /** The whole event span (undefined for continuous haps) */
  whole?: TimeSpan;
  /** The part of the event within the queried span */
  part: TimeSpan;
  value: any;
  context: Record<string, any>;
  hasOnset(): boolean;
  duration: any;
}

// =============================================================================
// VISUALISATION OPTIONS
// =============================================================================

interface PianorollOptions {
  /** Number of cycles to display simultaneously (default: 4) */
  cycles?: number;
  /** Position of the playhead on the time axis, 0-1 (default: 0.5) */
  playhead?: number;
  /** Display the roll vertically (default: false) */
  vertical?: boolean;
  /** Display labels on individual notes (default: false) */
  labels?: boolean;
  /** Reverse the direction of the roll (default: false) */
  flipTime?: boolean;
  /** Reverse the relative location of notes on the value axis (default: false) */
  flipValues?: boolean;
  /** Look up additional cycles outside the window (default: 1) */
  overscan?: number;
  /** Hide notes with negative time (default: false) */
  hideNegative?: boolean;
  /** Notes leave a solid trace (default: false) */
  smear?: boolean;
  /** Notes take the full value axis width (default: false) */
  fold?: number | boolean;
  /** Minimum note value to display on the value axis */
  minMidi?: number;
  /** Maximum note value to display on the value axis (default: 90) */
  maxMidi?: number;
  /** Automatically calculate minMidi and maxMidi (default: false) */
  autorange?: boolean;
  /** Show active notes differently */
  active?: boolean;
  /** Fill notes (default: true) */
  fill?: boolean;
  /** Stroke notes */
  stroke?: boolean;
  /** Draw a playhead line */
  playheadColor?: string;
  /** Color of active notes */
  activeColor?: string;
  /** Color of inactive notes */
  inactiveColor?: string;
  /** Background color */
  background?: string;
  [option: string]: unknown;
}

interface ScopeOptions {
  /** Align to first zero crossing (default: 1) */
  align?: number | boolean;
  /** Line color as hex code or color name (default: "white") */
  color?: string;
  /** Line thickness (default: 3) */
  thickness?: number;
  /** Scale the y-axis (default: 0.25) */
  scale?: number;
  /** Y-position relative to screen height, 0=top 1=bottom */
  pos?: number;
  /** Amplitude value used to align the scope (default: 0) */
  trigger?: number;
  /** Analyser id (default: 1) */
  id?: number | string;
  [option: string]: unknown;
}

interface SpectrumOptions {
  thickness?: number;
  speed?: number;
  min?: number;
  max?: number;
  id?: number | string;
  [option: string]: unknown;
}

interface SpiralOptions {
  stretch?: number;
  size?: number;
  thickness?: number;
  cap?: "butt" | "round" | "square";
  inset?: number;
  playheadColor?: string;
  playheadLength?: number;
  playheadThickness?: number;
  padding?: number;
  steady?: number;
  activeColor?: string;
  inactiveColor?: string;
  colorizeInactive?: boolean;
  fade?: boolean;
  logSpiral?: boolean;
  [option: string]: unknown;
}

interface PitchwheelOptions {
  hapcircles?: boolean;
  circle?: boolean;
  edo?: number;
  root?: number;
  thickness?: number;
  hapRadius?: number;
  mode?: "flake" | "polygon";
  margin?: number;
  [option: string]: unknown;
}

// =============================================================================
// @strudel/web (ships no .d.ts of its own)
// =============================================================================

interface InitStrudelOptions {
  /** Called after the default modules are loaded, e.g. `() => samples("github:tidalcycles/dirt-samples")` */
  prebake?: () => unknown;
  /** Set to false to keep strings out of the mini-notation parser */
  miniAllStrings?: boolean;
  [option: string]: unknown;
}

declare module "@strudel/web" {
  /**
   * Initialises Strudel: registers all functions as globals, loads the synths and sets up audio.
   * Resolves to the repl (`{ scheduler, setCps, start, stop, evaluate, ... }`).
   */
  export function initStrudel(options?: InitStrudelOptions): Promise<any>;
  /** Default prebake: evalScope(core, mini, tonal, webaudio) + registerSynthSounds() */
  export function defaultPrebake(): Promise<void>;
  /** Stops playback */
  export function hush(): void;
  /** Evaluates Strudel REPL code (transpiled) and plays it */
  export function evaluate(code: string, autoplay?: boolean): Promise<any>;
}
