#!/usr/bin/env node
// Bounce a song to a WAV file (offline, faster than real time, in headless Chromium).
//
//   npm run render -- <song-id> [--bars N | --section name] [--from bar] [--out file.wav]
//                               [--solo track[,track]] [--mute track[,track]] [--tail sec]
//                               [--rate 48000] [--float] [--url http://localhost:3000]
//   npm run render -- --code 'note("a4").s("sine")' --bpm 120 --bars 2
//
// See docs/audio-tools.md.

import { mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { songInfo, listSongIds, ROOT } from "./lib/song-info.mjs";
import { startVite, launchBrowser, render, DEFAULT_SAMPLE_RATE } from "./lib/render.mjs";
import { writeWav } from "./lib/wav.mjs";

const USAGE = `Usage: npm run render -- <song-id> [options]
  --bars N          bars to render (default: the whole arrangement, or 32)
  --section name    render one section (by name; "name#2" for its 2nd occurrence)
  --from bar        first bar, 0-based (default 0)
  --out file.wav    output file (default renders/<song-id>.wav)
  --solo a,b        only these tracks       --mute a,b   drop these tracks
  --tail sec        extra seconds after the last bar for reverb/delay tails (default 2)
  --rate hz         sample rate (default ${DEFAULT_SAMPLE_RATE})
  --float           32-bit float WAV (keeps overs) instead of 16-bit PCM
  --url URL         use a running dev server instead of starting one
  --code EXPR       render a Strudel expression instead of a song (needs --bpm)
  --bpm N           tempo for --code (default 120)
  --max-polyphony N voice limit (default 128, as live: older voices are cut beyond it)
Songs: ${listSongIds().join(", ")}`;

/** Parse CLI args shared by render and analyze. */
export function parseArgs(argv, { flags = [] } = {}) {
  const opts = { solo: [], mute: [], positional: [] };
  const list = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--bars": opts.bars = Number(val()); break;
      case "--section": opts.section = val(); break;
      case "--from": opts.from = Number(val()); break;
      case "--out": opts.out = val(); break;
      case "--solo": opts.solo.push(...list(val())); break;
      case "--mute": opts.mute.push(...list(val())); break;
      case "--tail": opts.tail = Number(val()); break;
      case "--rate": opts.sampleRate = Number(val()); break;
      case "--url": opts.url = val().replace(/\/$/, ""); break;
      case "--code": opts.code = val(); break;
      case "--bpm": opts.bpm = Number(val()); break;
      case "--float": opts.float = true; break;
      case "--max-polyphony": opts.maxPolyphony = Number(val()); break;
      case "-h": case "--help": opts.help = true; break;
      default:
        if (flags.includes(a)) opts[a.replace(/^--/, "")] = true;
        else if (a.startsWith("--") && flags.some((f) => f.startsWith(a + "="))) opts[a.slice(2)] = val();
        else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
        else opts.positional.push(a);
    }
  }
  return opts;
}

/**
 * Resolve which bars to render: --section, or --from/--bars, defaulting to the whole
 * arrangement (or 32 bars when the song has none).
 */
export function resolveRange(info, opts) {
  if (opts.section) {
    if (!info.sections) throw new Error(`${info.id} has no parsable arrangement; use --from/--bars`);
    const [name, nth = "1"] = opts.section.split("#");
    const matches = info.sections.filter((s) => s.name === name);
    const sec = matches[Number(nth) - 1];
    if (!sec) throw new Error(`no section "${opts.section}" (sections: ${info.sections.map((s) => s.name).join(", ")})`);
    return { from: sec.start, bars: opts.bars ?? sec.bars };
  }
  const from = opts.from ?? 0;
  const bars = opts.bars ?? (info.totalBars ? info.totalBars - from : 32);
  if (!(bars > 0)) throw new Error("nothing to render (bars <= 0)");
  return { from, bars };
}

/** Start (or reuse via --url) the dev server and a browser. */
export async function openEnv(opts) {
  const server = opts.url ? { url: opts.url, close() {} } : await startVite();
  const browser = await launchBrowser();
  return {
    url: server.url,
    context: browser.context,
    async close() {
      await browser.close();
      server.close();
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const id = opts.positional[0];
  if (opts.help || (!id && !opts.code)) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 1);
  }
  const info = opts.code
    ? { id: "code", name: "code", bpm: opts.bpm ?? 120, tracks: null, sections: null, totalBars: null }
    : await songInfo(id);
  const { from, bars } = resolveRange(info, opts);
  const tail = opts.tail ?? 2;
  const out = opts.out ?? join(ROOT, "renders", `${info.id}${opts.section ? "-" + opts.section.replace("#", "") : ""}.wav`);

  const env = await openEnv(opts);
  try {
    console.error(`Rendering ${info.name}: bars ${from + 1}–${from + bars} at ${info.bpm} BPM` +
      (opts.solo.length ? `, solo ${opts.solo.join(",")}` : "") + (opts.mute.length ? `, mute ${opts.mute.join(",")}` : "") + " …");
    const result = await render(env, {
      songId: opts.code ? null : id,
      code: opts.code,
      bpm: info.bpm,
      from,
      bars,
      tail,
      solo: opts.solo,
      mute: opts.mute,
      sampleRate: opts.sampleRate,
      maxPolyphony: opts.maxPolyphony,
    });
    mkdirSync(dirname(out), { recursive: true });
    const { clipped } = writeWav(out, result.channels, result.sampleRate, { float: opts.float });
    let peak = 0;
    for (const ch of result.channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
    const speed = result.seconds / (result.renderMs / 1000);
    console.log(`${relative(process.cwd(), out)}  ${result.seconds.toFixed(1)} s, ${result.sampleRate} Hz, ${opts.float ? "32-bit float" : "16-bit"} stereo`);
    console.log(`  rendered in ${(result.renderMs / 1000).toFixed(1)} s (${speed.toFixed(1)}× real time), ${result.triggered} events`);
    console.log(`  sample peak ${(20 * Math.log10(peak || 1e-12)).toFixed(1)} dBFS` +
      (clipped ? `  ⚠️  ${clipped} samples clipped at 0 dBFS in the 16-bit file` : ""));
    for (const w of new Set(result.warnings)) console.log(`  warning: ${w.replace(/%c|background-color[^;]*;color:[^;]*;border-radius:\S+/g, "").trim()}`);
  } finally {
    await env.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
