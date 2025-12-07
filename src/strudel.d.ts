// Comprehensive type declarations for Strudel (@strudel/web)
// These types cover the global functions registered by initStrudel()

// =============================================================================
// SAMPLE TYPES - Available samples from Strudel CDN
// =============================================================================

/**
 * Drum machine bank names for use with .bank()
 * Usage: s("bd").bank("RolandTR808")
 */
type DrumMachineBank =
  | "RolandTR808"
  | "RolandTR909"
  | "RolandTR707"
  | "RolandTR606"
  | "RolandTR626"
  | "RolandTR505"
  | "RolandTR727"
  | "LinnDrum"
  | "LinnLM1"
  | "LinnLM2"
  | "Linn9000"
  | "OberheimDMX"
  | "EmuDrumulator"
  | "EmuSP12"
  | "AkaiLinn"
  | "AkaiMPC60"
  | "AkaiXR10"
  | "AlesisHR16"
  | "AlesisSR16"
  | "BossDR55"
  | "BossDR110"
  | "BossDR220"
  | "BossDR550"
  | "CasioRZ1"
  | "CasioSK1"
  | "CasioVL1"
  | "KorgDDM110"
  | "KorgKPR77"
  | "KorgKR55"
  | "KorgM1"
  | "KorgMiniPops"
  | "KorgPoly800"
  | "KorgT3"
  | "SequentialCircuitsDrumTracks"
  | "SequentialCircuitsTom"
  | "SimmonsSDS5"
  | "SimmonsSDS400"
  | "SoundmasterSR88"
  | "YamahaRM50"
  | "YamahaRX5"
  | "YamahaRX21"
  | "YamahaRY30"
  | "YamahaTG33";

/**
 * Common drum part names used with drum machine banks
 * Usage: s("bd").bank("RolandTR808") - bd = bass drum
 */
type DrumPart =
  | "bd" // bass drum / kick
  | "sd" // snare drum
  | "hh" // hi-hat (closed)
  | "oh" // open hi-hat
  | "cp" // clap
  | "cb" // cowbell
  | "cr" // crash cymbal
  | "rd" // ride cymbal
  | "ht" // high tom
  | "mt" // mid tom
  | "lt" // low tom
  | "rim" // rimshot
  | "sh" // shaker
  | "tb" // tambourine
  | "perc" // percussion
  | "misc" // miscellaneous
  | "fx"; // effects

/**
 * All available sample names from Strudel CDN
 * These can be used directly with s() or sound()
 */
