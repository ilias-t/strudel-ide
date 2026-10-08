// ═══════════════════════════════════════════════════════════════════════════
// 🎵 LIQUID HOURS — liquid drum & bass
// ═══════════════════════════════════════════════════════════════════════════
//
// D minor, 174 BPM. A rolling two-step beat with ghost snares, a jungle-style
// break (programmed from single drum hits) tucked underneath, a sub + reese bass, soft minor-9th pads that pump
// with the kick, and a piano hook in a dotted-8th echo.
//
//   intro 8 → drop 16 → breakdown 8 → drop2 16   (48 bars, then loops)
//
// At 174 BPM a bar lasts 1.4 s, so 16-bar sections fly by. Every part is
// written over an 8-bar chord loop: Dm9 · Bbmaj9 · Gm9 · A7b9, 2 bars each.
//
// 🧪 Try this:
//   • turn the knobs: "cutoff" opens the reese, "space" floods the reverb,
//     "break" pushes the break up front (0 = clean two-step, 1 = jungle)
//   • swap the chords in PROG, e.g. "<Em9 C^9 Am9 B7b9>" (then move the bass
//     and hook notes too), or make it darker with "<Dm9 Dm9 Bb^9 Gm9>"
//   • move the bd/sd hits in the `breaks` track, or swap its bank ("EmuSP12")
//   • resize FORM, or add a second breakdown before the loop
//
// ═══════════════════════════════════════════════════════════════════════════

import type { Song } from "../songs";

export const meta = {
  id: "dnb",
  genre: "Drum & Bass",
  blurb: "Liquid rollers at 174: a two-step beat over a programmed jungle break, sub and reese bass, minor-9th pads pumping with the kick.",
};

// ─── 🎛️ KNOBS ───────────────────────────────────────────────────────────────

const BPM = 174;
const BEAT = 60 / BPM; // one quarter note in seconds (for delay times)

const CUTOFF = knob("cutoff", 700, 150, 3000, { log: true }); // Hz: the reese's lowpass (it drifts around this)
const SPACE = knob("space", 0.5, 0, 1); // reverb send on the pads and the hook
const BREAK = knob("break", 0.5, 0, 1); // how loud the programmed break rolls under the beat

// The harmony: one chord symbol per 2 bars (".slow(2)" below), voiced by
// chord().voicing(). "^" = major 7th, so Bb^9 = Bbmaj9.
const PROG = "<Dm9 Bb^9 Gm9 A7b9>";

// The form: [section, bars]. Every track says what it plays in each section.
type Section = "intro" | "drop" | "breakdown" | "drop2";
const FORM: [Section, number][] = [
  ["intro", 8], //     pads, shaker, the break filtered thin; sub sneaks in, snare roll
  ["drop", 16], //     the full beat, reese bass; the hook joins halfway
  ["breakdown", 8], // no drums: pads, hook and sub, then a roll back in
  ["drop2", 16], //    everything from the top: the hook all the way, a fuller break
];

// ─── 🎚️ MIX — faders in dB on top of each part's own gain ──────────────────
// Set from measurements (`npm run analyze -- starters/dnb`, see docs/audio-tools.md):
// −17.6 LUFS integrated, sample peak −2.0 dBFS, drops at about −16.9 / −16.5 LUFS.
// There's no limiter on the output, so MASTER_DB keeps the peaks under 0 dBFS.
const MASTER_DB = -6.3;
const FADERS_DB: Record<string, number> = {
  kick: -2, // sat 3 dB under the whole mix and held half the low end
  hats: 12, // were 26 dB under the mix: inaudible
  pads: 4, // the kick ducks them, so they need a push to stay in the drops
  hook: 5, // the piano was 12 dB under the mix in the drops
};
/** Every track through its fader (postgain: after drive/shape, before the delay/reverb sends) */
const mixdown = (tracks: Record<string, Pattern>): Record<string, Pattern> =>
  Object.fromEntries(
    Object.entries(tracks).map(([name, p]) => [name, p.postgain(10 ** ((MASTER_DB + (FADERS_DB[name] ?? 0)) / 20))])
  );

