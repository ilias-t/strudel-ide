// ═══════════════════════════════════════════════════════════════════════════
// 🌆 NEON DRIVE — synthwave / outrun
// ═══════════════════════════════════════════════════════════════════════════
//
// Midnight, empty highway, pink grid on the horizon. F♯ minor at 104 BPM:
// gated-reverb LinnDrum snare, Simmons tom fills, octave-bouncing saw bass,
// sidechained supersaw pads, a 16th-note arp and a soaring vibrato lead.
// The last chorus does the classic "truck-driver" key change up a semitone.
//
// How it's built (worth reading before you tweak):
//   • FORM is the song map. Every part is written per section and laid out
//     on that map with `bySection()` (a thin wrapper around `arrange`).
//   • PROGRESSION holds chord *symbols*. Pads, bass and arp are all derived
//     from it (`voicing()`, `rootNotes()`), so changing a chord here
//     re-harmonizes the whole band at once.
//   • KEY_SHIFT transposes everything melodic per section — that's the lift.
//
// ═══════════════════════════════════════════════════════════════════════════

import type { Song } from ".";

// ─────────────────────────────────────────────────────────────────────────────
// 🎛️ KNOBS — safe to change while it plays
// ─────────────────────────────────────────────────────────────────────────────

const BPM = 104;
const TRANSPOSE = 0; // whole song in semitones: -4 = D minor, +3 = A minor
const LEAD_SCALE = "F#4:minor"; // melodies are scale degrees: 0 = F#4, 7 = F#5
const DRUMS = "LinnDrum"; // try "OberheimDMX" or "RolandTR707"
const TOMS = "SimmonsSDS5"; // the 80s "pew" toms

// Dotted-8th delay: the signature synthwave echo (¾ of a beat, in seconds)
const DOTTED_8TH = (60 / BPM) * 0.75;

// ─────────────────────────────────────────────────────────────────────────────
// 🗺️ FORM — section name + length in bars (1 cycle = 1 bar of 4/4)
// Keep lengths multiples of 8: the parts below are written in 8-bar phrases.
// ─────────────────────────────────────────────────────────────────────────────

type Section = "intro" | "verse" | "pre" | "chorus" | "breakdown" | "chorus2" | "lift" | "outro";

const FORM: [Section, number][] = [
  ["intro", 8], //      pads + arp fade in from the dark
  ["verse", 16], //     beat drops in, lead enters halfway
  ["pre", 8], //        snare roll + riser, everything climbs
  ["chorus", 16], //    four-on-the-floor, the hook
  ["breakdown", 8], //  drums out, half-time chords, echoing lead
  ["pre", 8], //        build again
  ["chorus2", 8], //    hook, last bar pivots to the new key's V chord
  ["lift", 8], //       KEY CHANGE +1 semitone, lead doubled an octave up
  ["outro", 8], //      drums drop, everything fades
]; // = 88 bars ≈ 3:23, then it loops

// ─────────────────────────────────────────────────────────────────────────────
// 🎼 HARMONY — chord symbols per section (one `<...>` step = one bar)
// F♯m–D–A–E is i–VI–III–VII; the chorus flips to the relative major's
// I–V–vi–IV (A–E–F♯m–D) for that big, open, "sunrise" feeling.
// ─────────────────────────────────────────────────────────────────────────────

const PROGRESSION: Record<Section, string> = {
  intro: "<F#m D A E>",
  verse: "<F#m D A E>",
  pre: "<Bm Bm D D E E E E>", // iv → VI → VII: E (= V of A) begs for the chorus
  chorus: "<A E F#m D>",
  breakdown: "<F#m D A E>/2", // same as the verse, half speed
  chorus2: "<A E F#m D A E F#m F>", // F = the V chord of B♭, the new key
  lift: "<A E F#m D>", // played +1 semitone: B♭ F Gm E♭
  outro: "<F#m D A E>", // +1 semitone too: Gm E♭ B♭ F
};

