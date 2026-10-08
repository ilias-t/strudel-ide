# Strudel Live (VS Code / Cursor extension)

strudel.cc-style live coding for the Strudel IDE. The extension connects your
editor to the player running in the browser (through the Vite dev server), so
you get:

- **Live highlights**: the mini-notation tokens that are sounding right now get
  an outline in the editor, like on strudel.cc.
- **Status bar**: `▶ Jynx · 126 BPM · bar 33`. Click it to play or stop. It
  turns red and shows the message when the player reports an error, and shows
  `Strudel: player not connected` (click to open the player) when no browser
  tab is connected.
- **Keys**: Ctrl/Cmd+Enter plays, updates or stops the song you're editing.
  Ctrl+. stops.
- **Errors as diagnostics**: player errors that carry a file and line show up as
  red squiggles in that file and go away once the song evaluates cleanly.
- **CodeLens**: `▶ Play` / `■ Stop` above `createPattern` in every song file.
- **Commands** (`Strudel: …` in the command palette): Play This File,
  Next/Previous Song, Mute/Solo Track…, Open Player in Browser, Start Dev
  Server, Reconnect.

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

On macOS, Cmd+. is deliberately **not** bound because it's Quick Fix. To use it
anyway, add this to `keybindings.json`:

```json
{ "key": "cmd+.", "command": "strudel.stop", "when": "editorTextFocus && strudel.isSongFile" }
```

The context keys you can use in your own `when` clauses are
`strudel.isSongFile`, `strudel.connected` (dev server reachable),
`strudel.playerConnected` and `strudel.playing`.

### Settings

| Setting | Default | |
| --- | --- | --- |
| `strudel.serverUrl` | `""` | Dev server URL. Empty means auto-detect. |
| `strudel.highlights.enabled` | `true` | Live token outlines. |
| `strudel.codeLens` | `true` | ▶ Play / ■ Stop above `createPattern`. |

The highlight colors can be themed under `workbench.colorCustomizations`:

```json
"workbench.colorCustomizations": {
  "strudel.highlightBorder": "#ff79c6",
  "strudel.highlightBackground": "#ff79c622"
}
```

## How it works

```
browser player ──state/songs/highlight──▶ Vite dev server ──▶ this extension
               ◀──────────command─────── /__strudel relay ◀──
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
- Highlights can arrive about 30 times per second. The extension reuses one
  decoration type, caches a line index per document version, and calls
  `setDecorations` only on editors showing the highlighted file (plus a single
  clearing call when one stops matching).

## Tests

`npm run ext:check` runs `tsc` and `node --test` (Node ≥ 22.18, which runs
TypeScript directly):

- `test/logic.test.ts`: offset → range mapping, message handling, command
  planning, status text, discovery.
- `test/activation.test.ts`: runs the real `extension.ts` against a fake
  `vscode` module and a fake bridge over a real WebSocket. It covers status,
  highlights (version and dirty checks), diagnostics, CodeLens, commands,
  quick pick, disconnect and reconnect.

There is no `@vscode/test-electron` smoke test because it would download a
full VS Code build.
