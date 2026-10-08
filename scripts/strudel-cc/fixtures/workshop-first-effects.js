// Test fixture for scripts/test-strudel-cc.mjs, copied verbatim (below this header) from
// the strudel.cc workshop, "First effects" (website/src/pages/workshop/first-effects.mdx)
// in Strudel, https://codeberg.org/uzu/strudel (Strudel contributors).
// License: AGPL-3.0-or-later
// @title Workshop: first effects

$: sound("hh*8").gain("[.25 1]*4")

$: sound("bd*4,[~ sd:1]*2")

$: note("<[c2 c3]*4 [bb1 bb2]*4 [f2 f3]*4 [eb2 eb3]*4>")
.sound("sawtooth").lpf("200 1000 200 1000")

$: note("<[c3,g3,e4] [bb2,f3,d4] [a2,f3,c4] [bb2,g3,eb4]>")
.sound("sawtooth").vowel("<a e i o>")
