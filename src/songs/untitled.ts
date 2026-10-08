// ═══════════════════════════════════════════════════════════════════════════
// 🎵 UNTITLED — your scratchpad. Edit, save, hear it change.
// ═══════════════════════════════════════════════════════════════════════════
//
// A warm piano-house groove in C: 4-bar chord loop, arp joins at bar 5,
// snare fill every 4 bars. Everything melodic follows `progression`.
//
// 🧪 Try this (save after each change):
//   • progression = "<Am7 F^7 C^7 G7>"   (or "<Dm9 G13 C^7 A7>")
//   • key = 2 to move everything up to D, swing 0.33 for a full shuffle
//   • cutoff 500 for underwater, 6000 for bright (or turn the knobs on the stage)
//   • kick: "bd*4" → "bd(3,8)" (a Euclidean broken beat)
//   • hats: "*4" → "*2", or add .degradeBy(0.3) to thin them randomly
//   • arp: add .jux(rev) for stereo ping-pong, or .fast(2) for 16ths
//   • arp: delete the .mask(...) line to hear it from bar 1
//   • uncomment the shaker (and add it to the return)
//
// ═══════════════════════════════════════════════════════════════════════════

import type { Song } from ".";

// ─── 🎛️ KNOBS ──────────────────────────────────────────────────────────────
const bpm = 120;
const key = 0; // semitones from C: 2 = D, 5 = F, -3 = A
const progression = "<C^7 Am7 Dm9 G13>"; // one chord per bar (^7 = maj7)
const swing = knob("swing", 0.15, 0, 0.33, 0.01); // 0 = straight 16ths, 0.33 = triplet shuffle
const cutoff = knob("cutoff", 2200, 200, 8000, { log: true }); // Hz: brightness of the piano + arp

const song: Song = {
  name: "Untitled",
  bpm,
  visualization: { type: "pianoroll", options: { cycles: 4, labels: false } },

  createPattern() {
    // ─── 🥁 DRUMS ─────────────────────────────────────────────────────────────
    const drums = (pattern: string) => s(pattern).bank("AlesisSR16");

    const kick = drums("bd*4").gain(0.9);

    // Backbeat on 2 & 4; the last bar of every 4 rolls into the next phrase
    const snare = drums("~ sd ~ sd").gain(0.7).lastOf(4, (x) => x.ply("1 1 1 4"));

    // Closed-closed-OPEN-closed per beat; cut(1) lets a closed hat choke the open one
    const hats = drums("[hh hh oh hh]*4")
      .gain("[0.4 0.22 0.45 0.28]*4") // accents make it groove
      .cut(1)
      .swingBy(swing, 8); // delay every 2nd 16th note

    // const shaker = drums("sh*16").gain(0.15).pan(0.7);

    // ─── 🎸 BASS — root of each chord, offbeat house style ───────────────────
    // n() picks notes from the chord: 0 = root, 1 = next chord tone up
    const bass = n("~ 0 ~ 0 ~ 0 ~ [0 1]").chord(progression).mode("root:g2").voicing()
      .transpose(key)
      .s("sawtooth")
      .lpf(500)
      .decay(0.2)
      .sustain(0.4)
      .gain(0.5);

    // ─── 🎹 CHORDS — piano, voiced automatically, 3-3-2 rhythm ───────────────
    const chords = chord(progression).struct("x ~ ~ x ~ ~ x ~").voicing()
      .transpose(key)
      .s("piano")
      .lpf(cutoff)
      .gain(0.5)
      .room(0.4);

    // ─── ✨ ARP — up-and-down through the chord tones ────────────────────────
    const arp = n("0 1 2 3 4 3 2 1").chord(progression).mode("root:c4").voicing()
      .transpose(key)
      .s("square")
      .lpf(cutoff)
      .decay(0.15)
      .sustain(0)
      .gain(0.18)
      .pan(sine.range(0.3, 0.7).slow(8))
      .delay(knob("echo", 0.35, 0, 0.8))
      .delaytime((60 / bpm) * 0.75) // dotted 8th, in seconds
      .delayfeedback(0.45)
      .orbit(2) // its own effects bus, so the delay doesn't touch the piano
      .mask("<0!4 1!12>"); // silent for bars 1–4, then plays bars 5–16

    return { kick, snare, hats, bass, chords, arp };
  },
};

export default song;
