# Architecture

A bird's-eye view of how Strudel IDE works: the parts, how a change travels
from a song's text to the speakers, and where state lives. The details are in
the header comments of the files named here.

The browser page (the stage) plays songs with Strudel's runtime
(`@strudel/web`) on Web Audio, with samples fetched from Strudel's CDN at
startup (`src/engine/strudel.ts`). A song's text can come from three places:
a file in `src/songs/`, your editor (Cursor / VS Code) through the Vite dev
server, or the stage's own editor, which compiles in the page. There is no
backend and no database: song files are the source of truth, and the stage
keeps browser edits, user songs and per-browser settings in localStorage.

```
                     ┌──────────── WebSocket /__strudel ────────────┐
                     ▼                                              ▼
editor ──save──▶ src/songs/*.ts ──watch──▶ Vite dev server ──HMR──▶ browser stage ──▶ Web Audio
                     ▲   ▲                   │      │                 │   ▲
                     │   └ knob write-back ──┘      │                 │   │ typing: compiled in a
                     └──── POST /__strudel/song ◀───┼──── ⌘S ─────────┘   │ worker, hot-swapped
                                                    │                     └─ localStorage (autosave)
```

The editor and the stage never exchange messages directly: everything goes
through the dev server. Over the WebSocket the stage sends state, highlights
and knobs to editors. Editors send back commands, and unsaved code that the
server compiles for the stage. On the hosted site there is no dev server, so
only the stage's own editor and its localStorage are left.

## The parts

- **Songs** (`src/songs/`). TypeScript modules, found with an eager
  `import.meta.glob` in `src/songs/index.ts`. They call Strudel's functions as
  globals, which the runtime installs and generated declaration files type
  (`src/strudel*.d.ts`). `createPattern()` returns a pattern, usually as named
  tracks for the mixer. A Strudel pattern is a function of time, so nothing is
  rendered ahead: the scheduler keeps asking it for the events just ahead of
  playback.
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
  - `strudel-songs` serves `POST /__strudel/song`, which writes a song the
    stage's editor saved to `src/songs/<id>.ts` (dev server only).
  - `local-request` is the gate the bridge and the write endpoints share:
    only pages served from this machine may write files or join the bridge.
- **Browser compiler** (`src/compile/`). The same transforms as the plugins
  (`locations.ts`, `knobs.ts` are the one shared implementation), plus
  TypeScript's `transpileModule`, run in a Web Worker (`worker.ts`, created
  on the first compile). `client.ts` is the main-thread side; `evaluate.ts`
  imports the result from a `blob:` URL with an inlined source map, so errors
  point at the line you typed. Highlight offsets index into the text exactly
  as they would into the file.
- **Player** (`src/engine/`). Owns playback state. It builds the song's
  pattern, layers mute/solo, an error guard and section jumps/loops on top
  (the header of `player.ts` lists the layers) and swaps the result into the
  running scheduler. It knows three kinds of song text: the files, evaluated
  text standing in for a song (`evalLive` from your editor, `evalSource` from
  the browser), and user songs that exist only in the browser (`addSong`,
  `removeSong`).
- **Songs store** (`src/songs-store/`). Keeps the browser's songs in
  localStorage: an *override* is edited text for a built-in song, a *user
  song* exists only here. It replays them into the player at boot, makes and
  opens share links (`share.ts`), downloads a song as a file, and saves to a
  file through the dev server. It only persists: evaluating is the player's
  job.
- **Live signals** (`src/live/`). The highlighter turns the events sounding
  now into source ranges (at most 30 times a second) for the code view and the
  editors. The editor link maps bridge commands to the player.
- **Stage UI** (`src/ui/`). Plain TypeScript, DOM and canvas: code view,
  mixer, timeline, knobs, room lights. The DOM re-renders on player state
  changes, and one animation-frame loop drives what moves. Edit mode is in
  its own modules:
  - `code-editor.ts`: Monaco on the code unit's glass (a lazy chunk), with
    the same highlights, flashes and knob chips as the read-only `code-view.ts`.
  - `edit-session.ts`: one per song, pure. Who owns the buffer (below), the
    debounced typing evals and ⌘/Ctrl+Enter, and what to do with outside
    changes.
  - `editor-source.ts`: the session's path into the player (`evalSource`).
  - `song-saver.ts`: the debounced autosave into the songs store.
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
   query. A saved file is the truth again: evaluated text standing in for that
   song steps down, and an eval of it still compiling is dropped.
4. If `createPattern()` or the new pattern throws, the last good pattern
   keeps playing and the error shows on the stage and in the editor. (A saved
   syntax error never reaches the player: Vite shows its error overlay.)

Live eval takes the same path, except that the module comes from the editor's
buffer instead of the disk, and the stage imports it when the bridge says so.
Mute/solo and section jumps only rebuild the outer layers, so they are
seamless too. Turning a knob rebuilds nothing: a knob's value is read each
time the pattern is queried.

## Typing in the browser, end to end

1. Monaco reports the edit. The song's `EditSession` takes the buffer, and
   the `SongSaver` schedules an autosave (300 ms).
2. After a pause (400 ms) the session evaluates the buffer as a *typing*
   eval: `player.evalSource(id, text, { intent: "typing" })`.
3. The player hands the text to the compiler worker, imports the module and
   swaps it in exactly like a save: seamless while playing, and a text that
   doesn't build never replaces the last good pattern. A typing eval never
   opens the stage's error panel: its error comes back to the session and
   shows inline, as a marker and a status in the file bar.
