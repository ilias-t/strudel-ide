# strudel.cc bridge

Share songs on [strudel.cc](https://strudel.cc/) and bring strudel.cc code
back as songs.

```bash
npm run export -- acid-rain                 # REPL code on stdout
npm run export -- acid-rain --out acid.js   # … or to a file
npm run export -- acid-rain --url           # a strudel.cc share link
npm run export -- acid-rain --json          # { name, code, url, warnings }

npm run import -- 'https://strudel.cc/#…'   # → src/songs/<id>.ts
npm run import -- tune.js --id my-tune --name "My Tune"
pbpaste | npm run import -- -               # code or a link on stdin
```

Warnings go to stderr. `import` refuses to overwrite a song unless you pass
`--force`, prints the new file's path on stdout, then runs
`scripts/check-songs.mjs` on it. It exits with 2 when check-songs complains;
the file is still written.

The code is in `scripts/strudel-cc/`: `export.mjs`, `import.mjs`,
`shared.mjs` (share links, sample packs), `runtime.mjs` (Strudel in Node, the
app's way and strudel.cc's way) and `tsproject.mjs` (type-checking a song).

## Share links

strudel.cc keeps the whole program in the URL fragment:

```
https://strudel.cc/#<encodeURIComponent(base64(UTF-8 bytes of the code))>
```

This is `code2hash()` in `@strudel/core` (`packages/core/util.mjs`). The
website writes links with `'#' + code2hash(code)` (`shareCode()` in
`website/src/repl/util.mjs`, and on every evaluation in `useReplContext.jsx`).
It reads them back in `initCode()`, which takes `href.split('#')[1]` and calls
`hash2code()`. Both scripts call those same two functions from
`@strudel/core`, and `export --url` checks that each link decodes back to the
exact code. Links like `https://strudel.cc/?abc123` are short ids stored in
strudel.cc's database, so they can't be decoded offline: open one, copy the
code, then import the file or `-`.

A link carries the song's comments too, so it is long (untitled ≈ 6 kB,
acid-rain ≈ 20 kB). Browsers handle that fine; some chat apps cut it off.

## Export: song → strudel.cc

- The TypeScript is erased in place using the TS compiler's AST (annotations,
  `as`/`satisfies`, generics), so comments and layout survive. The output is
  checked with acorn, the parser strudel.cc uses.
- Only the top-level constants and helpers that `createPattern()` reaches get
  inlined, followed by the body of `createPattern()`.
- Each returned track becomes a label: `const kick = s("bd*4")` plus
  `return { kick }` turns into `kick: s("bd*4")`. When `createPattern()`
  returns something else, like `return mixdown({ kick, … })` or a `tracks`
  object, that expression is kept and the labels read from it
  (`kick: tracks.kick`). strudel.cc mutes labels that start or end with `_`,
  so such names become `$:`.
- Tempo becomes `setcpm(bpm/4)`, since 1 cycle is 1 bar of 4/4.
- Strings: Strudel IDE parses every string a pattern function receives as
  mini-notation (`miniAllStrings()`). strudel.cc's transpiler only does that
  for `"double-quoted"` and `` `backtick` `` literals, and it does it wherever
  they appear: it rewrites them to `m("…")`, which is a Pattern. So export
  keeps a string double-quoted only where TypeScript says it goes straight
  into a pattern argument, which keeps highlighting on strudel.cc. Every other
  string becomes `'single-quoted'`, and `${}` templates become `'a' + x`.
  Without this, the transpiler would turn `["intro", 8]` keys, `.join(" ")`
  separators and `typeof x === "string"` checks into Patterns, and it would
  replace a template with only its first chunk. The code also calls
  `miniAllStrings()`, so single-quoted strings still reach patterns as
  mini-notation, as they do in the app.
- `knob("cutoff", 2200, 200, 8000, { step: 10 })` becomes
  `/* cutoff */ slider(2200, 200, 8000, 10)`. `log: true` has no slider
  equivalent (you get a warning), and neither does a value that isn't a number
  literal.
