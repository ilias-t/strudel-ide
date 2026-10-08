// ═══════════════════════════════════════════════════════════════════════════
// 🎓 A TOUR OF STRUDEL — a tutorial you listen to. D minor, 116 BPM.
// ═══════════════════════════════════════════════════════════════════════════
//
// One track, fourteen chapters. Every chapter adds one idea and one layer, so
// by the end a single kick drum has grown into a full song. Press play and
// read along: the code view lights up each token as it sounds and scrolls to
// the chapter that's playing.
//
// ⌨️  Stage keys
//   Space      play / stop
//   ] and [    next / previous chapter (or click one on the timeline)
//   L          loop the current chapter: stay on it while you tweak it
//   1–8        mute a track · Shift+1–8 solo it · 0 unmute everything
//   F          follow the music again after you've scrolled away
//   C          show / hide the code view
//   ← and →    previous / next song
//   ?          all the keys
//
// 🧪 How to play with it: loop a chapter (L), change something in its code,
// save. The song hot-swaps on the next beat without stopping.
//
// How this file is built: each chapter is a SCENE, a record of named tracks
// like { pulse, hats, bass }. Scenes repeat the parts that keep playing,
// so what's lit up is always right next to the text that explains it. At
// the bottom, THE MIX lays the scenes end to end with `arrange()`.
//
// ═══════════════════════════════════════════════════════════════════════════

import type { Song } from ".";

// ─── 🎛️ KNOBS ──────────────────────────────────────────────────────────────
const BPM = 116; // quarter notes per minute; 1 cycle = 1 bar of 4/4
const KIT: DrumMachineBank = "RolandTR909"; // the drum machine from chapter 5 on
const DOTTED_8TH = (60 / BPM) * 0.75; // echo time in seconds: ¾ of a beat

// ─── 🗺️ THE TOUR — one row per chapter: name + length in bars (the timeline) ─
const SECTIONS = [
  ["pulse", 4], //       1  s("bd*4")
  ["rests", 4], //       2  ~ and [ ]
  ["turns", 4], //       3  < > ! * @
  ["banks", 4], //       4  drum machines
  ["euclid", 8], //      5  (3,8)
  ["notes", 8], //       6  n() and .scale()
  ["chords", 8], //      7  chord().voicing()
  ["synths", 8], //      8  envelopes and filters
  ["signals", 8], //     9  sine, saw, perlin
  ["effects", 8], //    10  delay, reverb, orbits
  ["transforms", 8], // 11  every, sometimesBy, jux, off
  ["tracks", 8], //     12  stack and the mixer (breakdown)
  ["arrange", 8], //    13  arrange (build-up)
  ["finale", 8], //     14  everything together
] as const; // = 96 bars ≈ 3:19, then back to the start

// The mixer strips, in order: key 1 = pulse, 2 = snare, … 8 = arp
const TRACKS = ["pulse", "snare", "hats", "perc", "bass", "chords", "lead", "arp"] as const;
type Track = (typeof TRACKS)[number];
type Scene = Partial<Record<Track, Pattern>>;

