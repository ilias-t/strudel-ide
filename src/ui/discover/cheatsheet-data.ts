// ═══════════════════════════════════════════════════════════════════════════
// The cheat sheet's pure parts: curated rows, links, families, search
// ═══════════════════════════════════════════════════════════════════════════
//
// No DOM, no engine: ./cheatsheet.ts renders what these return, and
// test/discover-cheatsheet.test.ts runs them in Node (every example evaluated
// headlessly, every link checked against the strudel.cc snapshot in
// scripts/lib/catalog/strudel-docs.json).
//
//   MINI              one row per mini-notation operator
//   FUNCTION_GROUPS   ~60 core functions in eight groups, one sentence and a
//                     literal example each; `library` is the functions.json
//                     category the group's "more" opens in the library
//   functionRows()    those, joined with completions.json's optional range,
//                     docUrl and synonyms (absent until the catalog has them:
//                     the curated link is the fallback)
//   soundFamilies()   sounds.json as families: drums by kind, instruments,
//                     synths, fx, then the drum machines
//   searchSheet()     every tab and the intent table at once: intents first,
//                     then each tab's rows, best first. Every word of the
//                     query must match (name, symbol, synonym, phrase, or a
//                     word of the text by prefix)
//
// Examples are string literals only (they light up in the editor once
// inserted) and pass previewable(), so ▶ can play each one.

import type { CompletionMeta } from "../complete/types.ts";
import type { CompletionsCatalog, Intent, IntentsCatalog, SoundsCatalog } from "./catalog.ts";
import { soundAudition } from "./library-data.ts";

export type SheetTab = "mini" | "functions" | "sounds" | "keys";

export const TABS: readonly { id: SheetTab; label: string }[] = [
  { id: "mini", label: "Mini-notation" },
  { id: "functions", label: "Functions" },
  { id: "sounds", label: "Sounds" },
  { id: "keys", label: "Keys" },
];

export const DOCS_BASE = "https://strudel.cc";

/** A strudel.cc page (a key of strudel-docs.json's pages) and one of its heading anchors */
export interface DocLink {
  page: string;
  anchor?: string;
}

export function docHref(link: DocLink): string {
  return `${DOCS_BASE}${link.page}${link.anchor ? `#${link.anchor}` : ""}`;
}

const MN = "/learn/mini-notation/";

// ── mini-notation ──────────────────────────────────────────────────────────

export interface MiniRow {
  id: string;
  /** As shown: "[ ]", "*", "(3,8)" */
  symbol: string;
  name: string;
  meaning: string;
  example: string;
  doc: DocLink;
}

