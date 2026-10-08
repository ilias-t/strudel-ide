// ═══════════════════════════════════════════════════════════════════════════
// 🎵 JYNX — French filter house in A minor, 126 BPM
// ═══════════════════════════════════════════════════════════════════════════
//
// Daft Punk-ish: detuned supersaw chords pumping against a 909 kick (real
// sidechain via `duckorbit`), a plucky disco bass with a filter envelope,
// vocoder-flavoured `vowel` stabs, and long filter sweeps into every drop.
//
// Everything melodic is written in SCALE DEGREES relative to the current chord
// (0 = root, 2 = third, 4 = fifth, 6 = seventh, 7 = octave), so you can change
// KEY, MODE or PROG below while it plays and the whole song follows, in key.
//
// ═══════════════════════════════════════════════════════════════════════════

import type { Song } from ".";

// ─── 🎛️ KNOBS — tweak these live ─────────────────────────────────────────────

const BPM = 126;
const KEY = "A";
const MODE = "minor";

/** Chord roots as scale degrees, one per bar: i – VII – VI – v (Am7 – G7 – Fmaj7 – Em7) */
const PROG = "<0 -1 -2 -3>";
/** Which scale degrees (above the root) make a chord: stacked thirds = diatonic 7ths. Try "[0,2,4,7]" */
const CHORD_SHAPE = "[0,2,4,6]";

/** MPC-style swing on every off-beat 16th: 0 = straight, ~0.16 ≈ 58%, 0.33 = full triplet shuffle */
const SWING = 0.16;
/** Sidechain depth: how hard the kick ducks bass + chords (0–1) */
const PUMP = 0.75;
const DRUMS: DrumMachineBank = "RolandTR909";

/** Disco octave bass, relative to the chord root (0 root, 4 fifth, 7 octave) */
const BASS_GROOVE = "[0 ~ 7 0] [~ 0 7 ~] [0 ~ 7 0] [~ 4 7 4]";

/** Verse motif (the original Jynx verse), now re-harmonised to follow each chord */
const VERSE = "4 ~ 0 ~ 6 4 ~ ~ 4 ~ 0 ~ 2 0 ~ ~";

/** The hook: an octave–fifth–root bounce three times, then an answer that climbs over the v chord */
const HOOK_CALL = "7 ~ 4 ~ 0 ~ 7 ~ ~ 4 ~ 6 ~ 4 2 ~";
const HOOK_ANSWER = "7 ~ 9 ~ 11 ~ 10 ~ 9 ~ 7 ~ 4 ~ ~ ~";
const HOOK_ANSWER_2 = "7 ~ 9 ~ 11 ~ 14 ~ 11 ~ 9 ~ 10 11 ~ ~"; // peaks an octave up, leads back to the top
const HOOK = `<[${HOOK_CALL}]!3 [${HOOK_ANSWER}] [${HOOK_CALL}]!3 [${HOOK_ANSWER_2}]>`;

/** Arrangement: [section, bars]. 88 bars ≈ 2:48, then it loops */
const SECTIONS = [
  ["intro", 8], //      kick + filtered chords opening up
  ["groove", 16], //    pump starts, vocoder stabs, verse lead in bar 9
  ["build", 8], //      snare roll + noise riser, filters open, last bar drops out
  ["drop", 16], //      the hook
  ["breakdown", 8], //  no drums: choir pad + vocoder melody
  ["rise", 8], //       hook teaser, kick + roll come back
  ["drop2", 16], //     everything, hook doubled, arp on top
  ["outro", 8], //      filters close, back round to the intro
] as const;

type Section = (typeof SECTIONS)[number][0];