type Sample =
  // Basic waveforms
  | "sine"
  | "saw"
  | "sawtooth"
  | "square"
  | "sqr"
  | "tri"
  | "triangle"
  | "pulse"
  // Noise
  | "white"
  | "pink"
  | "brown"
  | "crackle"
  // Piano & Keys
  | "piano"
  | "piano1"
  | "fmpiano"
  | "steinway"
  | "harmonica"
  | "harmonica_soft"
  | "harmonica_vib"
  // Orchestral
  | "glockenspiel"
  | "marimba"
  | "vibraphone"
  | "vibraphone_soft"
  | "vibraphone_bowed"
  | "xylophone_hard_ff"
  | "xylophone_hard_pp"
  | "xylophone_medium_ff"
  | "xylophone_medium_pp"
  | "xylophone_soft_ff"
  | "xylophone_soft_pp"
  | "tubularbells"
  | "tubularbells2"
  | "handbells"
  | "handchimes"
  | "harp"
  | "folkharp"
  | "psaltery_bow"
  | "psaltery_pluck"
  | "psaltery_spiccato"
  | "timpani"
  | "timpani2"
  | "timpani_roll"
  // Wind instruments
  | "recorder_alto_stacc"
  | "recorder_alto_sus"
  | "recorder_alto_vib"
  | "recorder_bass_stacc"
  | "recorder_bass_sus"
  | "recorder_bass_vib"
  | "recorder_soprano_stacc"
  | "recorder_soprano_sus"
  | "recorder_tenor_stacc"
  | "recorder_tenor_sus"
  | "recorder_tenor_vib"
  | "ocarina"
  | "ocarina_small"
  | "ocarina_small_stacc"
  | "ocarina_vib"
  | "sax"
  | "sax_stacc"
  | "sax_vib"
  | "saxello"
  | "saxello_stacc"
  | "saxello_vib"
  | "didgeridoo"
  // Organ
  | "organ_4inch"
  | "organ_8inch"
  | "organ_full"
  | "pipeorgan_loud"
  | "pipeorgan_loud_pedal"
  | "pipeorgan_quiet"
  | "pipeorgan_quiet_pedal"
  // String
  | "dantranh"
  | "dantranh_tremolo"
  | "dantranh_vibrato"
  | "kalimba"
  | "kalimba2"
  | "kalimba3"
  | "kalimba4"
  | "kalimba5"
  | "balafon"
  | "balafon_hard"
  | "balafon_soft"
  | "strumstick"
  // Percussion
  | "agogo"
  | "anvil"
  | "ballwhistle"
  | "bassdrum1"
  | "bassdrum2"
  | "belltree"
  | "bongo"
  | "brakedrum"
  | "cabasa"
  | "cajon"
  | "clash"
  | "clash2"
  | "clave"
  | "conga"
  | "cowbell"
  | "darbuka"
  | "fingercymbal"
  | "flexatone"
  | "framedrum"
  | "gong"
  | "gong2"
  | "guiro"
  | "marktrees"
  | "oceandrum"
  | "ratchet"
  | "shaker_large"
  | "shaker_small"
  | "siren"
  | "slapstick"
  | "sleighbells"
  | "slitdrum"
  | "tambourine"
  | "tambourine2"
  | "trainwhistle"
  | "triangles"
  | "vibraslap"
  | "wineglass"
  | "wineglass_slow"
  | "woodblock"
  | "sus_cymbal"
  | "sus_cymbal2"
  // Toms & snares
  | "tom_mallet"
  | "tom_rim"
  | "tom_stick"
  | "tom2_mallet"
  | "tom2_rim"
  | "tom2_stick"
  | "snare_hi"
  | "snare_low"
  | "snare_modern"
  | "snare_rim"
  // Indian percussion (mridangam)
  | "mridangam_ardha"
  | "mridangam_chaapu"
  | "mridangam_dhi"
  | "mridangam_dhin"
  | "mridangam_dhum"
  | "mridangam_gumki"
  | "mridangam_ka"
  | "mridangam_ki"
  | "mridangam_na"
  | "mridangam_nam"
  | "mridangam_ta"
  | "mridangam_tha"
  | "mridangam_thom"
  // Generic drum parts (used with banks)
  | "bd"
  | "sd"
  | "sbd"
  | "hh"
  | "oh"
  | "cp"
  | "cb"
  | "cr"
  | "rd"
  | "ht"
  | "mt"
  | "lt"
  | "rim"
  | "sh"
  | "tb"
  | "clap"
  | "hihat"
  | "misc"
  | "brk"
  | "bytebeat"
  // Wavetables
  | "wt_digital"
  | "wt_digital_bad_day"
  | "wt_digital_basique"
  | "wt_digital_crickets"
  | "wt_digital_curses"
  | "wt_digital_echoes"
  | "wt_vgame"
  | "supersaw"
  | "super64"
  | "super64_acc"
  | "super64_vib"
  // Other
  | "kawai"
  | "clavisynth"
  // Allow any string for flexibility with custom samples
  | (string & {});

declare module "@strudel/web" {
  interface InitStrudelOptions {
    defaultSamples?: boolean;
    prebake?: boolean;
    transpiler?: boolean;
  }

  export function initStrudel(options?: InitStrudelOptions): Promise<void>;

  // These can also be imported directly
  export function note(notes: string | number | Pattern): Pattern;
  export function s(sounds: Sample): Pattern;
  export function sound(sounds: Sample): Pattern;
  export function n(notes: string | number): Pattern;
  export function stack(...patterns: (Pattern | string)[]): Pattern;
  export function seq(...patterns: (Pattern | string)[]): Pattern;
  export function cat(...patterns: (Pattern | string)[]): Pattern;
  export function silence(): Pattern;
  export function hush(): void;
  export function reify(value: any): Pattern;
  export function pure(value: any): Pattern;

  export const sine: Signal;
  export const saw: Signal;
  export const tri: Signal;
  export const square: Signal;
  export const cosine: Signal;
  export const rand: Signal;
  export const perlin: Signal;
}

