// ═══════════════════════════════════════════════════════════════════════════
// 🎵 TIDEPOOLS — generative ambient
// ═══════════════════════════════════════════════════════════════════════════
//
// A piece that never quite repeats. Nothing here is a fixed loop of bars:
//
//   • Every random choice (irand, rand, perlin, choose…) picks *scale degrees*
//     via n(...).scale(...), so chance can only ever land on a consonant note.
//   • Each layer swells in and out on its own slow "tide" (24, 40, 56 bars…).
//     The periods don't divide each other, so the texture keeps shifting and
//     takes hours to line up again. That breathing *is* the arrangement:
//     at the start only the drone, pad, shore and first tape loop sound, and
//     the other layers wash in one by one over the first couple of minutes.
//   • The piano "tape loops" are short phrases slowed to 7, 9, 11 and 13 bars,
//     like Eno's Music for Airports: they drift against each other and the
//     chords, making new melodies out of the gaps.
//
// Strudel's randomness is seeded by time, so a given bar always sounds the same
// on replay, but the piece itself never repeats.
//
// ═══════════════════════════════════════════════════════════════════════════

import type { Song } from ".";

// ─────────────────────────────────────────────────────────────────────────────
// 🎛️ KNOBS — change these while it plays
// ─────────────────────────────────────────────────────────────────────────────

const BPM = 70;
const KEY = "D";
const MODE = "lydian"; // dreamy raised 4th. Try "dorian" with PROGRESSION "<0 3 -1 0>"
const PROGRESSION = "<0 1 -2 -3>"; // chord roots as scale degrees: I II vi V = D E Bm A
const CHORD_BARS = 4; // how long each chord lasts
const CHORD_SHAPE = "[0,2,4,8]"; // stacked degrees on each root: triad + 9th (add9)

// Tide periods in bars: when each layer swells in and out (keep them coprime-ish)
const TIDES = { bells: 24, harp: 40, pebbles: 56 };

const BEAT = 60 / BPM; // one beat in seconds, for tempo-synced delays

/** A scale string for `.scale()`, e.g. inKey(4) → "D4:lydian" */
const inKey = (octave: number) => `${KEY}${octave}:${MODE}`;

/** A slow 0 → 1 → 0 swell lasting `bars` cycles; it starts at 0 when the piece begins */
const tide = (bars: number) => sine.slow(bars).late(bars / 4);

/** Let a layer breathe with its tide: thinned to silence at low tide, almost every note at high tide */
const breathe = (pat: Pattern, bars: number, fullness = 0.85) =>
  pat
    // segment(4) samples the tide once per beat, so the thinning is the same however Strudel slices time
    // @ts-expect-error degradeBy accepts a pattern (here a signal) — missing from strudel.d.ts
    .degradeBy(tide(bars).range(1, 1 - fullness).segment(4))
    .velocity(tide(bars).range(0.5, 1)); // and play softer as it ebbs

// Strudel's rand is seeded by *time*: every random thing that happens at the same moment
// rolls the same dice. degradeBy() uses rand too, so without care the notes that survive
// the thinning would always be the high ones. Shifting a random signal in time with late()
// gives it its own, independent dice.
const dice = (seed: number) => rand.late(seed);

