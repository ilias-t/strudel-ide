// theory.json: scales (with intervals), chord symbols, vowels and voicing dictionaries, for the
// editor's string completions and hovers (Theory in src/ui/complete/types.ts). Pure: inputs.mjs
// loads the data from what the app itself plays with (loadTheoryData):
//   scales        tonal's ScaleType.all() (what @strudel/tonal's scale() looks up), COMMON_SCALES first
//   chords        the symbols of @strudel/tonal's default voicing dictionary (voicingRegistry.ireal),
//                 each with tonal's ChordType intervals. iReal spellings tonal lacks go through
//                 CHORD_SPELLINGS; the few tonal has no chord for at all (-b6, 7susadd3, 7b13sus) get
//                 their first iReal voicing folded into one octave (10m → 3m, 13m → 6m), sorted.
//                 A symbol that resolves neither way fails the build.
//   vowels        superdough's vowelFormant letters (the 7 accessor aliases æ ø ɑ å ö ü ı left out)
//   voicingDicts  voicingRegistry's names, registry order

import { byCodePoint } from "./util.mjs";

/** The scales people reach for, in display order (each must be a tonal scale name) */
export const COMMON_SCALES = [
  "major",
  "minor",
  "dorian",
  "mixolydian",
  "phrygian",
  "lydian",
  "locrian",
  "harmonic minor",
  "melodic minor",
  "major pentatonic",
  "minor pentatonic",
  "minor blues",
  "major blues",
  "chromatic",
  "whole tone",
];

/** iReal spellings → the chord name tonal knows them by */
const CHORD_SPELLINGS = {
  M9: "maj9",
  M13: "maj13",
  "M9#11": "maj9#11",
  "M7#5": "maj7#5",
  "m^7": "mMaj7",
  "-M7": "mMaj7",
  "m^9": "mMaj9",
  "-M9": "mMaj9",
  "-add9": "madd9",
  h9: "m9b5",
};

const SEMITONES = { P: 0, M: 0, m: -1, A: 1, d: -1 };
const STEP = [0, 2, 4, 5, 7, 9, 11];

/** "10m" → "3m", "8P" → "1P": the same interval within one octave */
function simple(interval) {
  const m = interval.match(/^(\d+)([PMmAd])$/);
  if (!m) throw new Error(`theory: can't read interval ${interval}`);
  return `${((Number(m[1]) - 1) % 7) + 1}${m[2]}`;
}
const semis = (interval) => {
  const [, n, q] = interval.match(/^(\d+)([PMmAd])$/);
  const step = STEP[(Number(n) - 1) % 7];
  const perfect = [0, 5, 7].includes(step);
  return step + (perfect ? { P: 0, A: 1, d: -1 }[q] : SEMITONES[q]);
};

/**
 * @param {{ scaleTypes: { name: string, intervals: string[] }[], chordTypes: { name: string, aliases: string[], intervals: string[] }[],
 *   ireal: Record<string, string[]>, vowels: string[], voicingDicts: string[], commonScales?: string[] }} data
 * @returns {{ scales: { name: string, intervals: string[], common?: true }[], chords: Record<string, string[]>, vowels: string[], voicingDicts: string[] }}
 */
export function buildTheory({ scaleTypes, chordTypes, ireal, vowels, voicingDicts, commonScales = COMMON_SCALES }) {
  const byScale = new Map(scaleTypes.map((s) => [s.name, s]));
  for (const name of commonScales) if (!byScale.has(name)) throw new Error(`theory: common scale "${name}" is not a tonal scale`);
  const scales = [
    ...commonScales.map((name) => ({ name, intervals: [...byScale.get(name).intervals], common: /** @type {true} */ (true) })),
    ...scaleTypes
      .filter((s) => !commonScales.includes(s.name))
      .map((s) => ({ name: s.name, intervals: [...s.intervals] }))
      .sort((a, b) => byCodePoint(a.name, b.name)),
  ];

  const chordByAlias = new Map();
  // symbols first, then full names; tonal's unnamed types have name "" (not the "" symbol: major)
  for (const c of chordTypes) for (const a of c.aliases) if (!chordByAlias.has(a) && c.intervals.length) chordByAlias.set(a, c.intervals);
  for (const c of chordTypes) if (c.name && !chordByAlias.has(c.name) && c.intervals.length) chordByAlias.set(c.name, c.intervals);
  const chords = {};
  for (const [symbol, voicings] of Object.entries(ireal)) {
    const known = chordByAlias.get(symbol) ?? chordByAlias.get(CHORD_SPELLINGS[symbol]);
    if (known) {
      chords[symbol] = [...known];
      continue;
    }
    const first = voicings[0]?.trim().split(/\s+/);
    if (!first?.length) throw new Error(`theory: chord symbol "${symbol}" has no intervals`);
    const folded = [...new Set(first.map(simple))].sort((a, b) => semis(a) - semis(b));
    if (folded[0] !== "1P") folded.unshift("1P");
    chords[symbol] = folded;
  }

  return { scales, chords, vowels: [...vowels], voicingDicts: [...voicingDicts] };
}