// =============================================================================
// PATTERN TYPE
// The core chainable type in Strudel
// =============================================================================

interface Pattern {
  // ---------------------------------------------------------------------------
  // Playback Control
  // ---------------------------------------------------------------------------
  play(): void;
  stop(): void;

  // ---------------------------------------------------------------------------
  // Sound Selection
  // ---------------------------------------------------------------------------
  /** Select sound/sample by name */
  s(sound: Sample): Pattern;
  /** Select sound/sample by name (alias for s) */
  sound(sound: Sample): Pattern;
  /** Select sample bank (e.g., "RolandTR808", "RolandTR909") */
  bank(bank: DrumMachineBank): Pattern;
  /** Select sample number within a folder */
  n(index: string | number | Pattern): Pattern;

  // ---------------------------------------------------------------------------
  // Pitch / Note Control
  // ---------------------------------------------------------------------------
  /** Set note pitch (can be note name like "c4" or MIDI number) */
  note(notes: string | number | Pattern): Pattern;
  /** Set scale for note interpretation */
  scale(scale: string): Pattern;
  /** Shift pitch by octaves */
  octave(oct: number | Pattern): Pattern;
  /** Transpose notes by semitones */
  transpose(semitones: number | Pattern): Pattern;

  // ---------------------------------------------------------------------------
  // Amplitude / Volume
  // ---------------------------------------------------------------------------
  /** Set gain/volume (0-1+) */
  gain(level: number | Signal | Pattern): Pattern;
  /** Set velocity (0-1, for MIDI) */
  velocity(vel: number | Signal | Pattern): Pattern;
  /** Amplify by a factor */
  amp(amount: number | Signal | Pattern): Pattern;

  // ---------------------------------------------------------------------------
  // Envelope (ADSR)
  // ---------------------------------------------------------------------------
  /** Attack time in seconds */
  attack(time: number | Pattern): Pattern;
  /** Decay time in seconds */
  decay(time: number | Pattern): Pattern;
  /** Sustain level (0-1) */
  sustain(level: number | Pattern): Pattern;
  /** Release time in seconds */
  release(time: number | Pattern): Pattern;
  /** Hold time */
  hold(time: number | Pattern): Pattern;

  // ---------------------------------------------------------------------------
  // Filters
  // ---------------------------------------------------------------------------
  /** Low-pass filter cutoff frequency */
  lpf(freq: number | Signal | Pattern): Pattern;
  /** Low-pass filter resonance/Q */
  lpq(q: number | Signal | Pattern): Pattern;
  /** Low-pass filter envelope depth */
  lpenv(depth: number | Pattern): Pattern;
  /** Low-pass filter attack */
  lpattack(time: number | Pattern): Pattern;
  /** Low-pass filter decay */
  lpdecay(time: number | Pattern): Pattern;
  /** Low-pass filter sustain */
  lpsustain(level: number | Pattern): Pattern;
  /** Low-pass filter release */
  lprelease(time: number | Pattern): Pattern;

  /** High-pass filter cutoff frequency */
  hpf(freq: number | Signal | Pattern): Pattern;
  /** High-pass filter resonance/Q */
  hpq(q: number | Signal | Pattern): Pattern;
  /** High-pass filter envelope depth */
  hpenv(depth: number | Pattern): Pattern;
  /** High-pass filter attack */
  hpattack(time: number | Pattern): Pattern;
  /** High-pass filter decay */
  hpdecay(time: number | Pattern): Pattern;
  /** High-pass filter sustain */
  hpsustain(level: number | Pattern): Pattern;
  /** High-pass filter release */
  hprelease(time: number | Pattern): Pattern;

  /** Band-pass filter cutoff frequency */
  bpf(freq: number | Signal | Pattern): Pattern;
  /** Band-pass filter resonance/Q */
  bpq(q: number | Signal | Pattern): Pattern;

  /** Cutoff frequency (alias for lpf) */
  cutoff(freq: number | Signal | Pattern): Pattern;
  /** Resonance (alias for lpq) */
  resonance(q: number | Signal | Pattern): Pattern;

  /** Vowel formant filter */
  vowel(vowel: string | Pattern): Pattern;

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------
  /** Reverb room size (0-1) */
  room(amount: number | Signal | Pattern): Pattern;
  /** Reverb size */
  rsize(size: number | Signal | Pattern): Pattern;
  /** Reverb fade time */
  rfade(time: number | Signal | Pattern): Pattern;
  /** Dry/wet reverb mix */
  dry(amount: number | Signal | Pattern): Pattern;

