// Test fixture for scripts/test-strudel-cc.mjs, copied verbatim (below this header) from
// the strudel.cc workshop, "Pattern effects" (website/src/pages/workshop/pattern-effects.mdx)
// in Strudel, https://codeberg.org/uzu/strudel (Strudel contributors).
// License: AGPL-3.0-or-later
// @title Workshop: pattern effects

n("0 [4 <3 2>] <2 3> [~ 1]"
  .off(1/16, x=>x.add(4))
  //.off(1/8, x=>x.add(7))
).scale("<C5:minor Db5:mixolydian>/2")
.s("triangle").room(.5).dec(.1)