const song: Song = {
  name: "A Tour of Strudel",
  bpm: BPM,
  visualization: { type: "pianoroll", options: { cycles: 8, labels: false } },
  sections: SECTIONS, // the timeline: click a chapter to jump there

  createPattern() {
    // ─────────────────────────────────────────────────────────────────────────
    // 1 · PULSE
    // ─────────────────────────────────────────────────────────────────────────
    // Strudel makes music from patterns: little loops that repeat every
    // cycle. In this song one cycle is one bar. `s("bd")` plays a sound, here
    // "bd", a bass drum. `*4` fits it in four times per cycle, so you get a kick
    // on every beat ("four on the floor").
    const ch1: Scene = {
      pulse: s("bd*4"),
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 2 · RESTS & GROUPS
    // ─────────────────────────────────────────────────────────────────────────
    // A pattern string shares the bar out evenly between its steps.
    //   ~     is a rest: a step where nothing plays
    //   [ ]   squeezes several steps into the time of one
    // So "~ sd ~ sd" is four steps with the snare on beats 2 and 4, and each
    // "[~ hh]" splits a beat in two with the hi-hat on its second half.
    const ch2: Scene = {
      pulse: s("bd*4"),
      snare: s("~ sd ~ sd"),
      hats: s("[~ hh] [~ hh] [~ hh] [~ hh]"),
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 3 · TAKING TURNS
    // ─────────────────────────────────────────────────────────────────────────
    //   < >   plays ONE of its steps per cycle, taking turns: "<a b>" = a, then b
    //   !     repeats a step:  "hh!3 oh" = "hh hh hh oh"
    //   *     speeds a step up: "[…]*2" plays the group twice in its space
    //   @     makes a step longer: "bd@3 bd@3 bd@2" = 3+3+2 eighths, the
    //         "tresillo", a rhythm you'll hear again in this tour
    // The kick plays straight for three bars, then the tresillo on bar four.
    const ch3: Scene = {
      pulse: s("<bd*4!3 [bd@3 bd@3 bd@2]>"),
      snare: s("~ sd ~ <sd [sd sd]>"),
      hats: s("[hh!3 oh]*2"),
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 4 · DRUM MACHINES (BANKS)
    // ─────────────────────────────────────────────────────────────────────────
    // The same three patterns, now played by a Roland TR-909. `.bank()` picks
    // a drum machine, and every machine uses the same short names: bd sd hh oh
    // cp rim lt mt ht cr. Try "RolandTR808", "LinnDrum", "OberheimDMX" or
    // "RolandTR707" (your editor autocompletes the names).
    const ch4: Scene = {
      pulse: s("<bd*4!3 [bd@3 bd@3 bd@2]>").bank("RolandTR909"),
      snare: s("~ sd ~ <sd [sd sd]>").bank("RolandTR909"),
      hats: s("[hh!3 oh]*2").bank("RolandTR909"),
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 5 · EUCLIDEAN RHYTHMS
    // ─────────────────────────────────────────────────────────────────────────
    // "rim(3,8)" spreads 3 hits as evenly as possible over 8 steps: x..x..x.
    // That's the tresillo again! A third number rotates the pattern, so
    // "(3,8,2)" starts two steps later. Many rhythms from around the world are
    // Euclidean. Try (5,8) for the Cuban cinquillo or (7,16) for a samba feel.
    // (From here on the drums use the KIT knob at the top.)
    const ch5: Scene = {
      pulse: s("bd*4").bank(KIT),
      snare: s("~ sd ~ <sd!3 [sd sd]>").bank(KIT),
      hats: s("[hh!3 oh]*2").bank(KIT),
      perc: s("rim(3,8,2)").bank(KIT),
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 6 · NOTES & SCALES
    // ─────────────────────────────────────────────────────────────────────────
    // `n()` numbers the notes of a scale, and `.scale("D2:minor")` says which
    // scale: D minor from octave 2. Step 0 is D, 1 is E, 2 is F… and 7 is the
    // D an octave up, so the riff bounces between the root and its octave.
    // `.add(n("<0 -2 2 -1>"))` moves the whole riff each bar, to D, B♭, F and C.
    // Those are the roots of this song's chords, which arrive next.
    const ch6: Scene = {
      pulse: s("bd*4").bank(KIT),
      snare: s("~ sd ~ <sd!3 [sd sd]>").bank(KIT),
      hats: s("[hh!3 oh]*2").bank(KIT),
      perc: s("rim(3,8,2)").bank(KIT),
      bass: n("0 ~ 0 7 ~ 0 7 0").add(n("<0 -2 2 -1>")).scale("D2:minor").s("sawtooth").lpf(500),
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 7 · CHORDS
    // ─────────────────────────────────────────────────────────────────────────
    // `chord()` takes chord symbols: Dm7, Bb^7 (^7 = major 7th), F^7, C7.
    // `.voicing()` turns each symbol into notes to play, spaced out and
    // moving smoothly from chord to chord. `.struct()` gives them a rhythm,
    // x = play and ~ = rest. It's the 3+3+2 tresillo once more.
    const ch7: Scene = {
      pulse: s("bd*4").bank(KIT),
      snare: s("~ sd ~ <sd!3 [sd sd]>").bank(KIT),
      hats: s("[hh!3 oh]*2").bank(KIT),
      perc: s("rim(3,8,2)").bank(KIT),
      bass: n("0 ~ 0 7 ~ 0 7 0").add(n("<0 -2 2 -1>")).scale("D2:minor").s("sawtooth").lpf(500),
      chords: chord("<Dm7 Bb^7 F^7 C7>").voicing().struct("x ~ ~ x ~ ~ x ~").s("piano").gain(0.6),
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 8 · SYNTHS & SOUND DESIGN
    // ─────────────────────────────────────────────────────────────────────────
    // Synths start as raw waveforms (sine, triangle, square, sawtooth) that
    // you shape. The ENVELOPE shapes each note's volume, ADSR:
    //   attack   seconds to fade in
    //   decay    seconds to fall from the peak to…
    //   sustain  …this level (0–1), held while the note lasts
    //   release  seconds to fade out after the note ends
    // A low-pass filter (lpf, in Hz) removes the highs. A FILTER ENVELOPE
    // opens it for a moment at the start of each note: lpenv = how many
    // octaves it jumps, lpdecay = how fast it closes again. Short decays and a
    // resonant filter (lpq) make the bass "squelch".
    // These are plain functions, so later chapters reuse the same sounds.
    const acidBass = (p: Pattern) =>
      p.s("sawtooth")
        .attack(0.005).decay(0.18).sustain(0.35).release(0.08)
        .lpf(260).lpq(7).lpenv(3.5).lpdecay(0.14);

    const squareLead = (p: Pattern) =>
      p.s("square")
        .attack(0.02).decay(0.25).sustain(0.5).release(0.3)
        .lpf(1400).lpenv(1.5).lpdecay(0.2)
        .hpf(250); // a high-pass filter cuts the lows, leaving room for the bass

    // The lead is a 4-bar melody, one [ ] group per bar, 8 eighths each.
    // Its notes are chord tones (A, C, F over Dm7…), which is why it fits.
    const ch8: Scene = {
      pulse: s("bd*4").bank(KIT),
      snare: s("~ sd ~ <sd!3 [sd sd]>").bank(KIT),
      hats: s("[hh!3 oh]*2").bank(KIT),
      perc: s("rim(3,8,2)").bank(KIT),
      bass: acidBass(n("0 ~ 0 7 ~ 0 7 0").add(n("<0 -2 2 -1>")).scale("D2:minor")),
      chords: chord("<Dm7 Bb^7 F^7 C7>").voicing().struct("x ~ ~ x ~ ~ x ~").s("piano").gain(0.6),
      lead: squareLead(
        n("<[4 ~ 4 6 ~ 4 2@2] [~ 2 ~ 2 4 2 0@2] [4 ~ 4 6 ~ 8 6@2] [5 ~ 3 1 ~ 3@3]>").scale("D4:minor")
      ),
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 9 · SIGNALS
    // ─────────────────────────────────────────────────────────────────────────
    // Signals are values that keep moving instead of stepping:
    //   sine, saw, tri, square → smooth shapes from 0 to 1
    //   perlin, rand           → drifting / random values
    // `.range(lo, hi)` scales one to useful numbers, `.slow(8)` stretches one
    // sweep over 8 bars. Use them anywhere a number goes. Here a sine moves
    // the bass filter, a saw opens a new pad's filter across the chapter,
    // perlin noise varies how hard the hats hit, and the rim drifts across
    // the stereo field.
    const pad = (p: Pattern) =>
      p.s("sawtooth").attack(0.4).decay(0.6).sustain(0.7).release(1.2).hpf(200).gain(0.3);

    const ch9: Scene = {
      pulse: s("bd*4").bank(KIT),
      snare: s("~ sd ~ <sd!3 [sd sd]>").bank(KIT),
      hats: s("[hh!3 oh]*2").bank(KIT).velocity(perlin.range(0.55, 1)),
      perc: s("rim(3,8,2)").bank(KIT).pan(sine.range(0.2, 0.8).slow(2)),
      bass: acidBass(n("0 ~ 0 7 ~ 0 7 0").add(n("<0 -2 2 -1>")).scale("D2:minor"))
        .lpf(sine.range(200, 700).slow(8)),
      chords: pad(chord("<Dm7 Bb^7 F^7 C7>").voicing()).lpf(saw.range(400, 2600).slow(8)),
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 10 · EFFECTS
    // ─────────────────────────────────────────────────────────────────────────
    // delay  echoes: how loud (0–1), delaytime (seconds), delayfeedback (how
    //        many repeats). A dotted eighth makes echoes that dance.
    // room   reverb: how much (0–1); rsize = how big the room is
    // orbit  an effects bus. Each orbit has ONE reverb and ONE delay, so give
    //        parts with different settings their own orbit (drums 1, lead 2,
    //        pad 3).
    // duckorbit makes every kick turn orbit 3 down for a moment ("sidechain"
    // pumping), so the pad breathes with the beat.
    // The lead now plays the full 8-bar hook: the first 4 bars ask, the last
    // 4 answer.
    const echoes = (p: Pattern) =>
      p.delay(0.35).delaytime(DOTTED_8TH).delayfeedback(0.45).room(0.3).rsize(3).orbit(2);
    const hall = (p: Pattern) => p.room(0.6).rsize(6).orbit(3);
    const pump = (p: Pattern) => p.duckorbit(3).duckattack(0.2).duckdepth(0.6);

    const ch10: Scene = {
      pulse: pump(s("bd*4").bank(KIT)),
      snare: s("~ sd ~ <sd!3 [sd sd]>").bank(KIT).room(0.15),
      hats: s("[hh!3 oh]*2").bank(KIT).velocity(perlin.range(0.55, 1)),
      perc: s("rim(3,8,2)").bank(KIT).pan(sine.range(0.2, 0.8).slow(2)),
      bass: acidBass(n("0 ~ 0 7 ~ 0 7 0").add(n("<0 -2 2 -1>")).scale("D2:minor"))
        .lpf(sine.range(200, 700).slow(8)),
      chords: hall(pad(chord("<Dm7 Bb^7 F^7 C7>").voicing()).lpf(1800)),
      lead: echoes(squareLead(n(`<
        [4 ~ 4 6 ~ 4 2@2] [~ 2 ~ 2 4 2 0@2] [4 ~ 4 6 ~ 8 6@2] [5 ~ 3 1 ~ 3@3]
        [4 ~ 4 6 ~ 7 9@2] [~ 9 ~ 7 5 4 2@2] [4 ~ 6 8 ~ 6 4@2] [3 ~ 1 -1 ~ 0@3]
      >`).scale("D4:minor"))),
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 11 · TRANSFORMS
    // ─────────────────────────────────────────────────────────────────────────
    // Functions that take a pattern and change it:
    //   .every(4, f)          apply f on the first of every 4 bars (the bass
    //                         doubles up; .lastOf(4, f) is the one for fills)
    //   .sometimesBy(0.2, f)  apply f to ~20% of the events, at random
    //   .ply(2)               play every event twice as fast
    //   .jux(rev)             left ear as is, right ear reversed
    //   .off(1/16, f)         a copy of the pattern, a 16th later, changed by f
    // The new arp plays a chord shape and `.off` adds an echo one octave up
    // (+7 scale steps).
    const bell = (p: Pattern) =>
      p.s("triangle").attack(0.005).decay(0.16).sustain(0).release(0.1).lpf(3200);

    const ch11: Scene = {
      pulse: pump(s("bd*4").bank(KIT)),
      snare: s("~ sd ~ <sd!3 [sd sd]>").bank(KIT).room(0.15),
      hats: s("[hh!3 oh]*2").bank(KIT).velocity(perlin.range(0.55, 1)).sometimesBy(0.2, (x) => x.ply(2)),
      perc: s("rim(3,8,2)").bank(KIT).jux(rev),
      bass: acidBass(n("0 ~ 0 7 ~ 0 7 0").add(n("<0 -2 2 -1>")).scale("D2:minor"))
        .lpf(sine.range(200, 700).slow(8))
        .every(4, (x) => x.ply(2)),
      chords: hall(pad(chord("<Dm7 Bb^7 F^7 C7>").voicing()).lpf(1800)),
      lead: echoes(squareLead(n(`<
        [4 ~ 4 6 ~ 4 2@2] [~ 2 ~ 2 4 2 0@2] [4 ~ 4 6 ~ 8 6@2] [5 ~ 3 1 ~ 3@3]
        [4 ~ 4 6 ~ 7 9@2] [~ 9 ~ 7 5 4 2@2] [4 ~ 6 8 ~ 6 4@2] [3 ~ 1 -1 ~ 0@3]
      >`).scale("D4:minor"))),
      arp: echoes(bell(
        n("[0 2 4 7]*2").add(n("<0 -2 2 -1>")).off(1 / 16, (x) => x.add(n(7))).scale("D4:minor")
      )),
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 12 · TRACKS & THE MIXER — the breakdown
    // ─────────────────────────────────────────────────────────────────────────
    // `stack(a, b)` plays patterns at the same time. The chords track below
    // stacks the pad and the piano into one part.
    // A song returns its parts as a record of NAMED tracks:
    //   return { pulse, snare, hats, perc, bass, chords, lead, arp }
    // and the player stacks them for you. The names become the mixer strips
    // on the stage, and the number keys follow their order. Try it now:
    // Shift+6 solos the chords, Shift+8 the arp, 0 brings everything back.
    // The drums drop out here to give you a breather.
    const ch12: Scene = {
      hats: s("hh*8").bank(KIT).velocity(perlin.range(0.25, 0.55)),
      bass: n("<0 -2 2 -1>").scale("D2:minor").s("sine").attack(0.05).release(0.6).gain(1.1),
      chords: hall(stack(
        pad(chord("<Dm7 Bb^7 F^7 C7>").voicing()).lpf(sine.range(700, 2000).slow(8)),
        chord("<Dm7 Bb^7 F^7 C7>").voicing().struct("x ~ ~ x ~ ~ x ~").s("piano").gain(0.45)
      )),
      arp: echoes(bell(
        n("[0 2 4 7]*2").add(n("<0 -2 2 -1>")).off(1 / 16, (x) => x.add(n(7))).scale("D4:minor")
      )).lpf(saw.range(600, 3200).slow(8)),
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 13 · ARRANGE — the build-up
    // ─────────────────────────────────────────────────────────────────────────
    // `arrange([bars, pattern], …)` plays patterns one after another, each
    // for a number of bars. Inside this chapter: the kick goes half-time →
    // straight → double time, and the snare rolls faster and faster. Saw
    // signals turn everything up and open the filters over the 8 bars.
    // The whole song is one big arrange too (THE MIX, at the bottom), and
    // `sections: SECTIONS` gives the timeline its chapters. Press L to loop
    // one.
    const ch13: Scene = {
      pulse: pump(arrange([4, s("bd ~ ~ ~ bd ~ ~ ~")], [3, s("bd*4")], [1, s("bd*8")]).bank(KIT)),
      snare: arrange([4, s("~ sd ~ sd")], [2, s("sd*8")], [2, s("sd*16")])
        .bank(KIT)
        .velocity(saw.range(0.35, 1).slow(8))
        .room(0.15),
      hats: s("hh*16").bank(KIT).velocity(saw.range(0.25, 0.9).slow(8)),
      perc: s("white*16").decay(0.07).sustain(0).hpf(saw.range(500, 9000).slow(8))
        .velocity(saw.range(0.05, 0.7).slow(8)), // a noise "riser"
      bass: acidBass(n("0*8").add(n("<0 -2 2 -1>")).scale("D2:minor")).lpf(saw.range(200, 900).slow(8)),
      chords: hall(pad(chord("<Dm7 Bb^7 F^7 C7>").voicing()).lpf(saw.range(500, 3500).slow(8))),
      arp: echoes(bell(
        n("[0 2 4 7]*2").add(n("<0 -2 2 -1>")).off(1 / 16, (x) => x.add(n(7))).scale("D4:minor")
      )).lpf(saw.range(1200, 5000).slow(8)),
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 14 · FINALE
    // ─────────────────────────────────────────────────────────────────────────
    // Everything at once: the 909 groove with a clap stacked on the snare
    // and a crash on the downbeat, the acid bass, pad + piano, the hook
    // doubled an octave up with `.superimpose()`, and the arp. Then the tour
    // starts over from the single kick.
    const ch14: Scene = {
      pulse: pump(s("bd*4").bank(KIT)),
      snare: stack(s("~ sd ~ <sd!3 [sd sd]>"), s("~ cp ~ cp").gain(0.6)).bank(KIT).room(0.15),
      hats: s("[hh!3 oh]*2").bank(KIT).velocity(perlin.range(0.55, 1)).sometimesBy(0.2, (x) => x.ply(2)),
      perc: stack(s("rim(3,8,2)").jux(rev), s("<cr ~!7>").gain(0.7)).bank(KIT),
      bass: acidBass(n("0 ~ 0 7 ~ 0 7 0").add(n("<0 -2 2 -1>")).scale("D2:minor"))
        .lpf(sine.range(250, 800).slow(8))
        .every(4, (x) => x.ply(2)),
      chords: hall(stack(
        pad(chord("<Dm7 Bb^7 F^7 C7>").voicing()).lpf(2400),
        chord("<Dm7 Bb^7 F^7 C7>").voicing().struct("x ~ ~ x ~ ~ x ~").s("piano").gain(0.45)
      )),
      lead: echoes(squareLead(n(`<
        [4 ~ 4 6 ~ 4 2@2] [~ 2 ~ 2 4 2 0@2] [4 ~ 4 6 ~ 8 6@2] [5 ~ 3 1 ~ 3@3]
        [4 ~ 4 6 ~ 7 9@2] [~ 9 ~ 7 5 4 2@2] [4 ~ 6 8 ~ 6 4@2] [3 ~ 1 -1 ~ 0@3]
      >`).superimpose((x) => x.add(n(7))).scale("D4:minor"))),
      arp: echoes(bell(
        n("[0 2 4 7]*2").add(n("<0 -2 2 -1>")).off(1 / 16, (x) => x.add(n(7))).scale("D4:minor")
      )),
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 🎚️ THE MIX — the scenes laid end to end, one per SECTIONS row
    // ─────────────────────────────────────────────────────────────────────────
    // For each track, `arrange` plays that track's part from every scene for
    // that chapter's bars (silence where a scene leaves the track out).
    // LEVELS are the faders: `postgain` sets a track's volume after its
    // effects, like a channel fader on a mixing desk.
    const SCENES: Scene[] = [ch1, ch2, ch3, ch4, ch5, ch6, ch7, ch8, ch9, ch10, ch11, ch12, ch13, ch14];
    const LEVELS: Record<Track, number> = {
      pulse: 1,
      snare: 0.7,
      hats: 0.45,
      perc: 0.5,
      bass: 0.6,
      chords: 0.55,
      lead: 0.42,
      arp: 0.3,
    };

    const tracks = {} as Record<Track, Pattern>;
    for (const track of TRACKS) {
      const parts = SECTIONS.map(([, bars], i): [number, Pattern] => [bars, SCENES[i][track] ?? silence]);
      tracks[track] = arrange(...parts).postgain(LEVELS[track]);
    }
    return tracks;
  },
};

export default song;
