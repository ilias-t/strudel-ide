// ═══════════════════════════════════════════════════════════════════════════
// 🎵 LATE NIGHT STUDY — lo-fi hip hop
// ═══════════════════════════════════════════════════════════════════════════
//
// F major (D minor's relative), 82 BPM, swung boom-bap drums, jazzy piano.
//
//   intro 4 → A 8 → B 8 → A 8 → break 4 → B 8 → outro 8   (48 bars, then loops)
//
// Things to try while it plays:
//   • SWING: 0 = straight robot, 1/3 = triplet shuffle, 0.4+ = drunk Dilla
//   • swap the chord symbols in PROG_A / PROG_B (any iReal symbol: m9, ^7, 7#9, 13…)
//   • change the drum banks (EmuSP12, AkaiXR10, LinnDrum…) for a different dust
//   • reorder or resize FORM to rearrange the whole song
//
// ═══════════════════════════════════════════════════════════════════════════

import type { Song } from ".";

// ─── 🎛️ KNOBS ───────────────────────────────────────────────────────────────

const BPM = 82;
const BEAT = 60 / BPM; // one quarter note in seconds (for delay times)
const SWING = knob("swing", 0.3, 0, 0.5, 0.01); // how late the off-beat 8ths fall (0.33 = triplet swing)

// Chord symbols are voiced automatically by chord().voicing() (iReal dictionary).
// "^" = major 7th, so F^9 = Fmaj9.
const PROG_A = "<Gm9 C9 F^9 D7#9>"; // ii – V – I – VI7 (the D7#9 pulls back to Gm)
const PROG_B = "<Bb^9 A7b13 Dm9 G13>"; // IV – III7 – vi – II7 (G13 → Gm9 is a sweet B→Bb slide)

const KICK_BANK = "AkaiMPC60";
const SNARE_BANK = "EmuSP12";
const HAT_BANK = "AkaiMPC60";

// The form: [section, bars]. Every track below says what it plays in each section.
type Section = "intro" | "A1" | "B1" | "A2" | "break" | "B2" | "outro";
const FORM: [Section, number][] = [
  ["intro", 4],
  ["A1", 8],
  ["B1", 8],
  ["A2", 8],
  ["break", 4],
  ["B2", 8],
  ["outro", 8],
];

// ─── 🎚️ MIX — faders in dB on top of each part's own gain ──────────────────
// Set from measurements (`npm run analyze -- lofi-study`, see docs/audio-tools.md).
// There's no limiter on the output, so MASTER_DB keeps the peaks under 0 dBFS.
const MASTER_DB = -1.5;
const FADERS_DB: Record<string, number> = {
  kick: -4, // set the peaks (kick + bass stacked over 0 dBFS)
  snare: -4, // peaked over 0 dBFS on its own and was 61% of the highs
  vinyl: 12, // was 35-38 dB under the mix: inaudible
  keys: 2, // the chords were 12-13 dB under the mix
};
/** Every track through its fader (postgain: after drive/shape, before the delay/reverb sends) */
const mixdown = (tracks: Record<string, Pattern>): Record<string, Pattern> =>
  Object.fromEntries(
    Object.entries(tracks).map(([name, p]) => [name, p.postgain(10 ** ((MASTER_DB + (FADERS_DB[name] ?? 0)) / 20))])
  );

