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

## Editor integration (VS Code / Cursor)

`vscode-extension/` contains an extension that connects your editor to the
running player. It outlines the tokens that are playing, shows the song and bar
in the status bar, plays and stops with Ctrl/Cmd+Enter and Ctrl+., and shows
player errors as diagnostics. To build it, run `npm run ext:package` and
install `vscode-extension/strudel-live.vsix`. See
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
