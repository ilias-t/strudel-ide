# H2: Instrument in a room

## Pitch

The stage is a small rig of solid graphite gear on a desk in a dim studio at dusk. The room is the whole viewport: a soft field of coloured light from a few fixed lamps, each one a part of the mix. A lavender window wash from above swells with each pad chord. A blue pool on the right breathes with the bass. Rose light comes off the left wall on the snare. A peach floor lamp in front flares on every kick. The modules (a code display, transport units, a knob unit, a mixer and a sequencer strip) are fully opaque, so the light never shows *through* them. It lands *on* them instead: coloured rim light on the edge that faces each lamp, a faint tint on the powder coat, and a shadow that jumps up and back each time the floor lamp fires. The screens are emissive black glass that the room light never touches, so the code stays as crisp as the Hardware mock's OLED. The point is the contrast: still, precise objects in a room that moves with the music.

Switch songs (the ▸ key or `a`) to Acid Rain and the room changes: near-black, an acid-green field from the 303 that grows and shrinks with the filter, ultraviolet flicker from the hats, and a white 909 floor strobe with almost no tail. That shot is the transient test.

## Palette

| token | hex | role |
|---|---|---|
| coat | `#232325` (hi `#2C2C2F`, lo `#1C1C1E`) | graphite powder coat on every module, with a faint noise grain |
| silk | `#E6E1D6` / soft `#A29D93` | silkscreen labels |
| glass | `#060607`, text `#EEE9DE` | every screen: code, LCDs, pianoroll/scope |
| ember | `#FF6A2B` | drums, LEDs, the dirty knob arc, mute |
| cobalt | `#3F6BFF` | bass, method names, cutoff knob |
| lilac | `#9C82F2` | pads, reverb knob |
| teal | `#1DB89F` | arp |
| cream | `#F1ECE1` | lead, swing knob, rubber-key highlights |
| acid | `#B9F03A` | the 303 in Acid Rain (light, scope, numbers, LEDs) |
| red | `#FF4433` | errors only |
| room, neon | base `#1F2150` to `#2A1C38`, lights `#8C78E8` pads, `#3F78FF` bass, `#F0729A` snare, `#FF8A5A` kick | dusk |
| room, acid | base `#0C0B18`, lights `#A6E62E` acid, `#7A4DFF` hats, `#FF3D9A` clap, `#E4E0FF` kick | club |

Track colours do two jobs: they're the knob caps, keys and meter LEDs, and in the room they're the lamp colours, so a lilac pad cap and the lilac window wash belong to the same part.

## Type

- **Instrument Sans** at 75–80% width: lowercase silkscreen labels and the condensed `strudel` wordmark. It's narrow enough for 13 mixer strips.
- **Geist Mono** for code and screen text. It's narrower than Martian Mono, which is how 36 lines and ~105 columns fit.
- Tempo and bar use hand-built SVG seven-segment digits with ghost segments, lit warm white on black glass.

## Layout (1440×900)

Top row: three separate units (brand + song screen + ◂▸, transport + tempo + bar + beat LEDs, follow edits + editor link + ?), with open room between them. Middle: the code display unit (36 visible lines, live tokens) and a right column of pianoroll/scope, knobs, and an 11- or 13-strip mixer. Bottom: the sequencer strip, with the section screen, labelled section brackets over one LED per bar, and the loop key. The gaps (20–24px) and margins (24–32px) leave the room visible all round, and the rim light carries it onto the gear.

## What changed vs round 1