// Semitones added per section (on top of TRANSPOSE)
const KEY_SHIFT: Partial<Record<Section, number>> = { lift: 1, outro: 1 };

// ─────────────────────────────────────────────────────────────────────────────
// 🎤 MELODIES — scale degrees in LEAD_SCALE, one string per bar.
// `@n` stretches a note over n steps; "~" is a rest. Each bar = 8 eighths.
// ─────────────────────────────────────────────────────────────────────────────

// Verse: call (bars 1–2, falling) and response (bars 3–4, rising)
const VERSE = [
  "4@3 3 2@2 ~ 0", //  F#m: C# B A . F#
  "2@3 0 -2@3 ~", //   D:   A F# D
  "~ 2 4 6 4@4", //    A:   A C# E C#
  "3@2 1@2 -1@4", //   E:   B G# E
  "4@3 3 2@2 ~ 0",
  "2@3 0 -2@3 ~",
  "~ 2 4 6 9@4", //    reaches up to A5 the second time…
  "8@2 6@2 3@4", //    …and falls back G# E B
];

// Pre-chorus: arpeggios climbing an octave per chord
const PRE = [
  "3@2 5@2 7@4", //    Bm: B D F#
  "7@2 5@2 3@4",
  "5@2 7@2 9@4", //    D:  D F# A
  "9@2 7@2 5@4",
  "6@2 8@2 10@4", //   E:  E G# B
  "10@2 8@2 6@4",
  "6 8 10 8 6 8 10 11", // running 8ths…
  "13@4 ~@4", //       …up to E6, then a breath before the drop
];

// The hook: 3+3+2 "dotted" rhythm — the most 80s rhythm there is
const HOOK = [
  "4@3 6@3 9@2", //    A:   C# E A   (rising A major arpeggio)
  "8@3 6@3 3@2", //    E:   G# E B
  "4@3 2@3 0@2", //    F#m: C# A F#
  "2@4 ~ 0 2 5", //    D:   A … F# A D (pickup into the repeat)
  "4@3 6@3 9@2",
  "10@3 8@3 6@2", //   E:   B G# E   (answer, an octave higher)
  "9@3 7@3 4@2", //    F#m: A F# C#
  "5@6 ~@2", //        D:   long D, let the delay sing
];

// Breakdown: fragments of the hook, one bar on, one bar off (the delay fills the gaps)
const ECHO = [
  "4@3 2@3 0@2", "~", //   F#m
  "2@3 0@3 -2@2", "~", //  D
  "4@3 6@3 2@2", "~", //   A
  "3@3 1@3 -1@2", "~", //  E
];

const rest = (n: number) => Array<string>(n).fill("~");

// ─────────────────────────────────────────────────────────────────────────────
// 🧰 HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** ["a b", "c"] → "<[a b] [c]>": one bar per string */
const bars = (list: string[]) => `<${list.map((b) => `[${b}]`).join(" ")}>`;

/** Only on the last bar of an n-bar phrase: "<~ ~ ~ [fill]>" */
const lastBar = (n: number, fill: string) => `<~!${n - 1} [${fill}]>`;

/**
 * Lay per-section parts out along FORM (silent where a section isn't listed).
 * Each part starts from its own bar 1 whenever its section begins — this is
 * Strudel's `arrange([bars, pattern], ...)` under the hood.
 */
const bySection = (
  parts: Partial<Record<Section, Pattern | string | number>>,
  otherwise: Pattern | string | number = "~"
): Pattern => arrange(...FORM.map(([name, n]): [number, Pattern] => [n, reify(parts[name] ?? otherwise)]));

/** 1 while any of the given sections plays, nothing otherwise — use with .mask() */
const during = (...names: Section[]) => bySection(Object.fromEntries(names.map((name) => [name, 1])));