  /** Delay amount (0-1) */
  delay(amount: number | Signal | Pattern): Pattern;
  /** Delay time */
  delaytime(time: number | Signal | Pattern): Pattern;
  /** Delay feedback (0-1) */
  delayfeedback(fb: number | Signal | Pattern): Pattern;
  /** Delay time (alias) */
  delayt(time: number | Signal | Pattern): Pattern;
  /** Delay feedback (alias) */
  delayf(fb: number | Signal | Pattern): Pattern;

  /** Stereo pan (-1 to 1, or 0 to 1) */
  pan(amount: number | Signal | Pattern): Pattern;

  /** Bit crusher depth (1-16) */
  crush(depth: number | Signal | Pattern): Pattern;
  /** Sample rate reduction */
  coarse(amount: number | Signal | Pattern): Pattern;
  /** Waveshaping distortion */
  distort(amount: number | Signal | Pattern): Pattern;
  /** Distortion/overdrive */
  shape(amount: number | Signal | Pattern): Pattern;
  /** Squiz pitchshifting effect */
  squiz(amount: number | Signal | Pattern): Pattern;

  /** Phaser effect */
  phaser(depth: number | Signal | Pattern): Pattern;
  /** Phaser rate */
  phaserrate(rate: number | Signal | Pattern): Pattern;
  /** Phaser depth */
  phaserdepth(depth: number | Signal | Pattern): Pattern;

  /** Leslie speaker effect */
  leslie(amount: number | Signal | Pattern): Pattern;
  /** Leslie rate */
  lrate(rate: number | Signal | Pattern): Pattern;
  /** Leslie size */
  lsize(size: number | Signal | Pattern): Pattern;

  /** Effect bus/orbit for grouping */
  orbit(num: number | Pattern): Pattern;

  // ---------------------------------------------------------------------------
  // Sample Playback
  // ---------------------------------------------------------------------------
  /** Playback speed (affects pitch) */
  speed(amount: number | Signal | Pattern): Pattern;
  /** Start position in sample (0-1) */
  begin(pos: number | Signal | Pattern): Pattern;
  /** End position in sample (0-1) */
  end(pos: number | Signal | Pattern): Pattern;
  /** Cut group - stops other sounds in same group */
  cut(group: number | Pattern): Pattern;
  /** Enable sample looping */
  loop(enable: number | Pattern): Pattern;
  /** Loop start position (0-1) */
  loopBegin(pos: number | Signal | Pattern): Pattern;
  /** Loop end position (0-1) */
  loopEnd(pos: number | Signal | Pattern): Pattern;
  /** Fit sample to n cycles */
  loopAt(cycles: number | Pattern): Pattern;
  /** Time unit for speed: "r"=rate, "c"=cycles, "s"=seconds */
  unit(unit: string): Pattern;
  /** Clip/truncate events */
  clip(amount: number | Signal | Pattern): Pattern;
  /** Note length relative to event */
  legato(amount: number | Pattern): Pattern;

  // ---------------------------------------------------------------------------
  // Sample Slicing / Granular
  // ---------------------------------------------------------------------------
  /** Chop sample into n parts */
  chop(parts: number | Pattern): Pattern;
  /** Striate - granular playback across sample */
  striate(parts: number | Pattern): Pattern;
  /** Slice sample and sequence slices */
  slice(slices: number, pattern: string | Pattern): Pattern;
  /** Splice - like slice but stretches */
  splice(slices: number, pattern: string | Pattern): Pattern;
  /** Fit sample to specified number of cycles */
  fit(cycles: number): Pattern;

  // ---------------------------------------------------------------------------
  // Time / Tempo Modifiers
  // ---------------------------------------------------------------------------
  /** Speed up pattern by factor */
  fast(factor: number | Pattern): Pattern;
  /** Slow down pattern by factor */
  slow(factor: number | Pattern): Pattern;
  /** Hurry - speed up with pitch */
  hurry(factor: number | Pattern): Pattern;
  /** Time offset/nudge */
  nudge(time: number | Pattern): Pattern;
  /** Swing timing */
  swing(amount: number | Pattern): Pattern;
  /** Linger on a portion of the pattern */
  linger(fraction: number | Pattern): Pattern;
  /** Zoom into a portion of the pattern */
  zoom(start: number, end: number): Pattern;
  /** Focus on a time range */
  focus(start: number, end: number): Pattern;
  /** Compress pattern into time range */
  compress(start: number, end: number): Pattern;
  /** Apply function within a time range */
  within(start: number, end: number, fn: PatternFunc): Pattern;

