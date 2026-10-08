// ═══════════════════════════════════════════════════════════════════════════
// 🏠 HOUSE — deep, warm, four-on-the-floor
// ═══════════════════════════════════════════════════════════════════════════
//
// A minor, 123 BPM. The Chicago / New York recipe: a TR-909 kick on every
// beat, claps on 2 & 4, an open hat on every off-beat ("tss"), swung 16ths
// in between, a bass that dances *around* the kick, and lush 9th-chord
// stabs that pump because every kick ducks them (sidechain).
//
//   intro 8 → groove 16 → break 8 → drop 16   (48 bars ≈ 1:34, then loops)
//
// 🧪 Try this:
//   • turn "swing" while it plays: 0 = straight, 0.2 = house shuffle, 0.4 = drunk
//   • turn "cutoff": closed = muffled "dub" stabs, open = bright piano-house
//   • change PROGRESSION, e.g. "<Am9 Am9 Dm9 Em7>" (and the bass's "<0 0 3 4>" to match)
//   • swap the drum bank: "RolandTR808" for softer, "RolandTR707" for 80s Chicago
//
// ═══════════════════════════════════════════════════════════════════════════

import type { Song } from "../songs";

// ─── 🎛️ KNOBS — turn them on the stage while it plays ──────────────────────

const BPM = 123;
const BEAT = 60 / BPM; // one quarter note in seconds (for delay times)
const DRUMS = "RolandTR909"; // the house drum machine

const SWING = knob("swing", 0.2, 0, 0.5, 0.01); // how late every 2nd 16th falls
const CUTOFF = knob("cutoff", 1400, 300, 6000, { log: true }); // Hz: the chord stabs' filter
const SPACE = knob("space", 0.35, 0, 0.9); // reverb send on the chords and pads

// One chord per bar, i – iv – VI – v in A minor. "^" = major 7th, so F^9 = Fmaj9.
// 9th chords are the deep-house sound: soft, open, a little melancholy.
const PROGRESSION = "<Am9 Dm9 F^9 Em7>";

// ─── 🗺️ FORM — section name + length in bars (1 cycle = 1 bar) ────────────

type Section = "intro" | "groove" | "break" | "drop";
const FORM: [Section, number][] = [
  ["intro", 8], //  kick + hats, the pads fade in from behind a filter
  ["groove", 16], // clap, bass and chord stabs join: the main groove
  ["break", 8], //  no kick: open pads, the piano hook, a riser and a clap roll
  ["drop", 16], //  everything together, a shaker on top
]; // the drop's last bar flows straight back into the intro's kick

// ─── 🎚️ MIX — faders in dB on top of each part's own gain ──────────────────
// Set from measurements (`npm run analyze -- starters/house`, see docs/audio-tools.md):
// −17.5 LUFS integrated, sample peak −1.8 dBFS, PLR 15.8 dB, no problems flagged.
// There's no limiter on the output, so MASTER_DB keeps the peaks under 0 dBFS.
const MASTER_DB = -2.1;
const FADERS_DB: Record<string, number> = {
  kick: -8, // was within 1 dB of the whole mix and 92% of its energy
  clap: -1, // kick + clap on the drop's first bar set the song's peak
  bass: 3, // was 14 dB under the mix
  chords: 3, // the stabs were 13 dB under the mix
  hook: 4, // was 15 dB under the mix
  fx: 4, // the riser was 20 dB under the break
};
/** Every track through its fader (postgain: after drive/shape, before the delay/reverb sends) */
const mixdown = (tracks: Record<string, Pattern>): Record<string, Pattern> =>
  Object.fromEntries(
    Object.entries(tracks).map(([name, p]) => [name, p.postgain(10 ** ((MASTER_DB + (FADERS_DB[name] ?? 0)) / 20))])
  );

