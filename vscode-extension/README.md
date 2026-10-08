# Strudel Live (VS Code / Cursor extension)

strudel.cc-style live coding for the Strudel IDE. The extension connects your
editor to the player running in the browser (through the Vite dev server), so
you get:

- **Live eval without saving**: like strudel.cc, Ctrl/Cmd+Enter plays what's
  in the editor, unsaved. By default the song you're editing also updates when
  you stop typing for a moment. Nothing is written to disk; save when you want
  to keep it. Code that doesn't compile or build never replaces what's
  playing: you get a red squiggle and the music carries on. See
  [Live eval](#live-eval).
- **Live highlights**: the mini-notation tokens that are sounding right now get
  an outline in the editor, like on strudel.cc. They stay on while you type:
  tokens you don't touch keep lighting up, and the ones you edit catch up at
  the next eval.
- **Hit pulses**: every note onset briefly flashes its token, so a retriggered
  token like `bd*4` visibly hits four times a bar instead of just staying lit.
- **Status bar** that follows the song, including jumps and loops:
  `▶ Neon Drive · chorus · bar 3/16 · 104 BPM`, with a loop icon before the
  section while it loops and `verse → chorus` while a jump waits for the bar
  line. Songs without sections show `▶ Jynx · bar 33 · 126 BPM`. Click it to
  play or stop. It turns red and shows the message when the player reports an
  error, and shows `Strudel: player not connected` (click to open the player)
  when no browser tab is connected.
- **Sections**: Jump to Section… (a quick pick of the song's sections), Next /
  Previous Section and Toggle Loop Section, with keys in song files. Jumps land
  on the next bar line, like clicking the timeline in the stage.
- **Mixer in the code**: in the song that's loaded in the player, each track
  gets a CodeLens above its definition (`const kick = …`, or the property in
  the object `createPattern` returns) with its state and actions:
  `🔇 muted · unmute | solo`, `🎧 solo · unsolo | mute`,
  `🔊 on · mute | solo`. A `🎚 2 muted · unmute all` lens sits on the `return`.
  Muted tracks, and tracks silenced by a solo, are dimmed over their whole
  definition, so you can see what's silent.
- **Click in the browser, land in the editor**: clicking a token or line in the
  stage's code view, or the location in its error panel, opens that file at
  that line and column here and brings the window to the front.
- **Keys**: Ctrl/Cmd+Enter plays, updates or stops the song you're editing.
  Ctrl+. stops. More under [Keybindings](#keybindings).
- **Errors as diagnostics**: player errors that carry a file and line show up as
  red squiggles in that file and go away once the song evaluates cleanly.
- **Knobs in the code**: each `knob("cutoff", 2200, 200, 8000)` call shows its
  live value right after it (`◉ 1800`), amber while it differs from the
  number in the code. **Strudel: Adjust Knob…** (Ctrl+Alt+K, on the knob under
  the cursor) opens a stepper that stays open: step down/up, ±5% of the
  travel, type a number and Enter, reset, write. A turned knob gets a
  `◉ cutoff changed · write | reset` CodeLens. Writing puts the value into the
  file (the dev server rewrites the literal), or, when the document has
  unsaved changes, into the editor buffer (and evaluates it, unless
  `strudel.liveEval` is `"off"`).
- **CodeLens**: `▶ Play` / `■ Stop` above `createPattern` in every song file.
- **Commands** (`Strudel: …` in the command palette): Play This File,
  Next/Previous Song, Jump to Section…, Next/Previous Section, Toggle Loop
  Section, Mute/Solo Track…, Unmute All Tracks, Adjust Knob…, Write Knob to
  Code…, Write All Changed Knobs to Code, Reset Knob…, Open Player in Browser,
  Start Dev Server, Reconnect.

The stage shows the link too: its editor LED is green with the editor's name
(`Cursor`, `VS Code`) when an editor is attached, amber when the dev server
bridge is up but no editor is, and dark without the bridge.

## Build and install

From the repo root:

```bash
npm run ext:package   # installs extension deps on first run, builds, writes vscode-extension/strudel-live.vsix
```

Then install the `.vsix`:

```bash
code   --install-extension vscode-extension/strudel-live.vsix   # VS Code
cursor --install-extension vscode-extension/strudel-live.vsix   # Cursor
```

You can also use **Extensions: Install from VSIX…** in the command palette of
either editor. Reload the window after you install or update.

Other scripts: `npm run ext:build` bundles to `vscode-extension/dist/` and
`npm run ext:check` runs the typecheck and unit tests. Inside
`vscode-extension/` you can also run `npm run watch`. To debug, run
`npm run ext:build`, open `vscode-extension/` in VS Code and press F5. That
starts an Extension Development Host on the repo root.

## Use

1. Run `npm run dev` and open the player in the browser. **Click once anywhere
   on the page**: browsers only allow audio after a user gesture, and commands
   from the editor don't count as one.
2. Open the repo in VS Code or Cursor. The extension activates when the
   workspace contains `src/songs/*.ts`.
3. Open a song in `src/songs/` and press **Cmd+Enter** (macOS) or
   **Ctrl+Enter**.

What Ctrl/Cmd+Enter does ("evaluate", like strudel.cc):

| Editor state | Action |
| --- | --- |
| unsaved changes, song is playing | evaluate the buffer: the player hot-swaps it, nothing is saved |
| unsaved changes, song not playing | evaluate the buffer, select this song, play |
| saved, song is playing | stop |
| saved, another song or nothing is playing | select this song, play |
| not a song file | toggle play/stop |

With `strudel.liveEval` set to `"off"`, unsaved changes are saved instead and
Vite HMR hot-swaps them (the behavior before 0.3.0). With live eval on,
Ctrl/Cmd+Enter never saves: without a player connected it only tells you so.
The status bar shows
`● unsaved` while the player plays a buffer you haven't saved.

### Live eval

`strudel.liveEval` picks when the unsaved buffer of a song file goes to the
player:

| Value | When |
| --- | --- |
| `"onPause"` (default) | when you stop typing for `strudel.liveEvalDelay` ms (600), and on Ctrl/Cmd+Enter |
| `"onCommand"` | only on Ctrl/Cmd+Enter, exactly like strudel.cc |
| `"off"` | never: Ctrl/Cmd+Enter saves |

Why `onPause` is the default: it keeps the music and the highlights in step
with the code you see, which is the point of not having to save, and it's
safe to leave on:

- a buffer that doesn't compile (a syntax error) or whose `createPattern()`
  throws never replaces what's playing. The player keeps the last good
  pattern and the error shows up as a squiggle on your unsaved text.
- a pause only updates the song that's loaded in the player. Typing in
  another song never switches the music (Ctrl/Cmd+Enter does, like it
  always has).
- the same text is never sent twice, and a document you didn't change since
  the last save sends nothing.

The tradeoff: code that is valid halfway through an edit plays for a moment
if you pause there, e.g. `.lpf(8)` on the way to `.lpf(800)`. When you
perform, or prefer strudel.cc's explicit evaluation, use `"onCommand"`. 600 ms
is longer than the gaps between keystrokes while you type a word, and short
enough to feel live.

Saving afterwards is seamless: when the saved text is what the player already
plays, it doesn't swap again. Highlights and pulses carry the version of the
text they index into (the saved file or an evaluated buffer), so they show
on the unsaved document whenever its text is that version, and follow the
edits you make after it.

### Keybindings

| Key | Command | Notes |
| --- | --- | --- |
| Cmd+Enter (macOS), Ctrl+Enter (all) | Strudel: Play / Update / Stop | Only active in song files (`strudel.isSongFile`). It overrides *Insert Line Below* there. |
| Ctrl+. | Strudel: Stop | strudel.cc's stop key. On Windows/Linux it overrides *Quick Fix* in song files (the lightbulb still works). |
| Ctrl+Alt+J | Strudel: Jump to Section… | Quick pick of the song's sections. |
| Ctrl+Alt+L | Strudel: Toggle Loop Section | Loops the section that's playing (or the one a jump is heading to). |
| Ctrl+Alt+] (macOS), Ctrl+Alt+PageDown | Strudel: Next Section | |
| Ctrl+Alt+[ (macOS), Ctrl+Alt+PageUp | Strudel: Previous Section | |
| Ctrl+Alt+K | Strudel: Adjust Knob… | The knob under the cursor, else a pick list. |

All of them are only active in song files. Windows/Linux use PageUp/PageDown
for the section keys because Ctrl+Alt is AltGr on many keyboard layouts; if
Ctrl+Alt+J or Ctrl+Alt+L types a character you need (e.g. AltGr+L is `ł` on
Polish layouts), rebind them. Jump to Section and Adjust Knob take an optional
argument (a section, a knob name), so
you can bind a key straight to a section:

```json
{ "key": "ctrl+alt+1", "command": "strudel.jumpToSection", "args": "chorus", "when": "strudel.isSongFile" }
```

On macOS, Cmd+. is deliberately **not** bound because it's Quick Fix. To use it
anyway, add this to `keybindings.json`:

```json
{ "key": "cmd+.", "command": "strudel.stop", "when": "editorTextFocus && strudel.isSongFile" }
```

The context keys you can use in your own `when` clauses are
`strudel.isSongFile`, `strudel.connected` (dev server reachable),
`strudel.playerConnected`, `strudel.playing`, `strudel.hasSections` and
`strudel.looping`.

### Settings

| Setting | Default | |
| --- | --- | --- |
| `strudel.serverUrl` | `""` | Dev server URL. Empty means auto-detect. |
| `strudel.liveEval` | `"onPause"` | When unsaved changes play: `onPause` (a typing pause, and Ctrl/Cmd+Enter), `onCommand` (Ctrl/Cmd+Enter only), `off` (Ctrl/Cmd+Enter saves). See [Live eval](#live-eval). |
| `strudel.liveEvalDelay` | `600` | Milliseconds without typing before `onPause` evaluates (at least 150). |
| `strudel.highlights.enabled` | `true` | Live token outlines (and pulses). |
| `strudel.highlights.pulses` | `true` | Flash a token on every hit. |
| `strudel.codeLens` | `true` | ▶ Play / ■ Stop above `createPattern`. |
| `strudel.mixer.codeLens` | `true` | Mute/solo lenses above each track. |
| `strudel.mixer.dimMuted` | `true` | Dim the definitions of silent tracks. |
| `strudel.knobs.hints` | `true` | The live value after each `knob(…)` call. |
| `strudel.knobs.codeLens` | `true` | Write / reset lenses above turned knobs. |
| `strudel.reveal.focusWindow` | `"auto"` | How a click in the browser brings this window forward: `auto` activates the editor app on macOS (`open -a`), `uri` opens the editor's own `cursor://file/…` link (focuses the right window, the editor may ask to confirm), `off` only opens the file. |

The highlight colors can be themed under `workbench.colorCustomizations`:

```json
"workbench.colorCustomizations": {
  "strudel.highlightBorder": "#ff79c6",
  "strudel.highlightBackground": "#ff79c622",
  "strudel.pulseBackground": "#ff79c688",
  "strudel.pulseBorder": "#ffffff",
  "strudel.knobForeground": "#8be9fd",
  "strudel.knobDirtyForeground": "#ffb86c"
}
```

### Opening files from the browser without the extension

When no editor is attached, clicking code in the stage opens a
`<scheme>://file/<absolute path>:line:column` link instead. The dev server
picks the scheme, first match wins:

1. `strudelBridge({ editorScheme: "cursor" })` in `vite.config.ts`, or the
   `STRUDEL_EDITOR` environment variable (`STRUDEL_EDITOR=vscode npm run dev`)
2. the editor that attached most recently (the extension tells it its scheme)
3. Cursor, if the dev server runs in Cursor's terminal or Cursor is installed
4. `vscode`

A browser can override it with
`localStorage.setItem("strudel-ide:editor-scheme", "vscode-insiders")`.

## How it works

```
browser player ──state/songs/highlight/onsets/reveal/knobs──▶ Vite dev server ──▶ this extension
               ◀──────────────command (incl. knobs)───────── /__strudel relay ◀──
               ◀── live {url | error} ── compiles ◀── eval {file, text} ───────────
               ◀── editors {count} / server {root, editorScheme}
```

- `npm run dev` runs a WebSocket relay at `ws://localhost:<port>/__strudel`
  (`vite-plugins/strudel-bridge.ts`) and writes
  `node_modules/.strudel/server.json` with the real port. The extension reads
  that file before every connection attempt, so it also finds a server on 3001
  and up. `strudel.serverUrl` overrides it, and the fallback is
  `http://localhost:3000`. A file left behind by a crashed server is ignored
  because its pid is dead.
- The message types live in `src/live/protocol.ts`, shared with the browser
  and the relay.
- **Live eval** (`vite-plugins/strudel-live-eval.ts`): the extension sends
  `{ type: "eval", file, text, version }`. The dev server checks it's an
  existing song file (`src/songs/<name>.ts`, at most 512k characters), keeps
  the text in memory and compiles it as the module
  `/src/songs/<name>.ts?live=<version>` through Vite's own pipeline (its
  `load` hook returns the buffer), so TypeScript stripping, mini-notation
  locations and `knob()` routing apply exactly as for the file. Syntax errors
  are caught on the server (no Vite error overlay in the player) and come back
  as a located player error. Otherwise the browser imports the module and
  hot-swaps it like a save. The player answers with `evalResult`.
- Highlight offsets index into the text identified by `version`
  (`contentVersion(text)`): the file on disk or an evaluated buffer. The
  extension shows them on a document whose text has that version, saved or
  not. After that it records your edits, so ranges move with the text you
  insert or delete before them and only the tokens you edit go dark until the
  next eval. Unversioned offsets are only shown on saved documents.
  Decorations are cleared when playback stops or the player disconnects.
- **Knobs**: the player sends the current song's knobs
  (`{ type: "knobs", songId, file, knobs: [{ name, value, def, min, max, step, log, dirty }] }`)
  whenever they change, at most ~30 times a second, and the relay replays the
  latest to editors that connect later. The extension turns them with the
  commands `setKnob`, `resetKnob`, `grabKnob` (held while the stepper is
  open, so a file edit doesn't reset it) and `writeKnobs` (answered with
  `knobWrite`). The dev server refuses to write a knob into the file while
  the player plays an unsaved buffer of it (the extension writes into the
  buffer then), and says so when the knob only exists in the buffer.
- Highlights and onsets each arrive at most about 30 times per second (onsets
  only when something was hit). The extension uses one decoration type per
  layer (highlights, pulses, dimmed tracks), caches a line index and the track
  definitions per document version, and calls `setDecorations` only on editors
  showing the affected file (plus a single clearing call when one stops
  matching). Pulses expire after ~140 ms with one timer for all of them.
- `state` carries the song position (`position`, in bars, with jumps and loops
  applied), the sections, the current section and the loop flag. Between
  messages the extension extrapolates with `cps`, wrapping inside a looped
  section or the song. The player sends a new state whenever a section starts
  or a jump lands.
- Track definitions come from a small scanner (`src/tracks.ts`, not a full
  parser): the keys of the object `createPattern` returns, each mapped to its
  `const`/`let` declaration (inside `createPattern`, else at the top level) or
  to the property itself.

## Tests

`npm run ext:check` runs `tsc` and `node --test` (Node ≥ 22.18, which runs
TypeScript directly):

- `test/logic.test.ts`: offset → range mapping, message handling, command
  planning (including live eval), status text, song position (sections,
  loops, jumps), track definitions (including every real song), pulses,
  discovery, carrying highlight ranges across edits, the live-eval debounce,
  and knob hints, stepping and buffer writes.
- `test/activation.test.ts`: runs the real `extension.ts` against a fake
  `vscode` module and a fake bridge over a real WebSocket. It covers status,
  highlights (version and dirty checks), hit pulses, sections and their
  commands, the mixer CodeLens and dimming, reveal, diagnostics, CodeLens,
  commands, quick pick, disconnect and reconnect, and live eval: the typing
  pause debounce, highlights on an unsaved document (with a matching version,
  then across edits), diagnostics from eval errors, Ctrl/Cmd+Enter on unsaved
  text, knob hints, the write lens (into the buffer when unsaved, the file
  otherwise) and the Adjust Knob stepper.

There is no `@vscode/test-electron` smoke test because it would download a
full VS Code build.