export const MINI: readonly MiniRow[] = [
  { id: "sequence", symbol: "␣", name: "sequence", meaning: "Steps split the cycle evenly: four words, four quarter notes.", example: 's("bd hh sd hh")', doc: { page: MN, anchor: "sequences-of-events-in-a-cycle" } },
  { id: "rest", symbol: "~", name: "rest", meaning: "A silent step (so is -).", example: 's("bd ~ sd ~")', doc: { page: MN, anchor: "rests" } },
  { id: "subdivide", symbol: "[ ]", name: "subdivide", meaning: "Squeeze a group into one step.", example: 's("bd [sd sd]")', doc: { page: MN, anchor: "subdividing-time-with-bracket-nesting" } },
  { id: "group", symbol: ".", name: "group", meaning: "Split into equal groups without brackets: a . b = [a] [b].", example: 's("bd sd . hh hh hh")', doc: { page: MN, anchor: "subdividing-time-with-bracket-nesting" } },
  { id: "alternate", symbol: "< >", name: "alternate", meaning: "One per cycle, taking turns.", example: 's("bd <sd cp>")', doc: { page: MN, anchor: "angle-brackets" } },
  { id: "stack", symbol: ",", name: "stack", meaning: "Play at the same time: chords, layers.", example: 'note("[c3,e3,g3]")', doc: { page: MN, anchor: "parallel--polyphony" } },
  { id: "polymeter", symbol: "{ }", name: "polymeter", meaning: "Layers keep the first one's step length, so they drift against it.", example: 's("{bd sd, hh hh hh}")', doc: { page: "/learn/factories/", anchor: "polymeter" } },
  { id: "faster", symbol: "*", name: "faster", meaning: "Repeat a step n times within it.", example: 's("hh*8")', doc: { page: MN, anchor: "multiplication" } },
  { id: "slower", symbol: "/", name: "slower", meaning: "Stretch a step over n cycles.", example: 'note("[c3 e3 g3 b3]/2")', doc: { page: MN, anchor: "division" } },
  { id: "replicate", symbol: "!", name: "replicate", meaning: "Repeat a step as extra steps (the cycle gets more steps).", example: 's("bd!3 sd")', doc: { page: MN, anchor: "replication" } },
  { id: "elongate", symbol: "@", name: "elongate", meaning: "Give a step n times the weight of the others.", example: 'note("c3@3 e3")', doc: { page: MN, anchor: "elongation" } },
  { id: "hold", symbol: "_", name: "hold", meaning: "Carry the step before on through this one.", example: 'note("c3 _ _ e3")', doc: { page: MN, anchor: "elongation" } },
  { id: "maybe", symbol: "?", name: "maybe", meaning: "Drop the step half the time (?0.2: a fifth of the time).", example: 's("hh*8?")', doc: { page: MN, anchor: "randomness" } },
  { id: "choice", symbol: "|", name: "random choice", meaning: "Pick one of the options each cycle.", example: 's("bd [sd|cp|rim]")', doc: { page: MN, anchor: "randomness" } },
  { id: "variant", symbol: ":", name: "variant", meaning: "Which file of a sound: hh:0, hh:1, …", example: 's("hh:0 hh:1 hh:2 hh:3")', doc: { page: "/learn/samples/", anchor: "selecting-sounds" } },
  { id: "euclid", symbol: "(3,8)", name: "euclid", meaning: "k hits spread over n steps (a third number rotates).", example: 's("bd(3,8)")', doc: { page: MN, anchor: "euclidian-rhythms" } },
];

// ── functions ──────────────────────────────────────────────────────────────

export interface FnEntry {
  name: string;
  /** One sentence */
  text: string;
  example: string;
  doc?: DocLink;
  /** Shown without a dot: a signal or a factory, not a method */
  value?: true;
}

export interface FnGroup {
  id: string;
  label: string;
  /** functions.json category the group's "more" opens in the library */
  library: string;
  fns: FnEntry[];
}

const TIME = "/learn/time-modifiers/";
const COND = "/learn/conditional-modifiers/";
const TONAL = "/learn/tonal/";
const SAMPLES = "/learn/samples/";
const FX = "/learn/effects/";
const SIGNALS = "/learn/signals/";
const RANDOM = "/learn/random-modifiers/";
const VALUES = "/functions/value-modifiers/";

