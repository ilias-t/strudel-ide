// Test fixture for scripts/test-strudel-cc.mjs, written for this repo (not
// from strudel.cc): one of each construct the importer has to convert.
// @title Bridge features
// @by Strudel IDE

samples('github:tidalcycles/dirt-samples') // a pack Strudel IDE doesn't load (unused below)
setcps(0.55)

const chords = "<C^7 A7 Dm7 G7>" // a double-quoted const is a Pattern on strudel.cc
const lead = (pat) => pat.s("square").decay(0.1).sustain(0)

// silenced by the hush() further down
$: s("cp*2").bank('RolandTR909')
hush()

// anonymous tracks, named after their sound
$: s("bd*4").bank('RolandTR909')
$: s("bd(3,8)").gain(0.5)
$: note("<c2 eb2>").s("sawtooth").lpf(slider(800, 200, 3000))

// a named track, a method on a string, a helper called with a string
bass: "<0 3 5 3>".add("<0 -2>").scale('C2 minor').note().s("triangle")
melody: lead(n("0 2 4 <6 7>")).scale('C4:minor')
keys: chord(chords).voicing().s("piano").gain(.4)

// muted tracks
_pad: note("c3,e3,g3").s("supersaw")
noise: s("white*8").gain(0.1).hush()

all(x => x.room(0.2))
all(x => x._pianoroll())