const song: Song = {
  name: "Jynx",
  bpm: BPM,
  visualization: { type: "pianoroll", options: { cycles: 8, labels: false } },

  createPattern() {
    // ─────────────────────────────────────────────────────────────────────────
    // 🧰 HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    const OFF = s("~");
    /**
     * One full-length track: a pattern per section, silence elsewhere.
     * `arrange` restarts each section at its own bar 0, so `<a b c d>` cycles,
     * `.mask("<1!7 0>")` and `saw.slow(8)` ramps all line up with the section.
     */
    const track = (parts: Partial<Record<Section, Pattern>>): Pattern =>
      arrange(...SECTIONS.map(([name, bars]): [number, Pattern] => [bars, parts[name] ?? OFF]));

    const scaleIn = (octave: number) => `${KEY}${octave}:${MODE}`;
    /** Scale degrees on top of the current chord root (adds PROG bar by bar) */
    const onChord = (degrees: string) => n(degrees).add(n(PROG));
    /** Same swing on every 16th-note part, so drums, bass and lead groove together */
    const swing = (pat: Pattern): Pattern =>
      pat.swingBy(SWING, 8);

    const BAR = 240 / BPM; // seconds per bar
    const DOTTED_8TH = (60 / BPM) * 0.75; // delay time that dances against the 16ths

    // Orbits = separate effect buses (each has its own reverb + delay):
    //   1 drums · 2 bass + chords (ducked by the kick) · 3 lead + arp · 4 vocoder · 5 pad · 6 fx

    // ─────────────────────────────────────────────────────────────────────────
    // 🥁 DRUMS — 909, the French house standard
    // ─────────────────────────────────────────────────────────────────────────

    const kick = s("bd*4").bank(DRUMS).gain(0.95);

    // Real sidechain: each kick ducks orbit 2 (bass + chords), which swells back
    // over `duckattack` seconds. That breathing IS the filter-house groove.
    // (Only used once orbit 2 has already played something, or superdough complains.)
    const pumpingKick: Pattern = kick
      .duckorbit(2)
      .duckattack(0.25)
      .duckdepth(PUMP);

    // Clap on 2 & 4, plus quiet swung ghost snares in between
    const clap = s("~ cp ~ cp").bank(DRUMS).gain(0.5).room(0.15);
    const ghosts = swing(
      s("~ ~ ~ ~ ~ ~ ~ sd ~ ~ sd ~ ~ ~ ~ sd").bank(DRUMS).gain(0.12).hpf(900)
    );
    const backbeat = stack(clap, ghosts);

    // 16th hats: accent the off-beat 8th, perlin noise for human velocity
    const hats = swing(
      s("hh*16")
        .bank(DRUMS)
        .gain(mini("[.28 .14 .45 .14]*4"))
        .velocity(perlin.range(0.75, 1))
        .pan(0.55)
    );

    // The house off-beat open hat, with a short decay so it doesn't wash out
    const openHat = s("[~ oh]*4").bank(DRUMS).gain(0.28).decay(0.2).sustain(0).pan(0.45);

    // Shaker + rim for extra shuffle in the big sections
    const perc = swing(
      stack(
        s("sh*16").bank("RolandTR808").gain(mini("[.08 .16]*8")).pan(0.7),
        s("~ ~ rim ~ ~ ~ ~ rim ~ ~ rim ~ ~ ~ ~ ~").bank(DRUMS).gain(0.2).pan(0.3)
      )
    );

    const crash = s("<cr ~!7>").bank(DRUMS).gain(0.3).room(0.3); // every 8 bars

    // Fills: a tom pickup into every 8th bar, and accelerating snare rolls for builds
    const tomFill = s("<~!7 [~ ~ ~ [lt mt ht ht]]>").bank(DRUMS).gain(0.35);
    const snareRoll = s("<sd*4!4 sd*8!2 sd*16!2>")
      .bank(DRUMS)
      .gain(saw.range(0.1, 0.5).slow(8)) // crescendo over the 8-bar build
      .hpf(saw.rangex(200, 3000).slow(8)) // ...getting thinner as it rises
      .room(0.25);
    const riseRoll = s("<~ ~ ~ ~ sd*4 sd*8 sd*16 [sd*8 ~]>")
      .bank(DRUMS)
      .gain(saw.range(0.05, 0.5).slow(8))
      .hpf(saw.rangex(300, 3000).slow(8))
      .room(0.25);

    // ─────────────────────────────────────────────────────────────────────────
    // 🌀 FX — white-noise riser: ONE long note whose high-pass filter
    // envelope (hpenv, in octaves) sweeps up across the whole build
    // ─────────────────────────────────────────────────────────────────────────

    const riser = s("white")
      .slow(8)
      .attack(8 * BAR * 0.9)
      .sustain(1)
      .release(0.2)
      .hpf(250)
      .hpenv(5)
      .hpattack(8 * BAR)
      .gain(0.16)
      .room(0.4)
      .orbit(6);

    // ─────────────────────────────────────────────────────────────────────────
    // 🔊 BASS — sawtooth with a filter envelope (lpenv) for the disco "wow" pluck,
    // plus a sine sub an octave below doubling the same groove
    // ─────────────────────────────────────────────────────────────────────────

    const bassNotes = swing(onChord(BASS_GROOVE));
    const bass = (cutoff: number | Pattern) =>
      bassNotes
        .scale(scaleIn(2))
        .s("sawtooth")
        .lpf(cutoff)
        .lpq(6)
        .lpenv(3) // each note's filter opens 3 octaves above `cutoff`, then closes
        .lpdecay(0.14)
        .lpsustain(0.1)
        .decay(0.2)
        .sustain(0.4)
        .release(0.05)
        .gain(0.5)
        .orbit(2);
    const sub = bassNotes
      .scale(scaleIn(1))
      .s("sine")
      .decay(0.25)
      .sustain(0.6)
      .release(0.05)
      .gain(0.45)
      .orbit(2);

    // ─────────────────────────────────────────────────────────────────────────
    // 🌊 CHORDS — detuned supersaw, sustained a bar each; the kick's ducking
    // chops it into the pump, a slow LFO on the low-pass filter keeps it moving
    // ─────────────────────────────────────────────────────────────────────────

    const chordNotes = onChord(CHORD_SHAPE).scale(scaleIn(3)); // Am7 = A3 C4 E4 G4 …
    const chords = (cutoff: number | Pattern) =>
      chordNotes
        .s("supersaw")
        .lpf(cutoff)
        .lpq(4)
        .attack(0.01)
        .decay(0.5)
        .sustain(0.65)
        .release(0.25)
        .hpf(200)
        .gain(0.24)
        .room(0.2)
        .orbit(2);

    // Breakdown pad: same chords with the root doubled an octave down, slow
    // attack, big reverb, and a `vowel` formant filter for an "ooh" choir feel
    const pad = (cutoff: number | Pattern) =>
      stack(onChord(CHORD_SHAPE), onChord("-7"))
        .scale(scaleIn(3))
        .s("supersaw")
        .vowel("o")
        .lpf(cutoff)
        .attack(1.2)
        .sustain(1)
        .release(2.5)
        .hpf(120)
        .gain(0.3)
        .room(0.6)
        .rsize(6)
        .orbit(5);

    // ─────────────────────────────────────────────────────────────────────────
    // 🗣️ VOCODER — `vowel` on a sawtooth is a poor man's talkbox
    // ─────────────────────────────────────────────────────────────────────────

    // Syncopated triad stabs that dodge the kick, mouthing a different vowel each bar
    const voxStabs = swing(onChord("[0,2,4]").struct("~ ~ ~ x ~ ~ x ~ ~ ~ x ~ ~ x ~ ~"))
      .scale(scaleIn(3))
      .s("sawtooth")
      .vowel("<a e o a>")
      .decay(0.15)
      .sustain(0.3)
      .release(0.1)
      .hpf(250)
      .gain(0.32)
      .room(0.3)
      .delay(0.25)
      .delaytime(DOTTED_8TH)
      .delayfeedback(0.3)
      .orbit(4);

    // Breakdown melody: the hook's skeleton in long notes, "singing" o-a-o-e
    const voxMelody = onChord("7@4 4@4 6@4 4@2 2@2")
      .scale(scaleIn(4))
      .s("sawtooth")
      .vowel("<o a o e>")
      .attack(0.03)
      .sustain(0.8)
      .release(0.6)
      .lpf(2500)
      .hpf(300)
      .gain(0.3)
      .room(0.45)
      .delay(0.25)
      .delaytime(DOTTED_8TH)
      .delayfeedback(0.3)
      .orbit(4);

    // ─────────────────────────────────────────────────────────────────────────
    // ✨ LEAD — square-wave hook with a touch of filter envelope + dotted-8th delay
    // ─────────────────────────────────────────────────────────────────────────

    const leadSynth = (notes: Pattern) =>
      swing(notes)
        .scale(scaleIn(4))
        .s("square")
        .lpf(2400)
        .lpq(2)
        .lpenv(1.5)
        .lpdecay(0.25)
        .lpsustain(0.3)
        .attack(0.005)
        .decay(0.2)
        .sustain(0.5)
        .release(0.12)
        .hpf(250)
        .gain(0.26)
        .delay(0.28)
        .delaytime(DOTTED_8TH)
        .delayfeedback(0.38)
        .room(0.25)
        .orbit(3);

    const hookNotes = onChord(HOOK);
    const hook = leadSynth(hookNotes);
    const verse = leadSynth(onChord(VERSE)).lpf(1800).gain(0.2);
    const hookTeaser = hook.lpf(saw.rangex(500, 3500).slow(8)); // opens across the rise
    const bigHook = leadSynth(hookNotes.superimpose((p) => p.add(n(-7)))).gain(0.2); // + octave below

    // ATB-style 16th arpeggio over the chord tones, panning side to side
    const arp = swing(onChord("[0 2 4 7] [9 7 4 2] [0 2 4 7] [4 7 9 11]"))
      .scale(scaleIn(4))
      .s("sawtooth")
      .lpf(sine.rangex(1200, 4000).slow(16))
      .lpenv(1.5)
      .lpdecay(0.08)
      .decay(0.12)
      .sustain(0)
      .release(0.08)
      .hpf(400)
      .gain(0.12)
      .delay(0.3)
      .delaytime(DOTTED_8TH)
      .delayfeedback(0.38)
      .pan(sine.range(0.25, 0.75).slow(4))
      .orbit(3);

    // ─────────────────────────────────────────────────────────────────────────
    // 🎼 ARRANGEMENT — every track says what it plays in each section.
    // `.mask("<1!7 0>")` = play 7 bars, drop out on the 8th (the gap before a drop).
    // ─────────────────────────────────────────────────────────────────────────

    const LAST_BAR_OUT = "<1!7 0>";
    const SECOND_HALF_16 = "<0!8 1!8>"; // in a 16-bar section: bars 9–16 only

    return {
      kick: track({
        intro: kick, // no ducking yet: the pump kicks in with the groove
        groove: pumpingKick,
        build: pumpingKick.mask(LAST_BAR_OUT),
        drop: pumpingKick,
        // half-time → four-to-the-floor → 8ths, then one beat of silence
        rise: s("<~ ~ ~ ~ [bd ~ bd ~] [bd ~ bd ~] bd*4 [bd bd bd bd bd bd ~ ~]>").bank(DRUMS).gain(0.95),
        drop2: pumpingKick,
        outro: pumpingKick.mask("<1!6 0 0>"),
      }),

      clap: track({
        groove: backbeat,
        build: clap.mask(LAST_BAR_OUT),
        drop: backbeat,
        drop2: backbeat,
        outro: backbeat.mask("<1!6 0 0>"),
      }),

      hats: track({
        intro: hats.mask("<0!4 1!4>"),
        groove: hats,
        build: hats.mask(LAST_BAR_OUT),
        drop: hats,
        rise: hats.mask("<0 0 0 0 1 1 1 0>"),
        drop2: hats,
        outro: hats.velocity(saw.range(1, 0.3).slow(8)), // fade out
      }),

      openHat: track({
        groove: openHat.mask(SECOND_HALF_16),
        drop: openHat,
        drop2: openHat,
        outro: openHat.mask("<1!6 0 0>"),
      }),

      perc: track({
        groove: perc.mask(SECOND_HALF_16),
        build: perc.mask(LAST_BAR_OUT),
        drop: perc,
        drop2: perc,
      }),

      crash: track({
        groove: crash,
        drop: crash,
        drop2: crash,
        outro: crash,
      }),

      fills: track({
        intro: tomFill,
        groove: tomFill,
        build: snareRoll,
        drop: tomFill,
        rise: riseRoll,
        drop2: tomFill,
      }),

      riser: track({
        build: riser,
        rise: riser,
      }),

      bass: track({
        intro: bass(150).mask("<0!4 1!4>"), // creeps in, nearly closed
        groove: bass(sine.rangex(250, 600).slow(16)),
        build: bass(saw.rangex(300, 1500).slow(8)).mask(LAST_BAR_OUT),
        drop: bass(sine.rangex(400, 900).slow(8)),
        drop2: bass(sine.rangex(450, 1000).slow(8)),
        outro: bass(saw.rangex(600, 150).slow(8)).mask("<1!6 0 0>"),
      }),

      sub: track({
        groove: sub,
        build: sub.mask(LAST_BAR_OUT),
        drop: sub,
        drop2: sub,
        outro: sub.mask("<1!6 0 0>"),
      }),

      chords: track({
        intro: chords(saw.rangex(250, 1500).slow(8)), // the classic filter-house intro sweep
        groove: chords(sine.rangex(700, 2600).slow(16)),
        build: chords(saw.rangex(900, 7000).slow(8)).mask(LAST_BAR_OUT),
        drop: chords(sine.rangex(1800, 6000).slow(8)),
        drop2: chords(sine.rangex(2000, 7000).slow(8)),
        outro: chords(saw.rangex(2500, 250).slow(8)), // and closing again
      }),

      pad: track({
        breakdown: pad(saw.rangex(800, 2000).slow(8)),
        rise: pad(saw.rangex(2000, 5000).slow(8)),
      }),

      vox: track({
        groove: voxStabs,
        build: voxStabs.mask(LAST_BAR_OUT),
        drop: voxStabs,
        breakdown: voxMelody,
        rise: voxMelody.mask("<1!4 0!4>"),
        drop2: voxStabs,
      }),

      lead: track({
        groove: verse.mask(SECOND_HALF_16),
        drop: hook,
        rise: hookTeaser,
        drop2: bigHook,
      }),

      arp: track({
        build: arp.lpf(saw.rangex(500, 5000).slow(8)).mask(LAST_BAR_OUT),
        drop: arp.mask(SECOND_HALF_16),
        drop2: arp,
        outro: arp.mask("<1!4 0!4>"),
      }),
    };
  },
};

export default song;
