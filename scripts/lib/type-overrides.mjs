// Hand-tuned pieces the generator can't infer from Strudel's JSDoc/source.
// Signatures are written in TypeScript (without the name) using the helper types
// declared in src/strudel.d.ts:
//   NumberInput  = number | mini-notation string | Pattern
//   StringInput<T> = T | string | Pattern (keeps literal autocomplete)
//   PatternInput = anything reify() accepts (Pattern | string | number | boolean)
//   SequenceInput = PatternInput or nested arrays of them (sequenced like mini-notation [..])
//   PatternFunc  = (pat: Pattern) => Pattern
// An array means overloads.

// ─────────────────────────────────────────────────────────────────────────────
// Public surface policy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runtime globals that are undocumented (or marked @noAutocomplete) but are useful in songs,
 * so they are declared anyway. Everything else undocumented that isn't a control, a signal or
 * a Pattern method twin is treated as engine/parser plumbing and left out (see audit-types).
 */
export const INCLUDE_GLOBALS = [
  "pure", "reify", "isPattern", "register", "mini", "m", "h", "steady", "signal", "evaluate",
  "initStrudel", "createParam", "createParams", "noteToMidi", "midiToFreq", "freqToMidi",
  "valueToMidi", "getFreq", "midi2note", "randrun", "stackLeft", "stackRight", "stackCentre",
  "stackBy", "perlinWith", "berlinWith", "chooseIn", "chooseOut", "registerVoicings",
  "setVoicingRange", "setDefaultVoicings", "voicingAlias", "getAudioContext",
  "initAudioOnFirstClick", "setDefault", "setDefaultValue", "setDefaultValues", "resetDefaults",
  "registerSound", "setMaxPolyphony", "pipe", "compose", "id", "s_cat", "s_alt", "s_polymeter",
  "s_zip", "chooseWith", "chooseInWith", "squeeze",
];

/** Documented globals that are still internal (or can't be declared, e.g. clash with lib.dom). */
export const EXCLUDE_GLOBALS = {
  frames: "clashes with lib.dom `declare var frames: Window` (use .frames() on a pattern)",
  Fraction: "class/factory, not needed in songs",
  colour: "exported as undefined at runtime",
  repeatCycles: "exported as undefined at runtime (only the method exists)",
};

/**
 * Should a runtime global be declared? Shared by the generator and the audit.
 * @param {{ name: string, kind: string }} g runtime global (see strudel-runtime.mjs)
 * @param {{ doc?: { noAutocomplete: boolean }, isMethodTwin: boolean }} info
 * @returns {{ public: boolean, reason: string }}
 */