  // ---------------------------------------------------------------------------
  // Pattern Structure / Rhythm
  // ---------------------------------------------------------------------------
  /** Apply rhythmic structure */
  struct(structure: string | Pattern): Pattern;
  /** Euclidean rhythm */
  euclid(pulses: number, steps: number, rotation?: number): Pattern;
  /** Euclidean rhythm with legato */
  euclidLegato(pulses: number, steps: number, rotation?: number): Pattern;
  /** Mask pattern with another */
  mask(pattern: string | Pattern): Pattern;
  /** Repeat each event n times */
  ply(n: number | Pattern): Pattern;
  /** Stutter/echo within pattern */
  stut(n: number, time: number, feedback: number): Pattern;
  /** Echo effect on pattern */
  echo(times: number, time: number, feedback: number): Pattern;

  // ---------------------------------------------------------------------------
  // Pattern Transformations
  // ---------------------------------------------------------------------------
  /** Reverse the pattern */
  rev(): Pattern;
  /** Rotate/shift pattern in time */
  iter(n: number): Pattern;
  /** Rotate pattern backwards */
  iterBack(n: number): Pattern;
  /** Palindrome - play forward then backward */
  palindrome(): Pattern;
  /** Rotate pattern */
  rotate(amount: number): Pattern;
  /** Early - shift pattern earlier */
  early(amount: number | Pattern): Pattern;
  /** Late - shift pattern later */
  late(amount: number | Pattern): Pattern;

  // ---------------------------------------------------------------------------
  // Pattern Conditionals / Probability
  // ---------------------------------------------------------------------------
  /** Apply function every n cycles */
  every(n: number, fn: PatternFunc): Pattern;
  /** Apply function with 50% probability */
  sometimes(fn: PatternFunc): Pattern;
  /** Apply function with ~75% probability */
  often(fn: PatternFunc): Pattern;
  /** Apply function with ~25% probability */
  rarely(fn: PatternFunc): Pattern;
  /** Apply function with ~10% probability */
  almostNever(fn: PatternFunc): Pattern;
  /** Apply function with ~90% probability */
  almostAlways(fn: PatternFunc): Pattern;
  /** Apply function with specified probability (0-1) */
  sometimesBy(prob: number, fn: PatternFunc): Pattern;
  /** Apply to different chunks each cycle */
  chunk(n: number, fn: PatternFunc): Pattern;
  /** Conditionally apply function */
  when(condition: Pattern | boolean, fn: PatternFunc): Pattern;
  /** Randomly drop events with 50% probability */
  degrade(): Pattern;
  /** Randomly drop events with specified probability */
  degradeBy(prob: number): Pattern;
  /** Undegradeを */
  undegrade(): Pattern;
  /** Undegradeto specified probability */
  undegradeBy(prob: number): Pattern;

  // ---------------------------------------------------------------------------
  // Pattern Combination / Layering
  // ---------------------------------------------------------------------------
  /** Juxtapose - pan original left, transformed right */
  jux(fn: PatternFunc): Pattern;
  /** Jux with custom pan amount */
  juxBy(amount: number, fn: PatternFunc): Pattern;
  /** Superimpose transformed pattern on original */
  superimpose(fn: PatternFunc): Pattern;
  /** Layer multiple transformations */
  layer(...fns: PatternFunc[]): Pattern;
  /** Offset and transform */
  off(time: number | Pattern, fn: PatternFunc): Pattern;
  /** Add pattern on top */
  stack(...patterns: (Pattern | string)[]): Pattern;
  /** Sequence patterns */
  seq(...patterns: (Pattern | string)[]): Pattern;
  /** Concatenate patterns (one cycle each) */
  cat(...patterns: (Pattern | string)[]): Pattern;
  /** Append pattern after current */
  append(pattern: Pattern | string): Pattern;
  /** Prepend pattern before current */
  prepend(pattern: Pattern | string): Pattern;

