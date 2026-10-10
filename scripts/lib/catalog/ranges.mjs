// Curated ranges and units for controls (completions.json / functions.json `range`): what a value
// means and where it's useful, for the editor's labels and hovers (and, later, knob ranges).
// Strudel has nothing machine-readable for this, so each entry comes from the control's own docs in
// @strudel/core/controls.mjs ("between 0 and 1", "time in seconds", "resonance factor between 0 and
// 50") or from superdough's code where it clamps (crush ≥ 1, unison 1–100, delay feedback < 1).
// A bound the docs don't state is left out (speed is "-inf to inf": no entry). Never invent one.
//
//   min / max  the useful range (both optional)
//   unit       "Hz", "s" (seconds), "cycles", "semitones", "bits", "m"
//   log        the range reads on a log scale (frequencies)
//
// Keys are canonical names (not aliases): an alias inherits its target's range. The generator fails
// on a key that isn't a function, is an alias, or has min ≥ max (test/catalog-data.test.mjs too).

const HZ = { min: 20, max: 20000, unit: "Hz", log: true }; // "audible between 0 and 20000" (log needs > 0: the audible floor)
const UNIT = { min: 0, max: 1 };
const SECONDS = { min: 0, unit: "s" };

/** @type {Record<string, { min?: number, max?: number, unit?: string, log?: true }>} */
export const RANGES = {
  // filters: "audible between 0 and 20000", "resonance factor between 0 and 50"
  lpf: HZ,
  hpf: HZ,
  bpf: HZ,
  lpq: { min: 0, max: 50 },
  hpq: { min: 0, max: 50 },
  bpq: { min: 0 },
  // filter envelopes: depth "between 0 and n"; times in seconds; sustain an amplitude 0–1
  lpenv: { min: 0 },
  hpenv: { min: 0 },
  bpenv: { min: 0 },
  lpattack: SECONDS,
  lpdecay: SECONDS,
  lprelease: SECONDS,
  lpsustain: UNIT,
  hpattack: SECONDS,
  hpdecay: SECONDS,
  hprelease: SECONDS,
  hpsustain: UNIT,
  bpattack: SECONDS,
  bpdecay: SECONDS,
  bprelease: SECONDS,
  bpsustain: UNIT,
  fanchor: UNIT, // "center 0 to 1"
  djf: UNIT, // "below 0.5 is low pass filter, above is high pass filter"
  // amplitude envelope: "time in seconds", "sustain level between 0 and 1"
  attack: SECONDS,
  decay: SECONDS,
  release: SECONDS,
  sustain: UNIT,
  // levels
  gain: { min: 0, max: 1.5 }, // a multiplier (default 0.8); above ~1 it clips without a limiter
  velocity: UNIT, // "Sets the velocity from 0 to 1"
  postgain: { min: 0 },
  pan: UNIT, // "between 0 and 1, from left to right"
  // delay: "level between 0 and 1", "feedback between 0 and 1" (superdough caps it at 0.995)
  delay: UNIT,
  delayfeedback: UNIT,
  delayspeed: SECONDS, // superdough's delaytime (its alias): the delay length in seconds
  delaysync: { min: 0, unit: "cycles" }, // "delay length in cycles"
  // reverb
  room: UNIT, // "level between 0 and 1"
  roomsize: { min: 0, max: 10 }, // "size between 0 and 10"
  roomfade: SECONDS,
  roomlp: HZ, // "between 0 and 20000hz"
  roomdim: HZ,
  dry: UNIT, // "0 = wet, 1 = dry"
  irbegin: UNIT,
  // waveshaping and lo-fi
  crush: { min: 1, max: 16, unit: "bits" }, // "between 1 (drastic) to 16 (barely no reduction)"
  coarse: { min: 1 }, // "1 for original 2 for half, 3 for a third…" (superdough: max(1, coarse))
  shape: UNIT, // "distortion between 0 and 1"
  distort: { min: 0, max: 10 }, // "Most useful values are usually between 0 and 10"
  distortvol: { min: 0 }, // linear postgain
  // samples: "between 0 and 1, where 1 is the length of the sample"
  begin: UNIT,
  end: UNIT,
  loopBegin: UNIT,
  loopEnd: UNIT,
  clip: { min: 0 }, // "factor >= 0"
  duration: { min: 0, unit: "cycles" }, // "the duration of the event in cycles"
  n: { min: 0 }, // "sample index starting from 0"
  // amplitude modulation
  tremolo: { min: 0, unit: "Hz" }, // "modulation speed in HZ"
  tremolosync: { min: 0, unit: "cycles" },
  tremolodepth: UNIT, // superdough: gain = max(1 - depth, 0)
  tremoloskew: UNIT, // "between 0 & 1"
  tremolophase: { unit: "cycles" }, // "the offset in cycles"
  // vibrato, phaser, chorus, leslie
  vib: { min: 0, unit: "Hz" }, // "frequency of the vibrato in hertz"
  vibmod: { unit: "semitones" }, // "depth of vibrato (in semitones)"
  phaser: { min: 0, unit: "Hz" }, // "speed of modulation"
  phaserdepth: UNIT, // "number between 0 and 1"
  phasercenter: { min: 0, unit: "Hz" }, // "center frequency in HZ"
  phasersweep: { min: 0, max: 4000, unit: "Hz" }, // "most useful values are between 0 and 4000"
  chorus: UNIT, // "mix amount between 0 and 1"
  leslie: UNIT, // "wet between 0 and 1"
  lrate: { min: 0, unit: "Hz" }, // "6.7 for fast, 0.7 for slow"
  lsize: { min: 0, max: 1, unit: "m" }, // "meters somewhere between 0 and 1"
  // synthesis
  fm: { min: 0 }, // modulation index
  fmh: { min: 0 }, // harmonicity ratio
  fmattack: SECONDS,
  fmdecay: SECONDS,
  unison: { min: 1, max: 100 }, // superdough: clamp(unison, 1, 100)
  spread: UNIT, // "between 0 and 1" (superdough clamps it)
  wt: UNIT, // "Position in the wavetable from 0 to 1"
  warp: UNIT, // "Warp of the wavetable from 0 to 1"
  wtenv: UNIT,
  warpenv: UNIT,
  wtphaserand: UNIT,
  wtattack: SECONDS,
  wtdecay: SECONDS,
  wtrelease: SECONDS,
  wtsustain: UNIT, // "sustain level (0 to 1)"
  wtrate: { min: 0, unit: "Hz" }, // "rate in hertz"
  warpattack: SECONDS,
  warpdecay: SECONDS,
  warprelease: SECONDS,
  warpsustain: UNIT,
  // pitch envelope
  pattack: SECONDS,
  pdecay: SECONDS,
  prelease: SECONDS,
  penv: { unit: "semitones" }, // "change in semitones" (negative flips it)
  pcurve: UNIT, // "0 = linear, 1 = exponential"
  panchor: UNIT, // "anchor 0: [note, note + penv]; anchor 1: [note - penv, note]"
  // ducking (sidechain)
  duckdepth: UNIT, // "depth of modulation from 0 to 1"
  duckonset: SECONDS,
  duckattack: SECONDS,
  // pitch
  freq: HZ, // "the audible range is between 20 and 20000 Hz"
  // randomness: probabilities
  degradeBy: UNIT,
  undegradeBy: UNIT,
  sometimesBy: UNIT,
  someCyclesBy: UNIT,
  // MIDI: "(0-15)", "(0-127)", "(-1 - 1)", "(0-1)"
  midichan: { min: 0, max: 15 },
  ccn: { min: 0, max: 127 },
  ccv: { min: 0, max: 127 },
  nrpnn: { min: 0, max: 127 },
  nrpv: { min: 0, max: 127 },
  progNum: { min: 0, max: 127 },
  midibend: { min: -1, max: 1 },
  miditouch: UNIT,
};

