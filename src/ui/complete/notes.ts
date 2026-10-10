// ═══════════════════════════════════════════════════════════════════════════
// Note names, intervals, scales and chords: the little music math the editor's
// completions and hovers need (pure)
// ═══════════════════════════════════════════════════════════════════════════
//
// Strudel's note names (superdough's noteToMidi): a letter, any number of
// accidentals (# or s sharpen, b or f flatten) and an optional octave, 3 by
// default, so c3 = MIDI 48. Intervals are tonal's, as theory.json stores them:
// "1P", "3m", "4A", "5d", "9M" (number, then quality). No @tonaljs import: the
// spelling below is the few lines it takes.

const LETTERS = "CDEFGAB";
/** Semitones of each letter above C */
const NATURAL = [0, 2, 4, 5, 7, 9, 11];

export interface ParsedNote {
  /** Upper case: "C" … "B" */
  letter: string;
  /** −2 … +2: flats negative */
  accidentals: number;
  octave: number;
  /** The octave was written out ("c3", not "c") */
  hasOctave: boolean;
  midi: number;
}

const NOTE = /^([a-gA-G])([#sbf]*)(-?\d+)?$/;

/** "c3", "Eb", "f#2", "cs4" → its parts and MIDI number; null if it isn't a note name */
export function parseNote(name: string): ParsedNote | null {
  const m = NOTE.exec(name);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  let accidentals = 0;
  for (const c of m[2]) accidentals += c === "#" || c === "s" ? 1 : -1;
  const hasOctave = m[3] !== undefined;
  const octave = hasOctave ? Number(m[3]) : 3;
  const midi = (octave + 1) * 12 + NATURAL[LETTERS.indexOf(letter)] + accidentals;
  return { letter, accidentals, octave, hasOctave, midi };
}

/** Equal temperament, A4 = 440 Hz */
export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

const INTERVAL = /^(-?)(\d+)([PMmAd]+)$/;

/** Semitones of an interval: "3m" → 3, "5P" → 7, "4A" → 6, "9M" → 14; NaN if unreadable */
export function intervalSemitones(interval: string): number {
  const m = INTERVAL.exec(interval);
  if (!m) return NaN;
  const num = Number(m[2]);
  if (num < 1) return NaN;
  const step = (num - 1) % 7;
  const octaves = Math.floor((num - 1) / 7);
  const perfect = step === 0 || step === 3 || step === 4;
  let semis = NATURAL[step] + 12 * octaves;
  const q = m[3];
  if (perfect) {
    if (q[0] === "A") semis += q.length;
    else if (q[0] === "d") semis -= q.length;
    else if (q !== "P") return NaN;
  } else if (q === "m") semis -= 1;
  else if (q[0] === "A") semis += q.length;
  else if (q[0] === "d") semis -= 1 + q.length;
  else if (q !== "M") return NaN;
  return m[1] ? -semis : semis;
}

/** The letter steps an interval spans: "3m" → 2 */
function intervalSteps(interval: string): number {
  const m = INTERVAL.exec(interval);
  return m ? (Number(m[2]) - 1) % 7 : 0;
}

/** Spell the note `interval` above `root` (a name without octave): C + "3m" → Eb, D + "3M" → F# */
export function transpose(root: string, interval: string): string | null {
  const r = parseNote(root);
  const semis = intervalSemitones(interval);
  if (!r || Number.isNaN(semis)) return null;
  const letterIndex = (LETTERS.indexOf(r.letter) + intervalSteps(interval)) % 7;
  const letter = LETTERS[letterIndex];
  const target = (((NATURAL[LETTERS.indexOf(r.letter)] + r.accidentals + semis) % 12) + 12) % 12;
  let diff = (((target - NATURAL[letterIndex]) % 12) + 12) % 12;
  if (diff > 6) diff -= 12;
  return letter + (diff > 0 ? "#".repeat(diff) : "b".repeat(-diff));
}

/** A root's scale or chord, spelled: ("C", minor) → C D Eb F G Ab Bb */
export function spell(root: string, intervals: readonly string[]): string[] {
  const out: string[] = [];
  for (const i of intervals) {
    const n = transpose(root, i);
    if (n) out.push(n);
  }
  return out;
}

/** MIDI numbers from `root` up through `intervals` (root at octave 3 unless it says): for previews */
export function midiUp(root: string, intervals: readonly string[]): number[] {
  const r = parseNote(root);
  if (!r) return [];
  const out: number[] = [];
  for (const i of intervals) {
    const s = intervalSemitones(i);
    if (!Number.isNaN(s)) out.push(r.midi + s);
  }
  return out;
}

/** Roots as a scale or chord starts with them */
export const ROOTS = ["C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B"] as const;

/** Pitch classes as note() strings use them (lower case) */
export const PITCH_CLASSES = ROOTS.map((r) => r.toLowerCase());
