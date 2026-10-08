// ═══════════════════════════════════════════════════════════════════════════
// 🏭 NIGHT SHIFT — warehouse techno (genre starter)
// ═══════════════════════════════════════════════════════════════════════════
//
// F minor, 130 BPM. Hypnotic, driving, made of very little: a pounding TR-909
// kick, the "rumble" (a reverb-drenched low tail that the kick pumps), offbeat
// open hats over 16th closed hats, a clap on 2 & 4, a rolling bass line
// and ONE minor-chord stab whose filter you ride. Techno is repetition plus slow change: the parts
// barely move, the filter and the space around them do.
//
//   intro 8 → groove 16 → break 8 → peak 16   (48 bars, then loops)
//
// The intro starts on the kick, so the peak flows straight back into it, the
// way one record mixes into the next in a DJ set.
//
// 🧪 Try this:
//   • turn the cutoff knob slowly over 16 bars: that IS the performance
//   • push the rumble knob up for a darker, more Berlin low end
//   • change the stab chord: "[f3,ab3,c4,eb4]" (Fm7) → "[f3,ab3,c4]" (plain Fm)
//     or "[f3,g3,c4,eb4]" (no third: hollow, more dub techno)
//   • move the stab's x's in its .struct(): the off-grid ones are the hypnosis
//   • swap DRUMS for "RolandR8" (90s, harder) or "RolandTR626" (thinner, lo-fi)
//   • space knob at 0.8 in the break: the echoes pile up into a wall
//
// ═══════════════════════════════════════════════════════════════════════════

import type { Song } from "../songs";

export const meta = {
  id: "techno",
  genre: "Techno",
  blurb: "Hypnotic warehouse techno: a pounding 909 over a reverb rumble, a rolling bass line and one minor stab whose filter you ride.",
};

// ─── 🎛️ KNOBS (turn these while it plays) ──────────────────────────────────

const BPM = 130;
const BEAT = 60 / BPM; // one quarter note in seconds (delay times are in seconds)
const DRUMS = "RolandTR909"; // the techno drum machine

const CUTOFF = knob("cutoff", 1400, 200, 6000, { log: true }); // Hz: the stab's filter, ride it!
const RUMBLE = knob("rumble", 0.4, 0, 1); // how loud the kick's reverb tail rumbles
const SPACE = knob("space", 0.35, 0, 0.8); // dotted-8th echo send on the stab

// ─── 🗺️ FORM — section name + length in bars (1 cycle = 1 bar of 4/4) ──────

type Section = "intro" | "groove" | "break" | "peak";
const FORM: [Section, number][] = [
  ["intro", 8], //   kick + rumble + hats; the stab creeps in, muffled
  ["groove", 16], // clap, open hats and the stab: the filter starts breathing
  ["break", 8], //   no kick: chords ring out, the filter sweeps up, clap roll
  ["peak", 16], //   everything + ride, the stab gets a second chord
];

// ─── 🎚️ MIX — faders in dB on top of each part's own gain ──────────────────
// Set from measurements (`npm run analyze -- starters/techno`, see docs/audio-tools.md).
// There's no limiter on the output, so MASTER_DB keeps the peaks under 0 dBFS.
// Measured: -17.4 LUFS integrated, sample peak -3.6 dBFS, PLR 13.8 dB; the break sits ~8 LU under the peak.
const MASTER_DB = -6.9;
const FADERS_DB: Record<string, number> = {
  kick: -4, // was within 1.5 dB of the whole mix: the kick leads, it shouldn't be everything
  rumble: -6, // soloed (no ducking) it was louder than the whole mix
  bass: 9, // the dry bass line was 17 dB under the mix: felt, not heard
  clap: 1.5, // up, but it's spiky: more and it sets the peaks
  hats: 6, // were 20 dB under the mix: felt, not heard
  openhat: 2,
  ride: 1,
  stab: 4, // the hook was 13 dB under the mix
  fx: 2,
};
/** Every track through its fader (postgain: after drive/shape, before the delay/reverb sends) */
const mixdown = (tracks: Record<string, Pattern>): Record<string, Pattern> =>
  Object.fromEntries(
    Object.entries(tracks).map(([name, p]) => [name, p.postgain(10 ** ((MASTER_DB + (FADERS_DB[name] ?? 0)) / 20))])
  );

