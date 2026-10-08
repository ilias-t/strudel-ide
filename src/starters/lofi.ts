// ═══════════════════════════════════════════════════════════════════════════
// 🌱 LO-FI HIP-HOP — a dusty starter beat
// ═══════════════════════════════════════════════════════════════════════════
//
// E♭ major, 78 BPM. Swung boom-bap on an E-mu SP-1200 kit, warm jazz piano
// through a low-pass with tape wobble, a round sine bass and a vinyl bed.
//
//   intro 4 → A 8 → B 8 → A 8   (28 bars, then loops back to the intro)
//
// Lo-fi in four ideas:
//   • the drums are *swung* and a bit late: nothing sits exactly on the grid
//   • the chords are jazzy 7ths/9ths/13ths, muffled as if sampled off a record
//   • the bass is soft and round, under the kick, not on top of it
//   • the dust (crackle + hiss) is part of the instrument, not a mistake
//
// 🧪 Try this:
//   • turn SWING: 0 = straight, 0.33 = triplet shuffle, 0.45+ = drunk MPC
//   • turn TONE down to ~600 Hz for "music from the next room"
//   • rewrite a progression: "<Ab^9 Gm7 Fm9 Bb13>" takes any chord symbols
//     (m9, ^7 = maj7, 13, 7b9, 7#9, m11 …)
//   • swap the kit: "EmuSP12" → "AkaiMPC60", "LinnDrum" or "AkaiXR10"
//   • swap "piano" for "vibraphone_soft" or "marimba" in the KEYS section
//
// ═══════════════════════════════════════════════════════════════════════════

import type { Song } from "../songs";

export const meta = {
  id: "lofi",
  genre: "Lo-fi Hip-Hop",
  blurb: "Swung SP-1200 boom-bap under muffled jazz piano chords, a round sine bass and a bed of vinyl crackle.",
};

// ─── 🎛️ KNOBS ───────────────────────────────────────────────────────────────

const BPM = 78;
const BEAT = 60 / BPM; // one quarter note in seconds (for the delay time)
// How late every 2nd 16th note falls: 0 = robot, 0.33 = triplet swing
const SWING = knob("swing", 0.22, 0, 0.5, 0.01);
// Low-pass on the piano: lower = dustier, more "sampled off a record"
const TONE = knob("tone", 2200, 400, 8000, { log: true });
// Crackle + hiss level (0 = clean, 1 = a worn-out record)
const VINYL = knob("vinyl", 0.5, 0, 1, 0.01);

const KIT = "EmuSP12"; // the E-mu SP-1200: gritty 12-bit drums, the boom-bap classic

// The form: [section, bars]. Every track below says what it plays in each section.
type Section = "intro" | "A1" | "B" | "A2";
const FORM: [Section, number][] = [
  ["intro", 4],
  ["A1", 8],
  ["B", 8],
  ["A2", 8],
];

// ─── 🎚️ MIX — faders in dB on top of each part's own gain ──────────────────
// Set from measurements (`npm run analyze -- starters/lofi`, docs/audio-tools.md):
// −17.7 LUFS integrated, sample peak −1.4 dBFS, short-term max −16.9, PLR 16.4 dB.
// There's no limiter on the output, so MASTER_DB keeps the peaks under −1 dBFS.
const MASTER_DB = -1.3;
const FADERS_DB: Record<string, number> = {
  vinyl: 3, // dust sits ~21 dB under the mix: heard in the gaps, not over the music
  kick: -1,
  snare: -2.5, // the SP-1200 snare set the song's peak
  bass: -6, // was 89% of the sub and 3 dB under the whole mix: boomy
  keys: 5, // lo-fi is about the chords: up front, ~6 dB under the mix
  hats: 3,
  lead: 9, // sparse and soft, but it has to cut through
};
/** Every track through its fader (postgain: after drive/shape, before the delay/reverb sends) */
const mixdown = (tracks: Record<string, Pattern>): Record<string, Pattern> =>
  Object.fromEntries(
    Object.entries(tracks).map(([name, p]) => [name, p.postgain(10 ** ((MASTER_DB + (FADERS_DB[name] ?? 0)) / 20))])
  );

