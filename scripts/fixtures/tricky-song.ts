// ═══════════════════════════════════════════════════════════════════════════
// 🧪 Fixture for scripts/test-locations.mjs — not a real song (emoji on purpose:
// offsets are UTF-16 code units, and these come before every literal)
// ═══════════════════════════════════════════════════════════════════════════
// Comments with quotes must be ignored: s("bd") 'note("c3")' don't "touch" this

import type { Song } from "../../src/songs";

const label = "kick drum"; // variable initializer — not a call argument
const ids = ["bd", "sd"]; // array literal — not rewritten

// a local helper that takes a plain string: not a strudel function → untouched
function shout(word: string): string {
  return word.toUpperCase();
}

// never called; only checked for which literals get rewritten
export function notEvaluated() {
  console.log("bd sd");
  JSON.parse("{}");
  "a b".split(" ");
  ids.join(",");
  import("./tricky-song.ts");
  return arrange([4, "bd sd"], [4, s("hh*8")]);
}

const song: Song = {
  name: "Tricky",
  bpm: 120,
  visualization: { type: "pianoroll", options: { cycles: 4 } },

  createPattern() {
    shout("hello");
    const kick = s("bd*2 [~ bd]").bank("RolandTR909"); // double quotes
    const snare = s('~ sd:2').bank('RolandTR808'); // single quotes
    const escaped = s("hh\thh*2"); // escape → skipped (raw ≠ cooked)
    const tpl = note(`<c3 e3
      g3 b3>`).sound(`triangle`); // backticks, multi-line
    const nested = stack(n("0 [2 4]").scale("A:minor"), note(seq("48 52").add("<0 12>")));
    const viaVar = s(ids[0]); // runtime string, no locations
    const notMini = s("bd(3,8)").gain("0.5 .8").pan(sine.range(0.2, 0.8)); // euclid + numbers
    const offsets = s("hh*4").degradeBy(0.3).sometimesBy("0.5", (x: Pattern) => x.speed("2"));
    const arranged = arrange([2, stack(kick, snare)], [2, cat("c3 e3", "g3").note()]);
    const wrapped = s(["bd", "sd"][1]); // element access → plain string
    return {
      kick,
      snare,
      escaped,
      tpl,
      nested,
      viaVar,
      notMini,
      offsets,
      arranged,
      wrapped,
      label: s(label),
    };
  },
};

export default song;
