// ═══════════════════════════════════════════════════════════════════════════
// 🌅 FIRST LIGHT — ambient starter
// ═══════════════════════════════════════════════════════════════════════════
//
// D major (with a Lydian G chord), 64 BPM, no drums. Ambient is about space
// and slow change: long attacks, long tails, and a few quiet voices that
// leave room for the reverb to become the instrument.
//
//   dawn 8 → bloom 16 → drift 8   (32 bars ≈ 2 minutes, then loops)
//
// The chords last 2 bars each, so the 4-chord progression fills 8 bars and
// every section starts on the D chord: drift fades back into dawn seamlessly.
//
// 🧪 Try this:
//   • turn "brightness" right down for a muffled, underwater dawn
//   • turn "space" up to 1 and let the hall swallow everything
//   • "drift" speeds up the slow wobbles (filters, panning, the noise swells)
//   • swap PROG for a darker cycle, e.g. "<Dm9 Bb^9 Gm11 A7sus>/2"
//   • change the bells' sound: "kalimba", "handchimes", "glockenspiel"…
//
// ═══════════════════════════════════════════════════════════════════════════

import type { Song } from "../songs";

// ─── 🎛️ KNOBS ───────────────────────────────────────────────────────────────

const BPM = 64;
const BEAT = 60 / BPM; // one quarter note in seconds (for delay times)
const BRIGHTNESS = knob("brightness", 1400, 300, 5000, { log: true }); // Hz: where the pad filter sits
const SPACE = knob("space", 0.6, 0, 1); // reverb send on every layer (and a bit more echo)
const DRIFT = knob("drift", 1, 0.25, 4, { log: true }); // × the speed of every slow wobble

// Chord symbols voiced by chord().voicing() ("^" = major 7th, "#11" = Lydian).
// "/2" stretches the <…> sequence so each chord lasts 2 bars.
const PROG = "<D^9 Bm11 G^9#11 A9sus>/2"; // I – vi – IV – V(sus): never quite resolves

// The form: [section, bars]. Every track below says what it plays in each section.
type Section = "dawn" | "bloom" | "drift";
const FORM: [Section, number][] = [
  ["dawn", 8],
  ["bloom", 16],
  ["drift", 8],
];

// ─── 🎚️ MIX — faders in dB on top of each part's own gain ──────────────────
// Set from measurements (`npm run analyze -- starters/ambient`, see docs/audio-tools.md):
// about −17.5 LUFS integrated, sample peak around −4 dBFS. With no drums the peaks
// stay low, so the slow parts can sit at the house loudness without clipping.
const MASTER_DB = 1.7;
const FADERS_DB: Record<string, number> = {
  drone: -5, // was the loudest part (−2.6 dB vs the mix) and 43% sub: it should sit under the pads
  melody: 6, // the piano was 14 dB under the mix
  bells: -2, // stood out over the pads in the dawn
  texture: 20, // the noise waves were 33 dB under the mix: inaudible
};
/** Every track through its fader (postgain: after drive/shape, before the delay/reverb sends) */
const mixdown = (tracks: Record<string, Pattern>): Record<string, Pattern> =>
  Object.fromEntries(
    Object.entries(tracks).map(([name, p]) => [name, p.postgain(10 ** ((MASTER_DB + (FADERS_DB[name] ?? 0)) / 20))])
  );