const song: Song = {
  name: "House Starter",
  bpm: BPM,
  visualization: { type: "pianoroll", options: { cycles: 4, labels: false } },
  sections: FORM, // the player's timeline (jump / loop)

  createPattern() {
    // Lay a part out over FORM: sections it doesn't mention stay silent.
    // arrange() restarts each section's pattern at its own bar 1.
    const track = (parts: Partial<Record<Section, Pattern>>): Pattern =>
      arrange(...FORM.map(([name, bars]): [number, Pattern] => [bars, parts[name] ?? silence]));

    // The shuffle: swingBy delays every 2nd 16th (8 slices per bar)
    const swung = (p: Pattern): Pattern => p.swingBy(SWING, 8);

    // ─── 🥁 KICK — four on the floor, and the sidechain ─────────────────────
    // Every kick also ducks orbit 2 (chords + pads): their volume dips on
    // each beat and swells back (duckattack, seconds). That's the "pump".
    const fourOnTheFloor = s("bd*4")
      .bank(DRUMS)
      .gain(0.95)
      .duckorbit(2)
      .duckdepth(0.6)
      .duckattack(0.2);

    const kick = track({
      intro: fourOnTheFloor,
      groove: fourOnTheFloor,
      drop: fourOnTheFloor,
    });

    // ─── 👏 CLAP — on 2 and 4, with a short room ────────────────────────────
    const backbeat = s("~ cp ~ cp").bank(DRUMS).gain(0.7).room(0.15);

    const clap = track({
      groove: backbeat,
      // the break builds with a clap roll in its last two bars
      break: s("<~!6 [~ cp ~ cp] [cp*4 cp*8]>").bank(DRUMS).gain(saw.range(0.35, 0.7)).room(0.2),
      drop: backbeat,
    });

    // ─── 🎩 HATS — open on the off-beat, closed 16ths around it ─────────────
    // Together they fill every 16th; velocity accents make them breathe.
    const openHat = s("[~ oh]*4").bank(DRUMS).gain(0.4).hpf(5000);
    const closedHat = s("[hh hh ~ hh]*4").bank(DRUMS).gain(0.4).velocity("[0.6 0.4 0 0.75]*4").hpf(7000);
    const shaker = s("shaker_small*16").gain(0.25).velocity("[0.5 0.8 0.6 1]*4").hpf(4000).pan(0.65);

    const hats = swung(
      track({
        intro: stack(closedHat, openHat.mask("<0!4 1!4>")), // open hats arrive in bar 5
        groove: stack(closedHat, openHat),
        break: closedHat.gain(0.25),
        drop: stack(closedHat, openHat, shaker),
      })
    );

    // ─── 🎸 BASS — syncopated, never on the kick ────────────────────────────
    // n() = scale degrees in A minor: 0 = the root, 4 = fifth, 6 = seventh,
    // 7 = octave. The "<0 3 5 4>" adds each bar's root (A, D, F, E), so the
    // line follows PROGRESSION. Notes land between the kicks, so they lock.
    const bassLine = n("~ ~ 0 ~ ~ ~ 0 7 ~ ~ 0 ~ ~ 4 ~ 6")
      .add(n("<0 3 5 4>"))
      .scale("A1:minor")
      .s("sawtooth")
      .lpf(380)
      .lpenv(2) // each note opens the filter a little: a soft "bow"
      .lpdecay(0.12)
      .attack(0.005)
      .decay(0.2)
      .sustain(0.5)
      .release(0.06)
      .gain(0.6);

    const bass = swung(
      track({
        groove: bassLine,
        break: bassLine.mask("<0!4 1!4>").lpf(250), // creeps back in, darker
        drop: bassLine,
      })
    );

    // ─── 🎹 CHORDS — 9th-chord stabs, off the beat ──────────────────────────
    // voicing() spreads each chord symbol into a smooth 4–5 note voicing.
    // A sawtooth through a low-pass with its own envelope = a classic stab.
    const stabs = chord(PROGRESSION)
      .struct("~ ~ x ~ ~ ~ ~ x ~ ~ x ~ ~ ~ ~ ~")
      .anchor("E5")
      .voicing()
      .s("sawtooth")
      .lpf(CUTOFF)
      .lpenv(1.5)
      .lpdecay(0.15)
      .decay(0.25)
      .sustain(0.15)
      .release(0.3)
      .hpf(200)
      .gain(0.28)
      .room(SPACE)
      .rsize(3)
      .orbit(2); // the bus the kick ducks

    const chords = swung(
      track({
        groove: stabs,
        drop: stabs,
      })
    );

    // ─── 🌌 PADS — the same chords, held and soft ───────────────────────────
    const padChords = chord(PROGRESSION)
      .anchor("E5")
      .voicing()
      .s("supersaw")
      .unison(4)
      .detune(0.18)
      .attack(0.4)
      .sustain(0.8)
      .release(1.2)
      .hpf(350) // keep the low-mids for the bass: no mud
      .gain(0.16)
      .room(SPACE)
      .rsize(3)
      .orbit(2); // pumps with the kick too

    const pads = track({
      intro: padChords.lpf(saw.range(300, 1600).slow(8)), // the filter opens over the intro
      break: padChords.lpf(2400),
      drop: padChords.lpf(1200).gain(0.1), // a quiet bed under the stabs
    });

    // ─── 🎹 HOOK — a little piano riff with a dotted-8th echo ───────────────
    // Scale degrees in A minor from A4 (one bar per [ ]): it outlines each chord.
    const riff = n("<[~ 4 ~ 7 ~ 6 4 ~] [~ 4 ~ 2 ~ ~ 0 ~] [~ 4 ~ 7 ~ 9 7 ~] [6 ~ 4 ~ 1 ~ ~ ~]>")
      .scale("A4:minor")
      .s("piano")
      .gain(0.4)
      .velocity("[0.8 1]*4")
      .hpf(300)
      .delay(0.3)
      .delaytime(BEAT * 0.75)
      .delayfeedback(0.4)
      .room(0.3)
      .orbit(3);

    const hook = swung(
      track({
        break: riff,
        drop: riff.mask("<0!8 1!8>"), // answers in the second half of the drop
      })
    );

    // ─── 🌀 FX — a noise riser into the drop, a crash on its downbeat ───────
    const fx = track({
      groove: s("<cr ~!15>").bank(DRUMS).gain(0.35),
      break: s("<~!4 white*16 white*16 white*16 white*16>")
        .decay(0.06)
        .sustain(0)
        .hpf(saw.range(600, 9000).slow(4))
        .gain(saw.range(0.02, 0.14).slow(4))
        .orbit(4),
      drop: s("<cr ~!15>").bank(DRUMS).gain(0.35),
    });

    // ─── 🎚️ MIXER — comment a track out to mute it ──────────────────────────
    return mixdown({ kick, clap, hats, bass, chords, pads, hook, fx });
  },
};

export const meta = {
  id: "house",
  genre: "House",
  blurb: "Deep house at 123 BPM: 909 four-on-the-floor, swung hats, a bouncing bass and pumping 9th-chord stabs.",
};

export default song;
