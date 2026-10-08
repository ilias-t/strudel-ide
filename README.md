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
3. Edit songs in `src/songs/` — changes hot reload automatically

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
- Editing the number in your editor resets the knob to it.
- In `npm run check`, a knob plays its default.

## Editor integration (VS Code / Cursor)

`vscode-extension/` contains an extension that connects your editor to the
running player. It outlines the tokens that are playing and flashes them on
every hit, shows the song, section and bar in the status bar, plays and stops
with Ctrl/Cmd+Enter and Ctrl+., jumps between and loops sections, puts a
mute/solo mixer above each track's definition (dimming silent tracks), and
shows player errors as diagnostics. Clicking code in the browser player opens
it in the editor. To build it, run `npm run ext:package` and install
`vscode-extension/strudel-live.vsix`. See
[vscode-extension/README.md](vscode-extension/README.md).

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
hot-swapping, error handling, follow-edits, tempo changes, the editor bridge
and the production build. Your songs are never edited, and a `npm run dev`
session running at the same time (and the VS Code extension linked to it)
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