const song: Song = {
  name: "Lo-fi Starter",
  bpm: BPM,
  visualization: { type: "pianoroll", options: { cycles: 8, labels: false } },
  sections: FORM, // the player's timeline (jump / loop)

  createPattern() {
    // ─── 🧰 HELPERS ───────────────────────────────────────────────────────────

    // Lay a track out over the FORM: sections it doesn't mention stay silent.
    // arrange() restarts each section at its own bar 1.
    const track = (parts: Partial<Record<Section, Pattern>>): Pattern =>
      arrange(...FORM.map(([name, bars]) => [bars, parts[name] ?? s("~")] as [number, Pattern]));

    // The shuffle: delay every 2nd 16th note (8 pairs per bar) by SWING
    const groove = (p: Pattern): Pattern => p.swingBy(SWING, 8);

    // ─── 📀 VINYL ─────────────────────────────────────────────────────────────
    // Random crackle clicks plus faint pink-noise hiss, one long note per bar.
    // Both follow the VINYL knob; perlin makes the crackle breathe a little.

    const dust = stack(
      s("crackle").density(0.03).sustain(1).release(0.05).hpf(800).lpf(7000).gain(perlin.range(2, 3.2).mul(VINYL)),
      s("pink").sustain(1).release(0.05).hpf(3000).lpf(10000).gain(VINYL.mul(0.24))
    ).orbit(4);

    const vinyl = track({ intro: dust, A1: dust, B: dust, A2: dust });

    // ─── 🥁 DRUMS ─────────────────────────────────────────────────────────────
    // 16 steps per bar. Boom-bap = a heavy kick on 1, a backbeat on 2 & 4, and
    // the kick dancing around the snare. Every 4th bar the kick adds a pickup.
    // The kick also ducks the piano's orbit (2): a gentle "breathing" pump.

    // Kick on 1, the "a" of 2 and the "and" of 3 (the 4th bar adds the "and" of 4)
    const kickBeat = s("<[bd ~ ~ ~ ~ ~ ~ bd ~ ~ bd ~ ~ ~ ~ ~]!3 [bd ~ ~ ~ ~ ~ ~ bd ~ ~ bd ~ ~ ~ bd ~]>");
    const kick = groove(
      track({ A1: kickBeat, B: kickBeat, A2: kickBeat })
        .bank(KIT)
        .velocity("[1 .85 .9]") // later kicks in the bar a touch softer
        .lpf(2500)
        .duckorbit(2)
        .duckdepth(0.3)
        .duckattack(0.2)
    );

    // Backbeat on 2 & 4, dragged a few ms late (nudge, in seconds), plus
    // quiet rimshot ghost notes. "?" drops a ghost at random, so bars differ.
    const ghosts = s("~ ~ ~ ~ ~ ~ ~ rim? ~ rim ~ ~ ~ ~ ~ rim?").gain(0.22);
    const backbeat = stack(s("~ sd ~ sd").gain(0.8), ghosts);
    const snare = groove(
      track({
        A1: backbeat,
        // B: the backbeat moves to a cross-stick rim for a softer, closer feel
        B: stack(s("~ rim ~ rim").gain(0.6), ghosts.gain(0.18)),
        A2: backbeat,
      })
        .bank(KIT)
        .nudge(0.012)
        .room(0.2)
    );

    // 16th hats with an accent shape (loud on the beat, soft on the "e" and "a"),
    // and a little timing jitter. Swing does most of the work here.
    const hats = groove(
      track({
        intro: s("~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ hh hh hh hh").mask("<0 0 1 1>"), // creeping in
        A1: s("hh*16"),
        B: s("hh*16").degradeBy(0.15), // looser: some 16ths drop out
        A2: stack(s("hh*16"), s("~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ oh ~")), // + an open hat on the "and" of 4
      })
        .bank(KIT)
        .gain("[.42 .14 .26 .16]*4")
        .nudge(rand.range(-0.005, 0.005))
        .lpf(6500)
        .pan(0.6)
    );

    // ─── 🎹 KEYS ──────────────────────────────────────────────────────────────
    // Chord symbols → jazz voicings (chord().voicing()), hit on 1 and pushed
    // on the "and" of 2. vib = slow pitch wobble (Hz:semitones) = warped tape.
    // A: IV – iii – ii – V in E♭ (the V, B♭13, rolls back to A♭ to loop)
    // B: vi – ii, then a ii – V into A♭ (B♭m9 – E♭7b9 → A♭^9)
    const piano = (p: Pattern) =>
      p
        .s("piano")
        .gain(0.32)
        .velocity(perlin.range(0.75, 1))
        .release(0.8)
        .lpf(TONE)
        .vib("0.4:0.1")
        .room(0.4)
        .orbit(2);

    const keys = groove(
      track({
        // muffled whole notes, as if the record is just starting
        intro: piano(chord("<Ab^9 Gm7 Fm9 Bb13>").voicing()).hpf(350).lpf(TONE.mul(0.6)),
        A1: piano(chord("<Ab^9 Gm7 Fm9 Bb13>").struct("x@3 x@5").voicing()),
        B: piano(chord("<Cm9 Fm9 Bbm9 Eb7b9>").struct("x@3 x@5").voicing()),
        A2: piano(chord("<Ab^9 Gm7 Fm9 Bb13>").struct("<[x@3 x@5] [x@3 x@4 x]>").voicing()),
      })
    );

    // ─── 🎸 BASS ──────────────────────────────────────────────────────────────
    // A sine with a little shape (soft saturation) = round and warm.
    // Root on 1 (with the kick) and again on 3, the 5th on 4, then a
    // chromatic approach note that leads into the next chord.

    const bassSound = (p: Pattern) =>
      p.s("sine").attack(0.01).decay(0.5).sustain(0.6).release(0.15).shape(0.25).lpf(900).gain(0.7);

    const bassA = bassSound(note("<[ab1@3 ~ ab1 ~ eb2 a1] [g1@3 ~ g1 ~ d2 f#1] [f1@3 ~ f1 ~ c2 a1] [bb1@3 ~ bb1 ~ f1 a1]>"));
    const bass = groove(
      track({
        A1: bassA,
        B: bassSound(note("<[c2@3 ~ c2 ~ g1 e1] [f1@3 ~ f1 ~ c2 b1] [bb1@3 ~ bb1 ~ f1 e2] [eb2@3 ~ eb2 ~ bb1 a1]>")),
        A2: bassA,
      })
    );

    // ─── 🎶 LEAD ──────────────────────────────────────────────────────────────
    // A sparse kalimba line over B only: chord tones, lots of space, a
    // dotted-8th echo on its own orbit (3). The E over E♭7b9 is the b9,
    // and it falls a half step into the A♭ chord when A comes back.

    const lead = groove(
      track({
        B: note("<[~ g4 bb4 d5@3 ~ ~] [~ ~ c5 ab4 g4@4] [~ f4 ab4 c5@2 db5@3] [c5@2 bb4 g4 e4@4]>")
          .s("kalimba")
          .gain(0.5)
          .lpf(3500)
          .room(0.4)
          .delay(0.3)
          .delaytime(BEAT * 0.75)
          .delayfeedback(0.35)
          .pan(0.4)
          .orbit(3),
      })
    );

    // ─── 🎚️ MIX ───────────────────────────────────────────────────────────────
    // Named tracks — the player stacks them; comment one out to mute it.

    return mixdown({ vinyl, kick, snare, hats, keys, bass, lead });
  },
};

export default song;
