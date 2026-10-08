# Strudel Live (VS Code / Cursor extension)

strudel.cc-style live coding for the Strudel IDE. The extension connects your
editor to the player running in the browser (through the Vite dev server), so
you get:

- **Live highlights**: the mini-notation tokens that are sounding right now get
  an outline in the editor, like on strudel.cc.
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
- **CodeLens**: `▶ Play` / `■ Stop` above `createPattern` in every song file.
- **Commands** (`Strudel: …` in the command palette): Play This File,
  Next/Previous Song, Jump to Section…, Next/Previous Section, Toggle Loop
  Section, Mute/Solo Track…, Unmute All Tracks, Open Player in Browser, Start
  Dev Server, Reconnect.

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
| unsaved changes, song is playing | save, and Vite HMR hot-swaps it |
| unsaved changes, song not playing | save, select this song, play |
| saved, song is playing | stop |
| saved, another song or nothing is playing | select this song, play |
| not a song file | toggle play/stop |

### Keybindings

| Key | Command | Notes |
| --- | --- | --- |
| Cmd+Enter (macOS), Ctrl+Enter (all) | Strudel: Play / Update / Stop | Only active in song files (`strudel.isSongFile`). It overrides *Insert Line Below* there. |
| Ctrl+. | Strudel: Stop | strudel.cc's stop key. On Windows/Linux it overrides *Quick Fix* in song files (the lightbulb still works). |
| Ctrl+Alt+J | Strudel: Jump to Section… | Quick pick of the song's sections. |
| Ctrl+Alt+L | Strudel: Toggle Loop Section | Loops the section that's playing (or the one a jump is heading to). |
| Ctrl+Alt+] (macOS), Ctrl+Alt+PageDown | Strudel: Next Section | |
| Ctrl+Alt+[ (macOS), Ctrl+Alt+PageUp | Strudel: Previous Section | |

All of them are only active in song files. Windows/Linux use PageUp/PageDown
for the section keys because Ctrl+Alt is AltGr on many keyboard layouts; if
Ctrl+Alt+J or Ctrl+Alt+L types a character you need (e.g. AltGr+L is `ł` on
Polish layouts), rebind them. Jump to Section takes an optional argument, so
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
| `strudel.highlights.enabled` | `true` | Live token outlines (and pulses). |
| `strudel.highlights.pulses` | `true` | Flash a token on every hit. |
| `strudel.codeLens` | `true` | ▶ Play / ■ Stop above `createPattern`. |
| `strudel.mixer.codeLens` | `true` | Mute/solo lenses above each track. |
| `strudel.mixer.dimMuted` | `true` | Dim the definitions of silent tracks. |
| `strudel.reveal.focusWindow` | `"auto"` | How a click in the browser brings this window forward: `auto` activates the editor app on macOS (`open -a`), `uri` opens the editor's own `cursor://file/…` link (focuses the right window, the editor may ask to confirm), `off` only opens the file. |

The highlight colors can be themed under `workbench.colorCustomizations`:

```json
"workbench.colorCustomizations": {
  "strudel.highlightBorder": "#ff79c6",
  "strudel.highlightBackground": "#ff79c622",
  "strudel.pulseBackground": "#ff79c688",
  "strudel.pulseBorder": "#ffffff"
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
browser player ──state/songs/highlight/onsets/reveal──▶ Vite dev server ──▶ this extension
               ◀──────────────command───────────────── /__strudel relay ◀──
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
- Highlight offsets refer to the file as it is on disk. The extension skips
  editors with unsaved changes. When the player sends a `version`, the
  extension also checks it against `contentVersion(text)` of the saved
  document, so stale offsets never land on the wrong characters. Decorations
  are cleared when playback stops or the player disconnects.
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
  planning, status text, song position (sections, loops, jumps), track
  definitions (including every real song), pulses, discovery.
- `test/activation.test.ts`: runs the real `extension.ts` against a fake
  `vscode` module and a fake bridge over a real WebSocket. It covers status,
  highlights (version and dirty checks), hit pulses, sections and their
  commands, the mixer CodeLens and dimming, reveal, diagnostics, CodeLens,
  commands, quick pick, disconnect and reconnect.

There is no `@vscode/test-electron` smoke test because it would download a
full VS Code build.