- **Projector wash-out (A).** The chassis is now dark graphite, not light grey. The only light surfaces are knob caps, lit keys and the code itself. The code screen is still the brightest, highest-contrast thing on screen, and a bright room fills the gaps instead of a bright frame.
- **GPU cost (D).** No `backdrop-filter` anywhere, and no translucent gear. The room is a 1/10-resolution canvas (144×90 at 1440) with radial gradients, upscaled by the browser. A second copy is screen-blended over the gear at 11% opacity, and the screens sit above it so they stay untinted. Rims and the kick shadow are fixed `box-shadow` layers whose `opacity` alone changes per frame. Meters are a fixed segment strip with a `scaleY` cover. All of that is compositor-friendly.
- **Hard transients (D).** Every song sets its own light envelopes. Neon Drive: kick 4 ms attack and 300 ms decay, pads 350 ms attack. Acid Rain: kick 0.5 ms attack and 110 ms decay, hats 35 ms. In the acid screenshot (4 ms after a kick) the floor strobe lifts the whole room while the gear stays dark and sharp.
- **Contrast of small text (D).** Secondary labels sit on opaque graphite, not on glass over moving colour.
- **Code lines (A: 28 at 1440, 25 at 1280).** Now 36 at 1440 and 33 at 1280, counted in the rendered page.
- **Density (A).** Bezels are thin (10px) on the code unit, and 13 strips fit without paging.

## States and interaction

- `index.html`: Neon Drive, chorus bar 3 of 16, 35.2, looping, toms muted, cutoff dirty (2200 Hz vs 1800 Hz in the file) with a lit LED, an arc from the file mark and a "write to file" key.
- `?acid`, `a` or the ◂▸ keys: Acid Rain, 134 BPM, 8 sections and 96 bars, 13 tracks. The display switches to a scope (that song's `visualization: "scope"`) showing the saw folding under resonance and drive. Resonance is the dirty knob (22 vs 17). The code shows real `acid-rain.ts` lines 185–220, so `bd*4`, `fourFloor` and `hh*16` hit as hard inverts.
- `?error` or `e`: the broken line (`neon-drive.ts:209`, an unclosed `s(`, or `acid-rain.ts:207`, `shap`) gets a red line number, a wavy underline and a red wash. An alert panel on the glass names the place, says what's wrong and states that the last good version keeps playing. The hot-swap LED on the file bar turns red.
- `?` or `?help`: a printed quick-reference card lies on the desk over the rig.
- Space plays or stops. Section brackets click to queue a jump (it blinks until the next bar), `1`–`9` do the same, and `l` or the key toggles loop. `m`/`s` keys work and muted tracks drop out of the light, meters and tokens. Knobs drag or take arrow keys. `window.seek(beats)` freezes the clock for screenshots (see `shoot.js`).
- With reduced motion, the lights hold a steady level instead of pulsing.

## Files

- `shot-1440.png`, `shot-1280.png`, `shot-acid-1440.png`, `shot-error-1440.png`, `shot-help-1440.png`
- `shot-*-v1.png`, `-v2.png`, `-v3.png`: the iteration passes. v1 had a lighter coat and 20% spill, which made the gear read lilac and semi-translucent. v2 darkened the coat, cut the spill to 11%, fixed the knob overflow, gave meters per-track gain and simplified the pianoroll. v3 strengthened the rims, made the acid kick a real strobe and widened the gaps.

## Best at

- **Mood plus precision.** You get Ambient's living room and Hardware's crisp, touchable gear without either compromising the other. The gear never goes soft.
- **Reading the mix from across a room.** The kick is the floor lamp and the snare is the left wall, so you can feel the arrangement in your peripheral vision while reading code.
- **Genre range.** The same rig reads as a calm dusk studio for Neon Drive and a dark strobing club for Acid Rain, because light envelopes and palette are per song.
- **Projector and stream.** Dark gear with the brightest pixels in the code. The room's slow gradients compress well in a stream.

## Worst at

- **The room still lives mostly in the margins.** At 1440 the gear covers most of the frame, so the environment shows as a frame of light plus rims. A "room" toggle that shrinks the rig would sell it better on a big screen.
- **Strobe comfort.** The acid kick flash is deliberately hard. It needs a per-user cap, which reduced motion already handles but a separate setting should too.
- **The pianoroll is small.** 8 cycles in a 436px window is busy. It might work better as a wide strip under the code or as a fullscreen mode.
- **Same-shape modules.** Rounded rectangles of one material risk the card-grid look. The screws, bezel depths and different units help, but a real rig would mix more form factors.