const song: Song = {
  name: "Neon Drive",
  bpm: BPM,
  visualization: { type: "pianoroll", options: { cycles: 8, labels: false } },

  createPattern() {
    // Song-long timelines everything else hangs off
    const progression = bySection(PROGRESSION); // "F#m", "D", … one per bar
    const chords: Pattern = chord(progression); // as {chord} values, ready for voicing()
    const keyShift = bySection(KEY_SHIFT, 0).add(TRANSPOSE);
    // Outro fade: velocity multiplies gain, ramping 1 → 0 over the last 8 bars
    const fade = bySection({ outro: saw.range(1, 0).slow(8) }, 1);

    // ─────────────────────────────────────────────────────────────────────────
    // 🥁 DRUMS — LinnDrum, the sound of 1982
    // ─────────────────────────────────────────────────────────────────────────

    // Kick: half-time in the verse, four-on-the-floor in the choruses.
    // Every kick also *ducks* orbit 3 (the pads) — sidechain pumping without
    // a compressor: `duckorbit` dips that bus's volume, `duckattack` is how
    // fast it swells back.
    const kick = bySection({
      verse: s("[bd ~ ~ ~] [~ ~ ~ ~] [bd ~ bd ~] [~ ~ ~ ~]"),
      pre: s("<[bd*4]!6 [bd*8]!2>"), // doubles up for the last 2 bars
      chorus: s("bd*4"),
      chorus2: s("<[bd*4]!7 [bd ~ ~ ~]>"), // drops out for the pivot fill
      lift: s("bd*4"),
      outro: s("<[bd*4]!4 ~!4>"),
    })
      .bank(DRUMS)
      .gain(0.95)
      .duckorbit(3)
      .duckattack(0.22)
      .duckdepth(0.55);

    // Snare on 2 & 4 — with GATED REVERB, the Phil Collins move: a big,
    // dense room that's cut off abruptly. Here: a very short reverb
    // (rsize 0.45 s) on its own orbit, plus a burst of white noise that
    // decays fast — that "chhh" is the gate slamming shut.
    const snareHits = bySection({
      verse: s("~ sd ~ sd"),
      pre: s("<[~ sd ~ sd]!6 [sd*8] [sd*16]>"), // snare roll into the chorus
      chorus: s("~ sd ~ sd"),
      chorus2: s("<[~ sd ~ sd]!7 ~>"),
      lift: s("~ sd ~ sd"),
      outro: s("<[~ sd ~ sd]!4 ~!4>"),
    });
    const rollUp = bySection({ pre: saw.range(0.55, 1).slow(8) }, 1); // crescendo
    const snare = stack(
      snareHits.bank(DRUMS).gain(0.75),
      snareHits.s("white").decay(0.2).sustain(0).hpf(1800).lpf(7000).gain(0.16) // the gate
    )
      .velocity(rollUp)
      .room(0.55)
      .rsize(0.45)
      .orbit(2);

    // Hats: 8ths → 16ths → 16ths with an open hat on every off-beat.
    // One accent shape on the 16th grid works for all of them: strong on
    // the beat, medium on the "and" (where the open hat sits), soft between.
    const CHORUS_HATS = "[hh hh oh hh]*4";
    const accent = reify("[1 0.45 0.75 0.45]*4");
    const hats = bySection({
      intro: s("<~!4 [hh*8]!4>").gain(0.25), // creeps in for the last 4 bars
      verse: s("hh*8").gain(0.4),
      pre: s("hh*16").gain(0.4),
      chorus: s(CHORUS_HATS).gain(0.4),
      chorus2: s(`<[${CHORUS_HATS}]!7 ~>`).gain(0.4),
      lift: s(CHORUS_HATS).gain(0.42),
      outro: s("<[hh*8]!4 ~!4>").gain(0.35),
    })
      .bank(DRUMS)
      .velocity(accent.mul(perlin.range(0.8, 1))) // …plus a little drift: a drummer, not a metronome
      .hpf(3000)
      .pan(sine.range(0.4, 0.6).fast(2));

    // Toms: Simmons fills on the last bar of a phrase, through the same gated room
    const FILL = "~@2 [ht ht mt mt] [lt lt lt lt]"; // last 2 beats, 16ths, down the kit
    const PICKUP = "~@3 [ht mt lt lt]"; // just the last beat
    const PIVOT = "[ht ht ht ht] [mt mt mt mt] [lt lt lt lt] [lt lt mt ht]"; // a whole bar!
    const toms = bySection({
      intro: s(lastBar(8, FILL)),
      verse: s(`<~!7 [${PICKUP}] ~!7 [${FILL}]>`),
      chorus: s(`<~!7 [${PICKUP}] ~!7 [${FILL}]>`),
      breakdown: s(lastBar(8, FILL)),
      chorus2: s(lastBar(8, PIVOT)), // the drum break that carries us into the new key
      lift: s(lastBar(8, PICKUP)),
    })
      .bank(TOMS)
      .gain(0.6)
      .velocity(saw.range(0.7, 1)) // each fill builds through the bar
      .room(0.55)
      .rsize(0.45)
      .orbit(2);

    // Crash on the downbeat of every big section
    const crash = bySection({
      verse: s("<cr ~!15>"),
      chorus: s("<cr ~!7>"),
      breakdown: s("<cr ~!7>"),
      chorus2: s("<cr ~!7>"),
      lift: s("<cr ~!7>"),
      outro: s("<cr ~!7>"),
    })
      .bank(DRUMS)
      .gain(0.4);

    // ─────────────────────────────────────────────────────────────────────────
    // 🎸 BASS — the engine: driving 8ths, bouncing between root and octave
    // ─────────────────────────────────────────────────────────────────────────

    // rootNotes(1) turns each chord symbol into its root in octave 1;
    // struct() gives it a rhythm per section; transpose("[0 12]*4") makes
    // every other 8th jump up an octave (in the pre's 16ths: root-root-oct-oct).
    const bass = chords
      .rootNotes(1)
      .struct(
        bySection({
          verse: "x*8",
          pre: "x*16",
          chorus: "x*8",
          chorus2: "<[x*8]!7 [x ~ ~ ~]>",
          lift: "x*8",
          outro: "<[x*8]!4 ~!4>",
        })
      )
      .transpose("[0 12]*4")
      .transpose(keyShift)
      .sound("sawtooth")
      // plucky filter envelope: opens 2.5 octaves above lpf, snaps shut in 120 ms
      .lpf(bySection({ pre: saw.range(400, 900).slow(8), chorus: 650, chorus2: 650, lift: 700 }, 480))
      .lpenv(2.5)
      .lpdecay(0.12)
      .lpq(5)
      .decay(0.2)
      .sustain(0.5)
      .release(0.05)
      .gain(0.55);

    // ─────────────────────────────────────────────────────────────────────────
    // 🌌 PADS — lush detuned supersaw chords, pumping with the kick
    // ─────────────────────────────────────────────────────────────────────────

    // voicing() turns "F#m" into a spread-out 4–5 note chord whose top note
    // sits at or below the anchor (C#5) — smooth voice-leading for free.
    // supersaw: `unison` = number of detuned voices, `detune` = how far apart.
    const pads = chords
      .anchor("C#5")
      .voicing()
      .transpose(keyShift)
      .s("supersaw")
      .unison(6)
      .detune(0.22)
      .spread(0.8)
      .attack(0.35)
      .decay(0.6)
      .sustain(0.7)
      .release(1.4)
      .hpf(220)
      .lpf(
        bySection(
          {
            intro: saw.range(300, 2400).slow(8), // the sun coming up over the grid
            pre: saw.range(1600, 4000).slow(8),
            chorus: 4000,
            breakdown: sine.range(700, 2200).slow(8),
            chorus2: 4000,
            lift: 4500,
          },
          1800
        )
      )
      .gain(0.5)
      .velocity(fade)
      .room(0.5)
      .rsize(4)
      .orbit(3); // the bus the kick ducks

    // ─────────────────────────────────────────────────────────────────────────
    // 🎹 ARP — 16th notes running up and down the current chord
    // ─────────────────────────────────────────────────────────────────────────

    // n() + chord() + voicing(): n picks the n-th note *of the voiced chord*
    // (going past the top wraps into the next octave) — so one figure follows
    // every chord change automatically.
    const UP_DOWN = "[0 1 2 3 4 3 2 1]*2";
    const arp = bySection({
      intro: n(UP_DOWN),
      verse: n(UP_DOWN),
      pre: n("[0 1 2 3 4 5 6 7]*2"), // straight up, again and again: tension
      chorus: n(UP_DOWN),
      breakdown: n("0 2 1 3 2 4 3 5"), // half the speed, lots of echo
      chorus2: n(UP_DOWN),
      lift: n(UP_DOWN),
      outro: n(UP_DOWN),
    })
      .chord(progression)
      .anchor("E4")
      .mode("above")
      .voicing()
      .transpose(keyShift)
      .s("sawtooth")
      .lpf(bySection({ intro: saw.range(250, 1600).slow(8), chorus: 1500, chorus2: 1500, lift: 1800 }, 1100))
      .lpenv(3) // every note is a little filter "blip"
      .lpdecay(0.09)
      .decay(0.14)
      .sustain(0)
      .hpf(300)
      .gain(0.28)
      .velocity(fade)
      .pan(sine.range(0.25, 0.75).slow(4)) // drifts across the stereo field
      .delay(0.35)
      .delaytime(DOTTED_8TH)
      .delayfeedback(0.45)
      .room(0.35)
      .rsize(3)
      .orbit(4);

    // ─────────────────────────────────────────────────────────────────────────
    // 🎷 LEAD — soaring supersaw with vibrato and dotted-8th echoes
    // ─────────────────────────────────────────────────────────────────────────

    const melody = bySection({
      verse: n(bars([...rest(8), ...VERSE])), // enters at verse bar 9
      pre: n(bars(PRE)),
      chorus: n(bars(HOOK)),
      breakdown: n(bars(ECHO)),
      chorus2: n(bars([...HOOK.slice(0, 7), "~"])), // rests over the pivot bar
      lift: n(bars(HOOK)),
      outro: n(bars(VERSE)),
    })
      .scale(LEAD_SCALE)
      .transpose(keyShift);

    const leadSound = (p: Pattern) =>
      p
        .s("supersaw")
        .unison(3)
        .detune(0.12)
        .vib(5.5) // vibrato: 5.5 wobbles per second…
        .vibmod(0.12) // …0.12 semitones deep
        .attack(0.02)
        .decay(0.3)
        .sustain(0.75)
        .release(0.35)
        .hpf(300)
        .delaytime(DOTTED_8TH)
        .delayfeedback(0.45)
        .room(0.35)
        .rsize(3)
        .orbit(4); // shares the echo bus with the arp

    const lead = leadSound(melody)
      .lpf(bySection({ verse: 2400, breakdown: 2000, outro: 2400 }, 3400))
      .delay(bySection({ breakdown: 0.55 }, 0.35))
      .gain(0.42)
      .velocity(fade);

    // The lift: same melody an octave up, quieter — instant "final chorus"
    const leadHigh = leadSound(melody.transpose(12).mask(during("lift")))
      .lpf(2800)
      .delay(0.3)
      .gain(0.16);

    // ─────────────────────────────────────────────────────────────────────────
    // 🌀 FX — white-noise risers sweep up into the big moments
    // ─────────────────────────────────────────────────────────────────────────

    const riser = bySection({
      pre: s("white*16").gain(saw.range(0.01, 0.13).slow(8)).hpf(saw.range(400, 8000).slow(8)),
      chorus2: s("<~!7 white*16>").gain(saw.range(0.02, 0.16)).hpf(saw.range(1000, 9000)),
    }).pan(sine.range(0.3, 0.7).fast(2));

    // ─────────────────────────────────────────────────────────────────────────
    // 🎚️ MIXER — comment a track out to mute it
    // ─────────────────────────────────────────────────────────────────────────

    return {
      kick,
      snare,
      hats,
      toms,
      crash,
      bass,
      pads,
      arp,
      lead,
      leadHigh,
      riser,
    };
  },
};

export default song;
