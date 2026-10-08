// ═══════════════════════════════════════════════════════════════════════════
// 🎵 SONG NAME — one line about the vibe (key, tempo, genre)
// ═══════════════════════════════════════════════════════════════════════════
//
// Copy this file to create a new song:
//   1. Duplicate it with your song name (e.g. my-song.ts) — songs are auto-discovered
//   2. Set the name, then tweak the knobs below (knob() ones also live, on the stage)
//   3. Each track is its own named pattern, returned at the bottom.
//      The player stacks them (and the mixer can mute/solo them by name).
//
// 🧪 Try this:
//   • change the progression, e.g. "<Am F C G>"
//   • hats: "*8" → "*16"
//
// ═══════════════════════════════════════════════════════════════════════════

import type { Song } from ".";

// ─── 🎛️ KNOBS ──────────────────────────────────────────────────────────────
const bpm = 120; // quarter notes per minute; 1 cycle = 1 bar of 4/4
const progression = "<C Am F G>"; // one chord per bar
// A knob: turn it on the stage while it plays, then "Write to file" to keep it
const cutoff = knob("cutoff", 1200, 200, 5000, { log: true }); // Hz: lower = darker

const song: Song = {
  name: "My Song",
  bpm,

  // "pianoroll" (scrolling notes), "scope" (waveform) or "none".
  // Full config: { type: "pianoroll", options: { cycles: 8, labels: true } }
  visualization: "pianoroll",

  createPattern() {
    // ─── 🥁 DRUMS ─────────────────────────────────────────────────────────────
    const kick = s("bd*4").bank("RolandTR808").gain(0.9);
    const snare = s("~ sd ~ sd").bank("RolandTR808").gain(0.7);
    const hats = s("hh*8").bank("RolandTR808").gain(0.35);

    // ─── 🎸 BASS — the root of each chord, in octave 2 ───────────────────────
    const bass = chord(progression).rootNotes(2)
      .struct("x ~ x ~ x ~ x x")
      .s("sawtooth")
      .lpf(cutoff.div(3))
      .decay(0.2)
      .sustain(0.3)
      .gain(0.5);

    // ─── 🎹 CHORDS — chord symbols turned into piano voicings ────────────────
    const chords = chord(progression).voicing()
      .s("piano")
      .lpf(cutoff.mul(2))
      .gain(0.5)
      .room(0.3);

    // Silence a part in a section with .mask("<0 0 1 1>") (0 = off, per bar)
    return { kick, snare, hats, bass, chords };
  },
};

export default song;