export const FUNCTION_GROUPS: readonly FnGroup[] = [
  {
    id: "rhythm",
    label: "Rhythm",
    library: "time",
    fns: [
      { name: "fast", text: "Speed up: 2 plays the pattern twice per cycle.", example: 's("bd sd").fast(2)', doc: { page: TIME, anchor: "fast" } },
      { name: "slow", text: "Slow down: 2 stretches the pattern over two cycles.", example: 'note("c3 e3 g3 b3").slow(2)', doc: { page: TIME, anchor: "slow" } },
      { name: "ply", text: "Repeat each event n times inside its own step.", example: 's("bd sd").ply(2)', doc: { page: TIME, anchor: "ply" } },
      { name: "euclid", text: "Spread k hits over n steps as evenly as possible.", example: 's("bd").euclid(3, 8)', doc: { page: TIME, anchor: "euclid" } },
      { name: "struct", text: "Play on the x steps of a rhythm, silent on the ~ ones.", example: 's("cp").struct("x ~ x x ~ x ~ ~")', doc: { page: COND, anchor: "struct" } },
      { name: "mask", text: "Silence the steps where the mask is 0.", example: 's("hh*8").mask("1 0 1 1")', doc: { page: COND, anchor: "mask" } },
      { name: "rev", text: "Play each cycle backwards.", example: 'note("c3 d3 e3 g3").rev()', doc: { page: TIME, anchor: "rev" } },
      { name: "iter", text: "Start one step later each cycle, wrapping around.", example: 'note("c3 d3 e3 g3").iter(4)', doc: { page: TIME, anchor: "iter" } },
      { name: "off", text: "Layer a copy shifted in time and changed by a function.", example: 'note("c3 e3").off(0.125, (x) => x.add(note(12)))', doc: { page: "/learn/accumulation/", anchor: "off" } },
      { name: "swingBy", text: "Push every second step of n late by x of a step: shuffle.", example: 's("hh*8").swingBy(0.3, 4)', doc: { page: TIME, anchor: "swingby" } },
      { name: "late", text: "Shift the pattern later by a fraction of a cycle.", example: 's("bd sd").late(0.125)', doc: { page: TIME, anchor: "late" } },
      { name: "chunk", text: "Change one of n parts of the cycle, a different part each cycle.", example: 'note("c3 d3 e3 g3").chunk(4, (x) => x.add(note(7)))', doc: { page: COND, anchor: "chunk" } },
      { name: "firstOf", text: "Change the pattern on the first of every n cycles.", example: 's("bd sd").firstOf(4, (x) => x.fast(2))', doc: { page: COND, anchor: "firstof" } },
    ],
  },
  {
    id: "pitch",
    label: "Pitch",
    library: "pitch",
    fns: [
      { name: "note", text: "Play pitches: names like c3 and eb4, or MIDI numbers.", example: 'note("c3 e3 g3 b3")', doc: { page: "/understand/pitch/" } },
      { name: "n", text: "A number: the degree with scale(), else which file of a sound.", example: 'n("0 2 4 7").scale("C:minor")', doc: { page: TONAL } },
      { name: "scale", text: "Turn n numbers into the notes of a scale (root:mode).", example: 'n("0 1 2 3 4 5 6 7").scale("D:dorian")', doc: { page: TONAL, anchor: "scalename" } },
      { name: "transpose", text: "Shift notes by semitones.", example: 'note("c3 e3 g3").transpose("<0 5 7>")', doc: { page: TONAL, anchor: "transposesemitones" } },
      { name: "add", text: "Add to the numbers in a pattern, step by step.", example: 'n("0 2 4").add("<0 3>").scale("C:minor")', doc: { page: VALUES, anchor: "add" } },
      { name: "voicing", text: "Voice chord symbols as notes that move smoothly.", example: 'chord("<C Am F G>").voicing()', doc: { page: TONAL, anchor: "voicing" } },
      { name: "arp", text: "Play a chord's notes one at a time, in the order given.", example: 'note("<[c3,e3,g3] [a2,c3,e3]>").arp("0 1 2 1")', doc: { page: COND, anchor: "arp" } },
    ],
  },
  {
    id: "sound",
    label: "Sound",
    library: "sound",
    fns: [
      { name: "s", text: "Choose the sound: a sample name or a synth.", example: 's("bd hh sd hh")', doc: { page: SAMPLES } },
      { name: "bank", text: "Play the drums of one drum machine.", example: 's("bd sd hh*2").bank("RolandTR909")', doc: { page: SAMPLES, anchor: "sound-banks" } },
      { name: "speed", text: "Playback rate: 2 is an octave up, negative plays backwards.", example: 's("bd*4").speed("<1 2 -1>")', doc: { page: SAMPLES, anchor: "speed" } },
      { name: "begin", text: "Start the sample part-way in: 0 to 1 of its length.", example: 's("brk").begin(0.25)', doc: { page: SAMPLES, anchor: "begin" } },
      { name: "end", text: "Stop the sample early: 0 to 1 of its length.", example: 's("brk").end(0.5)', doc: { page: SAMPLES, anchor: "end" } },
      { name: "clip", text: "Cut each note to its step's length (times x).", example: 'note("c3 e3 g3").s("piano").clip(0.5)', doc: { page: SAMPLES, anchor: "clip" } },
      { name: "chop", text: "Cut each sample into n parts played in order.", example: 's("brk").chop(8)', doc: { page: SAMPLES, anchor: "chop" } },
      { name: "slice", text: "Cut a sample into n slices and play them by index.", example: 's("brk").slice(8, "0 3 2 7")', doc: { page: SAMPLES, anchor: "slice" } },
      { name: "loopAt", text: "Fit a sample to n cycles.", example: 's("brk").loopAt(2).chop(8)', doc: { page: SAMPLES, anchor: "loopat" } },
      { name: "crush", text: "Bit crusher: 16 is clean, 1 is harsh.", example: 's("bd sd").crush(4)', doc: { page: FX, anchor: "crush" } },
      { name: "coarse", text: "Lower the sample rate: higher is grittier.", example: 's("hh*8").coarse(8)', doc: { page: FX, anchor: "coarse" } },
      { name: "distort", text: "Waveshaping distortion: drive it harder for more grit.", example: 'note("c2*4").s("sawtooth").distort(2).gain(0.5)', doc: { page: FX, anchor: "distort" } },
    ],
  },
  {
    id: "filter",
    label: "Filter",
    library: "effects",
    fns: [
      { name: "lpf", text: "Low-pass filter: cuts what's above the cutoff frequency.", example: 'note("c2 c3").s("sawtooth").lpf(800)', doc: { page: FX, anchor: "lpf" } },
      { name: "lpq", text: "Resonance at the low-pass cutoff.", example: 'note("c2*4").s("sawtooth").lpf(600).lpq(10)', doc: { page: FX, anchor: "lpq" } },
      { name: "hpf", text: "High-pass filter: cuts what's below the cutoff frequency.", example: 's("bd sd hh*2").hpf(1000)', doc: { page: FX, anchor: "hpf" } },
      { name: "bpf", text: "Band-pass filter: keeps a band around the frequency.", example: 's("hh*8").bpf(3000)', doc: { page: FX, anchor: "bpf" } },
      { name: "lpenv", text: "How far the filter envelope opens the low-pass.", example: 'note("c2*4").s("sawtooth").lpf(300).lpenv(4)', doc: { page: FX, anchor: "lpenv" } },
      { name: "vowel", text: "Formant filter: makes a sound say a, e, i, o or u.", example: 'note("c3*4").s("sawtooth").vowel("<a e i o>")', doc: { page: FX, anchor: "vowel" } },
    ],
  },
  {
    id: "space",
    label: "Space",
    library: "effects",
    fns: [
      { name: "room", text: "Reverb: how much of the sound goes into the room.", example: 's("cp").room(0.6)', doc: { page: FX, anchor: "room" } },
      { name: "size", text: "How big the reverb's room is.", example: 's("cp").room(0.5).size(4)', doc: { page: FX, anchor: "roomsize" } },
      { name: "delay", text: "Echo: how much of the sound goes into the delay.", example: 's("cp ~ ~ ~").delay(0.5)', doc: { page: FX, anchor: "delay-1" } },
      { name: "delaytime", text: "Time between echoes.", example: 's("cp ~ ~ ~").delay(0.5).delaytime(0.375)', doc: { page: FX, anchor: "delaytime" } },
      { name: "delayfeedback", text: "How much each echo feeds the next: keep it below 1.", example: 's("cp ~ ~ ~").delay(0.5).delayfeedback(0.6)', doc: { page: FX, anchor: "delayfeedback" } },
      { name: "pan", text: "Stereo position: 0 is left, 0.5 the middle, 1 right.", example: 's("hh*8").pan("0 1")', doc: { page: FX, anchor: "pan" } },
      { name: "jux", text: "Play a changed copy in the right speaker, the original in the left.", example: 's("bd sd hh cp").jux(rev)', doc: { page: FX, anchor: "jux" } },
    ],
  },
  {
    id: "dynamics",
    label: "Dynamics",
    library: "dynamics",
    fns: [
      { name: "gain", text: "Level: 1 leaves it, lower is quieter (a curve, not dB).", example: 's("hh*8").gain("1 0.5 0.7 0.5")', doc: { page: FX, anchor: "gain" } },
      { name: "velocity", text: "Per-note level from 0 to 1, multiplied with gain.", example: 's("hh*8").velocity("1 0.4")', doc: { page: FX, anchor: "velocity" } },
      { name: "postgain", text: "Level after the effects: where songs keep their mix.", example: 's("bd sd").postgain(0.8)', doc: { page: FX, anchor: "postgain" } },
      { name: "attack", text: "Fade-in time, in seconds.", example: 'note("c3 e3").s("sawtooth").attack(0.1)', doc: { page: FX, anchor: "attack" } },
      { name: "decay", text: "Time to fall from the peak to the sustain level, in seconds.", example: 'note("c3*4").s("sawtooth").decay(0.1).sustain(0)', doc: { page: FX, anchor: "decay" } },
      { name: "sustain", text: "Level held while the note lasts, 0 to 1.", example: 'note("c3*4").s("sawtooth").sustain(0.3)', doc: { page: FX, anchor: "sustain" } },
      { name: "release", text: "Fade-out after the note ends, in seconds.", example: 'note("c3 g3").s("triangle").release(0.5)', doc: { page: FX, anchor: "release" } },
      { name: "adsr", text: "Attack, decay, sustain and release at once.", example: 'note("c3 e3").s("sawtooth").adsr("0.01:0.2:0.5:0.3")', doc: { page: FX, anchor: "adsr" } },
    ],
  },
  {
    id: "modulation",
    label: "Modulation",
    library: "signals",
    fns: [
      { name: "sine", text: "A smooth wave from 0 to 1 and back over each cycle.", example: 's("hh*16").gain(sine)', doc: { page: SIGNALS, anchor: "sine" }, value: true },
      { name: "saw", text: "A ramp from 0 up to 1 over each cycle.", example: 'note("c2*8").s("sawtooth").lpf(saw.range(300, 3000))', doc: { page: SIGNALS, anchor: "saw" }, value: true },
      { name: "square", text: "Jumps between 0 and 1 each half cycle.", example: 's("hh*8").pan(square)', doc: { page: SIGNALS, anchor: "square" }, value: true },
      { name: "perlin", text: "Smooth random wandering between 0 and 1.", example: 's("hh*8").lpf(perlin.range(1000, 6000))', doc: { page: SIGNALS, anchor: "perlin" }, value: true },
      { name: "range", text: "Scale a 0–1 signal to a min and a max.", example: 'note("c2*8").s("sawtooth").lpf(sine.slow(4).range(200, 2000))', doc: { page: VALUES, anchor: "range" } },
      { name: "segment", text: "Sample a signal n times per cycle, making steps.", example: 'note(saw.range(48, 60).segment(8).round())', doc: { page: TIME, anchor: "segment" } },
    ],
  },
  {
    id: "randomness",
    label: "Randomness",
    library: "randomness",
    fns: [
      { name: "rand", text: "A random value from 0 to 1 for each event.", example: 's("hh*8").gain(rand)', doc: { page: SIGNALS, anchor: "rand" }, value: true },
      { name: "irand", text: "A random whole number from 0 to n - 1.", example: 'n(irand(8).segment(8)).scale("C:minor")', doc: { page: SIGNALS, anchor: "irand" }, value: true },
      { name: "choose", text: "Pick values at random from a list.", example: 'note(choose(48, 51, 55).segment(4))', doc: { page: RANDOM, anchor: "choose" }, value: true },
      { name: "degradeBy", text: "Drop events at random: 0.5 drops about half.", example: 's("hh*16").degradeBy(0.5)', doc: { page: RANDOM, anchor: "degradeby" } },
      { name: "sometimes", text: "Apply a function to about half the events.", example: 's("hh*8").sometimes((x) => x.speed(2))', doc: { page: RANDOM, anchor: "sometimes" } },
      { name: "rarely", text: "Apply a function to about a quarter of the events.", example: 's("hh*8").rarely((x) => x.crush(4))', doc: { page: RANDOM, anchor: "rarely" } },
      { name: "shuffle", text: "Play the n parts of each cycle in a random order, each once.", example: 'note("c3 d3 e3 g3").shuffle(4)' },
    ],
  },
];