4. The autosave writes the buffer to the store, built or not, so a reload
   brings it back. A buffer that says exactly what the file says drops the
   kept copy instead.

⌘/Ctrl+Enter evaluates at once as a *commit*, which reports errors like a
save. Evals can finish out of order, so each is numbered: per song, the player
only applies the newest eval, add or revert (`nextSeq`), and the session only
shows the newest result. A session that gives up its buffer (load theirs, a
save, a revert) also cancels its own eval still compiling, through an
`AbortSignal`; it can't bump the player's per-song number for that, because
your editor's evals share it.

**⌘/Ctrl+S.** Under `npm run dev` the stage posts the buffer to
`POST /__strudel/song`, which writes `src/songs/<id>.ts`. From there it is an
ordinary save: HMR brings the file in, and the store drops the kept copy once
the file says what it said. Saves of one song are chained, so an older, slower
one never lands after a newer one. On the hosted site ⌘S keeps the buffer in
localStorage at once.

**Revert** forgets the kept copy and plays the song's file again
(`player.revertSource`). It also bumps the song's eval number, so an eval
still compiling can't bring the edit back, and restores the file's top-level
knob declarations.

**Share links** put the song in the URL hash (`#song=…`: deflated, base64url
JSON of `{ v: 1, id, text }`), so the song never reaches a server. Opening one runs
its code, so nothing is compiled before the person agrees on the stage's card
(`share-confirm.ts`). The song is added as a user song (under its own id, or
`<id>-shared` when that id holds something else) and selected. It isn't saved
in their browser until they edit it.

**User songs that don't build** (a saved draft after a reload, or a share
link) are never dropped: they join the list as a placeholder that plays
silence, marked ⚠ in the picker. The editor opens their text with the error
inline, and the first edit that builds replaces the placeholder.

## Your editor and the browser on one song

Under `npm run dev` both can edit the song that's playing. `EditSession`
decides whose text the browser shows, so neither silently overwrites the
other:

| Owner | When | The browser's buffer |
| --- | --- | --- |
| mirror | nobody typed in the browser | follows the song: the file, or a buffer the browser evaluated |
| ide | your editor live-evaluates an unsaved buffer | shows it read-only, with a **take over** key |
| browser | you typed in the browser (or took over) | yours: a save or a newer IDE buffer becomes a *conflict*, offered with **load theirs** |

- The browser stops owning the buffer when the file is saved with exactly its
  text (back to mirror), when you load theirs, or when you revert.
- Loading theirs also makes the player play theirs: the browser's eval may
  have landed after theirs arrived, so the IDE's buffer is evaluated again (or
  the file plays again).
- A built-in song has a kept copy in the store exactly while the browser owns
  its buffer: every way out of browser ownership cancels the pending autosave
  and drops the copy, so a reload never brings back an abandoned draft. A user
  song's stored text is the song itself, so it stays; loading theirs stores
  their text in its place.
- The session recognises the echoes of its own evals (by content version), so
  its own text coming back from the player is never a conflict.

## At boot

`main.ts` picks the current song, mounts the stage and starts the audio
engine. Then it builds the current song once (so the mixer and timeline know
it before play), starts the store's replay and loads the sample maps, all of
them in parallel. What the page loads lazily:

| What | Loaded when |
| --- | --- |
| Monaco and the editor's TypeScript libs (`code-editor.ts`, `editor-lang.ts`) | you first press **E** (or the last visit ended in edit mode) |
| The compiler (`compile/client.ts`, its worker, TypeScript) | the first `evalSource` / `addSong`: typing, a stored song, or a share link |
| A share link's song | after "open it" on the stage's card |

The songs store replays what's kept (`initSongsStore`) after the first build:
overrides through `evalSource` (commit), user songs through `addSong`, then a
share link. Each stored entry is read again right before it's replayed, so a
song reverted meanwhile stays reverted. With nothing stored and no link the
store never calls the player, so a visit that only plays never loads the
compiler (`e2e/production.spec.ts` checks this on a production build).

## Where state lives

| Where | What |
| --- | --- |
| `src/songs/*.ts` | The music, including each knob's default value. The source of truth. |
| localStorage (`strudel-ide:*`) | The selected song, follow-edits, code view and edit mode, the first-visit hint, and per song: mute/solo, live knob values, and the browser's kept text (`my-song:<id>`: an override or a user song). Optionally an editor-scheme override. |
| URL hash | A share link's song, until it's opened. |
| Stage memory | What's playing: the current build, the last good pattern, section jumps and loops, evaluated text standing in for songs, user songs, and each song's edit session. Rebuilt from localStorage on reload. |
| Dev server memory | Recent unsaved buffers (live eval), and the latest stage state, replayed to editors that connect later. |
| `node_modules/.strudel/server.json` | The dev server's URL, so the extension finds it on any port. Removed when the server stops (a crashed server's leftover is ignored). |

A knob's live value lives in the browser, and its default is the number in
the source that's loaded (the file, or evaluated text). When they differ the
knob is "dirty", and **Write** puts the live value into the file.

## The published stage

Every push to `main` deploys a static build to GitHub Pages
(`.github/workflows/pages.yml`). The transforms run in the build, so the
published stage plays songs and lights up their code, and its editor compiles
in the page. It has no bridge, no live eval, no knob write-back and no save to
file: edits stay in that browser until they're downloaded or shared.