const song: Song = {
  name: "Night Shift",
  bpm: BPM,
  visualization: "scope",
  sections: FORM, // the player's timeline (jump / loop)
  room: "club", // the stage: a dark club with hard strobes

  createPattern() {
    /** One full-length track: a pattern per section, silent where none is given */
    const track = (parts: Partial<Record<Section, Pattern>>): Pattern =>
      arrange(...FORM.map(([name, bars]): [number, Pattern] => [bars, parts[name] ?? silence]));

    // ─── 🥁 KICK — four on the floor, and the pump ─────────────────────────────
    // Every kick also ducks orbit 2 (the rumble) and orbit 5 (the bass):
    // duckdepth = how far each dips, duckattack = how long it takes to swell
    // back. That swell is the groove. ":" makes a list, one value per orbit.

    const kick = track({
      intro: s("bd*4"),
      groove: s("<[bd*4]!15 [bd bd bd ~]>"), // one beat of air before the break
      peak: s("bd*4"),
    })
      .bank(DRUMS)
      .shape(0.25) // a little drive: 909s are run hot
      .gain(0.95)
      .duckorbit("2:5") // the rumble and the bass…
      .duckattack("0.3:0.12") // …the bass snaps back faster…
      .duckdepth("0.8:0.5"); // …and dips less, so the line stays clear

    // ─── 🌊 RUMBLE — the low tail under the kick ───────────────────────────────
    // The classic warehouse bass: the same kick, sent into a big reverb. Keep
    // ONLY the reverb (dry 0), make it dark (roomlp) and let the real kick duck
    // it (orbit 2), so the tail swells up between the kicks and gets slammed
    // down on every beat. No notes, just weight: the bass and the stab carry the harmony.

    const rumble = track({
      intro: s("bd*4"),
      groove: s("<[bd*4]!15 [bd bd bd ~]>"), // follows the kick
      break: s("<bd*4!4 ~!4>").velocity(0.3), // no kick to duck it: the floor keeps rumbling, then drops away
      peak: s("bd*4"),
    })
      .bank(DRUMS)
      .shape(0.3) // drive before the reverb: a dirtier, thicker tail
      .dry(0) // no direct sound, just the reverb
      .room(RUMBLE) // the rumble knob: how much kick goes into the reverb
      .rsize(2) // tail length in seconds (changing it rebuilds the reverb)
      .roomlp(250) // dark: only the low end of the reverb
      .orbit(2);

    // ─── 🎸 BASS — a dry, rolling line that follows the stab's chords ──────────
    // Two 16ths after every kick ("~ x x ~" per beat): the kick owns the
    // downbeat, the bass rolls in the gaps. A plucky saw (its filter opens on
    // each note and snaps shut) with NO reverb, so the pitch stays tight and
    // the rumble keeps the space. It follows the chords: F minor, and Db / Eb
    // where the stab changes.
    //                     1 . . .        2 . . .        3 . . .        4 . . .
    const bass = track({
      intro: note("<~!4 [[~ f1 f1 ~] [~ f1 f1 ~] [~ f1 f1 ~] [~ f1 f1 ~]]!4>"), // creeps in for the last 4 bars
      groove: note("[~ f1 f1 ~] [~ f1 f2 ~] [~ f1 f1 ~] [~ ab1 c2 ~]"), // Fm, walking up to the 5th
      break: note("<f1 f1 db1 eb1>").velocity(0.7), // held roots under the break's chords
      peak: note("<[[~ f1 f1 ~] [~ f1 f2 ~] [~ f1 f1 ~] [~ ab1 c2 ~]]!3 [[~ db1 db1 ~] [~ db1 db2 ~] [~ db1 db1 ~] [~ eb1 f1 ~]]>"), // Fm ×3, Db
    })
      .s("sawtooth")
      .attack(0.003)
      .decay(0.14)
      .sustain(0.35)
      .release(0.04)
      .lpf(260)
      .lpenv(2) // each note's filter "blip": 2 octaves up, then shut
      .lpdecay(0.08)
      .gain(0.5)
      .orbit(5); // its own bus (the kick ducks it), no reverb

    // ─── 👏 CLAP — 2 & 4, a roll into the peak ─────────────────────────────────

    const clap = track({
      groove: s("~ cp ~ cp"),
      break: s("<~!6 [cp*8] [cp*16]>").velocity(saw.range(0.4, 1)), // getting louder each bar
      peak: s("~ cp ~ cp, ~ ~ ~ ~ ~ ~ ~ rim ~ ~ ~ ~ ~ ~ rim ~"), // + rimshots on the off-16ths
    })
      .bank(DRUMS)
      .gain(0.6)
      .room(0.25)
      .rsize(1.2)
      .orbit(4);

    // ─── 🎩 HATS — 16th closed hats, the offbeat open hat, a ride for the peak ──

    const hats = track({
      intro: s("hh*8"),
      groove: s("hh*16"),
      break: s("<~!6 [hh*16]!2>"), // back for the last 2 bars, with the clap roll
      peak: s("hh*16"),
    })
      .bank(DRUMS)
      .velocity("[0.45 0.75 0.6 1]*4") // accents: the "a" of each beat leans forward
      .gain(0.4)
      .hpf(6000)
      .pan(perlin.range(0.4, 0.6));

    // the "tss" between the kicks that makes techno roll
    const openhat = track({
      intro: s("<~!4 [[~ oh]*4]!4>"),
      groove: s("[~ oh]*4"),
      peak: s("[~ oh]*4"),
    })
      .bank(DRUMS)
      .gain(0.35)
      .hpf(3000);

    const ride = track({
      groove: s("<~!8 [rd*8]!8>"), // joins halfway through the groove
      peak: s("rd*8"),
    })
      .bank(DRUMS)
      .velocity("[0.6 1]*4")
      .gain(0.2)
      .pan(0.6);

    // ─── 🎹 STAB — one minor chord, an off-grid rhythm, a filter to ride ───────
    // The rhythm puts a stab every 3 sixteenths (a dotted 8th), so it drifts
    // against the 4/4 kick and lands somewhere new each beat: hypnotic.
    // The echo is a dotted 8th too, so the repeats fill the gaps in the same grid.

    // How far the filter is open in each section, × the cutoff knob
    const filterRide = track({
      intro: saw.rangex(0.25, 0.7).slow(8), // creeping open
      groove: sine.rangex(0.6, 1.4).slow(16), // breathing
      break: saw.rangex(0.5, 3).slow(8), // the big sweep up into the peak
      peak: sine.rangex(1, 1.8).slow(8),
    });

    const stab = track({
      intro: note("[f3,ab3,c4,eb4]").struct("~ ~ x ~ ~ x ~ ~ x ~ ~ x ~ ~ x ~").mask("<0!4 1!4>"),
      groove: note("[f3,ab3,c4,eb4]").struct("~ ~ x ~ ~ x ~ ~ x ~ ~ x ~ ~ x ~"), // Fm7
      break: note("<[f3,ab3,c4,eb4]!2 [db3,f3,ab3,c4] [eb3,g3,bb3,db4]>").struct("x ~ ~ x ~ ~ x ~"), // Fm7 Fm7 Dbmaj7 Eb7
      peak: note("<[f3,ab3,c4,eb4]!3 [db3,f3,ab3,c4]>").struct("~ ~ x ~ ~ x ~ ~ x ~ ~ x ~ ~ x ~"), // Fm7 Fm7 Fm7 Dbmaj7
    })
      .s("sawtooth")
      .attack(0.003)
      .decay(0.18)
      .sustain(0)
      .release(0.05)
      .lpf(filterRide.mul(CUTOFF))
      .lpenv(2) // each stab opens the filter 2 octaves, then snaps shut
      .lpdecay(0.12)
      .lpq(6)
      .hpf(200) // leave the low end to the kick and the rumble
      .gain(0.35)
      .delay(SPACE)
      .delaytime(BEAT * 0.75)
      .delayfeedback(0.55)
      .room(0.3)
      .rsize(3)
      .orbit(3);

    // ─── 🌀 FX — a noise riser in the break, a crash on each big downbeat ───────

    const fx = track({
      groove: s("<cr ~!15>").bank(DRUMS).gain(0.3),
      break: s("white*16")
        .decay(0.05)
        .sustain(0)
        .hpf(saw.rangex(400, 9000).slow(8))
        .gain(saw.range(0.02, 0.18).slow(8)),
      peak: s("<cr ~!15>").bank(DRUMS).gain(0.3),
    });

    // ─── 🎚️ MIXER — comment a track out to mute it ────────────────────────────

    return mixdown({ kick, rumble, bass, clap, hats, openhat, ride, stab, fx });
  },
};

export default song;
