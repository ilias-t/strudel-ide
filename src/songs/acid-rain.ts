// ═══════════════════════════════════════════════════════════════════════════
// 🧪 ACID RAIN — acid techno
// ═══════════════════════════════════════════════════════════════════════════
//
// A TB-303 line through a resonant ladder filter is the star. Everything
// else (TR-909 drums, rolling bass, stabs) is there to make it squelch harder.
//
// The trick of acid: the riff barely changes, the *filter* does. A DJ rides
// the cutoff knob across the whole track. Here that knob is a signal (`knob`
// below), shaped per section and wobbled with perlin noise, so the squelch
// builds and releases on its own.
//
// Key: A phrygian (A Bb C D E F G). The b2 (Bb) gives it the menace.
// Harmony: an 8-bar root loop  i  i  i  i  VI VI vii vii  (Am Am Am Am F F Gm Gm),
// applied as *scale degrees*, so every part transposes and stays in key.
//
// ═══════════════════════════════════════════════════════════════════════════

import type { Song } from ".";

// ─── 🎛️ KNOBS (change these while it plays) ─────────────────────────────────

const BPM = 134;
const BEAT = 60 / BPM; // one quarter note in seconds (for delay times)

const KEY = "A"; // try "F" or "G"
const MODE = "phrygian"; // "minor" is less evil, "dorian" is brighter
const ROOTS = "<0 0 0 0 -2 -2 -1 -1>"; // scale degree of each bar's root: A A A A F F G G

const DRUMS = "RolandTR909";
const FILTER = "ladder"; // 303-style ladder filter; try "24db" (a nastier biquad) or "12db"

// The 303 "pattern memory": one bar of 16th notes. Numbers are scale degrees
// (0 = A2, 7 = A3 an octave up, 8 = Bb3), "~" is a rest.
// ACCENT and SLIDE line up step-for-step with every riff.
//               1 . . .   2 . . .   3 . . .   4 . . .
const RIFF_A = " 0 0 7 0   ~ 0 2 0   8 0 ~ 0   6 7 0 4 ";
const RIFF_B = " 0 ~ 7 0   3 0 ~ 2   8 7 0 ~   5 ~ 4 1 "; // ends on Bb → resolves to A
const RIFF_C = " 0 0 7 7   ~ 0 3 2   8 7 6 4   ~ 2 1 0 "; // falling run for the peak
const ACCENT = " 0 0 1 0   0 0 1 0   1 0 0 0   0 1 0 1 "; // 1 = louder + wider filter "wow"
const SLIDE  = " 0 0 1 0   0 0 0 0   1 0 0 0   0 0 0 0 "; // 1 = glide up an octave into this note

const RIB_SEED = 200; // the breakdown riff is locked-in randomness: change the seed for a new one

// Song structure: [section, bars]. Reorder, repeat or resize freely.
// (Some parts count bars inside a section, e.g. "<bd*4!7 ~>" = 7 bars of kick then a gap.)
const ARRANGEMENT = [
  ["intro", 8], //      kick, hats, the acid line creeping in muffled
  ["groove", 16], //    rolling bass, claps, filter starts breathing
  ["build", 8], //      clap roll, noise riser, cutoff twisted all the way up
  ["drop", 16], //      everything + ride, stabs, octave jumps
  ["breakdown", 16], // no kick: pads, acid rain, a palindrome riff from frozen randomness
  ["rebuild", 8], //    rotating riff (iter), roll, kick sneaks back
  ["peak", 16], //      brightest filter, ratchets, rumbling octaves
  ["outro", 8], //      filter closes, parts drop away
] as const;

type Section = (typeof ARRANGEMENT)[number][0];
const BARS = Object.fromEntries(ARRANGEMENT) as Record<Section, number>;