const song: Song = {
  name: "Late Night Study",
  bpm: BPM,
  visualization: { type: "pianoroll", options: { cycles: 8, labels: false } },
  sections: FORM, // the player's timeline (jump / loop)

  createPattern() {
    // ─── 🧰 HELPERS ───────────────────────────────────────────────────────────

    const REST = s("~");

    // Lay a track out over the FORM: sections it doesn't mention stay silent.
    // arrange() restarts each section's pattern at its own bar 1, so a
    // "<…>" sequence of 8 bars lines up with an 8-bar section.
    const track = (parts: Partial<Record<Section, Pattern>>): Pattern =>
      arrange(...FORM.map(([name, bars]) => [bars, parts[name] ?? REST] as [number, Pattern]));

    // One bar per string → a "<[bar1] [bar2] …>" sequence (one bar per cycle)
    const bars = (...b: string[]) => `<${b.map((bar) => `[${bar}]`).join(" ")}>`;

    // The lazy part: swingBy delays every 2nd 8th-note within each beat (4 per bar)
    const groove = (p: Pattern): Pattern =>
      p.swingBy(SWING, 4);

    // Jazz voicings from chord symbols (rootless, voice-led around C5)
    const voiced = (prog: string, rhythm: string): Pattern =>
      chord(prog).struct(rhythm).voicing();

    // ─── 📀 VINYL ─────────────────────────────────────────────────────────────
    // A bed of crackle (random clicks; density = clicks per sample) plus faint
    // pink-noise tape hiss. One long note per bar, gain wanders a little with perlin.

    const crackleBed = s("crackle")
      .density(0.025)
      .attack(0.02)
      .sustain(1)
      .release(0.05)
      .hpf(700)
      .lpf(6000)
      .gain(perlin.range(0.16, 0.3))
      .orbit(4);

    const hiss = s("pink").attack(0.02).sustain(1).release(0.05).hpf(2500).lpf(9000).gain(knob("hiss", 0.035, 0, 0.12, 0.005)).orbit(4);

    const vinylBed = stack(crackleBed, hiss);
    const vinyl = track({
      intro: vinylBed,
      A1: vinylBed,
      B1: vinylBed,
      A2: vinylBed,
      break: vinylBed,
      B2: vinylBed,
      outro: vinylBed,
    });

    // ─── 🥁 DRUMS ─────────────────────────────────────────────────────────────
    // Boom-bap on an 8th-note grid (8 steps per bar), swung by groove().
    // Bar 4 of each phrase varies the kick, bar 8 is a little fill.

    const KICK_MAIN = "bd ~ ~ bd bd ~ ~ ~"; // 1, and-of-2, 3
    const KICK_VAR = "bd ~ ~ bd ~ bd ~ ~"; // 1, and-of-2, and-of-3
    const KICK_FILL = "bd ~ ~ bd ~ bd ~ bd";
    const kickBeat = s(bars(KICK_MAIN, KICK_MAIN, KICK_MAIN, KICK_VAR, KICK_MAIN, KICK_MAIN, KICK_VAR, KICK_FILL))
      .bank(KICK_BANK)
      .gain(0.9)
      .lpf(3000)
      // Sidechain: every kick dips the piano's orbit (2) a little → gentle pump
      .duckorbit(2)
      .duckdepth(0.35)
      .duckattack(0.18);

    const kick = groove(
      track({
        A1: kickBeat,
        B1: kickBeat,
        A2: kickBeat,
        B2: kickBeat,
        outro: kickBeat.mask("<1 1 1 1 0 0 0 0>"), // drums leave halfway through the outro
      })
    );

    // Backbeat on 2 & 4, nudged a few ms late (seconds) for that lazy drag.
    // Ghost notes: quiet, and "?" drops them at random so no two bars match.
    // Bar 8 of each phrase ends with a little three-hit fill.
    const backbeat = s("~ sd ~ sd").gain(0.75);
    const ghosts = s("~ ~ ~ ~ ~ sd? ~ sd?").gain(0.13).lpf(2500);
    const fill = s(bars("~", "~", "~", "~", "~", "~", "~", "~ ~ ~ ~ ~ sd sd sd")).gain(0.4);
    const snareBeat = stack(backbeat, ghosts, fill).bank(SNARE_BANK).nudge(0.012).room(0.15).orbit(1);
    // A two-hit pickup at the end of the break, to throw back into the groove
    const pickup = s("<~ ~ ~ [~ ~ ~ ~ ~ ~ sd sd]>").bank(SNARE_BANK).gain(0.45).nudge(0.012);

    const snare = groove(
      track({
        A1: snareBeat,
        B1: snareBeat,
        A2: snareBeat,
        break: pickup,
        B2: snareBeat,
        outro: snareBeat.mask("<1 1 1 1 0 0 0 0>"),
      })
    );

    // Hats: 8ths with an accent on the beat, perlin "velocity" drift,
    // a random 16th double now and then, and tiny timing jitter (humanize).
    const hatBeat = s("hh*8")
      .bank(HAT_BANK)
      .gain(square.range(0.42, 0.26).fast(4)) // loud on the beat, soft off it
      .velocity(perlin.range(0.7, 1).slow(3))
      .sometimesBy(0.1, (x) => x.ply(2))
      .nudge(rand.range(-0.006, 0.006))
      .lpf(7000)
      .pan(0.6);
    const openHat = s("~ ~ ~ ~ ~ ~ ~ oh").bank(HAT_BANK).gain(0.22).lpf(6000).pan(0.6);

    const hats = groove(
      track({
        intro: hatBeat.mask("<0 0 1 1>").velocity(0.6), // creeping in
        A1: hatBeat,
        B1: stack(hatBeat, openHat),
        A2: hatBeat,
        B2: stack(hatBeat, openHat),
        outro: hatBeat.mask("<1 1 1 1 1 1 0 0>"), // hats hang on 2 bars longer
      })
    );

    // Extra percussion for the busier sections: a soft shaker + rimshot.
    const shaker = s("shaker_small*8").gain(square.range(0.1, 0.18).fast(4)).hpf(3000).pan(0.35);
    const rim = s("~ ~ ~ rim ~ ~ ~ ~").bank(KICK_BANK).gain(0.25).pan(0.3).sometimesBy(0.25, (x) => x.late(1 / 8));

    const perc = groove(
      track({
        B1: shaker,
        A2: stack(shaker, rim),
        B2: stack(shaker, rim),
      })
    );

    // ─── 🎹 KEYS ──────────────────────────────────────────────────────────────
    // Piano comping: hit on 1, sometimes a re-strike late in the bar ("?" = maybe).
    // vib = slow pitch wobble (Hz : semitones) → warped-tape "wow".
    // Keys sit on orbit 2 so the kick can duck them.

    const COMP = bars("x@5 x?@3", "x@6 x@2", "x@5 x?@3", "x@3 x@5");
    const piano = (p: Pattern, cutoff: number | Pattern) =>
      p
        .s("piano")
        .gain(0.3)
        .velocity(perlin.range(0.8, 1))
        .release(0.6)
        .lpf(cutoff)
        .vib("0.6:0.08")
        .room(0.35)
        .orbit(2);

    // Break: the A changes as a slow broken-chord arpeggio — n() picks voicing notes
    const arpeggio = n("0 1 2 3 4 3 2 1").chord(PROG_A).voicing();

    const keys = groove(
      track({
        intro: piano(voiced(PROG_A, "x"), 900), // muffled, "from the next room"
        A1: piano(voiced(PROG_A, COMP), sine.range(2200, 3200).slow(8)),
        B1: piano(voiced(PROG_B, COMP), 3000),
        A2: piano(voiced(PROG_A, COMP), 3400),
        break: piano(arpeggio, 1500).delay(0.3).delaytime(BEAT * 0.75).delayfeedback(0.35),
        B2: piano(voiced(PROG_B, COMP), 3400),
        // The tape slowly gets darker as the song closes
        outro: piano(voiced(PROG_A, COMP), saw.range(2800, 600).slow(8)),
      })
    );

    // ─── 🎸 BASS ──────────────────────────────────────────────────────────────
    // Soft triangle, low-passed round. Root on 1 and the and-of-2 (locking with
    // the kick), then two walking notes that lead chromatically into the next chord.

    const BASS_A = bars(
      "g1@3 g1@3 bb1 b1", //  Gm9   → B leads up to C
      "c2@3 c2@3 g1 e1", //   C9    → E leads up to F
      "f1@3 f1@3 c2 eb2", //  F^9   → Eb leads down to D
      "d2@3 d2@3 a1 ab1" //   D7#9  → Ab leads down to G
    );
    const BASS_B = bars(
      "bb1@3 bb1@3 f1 ab1", // Bb^9  → G# leads up to A
      "a1@3 a1@3 e2 c#2", //   A7b13 → C# leads up to D
      "d2@3 d2@3 a1 ab1", //   Dm9   → Ab leads down to G
      "g1@3 g1@3 d2 a1" //     G13   → A leads to Bb or G
    );
    const bassSound = (p: Pattern) =>
      p.s("triangle").lpf(420).attack(0.01).decay(0.4).sustain(0.55).release(0.12).gain(0.8);

    const bass = groove(
      track({
        A1: bassSound(note(BASS_A)),
        B1: bassSound(note(BASS_B)),
        A2: bassSound(note(BASS_A)),
        B2: bassSound(note(BASS_B)),
        outro: bassSound(note(BASS_A)).mask("<1 1 1 1 1 1 0 0>"),
      })
    );

    // ─── 🎶 LEAD ──────────────────────────────────────────────────────────────
    // A lazy vibraphone hook over the A changes: an 8-bar call (bars 1–4) and
    // answer (bars 5–8). Every note is a chord tone or a passing tone in F major,
    // plus the bluesy F→F# (#9 → 3rd) over D7#9 in bar 8.

    const HOOK = bars(
      "~ a4 c5 d5@3 ~ f5", //   Gm9:  9 11 5 … b7
      "e5@4 d5 c5@3", //        C9:   3 9 1
      "~ a4 c5 e5@3 ~ g5", //   F^9:  same shape, up a step
      "f5@3 c5 a4@2 ~ ~", //    D7#9: #9 b7 5
      "~ bb4 d5 f5@3 e5 d5", // Gm9:  answer starts higher
      "c5@3 bb4 g4@4", //       C9
      "a4@2 c5 e5 g5@4", //     F^9:  climbs to the 9th
      "f5 f#5@2 d5 c5@2 a4@2" // D7#9: blue note bends into the 3rd
    );

    // The B melody: longer notes, sung by a soft "flute" synth.
    const TUNE_B = bars(
      "d5@3 c5 a4@4", //            Bb^9
      "~ ~ c#5 e5 f5@4", //         A7b13
      "e5@3 d5 a4@2 f4@2", //       Dm9
      "~ b4 d5 e5@2 f5@3", //       G13
      "f5@3 e5 d5@2 c5@2", //       Bb^9 (E = lydian #11)
      "~ ~ e5 c#5 a4@4", //         A7b13
      "~ f5 e5 d5@2 c5 a4@2", //    Dm9
      "b4@3 d5 f5@2 e5 d5" //       G13
    );

    // Just fragments of the hook in the break
    const HOOK_FRAGMENT = bars("~ a4 c5 d5@3 ~ ~", "~", "~ a4 c5 e5@3 ~ ~", "~");

    const vibraphone = (p: Pattern) =>
      p
        .s("vibraphone_soft")
        .gain(0.5)
        .release(1.2)
        .lpf(4000)
        .room(0.5)
        .delay(0.25)
        .delaytime(BEAT * 0.75) // dotted-8th echo
        .delayfeedback(0.3)
        .pan(0.45)
        .orbit(3);

    // Triangle wave + vibrato (5 Hz, ±0.12 semitones) + soft attack ≈ breathy flute
    const flute = (p: Pattern) =>
      p
        .s("triangle")
        .attack(0.06)
        .decay(0.2)
        .sustain(0.7)
        .release(0.35)
        .vib("5:0.12")
        .lpf(1800)
        .gain(0.32)
        .room(0.5)
        .pan(0.55)
        .orbit(3);

    const lead = groove(
      track({
        A1: vibraphone(note(HOOK)),
        B1: flute(note(TUNE_B)),
        // Second time round the hook gets a flute an octave below, for warmth
        A2: stack(vibraphone(note(HOOK)), flute(note(HOOK).transpose(-12)).gain(0.26)),
        break: vibraphone(note(HOOK_FRAGMENT)).delayfeedback(0.5),
        // B returns with vibes doubling the flute tune
        B2: stack(flute(note(TUNE_B)), vibraphone(note(TUNE_B)).gain(0.35)),
        outro: vibraphone(note(HOOK)).mask("<1 1 1 1 0 0 0 0>"),
      })
    );

    // ─── 🎚️ MIX ───────────────────────────────────────────────────────────────
    // Named tracks — the player stacks them; comment one out to mute it.

    return mixdown({ vinyl, kick, snare, hats, perc, keys, bass, lead });
  },
};

export default song;