export interface FnRow extends FnEntry {
  /** FnGroup id */
  group: string;
  /** ".lpf", or "sine" for a value */
  display: string;
  /** "20–20000 Hz" (from completions.json, when it has one) */
  range?: string;
  /** strudel.cc: the catalog's docUrl, else the curated link */
  href?: string;
  /** Other names that find it (from completions.json) */
  synonyms: string[];
}

/** "0–1", "20–20000 Hz", "≥ 0" */
export function formatRange(r: CompletionMeta["range"] | undefined): string | undefined {
  if (!r) return undefined;
  const unit = r.unit ? ` ${r.unit}` : "";
  const has = (x: number | undefined): x is number => typeof x === "number" && Number.isFinite(x);
  if (has(r.min) && has(r.max)) return `${r.min}–${r.max}${unit}`;
  if (has(r.min)) return `≥ ${r.min}${unit}`;
  if (has(r.max)) return `≤ ${r.max}${unit}`;
  return undefined;
}

/** A catalog docUrl as a link: relative ones are on strudel.cc; anything else isn't trusted */
function absoluteDoc(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("/")) return `${DOCS_BASE}${url}`;
  return url.startsWith(`${DOCS_BASE}/`) ? url : undefined;
}

/** Every curated function, in group order, with what the catalog adds */
export function functionRows(completions: CompletionsCatalog | null | undefined): FnRow[] {
  const rows: FnRow[] = [];
  for (const g of FUNCTION_GROUPS) {
    for (const f of g.fns) {
      const meta = completions?.functions[f.name];
      const href = absoluteDoc(meta?.docUrl) ?? (f.doc ? docHref(f.doc) : undefined);
      rows.push({
        ...f,
        group: g.id,
        display: f.value ? f.name : `.${f.name}`,
        ...(formatRange(meta?.range) ? { range: formatRange(meta?.range) } : {}),
        ...(href ? { href } : {}),
        synonyms: meta?.synonyms ?? [],
      });
    }
  }
  return rows;
}

