# Strudel IDE

Songs are TypeScript files in `src/songs/`, played live by a browser stage that hot-swaps on every save. Strudel's API is a set of globals typed in `src/strudel.generated.d.ts`.

## Writing songs

- Default-export a `Song` (`src/songs/index.ts`). `createPattern()` returns a record of **named tracks** (`{ kick, bass, … }`). Track names drive the mixer, mute/solo and the editor's track lenses, so keep them short. They also pick each track's colour and which lamp it drives in the stage's room (the role patterns in `src/engine/tracks.ts`: `kick`, `snare`/`clap`, `hats`, `bass`/`sub`, `pads`/`chords`, `arp`, `lead`, `acid`…), so name tracks for what they are. Return the record as a literal `{…}` or wrapped (`mixdown({…})`) so the editor can find each track's definition.
- 1 cycle = 1 bar of 4/4. The player sets cps to `bpm / 240`.
- Export `sections` from the song's own form table (`sections: FORM`) so the timeline can jump and loop.
- `room: "club"` gives the stage a dark club with hard, short lights (Acid Rain); the default `"dusk"` suits softer songs.
- **Literals light up.** Only string literals passed directly to a call carry source locations, so only they highlight in the stage and the editor. A pattern string built by a helper, a template or a variable plays fine but stays dark. Prefer literals for the musical lines people will watch.
- Methods on string literals don't exist here (no strudel.cc transpiler). Write `mini("<c e>").note()` or `note("<c e>")`.
- `knob(name, value, min, max)` is the performable parameter. Use it for things worth turning live (cutoff, swing, sends). Write-back rewrites the numeric literal, so keep `value` a plain number.
- Mixing: songs keep levels in a `MASTER_DB` / `FADERS_DB` block applied with `postgain` (see any song). There's no master limiter, so the house target is about −17.5 LUFS with peaks ≤ −1 dBFS. Measure, don't guess: `npm run analyze -- <id>` (docs/audio-tools.md).
- Only sounds from the loaded sample maps exist. `check-songs` names any unknown sound.

## Starters and the catalog

- `src/starters/` holds one simple, editable song per genre (house, techno, lofi, ambient, dnb) for the "new song" flow, which copies one into `src/songs/`. Same `Song` format plus `export const meta = { id, genre, blurb }`, and the same house rules (`test/starters.test.ts` enforces them). The app's song picker doesn't list them. The audio tools and `check-songs` take them as `starters/<id>`.
- `src/catalog/` is generated discovery data: `sounds.json` (every sound by bank and kind), `functions.json` (Strudel functions by category, with docs, IDE-form examples, rank, range and strudel.cc link), `snippets.json` (working snippets by track role), `completions.json` and `theory.json` (what the editor's completions read), `intents.json` (search by sound: "wetter" → room, size, delay). Never edit it by hand. Edit `scripts/lib/catalog/` (category table, snippets, ranges, intents) and run `npm run gen:catalog`. `gen:types` reruns it, and `check` fails when it's stale. Two inputs are committed snapshots refreshed by hand: method usage (`node scripts/gen-catalog.mjs --recount` after songs change a lot) and strudel.cc's heading anchors (`node scripts/fetch-strudel-docs.mjs`).
- `check-songs`, the editor's completions and warnings, and the stage agree on one list of sounds: `sounds.json` (an e2e checks the stage registers every one). A sound that's missing from it is missing everywhere: fix the generator, not one consumer.

## Verifying

- `npm run check` must pass before a change is done: types, type audit, songs, locations, bridge, knobs, extension, strudel.cc round-trip. `node scripts/check-songs.mjs <id> --cycles 128` covers a full arrangement.
- Anything touching `src/engine`, `src/ui`, `src/live`, `src/main.ts` or `vite-plugins/` also needs `npm run test:e2e`. The suite serves a copy of the app from `.e2e-app/` and writes its fixture song there, never into `src/songs/`.
- Dev servers for testing: `NO_OPEN=1 npx vite --port <free port> --strictPort`. Port 3000 is the user's.

## Gotchas

- `src/strudel.generated.d.ts` and `src/strudel.sounds.generated.d.ts` are generated: change `scripts/lib/type-overrides.mjs` and run `npm run gen:types`. `knob` is typed separately in `src/knobs.d.ts` so the strict audit stays clean.
- In `vite.config.ts`, `strudelLocations()` must run before `strudelKnobs()`: the knobs transform shifts text, and locations need original offsets.
- Highlight offsets refer to the exact file text Vite read. The editor skips highlights when a document's `contentVersion` (src/live/protocol.ts) doesn't match.
- Bridge protocol changes touch three places that must agree: `src/live/protocol.ts`, `vite-plugins/strudel-bridge.ts` and `vscode-extension/`.