const song: Song = {
  name: "First Light",
  bpm: BPM,
  visualization: { type: "pianoroll", options: { cycles: 8, labels: false } },
  sections: FORM, // the player's timeline (jump / loop)
  room: "dusk", // soft, lush lamps

  createPattern() {
    // ─── 🧰 HELPERS ───────────────────────────────────────────────────────────

    // Lay a track out over the FORM: sections it doesn't mention stay silent.
    // arrange() restarts each section at its own bar 1.
    const track = (parts: Partial<Record<Section, Pattern>>): Pattern =>
      arrange(...FORM.map(([name, bars]) => [bars, parts[name] ?? silence] as [number, Pattern]));

    // A slow random wobble lasting about `bars` bars, sped up or slowed by DRIFT
    const wobble = (bars: number) => perlin.slow(bars).fast(DRIFT);

    // Reverb and delay live per orbit, so each layer gets its own space:
    //   1 = pads + drone (big hall) · 2 = bells (echoes) · 3 = melody (echoes)
    //   4 = texture (open air)

    // ─── 🌑 DRONE ─────────────────────────────────────────────────────────────
    // A pedal on D (with its fifth) that never moves: every chord in PROG has
    // a D in it, so the drone glues them together. Each note lasts 4 bars and
    // the long attack/release crossfade one into the next: no pulse at all.

    const droneNotes = note("[d1,a1,d2]")
      .slow(4)
      .s("triangle")
      .attack(3)
      .sustain(1)
      .release(5)
      .lpf(wobble(12).range(220, 420))
      .gain(0.3)
      .room(SPACE.mul(0.4))
      .rsize(8)
      .orbit(1);

    const drone = track({ dawn: droneNotes, bloom: droneNotes, drift: droneNotes });

    // ─── ☁️ PADS ──────────────────────────────────────────────────────────────
    // Detuned supersaw chords with a very slow attack. The filter envelope
    // (lpenv + lpattack) makes each chord bloom open over a few seconds;
    // the wobble moves where it blooms from, chord to chord.

    const pad = (cutoff: number | Pattern) =>
      chord(PROG)
        .anchor("a5") // voiced up high (top note near A5): airy, not muddy
        .voicing()
        .s("supersaw")
        .detune(0.25)
        .spread(0.8) // wide stereo
        .attack(2.5)
        .sustain(0.9)
        .release(4)
        .lpf(cutoff)
        .lpenv(1.5) // the filter opens 1.5 octaves above the cutoff…
        .lpattack(4) // …over 4 seconds…
        .lpdecay(3)
        .lpsustain(0.4) // …then settles back part of the way
        .hpf(240) // thin the low-mids: the drone owns the bottom
        .gain(0.16)
        .pan(sine.slow(11).fast(DRIFT).range(0.35, 0.65))
        .room(SPACE)
        .rsize(8)
        .orbit(1);

    const pads = track({
      dawn: pad(BRIGHTNESS.mul(saw.slow(8).range(0.5, 0.9))), // first light: opening up over 8 bars
      bloom: pad(BRIGHTNESS.mul(wobble(8).range(0.8, 1.4))),
      drift: pad(BRIGHTNESS.mul(saw.slow(8).range(0.9, 0.5))), // closing again, back to dawn
    });

    // ─── ✨ BELLS ─────────────────────────────────────────────────────────────
    // A slow arpeggio through the current chord: n() picks notes of the voicing
    // (0 = lowest). "?" drops a note at random, so the pattern breathes.
    // A dotted-8th echo turns a handful of notes into a shimmering cloud.

    const bellLine = n("0 ~ 2 ~ 4? ~ 3 [~ 5?]")
      .chord(PROG)
      .voicing()
      .add(note(12)) // up an octave, into glass territory
      .s("vibraphone_soft")
      .velocity(wobble(3).range(0.55, 0.9))
      .gain(0.4)
      .hpf(400)
      .pan(sine.slow(5).fast(DRIFT).range(0.2, 0.8))
      .delay(SPACE.mul(0.4).add(0.15))
      .delaytime(BEAT * 0.75) // dotted 8th
      .delayfeedback(0.5)
      .room(SPACE.mul(0.9))
      .rsize(10)
      .orbit(2);

    const bells = track({
      dawn: bellLine.mask("<0 0 0 0 1 1 1 1>"), // the sun comes up in bar 5
      bloom: bellLine,
      drift: bellLine.degradeBy(0.5), // thinning out
    });

    // ─── 🎹 MELODY ────────────────────────────────────────────────────────────
    // A sparse piano tune, 2 bars per chord, mostly long notes with gaps.
    // Lots of delay: the echoes answer each phrase.

    const piano = (p: Pattern) =>
      p
        .s("piano")
        .velocity(wobble(2).range(0.5, 0.75))
        .gain(0.55)
        .lpf(3200)
        .release(2)
        .delay(SPACE.mul(0.5).add(0.1))
        .delaytime(BEAT) // a quarter note (Web Audio caps delay time at 1 s)
        .delayfeedback(0.45)
        .room(SPACE.mul(0.8))
        .rsize(6)
        .pan(0.45)
        .orbit(3);

    const melody = track({
      bloom: piano(
        note(
          "<[~@2 a4 e5@3 f#5@2] [e5@6 ~@2] [~@2 d5 e5 f#5@2 a5@2] [e5@5 ~@3] [~@2 b4 c#5 d5@2 f#5@2] [e5@4 d5@2 ~@2] [~@2 e5 d5 b4@4] [a4@6 ~@2]>"
        )
      ),
      // Just the first phrase, an octave lower, as the light fades
      drift: piano(note("<[~@2 a3 e4@3 f#4@2] [e4@6 ~@2] ~ ~ ~ ~ ~ ~>")),
    });

    // ─── 🌊 TEXTURE ───────────────────────────────────────────────────────────
    // Pink noise "shore" waves: each a 4-bar swell through a wandering low-pass,
    // plus a low brown-noise rumble like distant wind.

    const waves = s("pink")
      .slow(4)
      .attack(5)
      .sustain(0.7)
      .release(6)
      .lpf(wobble(5).range(400, 1800))
      .hpf(500)
      .gain(0.12)
      .pan(sine.slow(7).fast(DRIFT).range(0.25, 0.75));

    const wind = s("brown").slow(8).attack(4).sustain(1).release(6).lpf(300).hpf(60).gain(0.06);

    const shore = stack(waves, wind).room(SPACE.mul(0.6)).rsize(4).orbit(4);

    const texture = track({ dawn: shore, bloom: shore, drift: shore });

    // ─── 🎚️ TRACKS ────────────────────────────────────────────────────────────

    return mixdown({ drone, pads, bells, melody, texture });
  },
};

export default song;

/** For the "new song" flow */
export const meta = {
  id: "ambient",
  genre: "Ambient",
  blurb: "Slow supersaw pads bloom over a D drone, with glassy vibraphone echoes, a sparse piano and noise waves.",
};
