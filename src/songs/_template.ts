// ═══════════════════════════════════════════════════════════════════════════
// 🎵 SONG NAME
// ═══════════════════════════════════════════════════════════════════════════
//
// Copy this file to create a new song:
//   1. Duplicate this file with your song name (e.g., my-song.ts)
//   2. Update the name and bpm
//   3. That's it! Songs are auto-discovered.
//
// ═══════════════════════════════════════════════════════════════════════════

import type { Song } from ".";

const song: Song = {
  name: "My Song",
  bpm: 120,

  // Visualization options:
  //   "pianoroll" - scrolling piano roll showing notes
  //   "scope"     - oscilloscope waveform
  //   "none"      - no visualization
  //
  // Or use full config: { type: "pianoroll", options: { cycles: 8, labels: true } }
  visualization: "pianoroll",

  createPattern() {
    // ─────────────────────────────────────────────────────────────────────────
    // 🥁 DRUMS
    // ─────────────────────────────────────────────────────────────────────────

    const kick = s("bd*4").bank("RolandTR808").gain(1);
    const snare = s("~ sd ~ sd").bank("RolandTR808").gain(0.8);
    const hihat = s("hh*8").bank("RolandTR808").gain(0.5);
    const drums = stack(kick, snare, hihat);

    // ─────────────────────────────────────────────────────────────────────────
    // 🎸 BASS
    // ─────────────────────────────────────────────────────────────────────────

    const bass = note("<c2 c2 f2 g2>")
      .sound("sawtooth")
      .lpf(400)
      .decay(0.2)
      .sustain(0);

    return stack(drums, bass);
  },
};

export default song;
