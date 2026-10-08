# Audio tools: render, analyze, test

Songs are written by people and agents who can't always listen. These tools render a
song to audio without a speaker and measure it, so you can check levels, clipping and
balance from the terminal.

```bash
npm run render  -- jynx                      # bounce the whole song → renders/jynx.wav
npm run render  -- jynx --section drop       # one section
npm run render  -- jynx --from 24 --bars 8   # bars 25–32 (0-based --from)
npm run render  -- jynx --solo lead,arp      # only these tracks
npm run render  -- jynx --mute kick --out /tmp/no-kick.wav
npm run analyze -- jynx                      # mix + every track soloed → tables + JSON
npm run analyze -- jynx --no-tracks          # mix only (fast)
npm run test:render                          # proves the renderer and meters are right
```

Both start their own Vite server (`NO_OPEN=1 vite --port 5330 --strictPort`, or a free
port if 5330 is taken) unless you pass `--url http://localhost:3000`. They need Playwright
with Chromium: the global install is used if the project has none
(`npm i -g playwright && npx playwright install chromium`). Remote sample files are cached
in `node_modules/.cache/strudel-render/`, so only the first render downloads them.

## How rendering works

Offline, faster than real time, through the real engine:

1. Headless Chromium opens the app with an init script that turns `new AudioContext()`
   into one `OfflineAudioContext`. superdough creates its context that way, so every
   synth, sample, AudioWorklet, orbit, delay and reverb renders into it.
2. In the page, the song's tracks are built (minus muted ones) and stacked.
3. Rendering runs in 0.1 s chunks: at each `ctx.suspend()` checkpoint the next chunk of
   haps is queried and triggered through Strudel's own `getTrigger` + `webaudioOutput`,
   and sample loads finish before rendering resumes. Nothing can arrive late, and the
   voice limit behaves as it does live.
4. Sidechain ducking (`duckorbit`) schedules its gain ramps from a timer callback. The
   renderer runs those callbacks at exact checkpoints too, or the pump would land late.
5. The float samples come back to Node. 16-bit WAVs are clipped at 0 dBFS like a sound
   card would; `--float` writes 32-bit float WAVs that keep the overs.

Speed: about 3–5× real time per render for a full song, ~15× for light patterns. The
analyzer runs several renders at once (`--jobs`).

There's no app hook: everything goes through `window.__strudel` and the Strudel globals
that `initStrudel()` registers. Each render uses a fresh page, because superdough binds
its output graph to the first context it sees.

`--code` renders any Strudel expression instead of a song:
`npm run render -- --code 'note("a4").s("sine")' --bpm 120 --bars 2`.

## What analyze reports

For the whole render, each section (from the song's `ARRANGEMENT`/`SECTIONS`/`FORM`/`BARS`
constant; 8-bar blocks when it has none), and each track soloed:

| column | meaning |
| --- | --- |
| LUFS | ITU-R BS.1770-4 integrated loudness (K-weighted, gated). Streaming services normalize to about −14. |
| short-term max, LRA | loudest 3 s window; loudness range |
| RMS | plain (unweighted) RMS, dBFS |
| peak, clip | sample peak in dBFS; samples at or over ±0.999. The browser clips at 0 dBFS, so any clip is audible distortion. |
| crest, PLR | peak minus RMS; peak minus LUFS. With no limiter on the master, PLR decides how loud a song can get before it clips. |
| sub … high | share of energy in 20–60, 60–250, 250–500, 500–2k, 2k–6k, 6k–20k Hz |
| corr, width | L/R correlation (1 = mono, < 0 = phase trouble); side-vs-mid energy in dB |
| silent% | share of 100 ms windows under −60 dBFS RMS |
| track vs mix | soloed track loudness minus the full mix's loudness over the moments the track plays |
| track share | how much of the mix's energy in a band comes from that track (finds the mud or harsh part) |

Problems are flagged with these heuristics (`LIMITS` in `scripts/analyze.mjs`):
clipping, peak above −1 dBFS, a track more than 25 dB under the mix (inaudible), a track
within 1.5 dB of the whole mix while 3+ other parts play (dominating), 250–500 Hz above
22 % of the energy in a section that has a low end (mud), 2–20 kHz above 14 % (harsh),
sections under −50 LUFS, negative correlation. A clipping/hot report says when the peak
happens and which soloed tracks peak loudest at that moment, which usually names the
culprit (often kick + snare landing together).

Soloing removes sidechain ducking (the kick isn't playing), so ducked parts read a little
louder soloed than they sound in the mix.

Agents: use `--json` or read `renders/<song>.analysis.json`.

### Mixing with it

Songs carry a `MASTER_DB` / `FADERS_DB` block: per-track faders in dB, applied with
`postgain` (after a part's drive/shape, so changing a fader never changes its tone).
The workflow: `npm run analyze -- <song>`, fix balance with faders (or EQ in the part),
then set `MASTER_DB` so the song lands near the house loudness without clipping.

House loudness is **about −17.5 LUFS integrated, sample peak ≤ −1 dBFS**. There's no
limiter on the output, so how loud a song can get is its PLR (peak-to-loudness ratio):
with unlimited drums that's 15–18 dB, which puts −14 LUFS out of reach without clipping.

### Voice limit

superdough cuts the oldest voice once 128 are sounding, live and in these renders alike.
Dense songs with long tails (tidepools) hit it, so some notes are cut early and renders
vary by about ±0.5 dB from run to run. `--max-polyphony 100000` shows the song without
the limit.

## Verification

`npm run test:render` renders known signals through the same path and checks them:

- the meter reads a −20 dBFS 997 Hz stereo sine as −20.0 LUFS
- a held `note("a4").s("sine").gain(0.5)` comes out at peak 0.150 (gain × superdough's
  0.3 oscillator scale), RMS 0.1061, 440.000 Hz, exactly 4 bars long, identical channels,
  with no sample-to-sample jumps and a steady envelope across every render chunk
- gain 0.25 vs 0.5 = −6.02 dB
- 64 quarter-note clicks over 16 bars land within 1 ms of the grid
- a `duckorbit` sidechain dips a held tone on every beat