const song: Song = {
  name: "Acid Rain",
  bpm: BPM,
  visualization: "scope", // watch the saw wave fold over when the resonance kicks in
  sections: ARRANGEMENT, // the player's timeline (jump / loop)

  createPattern() {
    // ─── 🧰 HELPERS ───────────────────────────────────────────────────────────

    const rest = s("~");

    /** One full-length track: a pattern per section, silent where none is given */
    const track = (parts: Partial<Record<Section, Pattern>>): Pattern =>
      arrange(...ARRANGEMENT.map(([name, bars]): [number, Pattern] => [bars, parts[name] ?? rest]));

    /** "<[a] [b] ...>": one riff per bar, cycling */
    const riffs = (...bars: string[]) => `<${bars.map((r) => `[${r}]`).join(" ")}>`;

    /** Scale degrees + the bar's root → note names in KEY/MODE at the given octave */
    const inKey = (degrees: string | Pattern, octave: number): Pattern =>
      (typeof degrees === "string" ? mini(degrees) : degrees).add(mini(ROOTS)).scale(`${KEY}${octave}:${MODE}`);

    // ─── 🧪 THE 303 ───────────────────────────────────────────────────────────
    // Sawtooth → resonant low-pass with its own envelope (lpenv = how many
    // octaves above the cutoff each note's filter "wow" starts, lpdecay = how
    // fast it snaps shut). Accents push both; slides hold the note over the
    // next step and scoop the pitch up from an octave below.

    const accent = mini(ACCENT);
    const slide = mini(SLIDE);

    const tb303 = (riff: string | Pattern, slides = true): Pattern => {
      const line = note(inKey(riff, 2))
        .s("sawtooth")
        .velocity(accent.range(0.7, 1))
        .lpenv(accent.range(2.5, 4.2))
        .lpdecay(accent.range(0.2, 0.12))
        .clip(slides ? slide.range(0.75, 1.6) : 0.75)
        .attack(0.002)
        .decay(0.15)
        .sustain(0.5)
        .release(0.04);
      if (!slides) return line;
      const slid: Pattern = line.penv(slide.mul(12)).pattack(0.06);
      return slid;
    };

    // ribbon/rib loops a slice of time: here, one bar of random scale degrees
    // frozen into a riff. Same seed → same riff, every time.
    const frozenRandom: Pattern = irand(8).segment(16).rib(RIB_SEED, 1);

    const acidLine = track({
      intro: tb303(RIFF_A),
      // random 32nd-note ratchets, the classic 303 stutter
      groove: tb303(riffs(RIFF_A, RIFF_A, RIFF_A, RIFF_B)).sometimesBy(0.12, (x) => x.ply(2)),
      // last two bars double-time (ply 2) for tension
      build: tb303(riffs(RIFF_A, RIFF_A, RIFF_A, RIFF_B)).ply(mini("<1!6 2 2>")),
      // every 4th bar jumps an octave (on the phrase downbeat)
      drop: tb303(riffs(RIFF_A, RIFF_A, RIFF_A, RIFF_B))
        .every(4, (x) => x.transpose(12))
        .sometimesBy(0.1, (x) => x.ply(2)),
      // palindrome: the frozen riff plays forwards, then backwards, then forwards...
      breakdown: tb303(frozenRandom, false).palindrome().degradeBy(0.15),
      // iter(4): each bar starts one beat later in the riff, so it rotates
      rebuild: tb303(RIFF_A).iter(4).ply(mini("<1!6 2 2>")),
      peak: tb303(riffs(RIFF_A, RIFF_C, RIFF_A, RIFF_B))
        .sometimesBy(0.2, (x) => x.transpose(12))
        .sometimesBy(0.1, (x) => x.ply(2)),
      outro: tb303(RIFF_A).degradeBy(0.3),
    });

    // 🎛️ The cutoff knob (Hz), ridden across the whole arrangement.
    // rangex = exponential range, which is how a filter knob feels.
    // perlin adds the slow drift of a hand that never quite sits still.
    const knob = track({
      intro: saw.rangex(140, 420).slow(BARS.intro), // creeping open
      groove: sine.rangex(300, 1100).slow(BARS.groove), // breathing
      build: saw.rangex(500, 3200).slow(BARS.build), // twist it all the way up
      drop: cosine.rangex(800, 3000).slow(BARS.drop), // slam open, ease off, open again
      breakdown: saw.rangex(160, 1800).slow(BARS.breakdown), // shut, then a slow re-open
      rebuild: saw.rangex(600, 3500).slow(BARS.rebuild),
      peak: cosine.rangex(1100, 3800).slow(BARS.peak),
      outro: saw.rangex(1500, 140).slow(BARS.outro), // closing down
    }).mul(perlin.range(0.85, 1.2).slow(2));

    // resonance breathes on its own 16-bar cycle (ladder self-oscillates near 30)
    const resonance = sine.range(12, 22).slow(16);

    const ladder: Pattern = acidLine.ftype(FILTER);

    const acid = ladder
      .lpf(knob)
      .lpq(resonance)
      .shape(0.3) // a bit of drive, like a 303 into a mixer channel pushed hot
      .hpf(70) // leave the sub to the rumble
      .gain(0.5)
      .delay(0.22)
      .delaytime(BEAT * 0.75) // dotted 8th echo
      .delayfeedback(0.45)
      .room(0.15)
      .orbit(2);

    // ─── 🔊 RUMBLE — rolling 16th bass between the kicks ──────────────────────
    // "~ x x x" per beat: the kick owns the downbeat, the bass fills the rest.

    const rolling = (steps: string) =>
      note(inKey(steps, 1))
        .s("sawtooth")
        .velocity(mini("[0 0.75 1 0.8]*4"))
        .lpf(170)
        .decay(0.1)
        .sustain(0)
        .release(0.02)
        .shape(0.15)
        .gain(0.55);

    const roll = rolling("[~ 0 0 0]*4");
    const rollOctave = rolling("[~ 0 7 0]*4"); // octave pop for the peak

    const rumble = track({
      groove: roll,
      build: roll.mask("<1!6 0!2>"), // pull the bass out before the drop
      drop: roll,
      rebuild: roll.mask("<0!4 1!3 0>"),
      peak: rollOctave,
      outro: roll.mask("<1!4 0!4>"),
    });

    // ─── 🥁 DRUMS — TR-909 ────────────────────────────────────────────────────

    const fourFloor = s("bd*4").bank(DRUMS).gain(0.95).shape(0.2);

    const kick = track({
      intro: fourFloor,
      groove: fourFloor,
      build: s("<bd*4!7 ~>").bank(DRUMS).gain(0.95).shape(0.2), // one empty bar = the drop hits harder
      drop: fourFloor,
      rebuild: s("<~!4 bd*4 bd*4 bd*8 ~>").bank(DRUMS).gain(0.95).shape(0.2),
      peak: fourFloor,
      outro: fourFloor,
    });

    // closed hats: 16ths with a velocity groove (loud on the "a" of each beat)
    const hat16 = s("hh*16")
      .bank(DRUMS)
      .velocity(mini("[0.5 0.8 0.65 1]*4"))
      .gain(0.3)
      .hpf(6000)
      .pan(perlin.range(0.4, 0.6));

    const hats = track({
      intro: s("[~ hh]*4").bank(DRUMS).gain(0.25).hpf(6000),
      groove: hat16.degradeBy(0.1), // drop a few at random so it breathes
      build: hat16,
      drop: hat16,
      breakdown: hat16.degradeBy(0.4).mask("<0!8 1!8>").gain(0.18),
      rebuild: hat16,
      peak: hat16.sometimesBy(0.08, (x) => x.ply(2)),
      outro: hat16.degradeBy(0.3),
    });

    // the offbeat open hat: the "tss" that makes techno roll
    const offbeatOpen = s("[~ oh]*4").bank(DRUMS).gain(0.3).hpf(4000);

    const openhat = track({
      intro: offbeatOpen.mask("<0!4 1!4>"),
      groove: offbeatOpen,
      build: offbeatOpen,
      drop: offbeatOpen,
      rebuild: offbeatOpen.mask("<0!4 1!4>"),
      peak: offbeatOpen,
      outro: offbeatOpen,
    });

    const backbeat = s("~ cp ~ cp").bank(DRUMS).gain(0.45).room(0.2);
    // snare-roll style clap build: 8ths → 16ths → 32nds, getting louder
    const clapRoll = s("<[~ cp]*2!4 cp*4 cp*4 cp*8 cp*16>")
      .bank(DRUMS)
      .gain(saw.range(0.2, 0.5).slow(8))
      .room(0.2);

    const clap = track({
      groove: backbeat.mask("<0!8 1!8>"),
      build: clapRoll,
      drop: backbeat,
      rebuild: clapRoll,
      peak: backbeat,
      outro: backbeat.mask("<1!4 0!4>"),
    });

    const ride8 = s("rd*8").bank(DRUMS).velocity(mini("[0.6 1]*4")).gain(0.16).pan(0.6);

    const ride = track({
      drop: ride8,
      rebuild: ride8.mask("<0!4 1!4>"),
      peak: ride8,
    });

    // euclidean rimshots (5 hits over 16 steps); iter(4) rotates them each bar
    const rims = s("rim(5,16,2)").bank(DRUMS).gain(0.22).pan(0.35).iter(4);

    const perc = track({
      groove: rims.mask("<0!8 1!8>"),
      drop: rims,
      peak: rims,
    });

    // ─── 🎹 STABS & PADS — diatonic triads on the root loop ───────────────────
    // "[0,2,4]" = root, third, fifth of the scale degree → Am, F, Gm.

    const chordStab = note(inKey("[0,2,4]", 3))
      .struct("~ ~ ~ x ~ ~ x ~ ~ ~ ~ ~ ~ ~ ~ ~")
      .s("square")
      .lpf(1800)
      .decay(0.12)
      .sustain(0)
      .hpf(300)
      .gain(0.2)
      .delay(0.35)
      .delaytime(BEAT * 0.75)
      .delayfeedback(0.4)
      .room(0.3)
      .orbit(3);

    const stab = track({
      drop: chordStab.mask("<0!8 1!8>"),
      peak: chordStab,
    });

    const chordPad = note(inKey("[0,2,4,7]", 3))
      .s("supersaw")
      .attack(1.2)
      .sustain(0.8)
      .release(1.5)
      .lpf(sine.rangex(500, 1500).slow(16))
      .hpf(200)
      .gain(0.18)
      .room(0.6)
      .orbit(4);

    const pad = track({
      breakdown: chordPad,
      rebuild: chordPad.mask("<1!4 0!4>"),
    });

    // ─── 🌧️ ACID RAIN — sparse high plinks with long echoes ──────────────────
    // Random pentatonic notes (all inside A phrygian) on a euclidean grid
    // whose rotation shifts every bar; sometimes a drop "drips" twice.

    const drops = note(irand(8).segment(8).scale(`${KEY}5:minor:pentatonic`))
      .struct("x(3,8,<0 2 5 1>)")
      .sometimesBy(0.3, (x) => x.ply(2))
      .s("sine")
      .decay(0.08)
      .sustain(0)
      .hpf(800)
      .gain(0.14)
      .pan(rand)
      .delay(0.5)
      .delaytime(BEAT * 0.75)
      .delayfeedback(0.55)
      .room(0.5)
      .orbit(5);

    const rain = track({
      breakdown: drops,
      outro: drops.mask("<0!4 1!4>"),
    });

    // ─── 🌀 FX — risers & crashes ─────────────────────────────────────────────

    // a 16th-note noise roll that brightens (hpf) and swells over the build
    const noiseRoll = (bars: number) =>
      s("white*16")
        .decay(0.05)
        .sustain(0)
        .hpf(saw.rangex(500, 9000).slow(bars))
        .gain(saw.range(0.02, 0.16).slow(bars));

    const riser = track({
      build: noiseRoll(BARS.build),
      rebuild: noiseRoll(BARS.rebuild),
    });

    const crashOnOne = s("<cr ~!15>").bank(DRUMS).gain(0.3);

    const crash = track({
      groove: crashOnOne,
      drop: crashOnOne,
      peak: crashOnOne,
    });

    // ─── 🎚️ MIXER — named tracks, stacked by the player ──────────────────────

    return { kick, rumble, hats, openhat, clap, ride, perc, crash, acid, stab, pad, rain, riser };
  },
};

export default song;
