// Test fixture for scripts/test-strudel-cc.mjs, copied verbatim (below this header) from
// the strudel.cc workshop, "First sounds" (website/src/pages/workshop/first-sounds.mdx)
// in Strudel, https://codeberg.org/uzu/strudel (Strudel contributors).
// License: AGPL-3.0-or-later
// @title Workshop: first sounds

setcpm(88/4)
sound(`
[-  -  -  - ] [-  -  -  - ] [-  -  -  - ] [-  -  oh:1 - ],
[hh hh hh hh] [hh hh hh hh] [hh hh hh hh] [hh hh -  - ],
[-  -  -  - ] [cp -  -  - ] [-  -  -  - ] [~  cp -  - ],
[bd bd -  - ] [-  -  bd - ] [bd bd - bd ] [-  -  -  - ]
`).bank("RolandTR808")
