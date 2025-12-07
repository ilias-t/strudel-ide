// ═══════════════════════════════════════════════════════════════════════════
// 🎵 JYNX
// ═══════════════════════════════════════════════════════════════════════════

import type { Song } from ".";

const song: Song = {
  name: "Jynx",
  bpm: 126,
  visualization: "scope",

  createPattern() {
    // A minor - scale degrees: 0=A, 1=B, 2=C, 3=D, 4=E, 5=F, 6=G

    // ─────────────────────────────────────────────────────────────────────────
    // 🌊 CHORDS - i - VII - VI - v (Am - G - F - Em)
    // Main chords with filter movement (Daft Punk style)
    // ─────────────────────────────────────────────────────────────────────────

    const chords = note(
      "<[a2,e3,a3,c4] [g2,d3,g3,b3] [f2,c3,f3,a3] [e2,b3,e3,g3]>"
    )
      .sound("sawtooth")
      .lpf(sine.range(800, 2400).slow(4)) // filter automation
      .attack(0.08)
      .decay(0.3)
      .sustain(0.5)
      .release(0.5)
      .gain(saw.range(0.2, 0.45).fast(4)) // sidechain pump
      .room(0.35);

    // Intro chords - heavily filtered for anticipation
    const introChords = note(
      "<[a2,e3,a3,c4] [g2,d3,g3,b3] [f2,c3,f3,a3] [e2,b3,e3,g3]>"
    )
      .sound("sawtooth")
      .lpf(600)
      .attack(0.08)
      .decay(0.3)
      .sustain(0.5)
      .release(0.5)
      .gain(0.3)
      .room(0.4);

    // Breakdown chords - stripped, filtered, emotional
    const breakdownChords = note(
      "<[a2,e3,a3,c4] [g2,d3,g3,b3] [f2,c3,f3,a3] [e2,b3,e3,g3]>"
    )
      .sound("sawtooth")
      .lpf(600)
      .attack(0.1)
      .decay(0.4)
      .sustain(0.6)
      .release(0.8)
      .gain(0.3)
      .room(0.6);

    // ─────────────────────────────────────────────────────────────────────────
    // 🎵 VERSE - scale degrees, restrained (A5 base = melody sits around E5-A5)
    // ─────────────────────────────────────────────────────────────────────────

    const verseMelody = note("4 ~ 0 ~ 6 4 ~ ~ 4 ~ 0 ~ 1 0 ~ ~")
      .scale("A5:minor")
      .sound("triangle")
      .lpf(2200)
      .decay(0.2)
      .sustain(0.25)
      .release(0.3)
      .gain(0.5)
      .delay(0.3)
      .delaytime(0.25)
      .delayfeedback(0.4)
      .room(0.3);

    // ─────────────────────────────────────────────────────────────────────────
    // ✨ CHORUS - scale degrees, anthemic rise (A5 base, reaches up to A6)
    // ─────────────────────────────────────────────────────────────────────────

    const chorusMelody = note("7 ~ 4 0 7 ~ 4 ~ 7 ~ 4 0 6 4 0 ~")
      .scale("A5:minor")
      .sound("triangle")
      .lpf(2800) // brighter than verse for lift
      .decay(0.15)
      .sustain(0.4)
      .release(0.4)
      .gain(0.55)
      .delay(0.25)
      .delaytime(0.25)
      .delayfeedback(0.35)
      .room(0.4);

    // Breakdown melody - softer, more space
    const breakdownMelody = note("4 ~ ~ ~ 0 ~ ~ ~ 6 ~ ~ ~ 4 ~ ~ ~")
      .scale("A5:minor")
      .sound("triangle")
      .lpf(1800)
      .decay(0.3)
      .sustain(0.4)
      .release(0.6)
      .gain(0.4)
      .delay(0.4)
      .delaytime(0.375)
      .delayfeedback(0.5)
      .room(0.5);

    // ─────────────────────────────────────────────────────────────────────────
    // 🎹 ARPEGGIO - ATB signature, filtered with stereo movement
    // ─────────────────────────────────────────────────────────────────────────

    // Arp follows chord roots: Am -> G -> F -> Em
    const arp = note(
      "<[a4 c5 e5 a5]*4 [g4 b4 d5 g5]*4 [f4 a4 c5 f5]*4 [e4 g4 b4 e5]*4>"
    )
      .sound("triangle")
      .lpf(sine.range(1200, 4000).slow(8)) // filter movement
      .decay(0.1)
      .sustain(0.2)
      .release(0.2)
      .gain(0.25)
      .delay(0.4)
      .delaytime(0.1875) // dotted 16th for rhythmic interest
      .delayfeedback(0.4)
      .pan(sine.range(0.3, 0.7).slow(2)); // stereo movement

    // ─────────────────────────────────────────────────────────────────────────
    // 🔊 BASSLINE - follows chord roots with octave bounce
    // Ducked with saw signal: low on kick hit, swells between kicks
    // ─────────────────────────────────────────────────────────────────────────

    const bass = note("<[a1 a2]*2 [g1 g2]*2 [f1 f2]*2 [e1 e2]*2>")
      .sound("sawtooth")
      .lpf(380)
      .decay(0.08)
      .sustain(0.7)
      .release(0.1)
      .gain(saw.range(0.25, 0.6).fast(4)) // sidechain duck
      .shape(0.3);

    // Sub-bass for low-end weight
    const sub = note("<a1 g1 f1 e1>")
      .sound("sine")
      .lpf(100)
      .decay(0.1)
      .sustain(0.8)
      .release(0.15)
      .gain(saw.range(0.3, 0.5).fast(4)); // sidechain with kick

    // ─────────────────────────────────────────────────────────────────────────
    // 🥁 DRUMS - layered for drive and punch
    // ─────────────────────────────────────────────────────────────────────────

    // Kick: 4-on-the-floor, the anchor
    const kick = s("bd*4").bank("RolandTR808").gain(1).shape(0.4);

    // Clap on 2 and 4 - the backbeat
    const clap = s("~ cp ~ cp")
      .bank("RolandTR808")
      .gain(0.65)
      .room(0.15)
      .delay(0.08)
      .delaytime(0.02)
      .delayfeedback(0.2); // tiny slap for width

    // Hi-hats: 16ths with velocity groove and stereo spread
    const hat = s("hh*16")
      .bank("RolandTR808")
      .gain(square.range(0.3, 0.5).fast(8)) // accent pattern for groove
      .lpf(9000)
      .pan(rand.range(0.4, 0.6)); // subtle stereo spread

    // Intro hats - just 8ths, filtered
    const introHat = s("hh*8").bank("RolandTR808").gain(0.35).lpf(5000);

    // Open hat on the "and" of 2 and 4 for lift
    const openHat = s("~ ~ ~ oh ~ ~ ~ oh")
      .bank("RolandTR808")
      .gain(0.35)
      .decay(0.15)
      .release(0.2);

    const ride = s("rd*8")
      .bank("RolandTR909")
      .gain(saw.range(0.08, 0.15).fast(4)) // sidechain pump
      .lpf(6000);

    // ─────────────────────────────────────────────────────────────────────────
    // 🪘 PERCUSSION - extra groove for chorus energy
    // ─────────────────────────────────────────────────────────────────────────

    const perc = stack(
      s("~ shaker_small ~ shaker_small").gain(0.2).pan(0.7),
      s("~ ~ rim ~").bank("RolandTR808").gain(0.3).pan(0.3)
    );

    // ─────────────────────────────────────────────────────────────────────────
    // 🌀 TRANSITIONS - risers and sweeps
    // ─────────────────────────────────────────────────────────────────────────

    // White noise riser for builds
    const riser = s("white")
      .hpf(sine.range(200, 8000).slow(2)) // sweep up
      .gain(0.12)
      .attack(1.5)
      .release(0.5);

    // Bigger riser for second build
    const bigRiser = s("white")
      .hpf(sine.range(100, 12000).slow(2)) // wider sweep
      .gain(0.18)
      .attack(1.8)
      .release(0.3)
      .room(0.3);

    // ─────────────────────────────────────────────────────────────────────────
    // 🎚️ SECTIONS
    // ─────────────────────────────────────────────────────────────────────────

    // Intro - filtered chords + hats only, building anticipation
    const intro = stack(introChords, introHat);

    // Full drums
    const drums = stack(kick, clap, hat, openHat);

    // Verse - full but restrained
    const verse = stack(chords, verseMelody, bass, sub, drums);

    // Build sections - tension before drop
    const build1 = stack(chords, verseMelody, bass, sub, drums, riser);
    const build2 = stack(chords, chorusMelody, bass, sub, drums, bigRiser, arp);

    // Chorus - full energy with all elements
    const chorus1 = stack(chords, chorusMelody, bass, sub, drums, ride, arp);
    const chorus2 = stack(
      chords,
      chorusMelody,
      bass,
      sub,
      drums,
      ride,
      arp,
      perc
    );

    // Breakdown - stripped, emotional pause
    const breakdown = stack(breakdownChords, breakdownMelody);

    // Outro - filter down, fade elements
    const outro = stack(introChords, introHat, sub);

    // ─────────────────────────────────────────────────────────────────────────
    // 🎼 ARRANGEMENT
    // Intro → Verse → Build → Chorus → Breakdown → Build → Chorus → Outro
    // ─────────────────────────────────────────────────────────────────────────

    return arrange(
      [4, intro],
      [8, verse],
      [4, build1],
      [8, chorus1],
      [8, breakdown],
      [4, build2],
      [8, chorus2],
      [4, outro]
    );
  },
};

export default song;