  // ---------------------------------------------------------------------------
  // Value Modifiers / Math
  // ---------------------------------------------------------------------------
  /** Add to pattern values */
  add(amount: number | Pattern): Pattern;
  /** Subtract from pattern values */
  sub(amount: number | Pattern): Pattern;
  /** Multiply pattern values */
  mul(amount: number | Pattern): Pattern;
  /** Divide pattern values */
  div(amount: number | Pattern): Pattern;
  /** Modulo operation */
  mod(amount: number | Pattern): Pattern;
  /** Set/replace values */
  set(other: Pattern): Pattern;
  /** Round values to nearest integer */
  round(): Pattern;
  /** Floor values */
  floor(): Pattern;
  /** Ceiling values */
  ceil(): Pattern;
  /** Absolute value */
  abs(): Pattern;
  /** Scale values to range */
  range(min: number, max: number): Pattern;
  /** Scale values to range (exponential) */
  rangex(min: number, max: number): Pattern;
  /** Scale bipolar values to range */
  range2(min: number, max: number): Pattern;
  /** Segment continuous signal into steps */
  segment(steps: number): Pattern;

  // ---------------------------------------------------------------------------
  // MIDI Output
  // ---------------------------------------------------------------------------
  /** Send to MIDI output */
  midi(output?: string): Pattern;
  /** Set MIDI channel (1-16) */
  midichan(channel: number | Pattern): Pattern;
  /** Control Change number */
  ccn(num: number | Pattern): Pattern;
  /** Control Change value (0-1) */
  ccv(value: number | Signal | Pattern): Pattern;
  /** Program change */
  progNum(num: number | Pattern): Pattern;

  // ---------------------------------------------------------------------------
  // OSC Output
  // ---------------------------------------------------------------------------
  /** Send via OSC */
  osc(): Pattern;

  // ---------------------------------------------------------------------------
  // Visualization / Debug
  // ---------------------------------------------------------------------------
  /** Log pattern events to console */
  log(): Pattern;
  /** Draw pattern visualization */
  draw(): Pattern;
  /** Pianoroll visualization - renders scrolling piano roll in background */
  pianoroll(options?: PianorollOptions): Pattern;
  /** Oscilloscope visualization - shows audio waveform */
  scope(options?: ScopeOptions): Pattern;

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  /** First cycle only */
  first(): Pattern;
  /** First n cycles */
  firstOf(n: number): Pattern;
  /** Last cycle */
  last(): Pattern;
  /** Apply function to pattern */
  apply(fn: PatternFunc): Pattern;
  /** Collect events for a number of cycles */
  queryArc(start: number, end: number): any[];
  /** Convert to string representation */
  showFirstCycle(): string;
}

// =============================================================================
// SIGNAL TYPE
// For continuous/oscillating values
// =============================================================================

interface Signal extends Pattern {
  /** Scale signal to range (0-1 input) */
  range(min: number, max: number): Signal;
  /** Scale signal to range (exponential) */
  rangex(min: number, max: number): Signal;
  /** Scale bipolar signal (-1 to 1) to range */
  range2(min: number, max: number): Signal;
  /** Slow down signal */
  slow(factor: number): Signal;
  /** Speed up signal */
  fast(factor: number): Signal;
  /** Segment into discrete steps */
  segment(steps: number): Signal;
}

// =============================================================================
// HELPER TYPES
// =============================================================================

/** Function that transforms a pattern */
type PatternFunc = (p: Pattern) => Pattern;

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
}

interface ScopeOptions {
  /** Align to first zero crossing (default: 1) */
  align?: number;
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
}

// =============================================================================
// GLOBAL PATTERN CREATION FUNCTIONS
// =============================================================================

