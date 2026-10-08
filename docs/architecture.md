# Architecture

A bird's-eye view of how Strudel IDE works: the parts, how a change travels
from a song file to the speakers, and where state lives. The details are in the
header comments of the files named here.

The browser page (the stage) plays songs with Strudel's runtime
(`@strudel/web`) on Web Audio, with samples fetched from Strudel's CDN at
startup (`src/engine/strudel.ts`). The Vite dev server sits between the song
files, the stage and your editor. There is no backend and no database: song
files are the source of truth, and the stage keeps per-browser settings in
localStorage.

```
editor ──save──▶ src/songs/*.ts ──watch──▶ Vite dev server ──HMR──▶ browser stage ──▶ Web Audio
  ▲                    ▲                      │       ▲                   ▲
  │                    └── knob write-back ───┘       │                   │
  └─────────── WebSocket /__strudel ──────────────────┴───────────────────┘
```

The editor and the stage never exchange messages directly: everything goes
through the dev server. Over the WebSocket the stage sends state, highlights
and knobs to editors. Editors send back commands, and unsaved code that the
server compiles for the stage.

## The parts

- **Songs** (`src/songs/`). TypeScript modules, found with `import.meta.glob`
  in `src/songs/index.ts`. They call Strudel's functions as globals, which the
  runtime installs and generated declaration files type (`src/strudel*.d.ts`).
  `createPattern()` returns a pattern, usually as named tracks for the mixer.
  A Strudel pattern is a function of time, so nothing is rendered ahead: the
  scheduler keeps asking it for the events just ahead of playback.
- **Vite plugins** (`vite-plugins/`):
  - `strudel-locations` wraps mini-notation literals in a call that records
    their offset in the file (`__strudel_m("…", offset)`, like strudel.cc's
    `m`). Events from those literals know which characters produced them,
    and that is what lights up. Strings built by helpers or variables play
    but stay dark.
  - `strudel-knobs` tells each `knob()` which song it belongs to, and serves
    `POST /__strudel/knob`, which rewrites a knob's number in the file.
  - `strudel-bridge` relays messages between the stage and editors over a
    WebSocket at `/__strudel` (protocol: `src/live/protocol.ts`). It also runs
    live eval (`strudel-live-eval.ts`): an unsaved editor buffer is compiled
    in memory as its own module.
- **Player** (`src/engine/`). Owns playback state. It builds the song's
  pattern, layers mute/solo, an error guard and section jumps/loops on top
  (the header of `player.ts` lists the layers) and swaps the result into the
  running scheduler.
- **Live signals** (`src/live/`). The highlighter turns the events sounding
  now into source ranges (at most 30 times a second) for the code view and the
  editor. The editor link maps bridge commands to the player.
- **Stage UI** (`src/ui/`). Plain TypeScript, DOM and canvas: code view,
  mixer, timeline, knobs, room lights. The DOM re-renders on player state
  changes, and one animation-frame loop drives what moves. Discovery (the
  library, the ⌘K palette and the track builder, `src/ui/discover/`) hangs off
  one small hooks module; each feature, and the catalog JSON in
  `src/catalog/`, is a lazy chunk loaded when it first opens.
- **Editor extension** (`vscode-extension/`). A client of the bridge; see
  [its README](../vscode-extension/README.md#how-it-works) for the protocol.
- **Scripts** (`scripts/`). Work on the same song files from the terminal:
  `check-songs` builds and queries every song in Node, `render` and `analyze`
  load the stage in headless Chromium to bounce and measure songs
  ([audio-tools.md](audio-tools.md)), and `export`/`import` convert to and
  from strudel.cc ([strudel-cc.md](strudel-cc.md)).

## A save, end to end

1. Vite sees the file change and recompiles that module through the two
   transforms (`strudel-locations`, then `strudel-knobs`).
2. Only `src/main.ts` imports the song registry at runtime, and it accepts
   the HMR update, so the page doesn't reload. It hands the new module to the
   player.
3. The player calls `createPattern()` and swaps the new pattern into the
   scheduler without resetting its clock. The change is heard on the next
   query.
4. If `createPattern()` or the new pattern throws, the last good pattern
   keeps playing and the error shows on the stage and in the editor. (A saved
   syntax error never reaches the player: Vite shows its error overlay.)

Live eval takes the same path, except that the module comes from the editor's
buffer instead of the disk, and the stage imports it when the bridge says so.
Mute/solo and section jumps only rebuild the outer layers, so they are
seamless too. Turning a knob rebuilds nothing: a knob's value is read each
time the pattern is queried.

## Where state lives

| Where | What |
| --- | --- |
| `src/songs/*.ts` | The music, including each knob's default value. The source of truth. |
| localStorage (`strudel-ide:*`) | The selected song, follow-edits and code view, and per song: mute/solo and live knob values. Optionally an editor-scheme override. |
| Stage memory | What's playing: the current build, the last good pattern, section jumps and loops, and evaluated unsaved buffers standing in for their files. Lost on reload. |
| Dev server memory | Recent unsaved buffers (live eval), and the latest stage state, replayed to editors that connect later. |
| `node_modules/.strudel/server.json` | The dev server's URL, so the extension finds it on any port. Removed when the server stops (a crashed server's leftover is ignored). |

A knob's live value lives in the browser, and its default is the number in
the source that's loaded (the file, or an evaluated buffer). When they differ
the knob is "dirty", and **Write** puts the live value into the file.

## The published stage

Every push to `main` deploys a static build to GitHub Pages
(`.github/workflows/pages.yml`). The transforms run in the build, so the
published stage plays songs and lights up their code, but it has no bridge, no
live eval and no knob write-back.