- Sample packs: strudel.cc preloads every pack the app loads (`SAMPLE_MAPS` in
  `src/engine/strudel.ts` against the website's `prebake.mjs`), so today no
  `samples()` lines are needed. A pack added to `SAMPLE_MAPS` that strudel.cc
  doesn't preload gets a `samples('…json')` line.
- `sections` become a comment (name, bars, starting cycle), and
  `visualization` becomes `all(x => x.pianoroll(…))` or `all(x => x.scope())`.
- Warnings cover: app-only globals, imports from other files (they aren't
  inlined), enums and namespaces, top-level statements with side effects, and
  `createPattern()` returning from several places (it then gets wrapped in a
  function).

## Import: strudel.cc → song

| strudel.cc | becomes |
|---|---|
| `"a b"` or `` `a b` `` passed straight to a Strudel function | left as is (`miniAllStrings`) |
| `"a b"` anywhere else: `"<c e>".note()`, consts, arrays, helper args | `mini("a b")` |
| `'C minor'` passed to a Strudel function | `pure('C minor')` when mini-notation would read it differently (on strudel.cc, single quotes are plain strings) |
| `name: pat`, `$: pat` | `const name = pat`, then `return { name, … }`. A `$:` track is named after its sound (`bd`, `bd2`, …), or `track1`… |
| `_name:`, `name_:`, `pat.hush()`, anything before a `hush()` | kept commented out ("muted on strudel.cc") |
| the last expression, when there are no labels | the one track |
| `setcpm(x)`, `setcps(x)`, `setbpm(x)` | `bpm: x*4`, `x*240`, `x` (constant expressions only) |
| `samples(…)` | a comment, plus a warning unless it's a pack the app loads |
| `slider(v, min, max, step)` | `knob("name", v, min, max, step)`, named by a `/* name */` comment, its const, or the method it feeds |
| `all(f)`, `each(f)` | `f` applied to every track (`all` acts on the stack on strudel.cc; for most functions that's the same) |
| `._pianoroll()`, `.pianoroll()`, `.punchcard()`, `.scope()` | the song's `visualization` (other visuals are dropped with a warning) |
| `.piano()` (a website helper, not part of Strudel) | `piano(…)`, a local copy of strudel.cc's version |
| `miniAllStrings()` | dropped |

`// @title`, `// @by` and `// @license` comments give the song its name and
its header lines. The source link goes in the header, or at the end of the
file when it's long.

Then the result is made to type-check:

1. A statement that uses something the app doesn't have (an unknown global,
   or a method that `Pattern` or `string` lacks) is commented out with
   `// TODO(strudel.cc import): …`, and so is every statement that uses what
   it declared. Top-level `await` is also commented out.
2. Parameters that TypeScript can't type get `: any`.
3. Any remaining error gets `// @ts-expect-error TODO(strudel.cc import): …`
   on the line above.

The file always loads. Sounds that only strudel.cc has still load, but
check-songs reports them.

## Tests

`npm run test:strudel-cc`, part of `npm run check`, runs in about 4 s:

- **Export:** each song in `src/songs/` is exported and run the way strudel.cc
  runs code: `@strudel/transpiler` plus core's `repl()` (labels → `.p()`,
  `setcpm`, `sliderWithID` → `ref()`, plain strings not mini-parsed). Its haps
  over 16 cycles (time and value) must equal the song's, the tempo must match,
  and the share link must decode to the same code.
- **Round trip:** song → export → import gives the same haps and bpm.
- **Import:** each fixture in `scripts/strudel-cc/fixtures/` (strudel.cc
  workshop examples and example tunes, AGPL-3.0, plus one CC BY-NC-SA tune;
  sources and licenses are in each file's header) goes through its share link.
  The result must type-check, match the snippet's haps as strudel.cc plays
  them, and pass `check-songs` (run on a scratch copy, so nothing appears in
  `src/songs/`).
- **Unconvertible code:** a snippet using hydra, MIDI out and MIDI in imports
  with TODOs and still loads.

The emulation uses the installed `@strudel/transpiler` 1.2.5. strudel.cc's
main branch has since moved the same rules into transpiler plugins and added
`// mini-off` comments, and it now plays silence when the last statement isn't
an expression. On 2026-10-08, three exported songs (untitled, acid-rain,
tour) were checked on the live strudel.cc with Playwright: the editor showed
exactly the encoded code, and evaluating it raised no errors.

## What doesn't convert

- **Sounds strudel.cc has that the app doesn't load:** General MIDI soundfonts
  (`gm_*`), its Dirt-Samples subset (`casio`, `crow`, `insect`, `wind`, `jazz`,
  `metal`, `east`, `space`, `numbers`, `num`), anything from `samples('github:…')`
  or `shabda:`, and user samples. They import, but they're silent and
  check-songs flags them.
- **strudel.cc-only APIs:** hydra (`H`, `initHydra`), MIDI/OSC/serial/MQTT
  (`.midi()`, `midin`, `.osc()`), csound, gamepad and device motion, `.cpm()`,
  `mondo`/`tidal` template languages, and the widget methods beyond the
  pianoroll and scope. They get commented out with a TODO.
- **Behavioural gaps:** `all(f)` becomes per-track (it differs for functions
  that look at the whole stack). A `${}` template on strudel.cc only uses its
  first chunk; import keeps the whole template and warns. Non-constant
  `setcpm(…)` and tempo changes inside patterns aren't converted.
- **Export:** knob `log` travel, knobs whose value isn't a literal (no draggable
  slider), song files that import helpers from other files, and TS-only
  runtime syntax (enums, namespaces, parameter properties). strudel.cc's real
  `.scope()` also adds an `analyze` control to every event; the tests stub it
  out.

## Hooks for a "Share" button and an editor command (not built)

The converter needs Node (the TypeScript checker, the song's runtime values),
so the smallest useful hooks are:

- **Stage "Share to strudel.cc" button:** a dev-server endpoint, for example
  in `vite-plugins/strudel-bridge.ts`: `GET /__strudel/share?song=<id>` runs
  `exportSong(id)` from `scripts/strudel-cc/export.mjs` and returns
  `{ name, code, url, warnings }` (the shape `npm run export -- <id> --json`
  prints). The button opens `url` in a new tab, copies it to the clipboard,
  and shows the warnings in the existing error/toast area. Because the app
  only runs under `npm run dev`, a dev-only endpoint is enough. If a static
  build should share too, move the string/label rules into `src/convert/`
  with no Node imports, and accept double-quoting less precisely without the
  type checker.
- **Cursor/VS Code commands:**
  - "Strudel: Share song to strudel.cc" runs
    `node scripts/strudel-cc/export.mjs <active file> --json` in the
    workspace and opens `url` with `vscode.env.openExternal`. Warnings go in
    an information message.
  - "Strudel: Import from strudel.cc" asks for a link (`showInputBox`), runs
    `node scripts/strudel-cc/import.mjs <link> --id <slug>`, and opens the
    path printed on stdout. Exit code 2 means check-songs found problems: say
    so, but still open the file.

  No extension API changes are needed; both commands use only the CLIs'
  stdout and exit codes.