// ── sounds ─────────────────────────────────────────────────────────────────

export interface SoundItem {
  /** A sound, or a drum machine (a bank) */
  name: string;
  /** auditionSound(play.name, play.opts) */
  play: { name: string; opts: { bank?: string; pitched?: boolean } };
  /** Other names that find it: a machine's aliases */
  alts?: string[];
}

export interface SoundFamily {
  /** A kind id (kick, keys, synth…), or "banks" */
  id: string;
  label: string;
  /** The group's label: "Drums", "Instruments", "Synths", "FX", "Drum machines" */
  section: string;
  items: SoundItem[];
  /** Where "in the library" goes */
  library: { tab: "sounds"; query: string };
}

/** Every kind of sound.json as a family, then the drum machines */
export function soundFamilies(cat: SoundsCatalog): SoundFamily[] {
  const out: SoundFamily[] = [];
  for (const g of cat.groups) {
    for (const k of g.kinds) {
      out.push({
        id: k.id,
        label: k.label,
        section: g.label,
        items: k.sounds.map((name) => {
          const info = cat.sounds[name];
          return { name, play: info ? soundAudition(name, info) : { name, opts: {} } };
        }),
        library: { tab: "sounds", query: k.id },
      });
    }
  }
  out.push({
    id: "banks",
    label: "Drum machines",
    section: "Drum machines",
    items: Object.entries(cat.banks).map(([name, bank]) => ({
      name,
      play: { name: bank.parts.includes("bd") ? "bd" : (bank.parts[0] ?? "bd"), opts: { bank: name } },
      ...(bank.aliases.length ? { alts: bank.aliases } : {}),
    })),
    library: { tab: "sounds", query: "" },
  });
  return out;
}