export function globalPolicy({ name, kind }, { doc, isMethodTwin }) {
  if (EXCLUDE_GLOBALS[name]) return { public: false, reason: EXCLUDE_GLOBALS[name] };
  if (kind === "pattern") return { public: true, reason: "signal/pattern constant" };
  if (kind === "control") return { public: true, reason: "control" };
  if (INCLUDE_GLOBALS.includes(name) || GLOBAL_SIGNATURES[name]) return { public: true, reason: "allow-listed" };
  if (name.startsWith("_")) return { public: false, reason: "underscore internal" };
  if (kind !== "function" && kind !== "curried") return { public: false, reason: `${kind} value` };
  if (isMethodTwin) return { public: true, reason: "twin of a Pattern method" };
  if (doc && !doc.noAutocomplete) return { public: true, reason: "documented" };
  return { public: false, reason: doc ? "@noAutocomplete" : "undocumented helper" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Control value types (for autocomplete); everything else is NumberInput
// ─────────────────────────────────────────────────────────────────────────────

export const CONTROL_TYPES = {
  s: "SoundInput",
  sound: "SoundInput",
  bank: "BankInput",
  vowel: 'StringInput<"a" | "e" | "i" | "o" | "u" | "ae" | "aa" | "oe" | "ue" | "y" | "uh" | "un" | "en" | "an" | "on">',
  unit: 'StringInput<"r" | "c">',
  note: "NoteInput",
  chord: "StringInput",
  mode: 'StringInput<"below" | "above" | "duck" | "root">',
  dictionary: "StringInput",
  dict: "StringInput",
  anchor: "NoteInput",
  fmwave: 'StringInput<"sine" | "square" | "sawtooth" | "triangle">',
  ftype: 'StringInput<"12db" | "ladder" | "24db"> | 0 | 1 | 2',
  tremoloshape: 'StringInput<"sine" | "square" | "sawtooth" | "triangle" | "tri" | "saw" | "ramp">',
  tremshape: 'StringInput<"sine" | "square" | "sawtooth" | "triangle" | "tri" | "saw" | "ramp">',
  label: "StringInput",
  activeLabel: "StringInput",
  color: "StringInput",
  ir: "SoundInput",
  iresponse: "SoundInput",
  midiport: "StringInput",
  oschost: "StringInput",
  byteBeatExpression: "StringInput",
  bbexpr: "StringInput",
  voice: "NumberInput",
  scram: "NumberInput",
};

// ─────────────────────────────────────────────────────────────────────────────
// Pattern methods
// ─────────────────────────────────────────────────────────────────────────────

const opMethod = "PatternOperator";

export const METHOD_SIGNATURES = {
  // playback (@strudel/web)
  play: "(): Pattern",
  hush: "(): Pattern",

  // querying / internals with non-Pattern results
  queryArc: "(begin: number, end: number, controls?: Record<string, any>): Hap[]",
  firstCycle: "(withContext?: boolean): Hap[]",
  sortHapsByPart: "(): Pattern",
  drawLine: "(): string",
  getPainters: "(): Array<(...args: any[]) => void>",
  asNumber: "(): Pattern",
  collect: "(): Pattern",
  fmap: "(func: (value: any) => any): Pattern",
  withValue: "(func: (value: any) => any): Pattern",
  filterValues: "(test: (value: any) => boolean): Pattern",
  filterHaps: "(test: (hap: Hap) => boolean): Pattern",
  withHap: "(func: (hap: Hap) => Hap): Pattern",
  withHaps: "(func: (haps: Hap[], state?: any) => Hap[]): Pattern",
  withHapSpan: "(func: (span: TimeSpan) => TimeSpan): Pattern",
  withQuerySpan: "(func: (span: TimeSpan) => TimeSpan): Pattern",
  withQuerySpanMaybe: "(func: (span: TimeSpan) => TimeSpan | undefined): Pattern",
  withHapTime: "(func: (time: any) => any): Pattern",
  withQueryTime: "(func: (time: any) => any): Pattern",
  withContext: "(func: (context: Record<string, any>) => Record<string, any>): Pattern",
  setContext: "(context: Record<string, any>): Pattern",
  withState: "(func: (state: any) => any): Pattern",
  onTrigger: "(onTrigger: (...args: any[]) => void, dominant?: boolean): Pattern",
  onTriggerTime: "(func: (hap: Hap) => void): Pattern",
  filter: "(test: (hap: Hap) => boolean): Pattern",
  filterWhen: "(test: (time: number) => boolean): Pattern",
  bind: "(func: (value: any) => Pattern): Pattern",
  innerBind: "(func: (value: any) => Pattern): Pattern",
  outerBind: "(func: (value: any) => Pattern): Pattern",
  squeezeBind: "(func: (value: any) => Pattern): Pattern",
  stepBind: "(func: (value: any) => Pattern): Pattern",
  polyBind: "(func: (value: any) => Pattern): Pattern",
  bindWhole: "(chooseWhole: (a: any, b: any) => any, func: (value: any) => Pattern): Pattern",
  appLeft: "(patFunc: Pattern): Pattern",
  appRight: "(patFunc: Pattern): Pattern",
  appBoth: "(patFunc: Pattern): Pattern",
  appWhole: "(wholeFunc: (a: any, b: any) => any, patValue: Pattern): Pattern",
  unjoin: "(pieces: PatternInput, func?: PatternFunc): Pattern",
  into: "(pieces: PatternInput, func: PatternFunc): Pattern",
  tag: "(tag: string): Pattern",
  setSteps: "(steps: number | undefined): Pattern",
  withSteps: "(func: (steps: any) => any): Pattern",
  withLoc: "(start: any, end: any): Pattern",
  draw: "(callback: (haps: Hap[], time: number, ...args: any[]) => void, options?: Record<string, any>): Pattern",
  onPaint: "(painter: (ctx: CanvasRenderingContext2D, time: number, haps: Hap[], drawTime: [number, number]) => void): Pattern",
  animate: "(options?: { callback?: (...args: any[]) => void; sync?: boolean; smear?: number }): Pattern",

  // combining
  stack: "(...patterns: SequenceInput[]): Pattern",
  seq: "(...patterns: SequenceInput[]): Pattern",
  sequence: "(...patterns: SequenceInput[]): Pattern",
  cat: "(...patterns: SequenceInput[]): Pattern",
  fastcat: "(...patterns: SequenceInput[]): Pattern",
  slowcat: "(...patterns: SequenceInput[]): Pattern",
  layer: "(...funcs: PatternFunc[]): Pattern",
  superimpose: "(...funcs: PatternFunc[]): Pattern",
  apply: "(func: PatternFunc): Pattern",
  struct: "(...structure: SequenceInput[]): Pattern",
  structAll: "(...structure: SequenceInput[]): Pattern",
  mask: "(...mask: SequenceInput[]): Pattern",
  maskAll: "(...mask: SequenceInput[]): Pattern",
  reset: "(...patterns: SequenceInput[]): Pattern",
  resetAll: "(...patterns: SequenceInput[]): Pattern",
  restart: "(...patterns: SequenceInput[]): Pattern",
  restartAll: "(...patterns: SequenceInput[]): Pattern",
  in: "(...patterns: SequenceInput[]): Pattern",
  out: "(...patterns: SequenceInput[]): Pattern",
  mix: "(...patterns: SequenceInput[]): Pattern",
  squeeze: "(...patterns: SequenceInput[]): Pattern",
  squeezeout: "(...patterns: SequenceInput[]): Pattern",
  poly: "(...patterns: SequenceInput[]): Pattern",
  tour: "(...patterns: PatternInput[]): Pattern",
  s_tour: "(...patterns: PatternInput[]): Pattern",
  zip: "(...patterns: PatternInput[]): Pattern",
  s_zip: "(...patterns: PatternInput[]): Pattern",
  polymeter: "(...patterns: SequenceInput[]): Pattern",
  s_polymeter: "(...patterns: SequenceInput[]): Pattern",
  shrinklist: "(amount: number | number[]): Pattern[]",
  s_taperlist: "(amount: number | number[]): Pattern[]",
  xfade: "(pos: NumberInput, b: PatternInput): Pattern",
  choose: "(...values: any[]): Pattern",
  choose2: "(...values: any[]): Pattern",
  pick: "(lookup: PatternLookup): Pattern",
  pickmod: "(lookup: PatternLookup): Pattern",
  pickOut: "(lookup: PatternLookup): Pattern",
  pickmodOut: "(lookup: PatternLookup): Pattern",
  pickRestart: "(lookup: PatternLookup): Pattern",
  pickmodRestart: "(lookup: PatternLookup): Pattern",
  pickReset: "(lookup: PatternLookup): Pattern",
  pickmodReset: "(lookup: PatternLookup): Pattern",
  inhabit: "(lookup: PatternLookup): Pattern",
  pickSqueeze: "(lookup: PatternLookup): Pattern",
  inhabitmod: "(lookup: PatternLookup): Pattern",
  pickmodSqueeze: "(lookup: PatternLookup): Pattern",
  pickF: "(lookup: NumberInput, funcs: PatternFunc[]): Pattern",
  pickmodF: "(lookup: NumberInput, funcs: PatternFunc[]): Pattern",
  arp: "(indices: NumberInput): Pattern",
  as: "(mapping: StringInput | string[]): Pattern",
  arpWith: "(func: (haps: any[]) => any): Pattern",
  weave: "(t: NumberInput, ...pats: Pattern[]): Pattern",
  weaveWith: "(t: NumberInput, ...funcs: PatternFunc[]): Pattern",

  // time
  range: "(min: NumberInput, max: NumberInput): Pattern",
  rangex: "(min: NumberInput, max: NumberInput): Pattern",
  range2: "(min: NumberInput, max: NumberInput): Pattern",
  euclid: "(pulses: NumberInput, steps: NumberInput): Pattern",
  euclidRot: "(pulses: NumberInput, steps: NumberInput, rotation: NumberInput): Pattern",
  euclidrot: "(pulses: NumberInput, steps: NumberInput, rotation: NumberInput): Pattern",
  euclidLegato: "(pulses: NumberInput, steps: NumberInput): Pattern",
  euclidLegatoRot: "(pulses: NumberInput, steps: NumberInput, rotation: NumberInput): Pattern",
  euclidish: "(pulses: NumberInput, steps: NumberInput, groove: NumberInput): Pattern",
  eish: "(pulses: NumberInput, steps: NumberInput, groove: NumberInput): Pattern",
  e: "(euclid: StringInput): Pattern",
  within: "(start: NumberInput, end: NumberInput, func: PatternFunc): Pattern",
  when: "(binary: PatternInput, func: PatternFunc): Pattern",
  whenKey: "(key: StringInput, func: PatternFunc): Pattern",
  off: "(time: NumberInput, func: PatternFunc): Pattern",
  echoWith: "(times: NumberInput, time: NumberInput, func: PatternFunc): Pattern",
  echowith: "(times: NumberInput, time: NumberInput, func: PatternFunc): Pattern",
  stutWith: "(times: NumberInput, time: NumberInput, func: PatternFunc): Pattern",
  stutwith: "(times: NumberInput, time: NumberInput, func: PatternFunc): Pattern",
  applyN: "(n: NumberInput, func: PatternFunc): Pattern",
  bypass: "(on: PatternInput): Pattern",
  hsla: "(h: NumberInput, s: NumberInput, l: NumberInput, a: NumberInput): Pattern",
  hsl: "(h: NumberInput, s: NumberInput, l: NumberInput): Pattern",
  swingBy: "(amount: NumberInput, subdivision: NumberInput): Pattern",
  swing: "(subdivision: NumberInput): Pattern",
  compressSpan: "(span: TimeSpan): Pattern",
  compressspan: "(span: TimeSpan): Pattern",
  focusSpan: "(span: TimeSpan): Pattern",
  focusspan: "(span: TimeSpan): Pattern",
  zoomArc: "(span: TimeSpan): Pattern",
  zoomarc: "(span: TimeSpan): Pattern",
  degradeByWith: "(withPat: Pattern, amount: NumberInput): Pattern",
  speak: "(lang: StringInput, voice: NumberInput): Pattern",
  ad: "(times: NumberInput): Pattern",
  ds: "(times: NumberInput): Pattern",
  ar: "(times: NumberInput): Pattern",
  adsr: "(times: NumberInput): Pattern",
  rescale: "(factor: NumberInput): Pattern",
  moveXY: "(dx: NumberInput, dy: NumberInput): Pattern",
  zoomIn: "(factor: NumberInput): Pattern",

  // tonal
  scale: "(scale: ScaleInput): Pattern",
  transpose: "(amount: NumberInput): Pattern",
  trans: "(amount: NumberInput): Pattern",
  scaleTranspose: "(steps: NumberInput): Pattern",
  scaleTrans: "(steps: NumberInput): Pattern",
  strans: "(steps: NumberInput): Pattern",
  voicings: "(dictionary: StringInput): Pattern",
  rootNotes: "(octave?: NumberInput): Pattern",
  voicing: "(): Pattern",

  // visuals
  pianoroll: "(options?: PianorollOptions): Pattern",
  punchcard: "(options?: PianorollOptions): Pattern",
  wordfall: "(options?: PianorollOptions): Pattern",
  spiral: "(options?: SpiralOptions): Pattern",
  pitchwheel: "(options?: PitchwheelOptions): Pattern",
  scope: "(options?: ScopeOptions): Pattern",
  tscope: "(options?: ScopeOptions): Pattern",
  fscope: "(options?: ScopeOptions): Pattern",
  spectrum: "(options?: SpectrumOptions): Pattern",

  // animate() params from @strudel/draw (createParams, so not registered controls)
  x: "(value?: NumberInput): Pattern",
  y: "(value?: NumberInput): Pattern",
  w: "(value?: NumberInput): Pattern",
  h: "(value?: NumberInput): Pattern",
  r: "(value?: NumberInput): Pattern",
  angle: "(value?: NumberInput): Pattern",
  fill: "(color?: StringInput): Pattern",
  scurve: "(distortion?: NumberInput, volume?: NumberInput): Pattern",

  // operator getters: callable, plus .in/.out/.mix/.squeeze/... variants
  set: opMethod, keep: opMethod, keepif: opMethod, add: opMethod, sub: opMethod, mul: opMethod,
  div: opMethod, mod: opMethod, pow: opMethod, log2: opMethod, band: opMethod, bor: opMethod,
  bxor: opMethod, blshift: opMethod, brshift: opMethod, lt: opMethod, gt: opMethod, lte: opMethod,
  gte: opMethod, eq: opMethod, eqt: opMethod, ne: opMethod, net: opMethod, and: opMethod,
  or: opMethod, func: opMethod,

  // other getters
  _steps: "number | undefined",
  hasSteps: "boolean",
  firstCycleValues: "any[]",
  showFirstCycle: "string[]",
};

/**
 * Getter-backed members (typed as readonly properties). Filled from the runtime, but listed
 * here so the generator knows the type of each.
 */
export const GETTER_TYPES = Object.fromEntries(
  Object.entries(METHOD_SIGNATURES).filter(([, v]) => !v.startsWith("(")),
);

// ─────────────────────────────────────────────────────────────────────────────
// Globals
// ─────────────────────────────────────────────────────────────────────────────

export const GLOBAL_SIGNATURES = {
  // constructing patterns
  stack: "(...patterns: SequenceInput[]): Pattern",
  polyrhythm: "(...patterns: SequenceInput[]): Pattern",
  pr: "(...patterns: SequenceInput[]): Pattern",
  stackLeft: "(...patterns: SequenceInput[]): Pattern",
  stackRight: "(...patterns: SequenceInput[]): Pattern",
  stackCentre: "(...patterns: SequenceInput[]): Pattern",
  stackBy: "(by: NumberInput, ...patterns: SequenceInput[]): Pattern",
  seq: "(...patterns: SequenceInput[]): Pattern",
  sequence: "(...patterns: SequenceInput[]): Pattern",
  fastcat: "(...patterns: SequenceInput[]): Pattern",
  cat: "(...patterns: SequenceInput[]): Pattern",
  slowcat: "(...patterns: SequenceInput[]): Pattern",
  slowcatPrime: "(...patterns: SequenceInput[]): Pattern",
  seqPLoop: "(...parts: Array<[number, number, PatternInput]>): Pattern",
  polymeter: "(...patterns: SequenceInput[]): Pattern",
  pm: "(...patterns: SequenceInput[]): Pattern",
  s_polymeter: "(...patterns: SequenceInput[]): Pattern",
  stepcat: "(...steps: Array<[number, PatternInput] | PatternInput>): Pattern",
  timecat: "(...steps: Array<[number, PatternInput] | PatternInput>): Pattern",
  timeCat: "(...steps: Array<[number, PatternInput] | PatternInput>): Pattern",
  s_cat: "(...steps: Array<[number, PatternInput] | PatternInput>): Pattern",
  stepalt: "(...groups: SequenceInput[]): Pattern",
  s_alt: "(...groups: SequenceInput[]): Pattern",
  arrange: "(...sections: Array<[number, PatternInput]>): Pattern",
  randcat: "(...patterns: PatternInput[]): Pattern",
  chooseCycles: "(...patterns: PatternInput[]): Pattern",
  wrandcat: "(...pairs: Array<[PatternInput, number]>): Pattern",
  wchooseCycles: "(...pairs: Array<[PatternInput, number]>): Pattern",
  choose: "(...values: any[]): Pattern",
  chooseIn: "(...values: any[]): Pattern",
  chooseOut: "(...values: any[]): Pattern",
  wchoose: "(...pairs: Array<[any, number]>): Pattern",
  chooseWith: "(pat: PatternInput, values: any[]): Pattern",
  chooseInWith: "(pat: PatternInput, values: any[]): Pattern",
  pure: "(value: any): Pattern",
  reify: "(value: any): Pattern",
  isPattern: "(value: unknown): value is Pattern",
  gap: "(steps: number): Pattern",
  steady: "(value: any): Pattern",
  signal: "(func: (time: number) => any): Pattern",
  run: "(n: NumberInput): Pattern",
  randrun: "(n: NumberInput): Pattern",
  binary: "(n: NumberInput): Pattern",
  binaryN: "(n: NumberInput, bits?: NumberInput): Pattern",
  irand: "(n: NumberInput): Pattern",
  brandBy: "(probability: NumberInput): Pattern",
  perlinWith: "(time: Pattern): Pattern",
  berlinWith: "(time: Pattern): Pattern",
  mini: "(...strings: string[]): Pattern",
  m: "(str: string, offset?: number): Pattern",
  h: "(str: string): Pattern",
  zip: "(...patterns: PatternInput[]): Pattern",
  s_zip: "(...patterns: PatternInput[]): Pattern",
  tour: "(pat: PatternInput, ...many: PatternInput[]): Pattern",
  s_tour: "(pat: PatternInput, ...many: PatternInput[]): Pattern",
  xfade: "(a: PatternInput, pos: NumberInput, b: PatternInput): Pattern",
  pick: ["(lookup: PatternLookup, pat: PatternInput): Pattern", "(pat: PatternInput, lookup: PatternInput[]): Pattern"],
  squeeze: "(pat: PatternInput, values: PatternInput[]): Pattern",
  shrinklist: "(amount: number | number[], pat: Pattern): Pattern[]",
  s_taperlist: "(amount: number | number[], pat: Pattern): Pattern[]",
  morph: "(frompat: PatternInput, topat: PatternInput, bypat: NumberInput): Pattern",

  // curried value operators: add(2) is a PatternFunc, add(2, pat) a Pattern
  ...Object.fromEntries(
    ["set", "keep", "keepif", "add", "sub", "mul", "div", "mod", "pow", "band", "bor", "bxor", "blshift",
      "brshift", "lt", "gt", "lte", "gte", "eq", "eqt", "ne", "net", "and", "or", "func"].map((op) => [
      op,
      ["(value: PatternInput, pat: PatternInput): Pattern", "(value: PatternInput): PatternFunc"],
    ]),
  ),
  mask: ["(mask: PatternInput, pat: PatternInput): Pattern", "(mask: PatternInput): PatternFunc"],
  struct: ["(structure: PatternInput, pat: PatternInput): Pattern", "(structure: PatternInput): PatternFunc"],
  superimpose: ["(funcs: PatternFunc[], pat: PatternInput): Pattern", "(funcs: PatternFunc[]): PatternFunc"],
  withValue: ["(func: (value: any) => any, pat: PatternInput): Pattern", "(func: (value: any) => any): PatternFunc"],
  bind: ["(func: (value: any) => Pattern, pat: PatternInput): Pattern", "(func: (value: any) => Pattern): PatternFunc"],
  innerBind: ["(func: (value: any) => Pattern, pat: PatternInput): Pattern", "(func: (value: any) => Pattern): PatternFunc"],
  outerBind: ["(func: (value: any) => Pattern, pat: PatternInput): Pattern", "(func: (value: any) => Pattern): PatternFunc"],
  squeezeBind: ["(func: (value: any) => Pattern, pat: PatternInput): Pattern", "(func: (value: any) => Pattern): PatternFunc"],
  stepBind: ["(func: (value: any) => Pattern, pat: PatternInput): Pattern", "(func: (value: any) => Pattern): PatternFunc"],
  polyBind: ["(func: (value: any) => Pattern, pat: PatternInput): Pattern", "(func: (value: any) => Pattern): PatternFunc"],
  filter: ["(test: (hap: Hap) => boolean, pat: PatternInput): Pattern", "(test: (hap: Hap) => boolean): PatternFunc"],
  filterWhen: ["(test: (time: number) => boolean, pat: PatternInput): Pattern", "(test: (time: number) => boolean): PatternFunc"],
  arpWith: ["(func: (haps: any[]) => any, pat: PatternInput): Pattern", "(func: (haps: any[]) => any): PatternFunc"],

  // samples & sounds (superdough)
  samples: "(sampleMap: string | Record<string, string | string[] | Record<string, string | string[]>>, baseUrl?: string, options?: { prebake?: boolean; tag?: string }): Promise<void>",
  aliasBank: ["(aliasMap: string | Record<string, string | string[]>): Promise<void>", "(bank: BankName | (string & {}), alias: string): Promise<void>"],
  soundAlias: "(original: SoundName | (string & {}), alias: string): void",
  registerSound: "(key: string, onTrigger: (...args: any[]) => any, data?: Record<string, any>): void",
  getAudioContext: "(): AudioContext",
  initAudioOnFirstClick: "(options?: Record<string, any>): Promise<void>",
  setDefault: "(control: string, value: any): void",
  setDefaultValue: "(key: string, value: any): void",
  setDefaultValues: "(defaults: Record<string, any>): void",
  resetDefaults: "(): void",
  setMaxPolyphony: "(polyphony: number): void",
  createParam: "(names: string | string[]): (value: PatternInput, pat?: Pattern) => Pattern",
  createParams: "<T extends string>(...names: T[]): Record<T, (value: PatternInput, pat?: Pattern) => Pattern>",
  register: "(name: string | string[], func: (...args: any[]) => Pattern, patternify?: boolean, preserveSteps?: boolean, join?: (pat: Pattern) => Pattern): any",

  // repl
  hush: "(): void",
  evaluate: "(code: string, autoplay?: boolean): Promise<any>",
  initStrudel: "(options?: InitStrudelOptions): Promise<any>",

  // tonal helpers
  registerVoicings: "(name: string, dictionary: Record<string, string[]>, options?: Record<string, any>): void",
  addVoicings: "(name: string, dictionary: Record<string, string[]>, range?: [string, string]): void",
  setVoicingRange: "(name: string, range: [string, string]): void",
  setDefaultVoicings: "(dictionary: string): void",
  voicingAlias: "(symbol: string, alias: string | string[], setOrSets?: any): void",
  noteToMidi: "(note: string, defaultOctave?: number): number",
  midiToFreq: "(midi: number): number",
  freqToMidi: "(freq: number): number",
  valueToMidi: "(value: { note?: string | number; freq?: number } | string | number, fallback?: number): number",
  getFreq: "(noteOrMidi: string | number): number",
  midi2note: "(midi: number): string",

  ref: "(accessor: () => any): Pattern",
  sequenceP: "(patterns: PatternInput[]): Pattern",
  tables: "(url: string, frameLen?: number, json?: Record<string, any>, options?: Record<string, any>): Promise<void>",

  // functional helpers
  pipe: "(...funcs: Array<(x: any) => any>): (x: any) => any",
  compose: "(...funcs: Array<(x: any) => any>): (x: any) => any",
  id: "<T>(value: T): T",
};

/** Notes added in front of a generated description (runtime quirks worth knowing). */
export const EXTRA_NOTES = {
  density:
    "⚠️ At runtime the `density` *control* (registered after `fast`) overwrites the `fast` alias, so `.density(2)` sets a `density` value instead of speeding up — use `.fast()`.",
  cpm:
    "⚠️ This is the (deprecated) pattern function: `cpm(n)` with one argument returns a curried function and does NOT change the global tempo. `setcpm`/`setcps` only exist inside the Strudel REPL's `evaluate()`.",
};

/** Short descriptions for common controls that have no JSDoc upstream. */
export const EXTRA_DOCS = {
  hold: "Hold time of the envelope in seconds (between decay and release).",
  nudge: "Nudges events in time by the given number of seconds (can be negative).",
  chord: "Sets the chord symbol(s) to voice with `.voicing()`, e.g. `chord(\"<C Am F G>\").voicing()`.",
  mode: 'Voicing mode for `.voicing()`: "below" | "above" | "duck" | "root", optionally with an anchor, e.g. "root:g2".',
  anchor: "Anchor note for `.voicing()`; voicings are placed relative to it (e.g. \"c5\").",
  dictionary: "Voicing dictionary used by `.voicing()` (e.g. \"ireal\", \"lefthand\").",
  dict: "Voicing dictionary used by `.voicing()` (alias of `dictionary`).",
  offset: "Voicing offset for `.voicing()`: shifts the voicing up/down by n voices.",
  octaves: "Number of octaves `.voicing()` may span.",
  degree: "Scale degree (SuperDirt).",
  rate: "Playback rate (SuperDirt).",
  slide: "Pitch slide (SuperDirt / zzfx).",
  semitone: "Semitone offset (SuperDirt).",
  voice: "Voice parameter (SuperDirt synths).",
  overgain: "Extra gain applied after `shape`/`distort` (SuperDirt).",
  fft: "FFT size used by `.analyze()`/visualisers.",
  analyze: "Marks the pattern for analysis so `scope()`/`spectrum()` can read it (value = analyser id).",
  zzfx: "Raw ZzFX parameter array for the zzfx synth.",
  cps: "Cycles per second for this event.",
  val: "Generic value control.",
  gate: "Gate (MIDI/SuperDirt).",
  gat: "Gate (alias of `gate`).",
};