const song: Song = {
  name: "Tidepools",
  bpm: BPM,
  visualization: { type: "pianoroll", options: { cycles: 8, labels: false } },

  createPattern() {
    // Reverb and delay live per orbit, and an orbit's reverb is rebuilt
    // whenever its size changes, so layers sharing a space share an orbit:
    //   1 = drone + pad (deep hall) · 2 = bells + pebbles (cave, echoes)
    //   3 = piano + harp (room)     · 4 = shore (open air)

    // ─────────────────────────────────────────────────────────────────────────
    // 🌑 DRONE — a pedal on the tonic and fifth that never moves.
    // Over the E chord it becomes E/D, the signature Lydian sound.
    // ─────────────────────────────────────────────────────────────────────────

    const drone = n("[0,4]")
      .slow(8) // one 8-bar breath per note; long attack/release crossfade them
      .scale(inKey(2))
      .s("triangle")
      .attack(4)
      .release(8)
      .sustain(1)
      .lpf(perlin.slow(16).range(250, 600))
      .gain(perlin.slow(24).range(0.22, 0.34))
      .room(0.4)
      .rsize(8)
      .orbit(1);

    // ─────────────────────────────────────────────────────────────────────────
    // ☁️ PAD — add9 chords on a slow progression, very slow attack.
    // superimpose() adds a copy detuned by a few cents for a soft chorus.
    // ─────────────────────────────────────────────────────────────────────────

    const pad = n(`${PROGRESSION}/${CHORD_BARS}`)
      .add(n(CHORD_SHAPE)) // root + chord shape, both in scale degrees
      .scale(inKey(3))
      .superimpose((x) => x.add(note(0.08)))
      .s("triangle")
      .attack(3)
      .release(6)
      .sustain(0.8)
      .lpf(perlin.slow(12).range(500, 1400))
      .hpf(120)
      .gain(0.14)
      .pan(sine.slow(13).range(0.3, 0.6))
      .room(0.7)
      .rsize(8)
      .orbit(1);

    // ─────────────────────────────────────────────────────────────────────────
    // 📼 TAPE LOOPS — four short piano phrases, each stretched over a different
    // number of bars (7, 9, 11, 13). They phase against each other and only
    // realign every 9009 bars. Steps don't fall on the beat grid at all.
    // ─────────────────────────────────────────────────────────────────────────

    const loops = stack(
      n("4 [~ 2] ~ ~ 7 ~ ~ ~").slow(7),
      n("~ ~ 6 ~ [3 ~] ~ ~ ~ ~").slow(9),
      n("~ -1 ~ ~ 2 ~ 1 ~ ~ ~").slow(11),
      n("-3 ~ ~ ~ ~ -5 ~ ~").slow(13)
    )
      .sometimesBy(0.15, (x) => x.add(n(7))) // now and then a note jumps an octave
      .scale(inKey(4))
      .s("piano")
      .velocity(dice(0.37).range(0.45, 0.8)) // a human, uneven touch
      .gain(0.6)
      .hpf(100)
      .delay(0.25)
      .delaytime(BEAT) // a quarter note (Web Audio caps delay time at 1s)
      .delayfeedback(0.4)
      .room(0.55)
      .rsize(6)
      .orbit(3);

    // ─────────────────────────────────────────────────────────────────────────
    // ✨ BELLS — random scale notes on an 11-step rhythm squeezed into 8 slots
    // ({…}%8 polymeter), so the rhythm rotates every bar. wchoose() picks the
    // instrument per note (mostly vibraphone), off() adds a delayed fifth.
    // ─────────────────────────────────────────────────────────────────────────

    const bells = breathe(
      // @ts-expect-error n() accepts a pattern (here irand) — missing from strudel.d.ts
      n(irand(10).late(0.31)) // a scale degree 0–9, with its own dice
        .struct("{x ~ ~ x ~ x ~ ~ ~ x ~}%8")
        .off(3 / 16, (x) => x.add(n(4)).degradeBy(0.5))
        .scale(inKey(5)),
      TIDES.bells,
      0.7
    )
      // @ts-expect-error wchoose is missing from strudel.d.ts
      .s(wchoose(["vibraphone_soft", 4], ["glockenspiel", 1], ["handchimes", 2]).late(0.47))
      .gain(0.32)
      .pan(dice(0.73).range(0.15, 0.85)) // each bell rings somewhere new
      .hpf(300)
      .delay(0.35)
      .delaytime(BEAT * 0.75) // dotted eighth
      .delayfeedback(0.45)
      .room(0.7)
      .rsize(10)
      .orbit(2);

    // ─────────────────────────────────────────────────────────────────────────
    // 🌊 HARP — a melody drawn by perlin noise: smooth random contours that rise
    // and fall like water, sampled into eighth notes with segment().
    // ─────────────────────────────────────────────────────────────────────────

    const harp = breathe(
      // @ts-expect-error n() accepts a pattern (here a perlin signal) — missing from strudel.d.ts
      n(perlin.slow(3).range(-2, 10).segment(8).floor())
        .scale(inKey(4))
        .sometimesBy(0.25, (x) => x.ply(2)), // the odd quick flutter
      TIDES.harp,
      0.6
    )
      .s("harp")
      .gain(0.4)
      .pan(perlin.slow(5).range(0.25, 0.75))
      .hpf(150)
      .delay(0.25)
      .delaytime(BEAT) // a quarter note (Web Audio caps delay time at 1s)
      .delayfeedback(0.4)
      .room(0.55)
      .rsize(6)
      .orbit(3);

    // ─────────────────────────────────────────────────────────────────────────
    // 🪨 PEBBLES — low marimba motifs. chooseCycles() picks a different motif
    // (or a rest) every 2 bars; juxBy() plays it reversed on the other side.
    // ─────────────────────────────────────────────────────────────────────────

    const pebbles = breathe(
      // @ts-expect-error chooseCycles is missing from strudel.d.ts (and n() of a pattern)
      n(chooseCycles("0 ~ 4 ~ ~ 2 ~ ~", "~ 4 ~ 7 ~ ~ ~ ~", "[0 4] ~ ~ ~ 2 ~ -1 ~", "~"))
        .slow(2)
        .juxBy(0.5, (x) => x.rev())
        .scale(inKey(3)),
      TIDES.pebbles,
      0.9
    )
      .s("marimba")
      .gain(0.38)
      .lpf(2500)
      .delay(0.35)
      .delaytime(BEAT * 0.75)
      .delayfeedback(0.45)
      .room(0.7)
      .rsize(10)
      .orbit(2);

    // ─────────────────────────────────────────────────────────────────────────
    // 🐚 SHORE — pink-noise waves (each a 3-bar swell through a wandering
    // low-pass), the occasional ocean drum, and a rare shimmer of wind chimes.
    // ─────────────────────────────────────────────────────────────────────────

    const waves = s("pink")
      .slow(3)
      .attack(3)
      .release(4)
      .sustain(0.7)
      .lpf(perlin.slow(5).range(300, 1200))
      .hpf(150)
      .gain(perlin.slow(9).range(0.05, 0.1))
      .pan(sine.slow(11).range(0.3, 0.7));

    const oceanDrum = s("oceandrum")
      .n(irand(3).late(0.19)) // one of three recordings
      .struct("<x ~ ~ ~ ~ [~ x] ~ ~ ~>")
      .degradeBy(0.3)
      .gain(0.25)
      .pan(dice(0.53).range(0.3, 0.7));

    const chimes = s("marktrees")
      .n(irand(6))
      .struct("<~ ~ ~ ~ ~ ~ x ~ ~ ~ ~ ~ ~>")
      .gain(0.12)
      .hpf(2000)
      .pan(dice(0.61));

    const shore = stack(waves, oceanDrum, chimes).room(0.4).rsize(4).orbit(4);

    // ─────────────────────────────────────────────────────────────────────────
    // 🎚️ TRACKS
    // ─────────────────────────────────────────────────────────────────────────

    return { drone, pad, loops, bells, harp, pebbles, shore };
  },
};

export default song;