// ── keys ───────────────────────────────────────────────────────────────────

/** One row of the Keys card (read from index.html's #help-keys) */
export interface KeyRow {
  keys: string;
  what: string;
}

// ── search ─────────────────────────────────────────────────────────────────

export interface SheetIndex {
  mini: readonly MiniRow[];
  functions: FnRow[];
  /** Every sound and machine, with its family's label */
  sounds: (SoundItem & { family: string })[];
  intents: Intent[];
  keys: KeyRow[];
}

export function buildIndex({
  completions,
  sounds,
  intents,
  keys,
}: {
  completions: CompletionsCatalog | null;
  sounds: SoundsCatalog | null;
  intents: IntentsCatalog | null;
  keys: KeyRow[];
}): SheetIndex {
  return {
    mini: MINI,
    functions: functionRows(completions),
    sounds: sounds ? soundFamilies(sounds).flatMap((f) => f.items.map((i) => ({ ...i, family: f.label }))) : [],
    intents: intents?.intents ?? [],
    keys,
  };
}

export interface SearchResult {
  intents: Intent[];
  mini: MiniRow[];
  functions: FnRow[];
  sounds: (SoundItem & { family: string })[];
  keys: KeyRow[];
  total: number;
}

/** Results per block at most (sounds are many: narrow the search for more) */
export const SOUND_LIMIT = 40;

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** How well one query term fits a field: exact 100, prefix 80, inside 50 (names only), 0 */
function fit(term: string, field: string, inside = false): number {
  const f = field.toLowerCase();
  if (f === term) return 100;
  if (f.startsWith(term)) return 80;
  return inside && f.includes(term) ? 50 : 0;
}