const song: Song = {
  name: "Liquid Hours",
  bpm: BPM,
  visualization: "scope",
  sections: FORM, // the player's timeline (jump / loop)
  room: "club", // the stage: a dark club with hard, short lights

  createPattern() {
    // ─── 🧰 HELPERS ───────────────────────────────────────────────────────────

    const REST = s("~");

    // Lay a track out over the FORM: sections it doesn't mention stay silent.
    // arrange() restarts each section at its own bar 1, so "<…>" sequences
    // and masks count bars from the start of the section.
    const track = (parts: Partial<Record<Section, Pattern>>): Pattern =>
      arrange(...FORM.map(([name, bars]) => [bars, parts[name] ?? REST] as [number, Pattern]));

    // ─── 🥁 KICK — the two-step ───────────────────────────────────────────────
    // 16 steps per bar. Kick on the 1 and on the "and" of 3 (step 11): that
    // lopsided pair against the snare on 2 and 4 is the drum & bass two-step.
    // Bar 2 adds a kick just before the 3 for some push.
    // Each kick also ducks orbits 2 (bass) and 3 (pads): sidechain pumping.
    //               1 . . .  2 . . .  3 . . .  4 . . .
    const twoStep = s("<[bd ~ ~ ~  ~ ~ ~ ~  ~ ~ bd ~  ~ ~ ~ ~] [bd ~ ~ ~  ~ ~ ~ bd  ~ ~ bd ~  ~ ~ ~ ~]>")
      .gain(0.9)
      .lpf(4000)
      .duckorbit("2:3") // ":" makes a list: duck both buses…
      .duckdepth("0.6:0.4") // …the bass harder than the pads
      .duckattack(0.15); // seconds to come back up

    const kick = track({
      drop: twoStep,
      drop2: twoStep,
    });

    // ─── 🪘 SNARE — backbeat plus ghosts ──────────────────────────────────────
    // The loud snare sits on 2 and 4. Ghost notes (same drum, much quieter,
    // filtered) fill the gaps; "?" drops one at random so it never quite loops.
    // Ghosts are what make a beat *roll* instead of march.
    const backbeat = stack(
      s("~ sd ~ sd").gain(0.75).room(0.15),
      s("~ ~ ~ ~  ~ ~ ~ sd  ~ sd? ~ ~  ~ ~ ~ sd?").n(2).gain(0.2).hpf(500).pan(0.55)
    );

    // A one-bar roll into the drop: 8ths then 16ths, getting louder
    const roll = s("<~!7 [sd*8 sd*16]>").gain(saw.range(0.15, 0.55)).hpf(300);

    const snare = track({
      intro: roll,
      drop: backbeat,
      breakdown: roll,
      drop2: backbeat,
    });

    // ─── 🎩 HATS — offbeat hat, 16th shaker, a crash on each drop ─────────────
    // The shaker's velocity accent (soft-loud-softer) gives the 16ths a swing
    // feel without moving them; the closed hat ticks on every offbeat 8th.
    const shaker = s("sh*16").velocity("[0.5 0.8 1 0.7]*4").gain(0.35).hpf(2000).pan(0.4);
    const offbeat = s("[~ hh]*4").gain(0.3).hpf(3000).pan(0.6);
    const crash = s("<cr ~!15>").gain(0.25).hpf(500);

    const hats = track({
      intro: shaker.mask("<0!4 1!4>"),
      drop: stack(shaker, offbeat, crash),
      breakdown: shaker.gain(0.25),
      drop2: stack(shaker, offbeat, crash),
    });

    // ─── ✂️ BREAKS — a break played from single hits ──────────────────────────
    // Classic jungle breaks are sampled records; here the break is *programmed*
    // from an Akai XR10's hits, in the shape of the famous ones: kicks
    // skipping around a snare that lands on 2, 4 and the offbeats around them,
    // over a ride of 8th hats. Highpassed, it adds the roll and shuffle of a
    // break without fighting our own kick and snare. Bar 4 stutters (sd*2).
    //                 1 . . .   2 . . .   3 . . .   4 . . .
    const breakbeat = stack(
      s("<[bd ~ bd ~  sd ~ ~ sd  ~ sd bd bd  sd ~ ~ sd] [bd ~ bd ~  sd ~ ~ sd  ~ sd bd ~  ~ sd ~ ~] [bd ~ bd ~  sd ~ ~ sd  ~ sd bd bd  sd ~ ~ sd] [bd ~ bd ~  sd ~ ~ sd  ~ sd bd ~  [sd sd] sd [sd sd] sd]>")
        .velocity("[1 0.5 0.8 0.5]*4"), // loud on the beat, softer between: the shuffle
      s("hh*8").velocity("[1 0.6]*4").gain(0.7)
    )
      .bank("AkaiXR10")
      .hpf(700)
      .gain(BREAK)
      .pan(0.45);

    const breaks = track({
      intro: breakbeat.lpf(2500).mask("<0!4 1!4>"), // "next room": dull, then the drop opens it
      drop: breakbeat,
      drop2: breakbeat.hpf(400), // more body in the second drop
    });

    // ─── 🔊 BASS — sub + reese, one line ──────────────────────────────────────
    // The chord roots (D · Bb · G · A, 2 bars each). Notes hit with the kick
    // (step 1 and step 11) and hold; the second bar of each chord ends with
    // a pickup into the next root.
    const bassLine = note(
      "<[d2@10 d2@6] [d2@10 d2@4 f2@2] [bb1@10 bb1@6] [bb1@10 bb1@4 c2@2] [g1@10 g1@6] [g1@10 g1@4 a1@2] [a1@10 a1@6] [a1@10 a1@4 c#2@2]>"
    );

    // Sub: a pure sine, felt more than heard. It owns everything under ~100 Hz.
    const sub = bassLine.s("sine").attack(0.005).sustain(1).release(0.08).lpf(200).gain(0.7).orbit(2);

    // Reese: detuned saws beating against each other (supersaw), highpassed
    // so it leaves the lows to the sub, through a lowpass that slowly drifts
    // around the cutoff knob. That drift is the reese's "talking" movement.
    const reese = bassLine
      .s("supersaw")
      .unison(4) // how many saws
      .detune(0.25) // how far apart they're tuned: more = wider, wobblier
      .spread(0.2) // keep it near mono
      .sustain(1)
      .release(0.1)
      .hpf(110)
      .lpf(sine.range(0.6, 1.6).slow(8).mul(CUTOFF))
      .lpq(4)
      .shape(0.2) // a little grit
      .gain(0.3)
      .orbit(2);

    const bass = track({
      intro: sub.gain(0.5).mask("<0!4 1!4>"), // sub only, halfway in
      drop: stack(sub, reese),
      breakdown: sub.gain(0.5),
      drop2: stack(sub, reese),
    });

    // ─── 🌌 PADS — minor 9ths in a big reverb ─────────────────────────────────
    // Slow-attack saws, softened with a lowpass. They sit on orbit 3, which the
    // kick ducks, so in the drops they breathe in time with the beat.
    const padChords = chord(PROG)
      .slow(2)
      .voicing()
      .s("sawtooth")
      .attack(0.6)
      .release(1.5)
      .lpf(sine.range(900, 2000).slow(16))
      .hpf(350) // thin out the 250–500 Hz mud: the bass and the reverb fill it anyway
      .gain(0.12)
      .room(SPACE)
      .rsize(5)
      .orbit(3);

    const pads = track({
      intro: padChords.lpf(saw.range(700, 2000).slow(8)), // filter opens across the intro
      drop: padChords,
      breakdown: padChords.gain(0.16),
      drop2: padChords,
    });

    // ─── 🎹 HOOK — a soulful piano line with a dotted-8th echo ────────────────
    // One bar of call (8 steps, 8th notes), one bar of answer, per chord.
    // The echo (3/4 of a beat) is the classic liquid / rolling delay.
    const hookLine = note(
      "<[~ e5 ~ f5 ~ ~ e5 d5] [~ ~ a4 ~ ~ ~ ~ ~] [~ d5 ~ f5 ~ ~ e5 d5] [~ ~ c5 ~ ~ ~ ~ ~] [~ d5 ~ f5 ~ ~ e5 d5] [~ ~ bb4 ~ ~ ~ ~ ~] [~ c#5 ~ e5 ~ ~ g5 e5] [~ ~ ~ ~ a4 ~ ~ ~]>"
    )
      .s("piano")
      .hpf(300)
      .gain(0.5)
      .delay(0.35)
      .delaytime(BEAT * 0.75)
      .delayfeedback(0.45)
      .room(SPACE)
      .orbit(4);

    const hook = track({
      drop: hookLine.mask("<0!8 1!8>"), // joins halfway through the first drop
      breakdown: hookLine,
      drop2: hookLine,
    });

    // ─── 🎚️ MIXER — named tracks, stacked by the player ──────────────────────
    return mixdown({ kick, snare, hats, breaks, bass, pads, hook });
  },
};

export default song;