/**
 * Every function's range: the curated ones, and each alias with its target's (followed through chains).
 * Throws on a key that isn't a function, is an alias, or is malformed.
 * @param {{ name: string, aliasOf?: string }[]} functions
 * @param {typeof RANGES} [ranges]
 * @returns {Record<string, { min?: number, max?: number, unit?: string, log?: true }>}
 */
export function buildRanges(functions, ranges = RANGES) {
  const byName = new Map(functions.map((f) => [f.name, f]));
  for (const [name, r] of Object.entries(ranges)) {
    const fn = byName.get(name);
    if (!fn) throw new Error(`ranges: "${name}" is not a function`);
    if (fn.aliasOf) throw new Error(`ranges: "${name}" is an alias of "${fn.aliasOf}": give the range to that`);
    if (r.min !== undefined && r.max !== undefined && !(r.min < r.max)) throw new Error(`ranges: "${name}" has min ≥ max`);
    if (r.log && !(r.min > 0)) throw new Error(`ranges: "${name}" is log but its min isn't > 0`);
    if (r.min === undefined && r.max === undefined && r.unit === undefined) throw new Error(`ranges: "${name}" says nothing`);
  }
  const target = (name, seen = new Set()) => {
    const to = byName.get(name)?.aliasOf;
    return to && byName.has(to) && !seen.has(to) ? target(to, seen.add(name)) : name;
  };
  const out = {};
  for (const { name } of functions) {
    const r = ranges[target(name)];
    if (r) out[name] = { ...r };
  }
  return out;
}