/** A term in running text: a word that starts with it */
const inText = (term: string, text: string, worth: number) => (words(text).some((w) => w.startsWith(term)) ? worth : 0);

/** Every term must fit somewhere; the sum of each term's best fit, 0 if one doesn't */
function score(terms: string[], best: (term: string) => number): number {
  let total = 0;
  for (const t of terms) {
    const s = best(t);
    if (!s) return 0;
    total += s;
  }
  return total;
}

function ranked<T>(items: readonly T[], terms: string[], best: (item: T, term: string) => number, limit = Infinity): T[] {
  const found: { item: T; s: number; i: number }[] = [];
  items.forEach((item, i) => {
    const s = score(terms, (t) => best(item, t));
    if (s) found.push({ item, s, i });
  });
  found.sort((a, b) => b.s - a.s || a.i - b.i);
  return found.slice(0, limit).map((f) => f.item);
}

/** Search every tab and the intent table. An empty query finds nothing */
export function searchSheet(index: SheetIndex, query: string): SearchResult {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { intents: [], mini: [], functions: [], sounds: [], keys: [], total: 0 };
  const q = terms.join(" ");

  const intents = ranked(index.intents, [q], (it) =>
    Math.max(
      fit(q, it.id),
      ...it.phrases.map((p) => {
        const exact = fit(q, p);
        if (exact) return exact;
        // every term starts a word of the phrase: "more rev" → "more reverb"
        const pw = words(p);
        return terms.every((t) => pw.some((w) => w.startsWith(t))) ? 60 : 0;
      })
    )
  );

  // the functions a matching intent names come along, after the direct matches
  const fromIntents = new Set(intents.flatMap((it) => it.functions));
  const functions = ranked(index.functions, terms, (f, t) =>
    Math.max(
      fit(t, f.name, true),
      ...f.synonyms.map((s) => fit(t, s) * 0.9),
      inText(t, f.text, 20),
      fromIntents.has(f.name) ? 10 : 0
    )
  );

  const mini = ranked(index.mini, terms, (r, t) =>
    Math.max(
      r.symbol.split(" ").includes(t) || r.symbol === t ? 100 : 0,
      fit(t, r.name),
      ...words(r.name).map((w) => fit(t, w)),
      inText(t, r.meaning, 20)
    )
  );

  const sounds = ranked(
    index.sounds,
    terms,
    (s, t) => Math.max(fit(t, s.name, true), ...(s.alts ?? []).map((a) => fit(t, a, true) * 0.9), inText(t, s.family, 30)),
    SOUND_LIMIT
  );

  const keys = ranked(index.keys, terms, (k, t) => Math.max(k.keys.toLowerCase().includes(t) ? 60 : 0, inText(t, k.what, 20)));

  return { intents, mini, functions, sounds, keys, total: intents.length + mini.length + functions.length + sounds.length + keys.length };
}