/** Create pattern from note names or MIDI numbers */
declare function note(notes: string | number | Pattern): Pattern;
/** Select sound by name */
declare function s(sounds: Sample): Pattern;
/** Select sound by name (alias for s) */
declare function sound(sounds: Sample): Pattern;
/** Select sample number */
declare function n(index: string | number): Pattern;
/** Stack patterns (play simultaneously) */
declare function stack(...patterns: (Pattern | string)[]): Pattern;
/** Sequence patterns (compress into one cycle) */
declare function seq(...patterns: (Pattern | string)[]): Pattern;
/** Concatenate patterns (one cycle each) */
declare function cat(...patterns: (Pattern | string)[]): Pattern;
/** Alternating sequence (alias for cat) */
declare function slowcat(...patterns: (Pattern | string)[]): Pattern;
/** Fast concatenation (alias for seq) */
declare function fastcat(...patterns: (Pattern | string)[]): Pattern;
/** Time-weighted concatenation */
declare function timecat(...entries: [number, Pattern | string][]): Pattern;
/** Create pattern from steps */
declare function stepcat(...entries: [number, Pattern | string][]): Pattern;
/** Arrange patterns over multiple cycles */
declare function arrange(...entries: [number, Pattern | string][]): Pattern;
/** Polyrhythm - different lengths cycle together */
declare function polyrhythm(...patterns: (Pattern | string)[]): Pattern;
/** Polymeter - align by steps */
declare function polymeter(...patterns: (Pattern | string)[]): Pattern;
/** Silence pattern */
declare function silence(): Pattern;
/** Pure/constant value pattern */
declare function pure<T>(value: T): Pattern;
/** Convert value to pattern */
declare function reify(value: any): Pattern;
/** Run numbers from 0 to n-1 */
declare function run(n: number): Pattern;
/** Create pattern from binary number */
declare function binary(n: number): Pattern;
/** Binary pattern with specific bit count */
declare function binaryN(n: number, bits: number): Pattern;
/** Parse mini notation */
declare function mini(notation: string): Pattern;
/** Register custom function */
declare function register(name: string, fn: Function): void;

// =============================================================================
// GLOBAL SIGNALS (Continuous Patterns)
// =============================================================================

/** Sine wave oscillator (0 to 1) */
declare const sine: Signal;
/** Sine wave oscillator (-1 to 1) */
declare const sine2: Signal;
/** Cosine wave oscillator (0 to 1) */
declare const cosine: Signal;
/** Cosine wave oscillator (-1 to 1) */
declare const cosine2: Signal;
/** Sawtooth wave (0 to 1) */
declare const saw: Signal;
/** Sawtooth wave (-1 to 1) */
declare const saw2: Signal;
/** Triangle wave (0 to 1) */
declare const tri: Signal;
/** Triangle wave (-1 to 1) */
declare const tri2: Signal;
/** Square wave (0 to 1) */
declare const square: Signal;
/** Square wave (-1 to 1) */
declare const square2: Signal;
/** Random values (0 to 1) */
declare const rand: Signal;
/** Perlin noise (0 to 1) */
declare const perlin: Signal;
/** Random integers from 0 to n-1 */
declare function irand(n: number): Signal;
/** Binary random (0 or 1) */
declare const brand: Signal;
/** Binary random with probability */
declare function brandBy(prob: number): Signal;
/** Time signal (current cycle position) */
declare const time: Signal;

// =============================================================================
// GLOBAL CONTROL FUNCTIONS
// =============================================================================

/** Stop all sounds */
declare function hush(): void;
/** Set cycles per minute */
declare function setcpm(cpm: number): void;
/** Set beats per minute (alias: 1 cycle = 1 beat) */
declare function setbpm(bpm: number): void;
/** Get current cycles per minute */
declare function getcpm(): number;
/** Set the default number of cycles per minute */
declare function cpm(cpm: number): void;
/** Panic - stop everything immediately */
declare function panic(): void;

// =============================================================================
// GLOBAL UTILITY FUNCTIONS
// =============================================================================

/** Create custom parameters */
declare function createParams<T extends string[]>(
  ...names: T
): Record<T[number], (value: any) => Pattern>;
/** Register a custom sample or load samples from a URL */
declare function samples(
  config:
    | string
    | Record<string, string | string[] | Record<string, string | string[]>>
): Promise<void>;

// =============================================================================
// MINI NOTATION (String Patterns)
// Global string augmentation for mini notation
// =============================================================================

interface String {
  /** Convert mini notation string to pattern with note values */
  note(): Pattern;
  /** Convert mini notation string to pattern with sound values */
  s(): Pattern;
  /** Convert mini notation string to pattern with sound values */
  sound(): Pattern;
  /** Convert mini notation string to pattern with n values */
  n(): Pattern;
  // All Pattern methods are available on strings via mini notation
  [key: string]: any;
}
