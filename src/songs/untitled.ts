// ═══════════════════════════════════════════════════════════════════════════
// 🎵 UNTITLED
// ═══════════════════════════════════════════════════════════════════════════

import type { Song } from ".";

const song: Song = {
  name: "Untitled",
  bpm: 120,
  visualization: "pianoroll",

  createPattern() {
    // ─────────────────────────────────────────────────────────────────────────
    // 🥁 DRUMS
    // ─────────────────────────────────────────────────────────────────────────

    const kick = s("bd*4").bank("AlesisSR16").gain(1);
    const snare = s("~ sd ~ sd").bank("AlesisSR16").gain(0.9);
    const hihat = s("hh*8").bank("AlesisSR16").gain(0.5);

    // ─────────────────────────────────────────────────────────────────────────
    // 🎸 BASS
    // ─────────────────────────────────────────────────────────────────────────

    const bass = note("<c2 c2 g2 f2>")
      .sound("sawtooth")
      .lpf(400)
      .decay(0.2)
      .sustain(0);

    // ─────────────────────────────────────────────────────────────────────────
    // 🎹 SYNTHS / MELODY - Using piano and vcsl sample packs
    // ─────────────────────────────────────────────────────────────────────────

    // Piano pad chords
    const pad = note("<[c3,e3,g3] [a2,c3,e3] [f2,a2,c3] [g2,b2,d3]>")
      .s("piano")
      .gain(0.5)
      .room(0.4);

    // Piano arpeggio
    const arp = note("<c4 e4 g4 b4>*4")
      .s("piano")
      .gain(0.35)
      .delay(0.3)
      .delaytime(0.125)
      .delayfeedback(0.4);

    // ─────────────────────────────────────────────────────────────────────────
    // 🎚️ MIXER - Enable/disable tracks by commenting them out
    // ─────────────────────────────────────────────────────────────────────────

    return stack(
      // Drums
      kick,
      snare,
      hihat,

      // Bass
      bass,

      // Synths
      pad,
      arp
    );
  },
};

export default song;
