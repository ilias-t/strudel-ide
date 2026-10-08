// Test fixture for scripts/test-strudel-cc.mjs, copied verbatim (below this header) from
// strudel.cc's example tunes (website/src/repl/tunes.mjs, goodTimes)
// in Strudel, https://codeberg.org/uzu/strudel (Strudel contributors).
// License: CC BY-NC-SA 4.0 (see the tune's own @license line; the file it comes from is AGPL-3.0-or-later)
// @title Good times

// "Good times"
// @license CC BY-NC-SA 4.0 https://creativecommons.org/licenses/by-nc-sa/4.0/
// @by Felix Roos

const scale = cat('C3 dorian','Bb2 major').slow(4);
stack(
  n("2*4".add(12)).off(1/8, add(2))
  .scale(scale)
  .fast(2)
  .add("<0 1 2 1>").hush(),
  "<0 1 2 3>(3,8,2)".off(1/4, add("2,4"))
  .n().scale(scale),
  n("<0 4>(5,8,-1)").scale(scale).sub(note(12))
)
  .gain(".6 .7".fast(4))
  .add(note(4))
  .piano()
  .clip(2)
  .mul(gain(.8))
  .slow(2)
  .pianoroll()
