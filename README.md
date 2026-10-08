# Strudel IDE

Write [Strudel](https://strudel.cc/) music in your editor with hot reload.

## Setup

```bash
npm install
npm run dev
```

## Usage

1. Select a song from the dropdown
2. Click **Play**
3. Edit songs in `src/songs/`. Saving hot-swaps the music without a restart.
   With the VS Code / Cursor extension you don't even have to save:
   Ctrl/Cmd+Enter (or a pause in typing) plays your unsaved code, like on
   strudel.cc (see [Live eval](#live-eval)).

## The stage

The browser page is the stage: a small rig of graphite gear (code display,
transport, visualizer, knobs, mixer, a sequencer strip of sections) in a room
lit by the music. The kick is a floor lamp, the pads a window wash, the bass a
pool of blue on the right and the snare light off the left wall. Track names
pick the colours and lamps (`kick`, `snare`, `hats`, `bass`, `pads`, `arp`,
`lead`, …), and `room: "club"` in a song swaps the dusk studio for a dark club
with hard strobes. With reduced motion turned on, the lamps hold a steady glow.

## Knobs

Like strudel.cc's `slider()`: write `knob(name, value, min, max, step?)`
wherever a number goes, and turn it on the stage while the music plays.

```typescript
const cutoff = knob("cutoff", 2200, 200, 8000, { log: true });
// … .lpf(cutoff), .gain(knob("drums", 0.8, 0, 1)), n(knob("degree", 3, 0, 7, 1))
```

- Turning a knob changes the sound right away, with no save and no hot-swap.
  Its value is read each time the pattern is queried, and otherwise it acts
  like the number literal.
- The stage keeps the knob's value per song, also across reloads. When it
  differs from the number in the file, the knob is "dirty", and **Write**
  (or **Write all**) puts the value into the file. The dev server rewrites the
  literal (`POST /__strudel/knob`).
- Editing the number in your editor resets the knob to it (when you save, or
  when the unsaved buffer is evaluated).
- While the player plays an unsaved buffer of the song (live eval), **Write**
  is refused: writing the file would replace your unsaved edits in the player.
  Save first, or write from the editor, which puts the value into its buffer.
- In `npm run check`, a knob plays its default.

## Editor integration (VS Code / Cursor)

`vscode-extension/` contains an extension that connects your editor to the
running player. It plays your unsaved code (live eval, below), outlines the
tokens that are playing and flashes them on every hit, shows the song, section
and bar in the status bar, plays and stops with Ctrl/Cmd+Enter and Ctrl+.,
jumps between and loops sections, puts a mute/solo mixer above each track's
definition (dimming silent tracks), shows each knob's live value next to its
`knob(…)` call (with a stepper and write-back), and shows player errors as
diagnostics. Clicking code in the browser player opens it in the editor. To
build it, run `npm run ext:package` and install
`vscode-extension/strudel-live.vsix`. See
[vscode-extension/README.md](vscode-extension/README.md).

## Live eval

strudel.cc evaluates the code in its editor without saving it, and so does
this IDE with the extension: Ctrl/Cmd+Enter in a song file with unsaved
changes sends the buffer to the dev server, which compiles it through Vite's
normal pipeline as its own module (`/src/songs/<name>.ts?live=<version>`, see
`vite-plugins/strudel-live-eval.ts`). The player hot-swaps it exactly like a
save. Nothing is written to disk. By default a short pause in typing does the
same for the song that's playing (`strudel.liveEval`: `onPause`, `onCommand`
or `off`).

- A buffer with a syntax error, or whose `createPattern()` throws, never
  replaces the music: the last good pattern keeps playing and the error shows
  in the stage and as a squiggle in the editor.
- The stage shows the evaluated text, marked **unsaved**, and the highlights
  index into it, so they also stay on in the editor while the document has
  unsaved changes.
- Saving afterwards loads the file through HMR as usual. When it says what you
  last evaluated, nothing is swapped again.
- Evaluating another song's buffer selects that song when "follow edits" is on.
- `knob()` calls in a buffer behave like in the file.

## Tests

```bash
npm run check        # fast, no browser: types, songs, bridge relay, extension
npm run test:e2e     # end-to-end in headless Chromium (~1 min)
npm run test:e2e:ui  # the same in Playwright's UI mode
npm run test:build   # production build (tsc + vite build into dist/)
```

The end-to-end suite (`e2e/`, Playwright) copies the app (`index.html`,
`src/`) into `.e2e-app/` and serves that copy with its own Vite dev server on
port 5310 (`E2E_PORT` to change it). It plays every song for a few seconds,
then edits a throwaway fixture song in the copy
(`.e2e-app/src/songs/zz-e2e-fixture.ts`) while it plays to check
hot-swapping, error handling, follow-edits, tempo changes, the editor bridge,
the production build, live eval of unsaved buffers (a Node WebSocket client
plays the editor) and knobs over the bridge. Your songs are never edited, and a
`npm run dev` session running at the same time (and the VS Code extension linked to it)
doesn't see any of it. `.e2e-app/` is deleted when the run ends. Tests drive
the player through `window.__strudel`, not the DOM.

The copy is made when the test server starts, so in `test:e2e:ui` changes to
`src/` don't reach the tests until you restart it.

First time on a new machine: `npx playwright install chromium`.

## Adding Songs

1. Copy `src/songs/_template.ts` to a new file (e.g., `my-song.ts`)
2. Edit the song
3. Done! Songs are auto-discovered.

## Song Structure

```typescript
import type { Song } from ".";

const song: Song = {
  name: "My Song",
  createPattern() {
    const kick = s("bd*4").bank("RolandTR808");
    const bass = note("<c2 f2 g2 a2>").sound("sawtooth").lpf(400);
    return stack(kick, bass);
  },
};

export default song;
```

## Docs

- [Architecture](docs/architecture.md): how the stage, the dev server and the editor fit together
- [Strudel Documentation](https://strudel.cc/)
- [Mini Notation](https://strudel.cc/learn/mini-notation/)

## Render and analyze

`npm run render -- <song>` bounces a song to `renders/<song>.wav` (offline, faster
than real time). `npm run analyze -- <song>` measures loudness, peaks, clipping,
spectral balance and each track's level against the mix. See
[docs/audio-tools.md](docs/audio-tools.md).

## Share on strudel.cc

`npm run export -- <song> --url` turns a song into a strudel.cc share link, and
`npm run import -- '<strudel.cc link>'` turns strudel.cc code into a song in
`src/songs/`. See [docs/strudel-cc.md](docs/strudel-cc.md).
