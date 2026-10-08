#!/usr/bin/env node
// Mix analysis: render a song (and each of its tracks soloed) offline and measure it.
//
//   npm run analyze -- <song-id> [--bars N | --section name] [--from bar] [--no-tracks]
//                                [--jobs N] [--json] [--out mix.wav] [--url URL]
//   npm run analyze -- --wav file.wav [<song-id> for its sections/BPM]
//
// Prints tables per section (or per 8 bars) and per track, then a list of problems.
// Writes the full numbers to renders/<song-id>.analysis.json (or stdout with --json).
// See docs/audio-tools.md for what the numbers mean.

import { cpus } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { songInfo, listSongIds, ROOT } from "./lib/song-info.mjs";
import { render, pool } from "./lib/render.mjs";
import { readWav, writeWav } from "./lib/wav.mjs";
import { measure, summarize, trackVsMix, silentRuns, round, dbAmp, HOP_SECONDS, BANDS } from "./lib/audio-analysis.mjs";
import { parseArgs, resolveRange, openEnv } from "./render.mjs";

// Thresholds for the problem list (heuristics, see docs/audio-tools.md)
export const LIMITS = {
  hotPeakDb: -1, // sample peak above this (without clipping) = no headroom
  inaudibleDb: -25, // track this far under the mix where it plays = inaudible
  quietDb: -20, // ... = barely audible (note only)
  dominatesDb: -1.5, // track within this of the whole mix (with 3+ other parts playing) = dominates
  mudPct: 22, // 250–500 Hz share of the mix energy ...
  mudMinLowPct: 25, // ... when the section has a low end (sub+low share at least this)
  harshPct: 14, // 2–20 kHz share of the mix energy
  silentLufs: -50, // section quieter than this = (near) silent
};

const USAGE = `Usage: npm run analyze -- <song-id> [options]
  --bars N / --section name / --from bar   what to analyze (default: whole arrangement, or 32 bars)
  --no-tracks     skip the per-track solo renders (much faster)
  --jobs N        parallel renders (default ${defaultJobs()})
  --json          print JSON instead of tables
  --out file.wav  also save the full-mix render (16-bit)
  --url URL       use a running dev server
  --wav file.wav  analyze an existing WAV (pass a song id too for its sections)
Songs: ${listSongIds().join(", ")}`;

function defaultJobs() {
  return Math.max(2, Math.min(6, Math.floor(cpus().length / 2)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis
// ─────────────────────────────────────────────────────────────────────────────

/** Section ranges (in hops) for the rendered bars */
function sectionRanges(info, from, bars, totalHops) {
  const cps = info.bpm / 240;
  const hopOf = (bar) => Math.min(totalHops, Math.round((bar - from) / cps / HOP_SECONDS));
  let list;
  if (info.sections) {
    const seen = {};
    list = info.sections
      .map((s) => {
        seen[s.name] = (seen[s.name] ?? 0) + 1;
        return { name: seen[s.name] > 1 ? `${s.name}#${seen[s.name]}` : s.name, start: s.start, end: s.start + s.bars };
      })
      .filter((s) => s.end > from && s.start < from + bars)
      .map((s) => ({ ...s, start: Math.max(s.start, from), end: Math.min(s.end, from + bars) }));
  } else {
    list = [];
    for (let b = from; b < from + bars; b += 8) list.push({ name: `bars ${b + 1}-${Math.min(b + 8, from + bars)}`, start: b, end: Math.min(b + 8, from + bars) });
  }
  return list.map((s) => ({ ...s, bars: s.end - s.start, h0: hopOf(s.start), h1: hopOf(s.end) }));
}

export function analyze({ info, from, bars, mix, tracks }) {
  const sections = sectionRanges(info, from, bars, mix.hops);
  const result = {
    song: info.id,
    name: info.name,
    bpm: info.bpm,
    from,
    bars,
    seconds: Math.round(mix.length / mix.fs * 10) / 10,
    sampleRate: mix.fs,
    overall: summarize(mix),
    silentRuns: silentRuns(mix, 1).map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10]),
    sections: sections.map((s) => ({ name: s.name, startBar: s.start, bars: s.bars, ...summarize(mix, s.h0, s.h1) })),
    tracks: null,
    problems: [],
  };
  if (tracks) {
    result.tracks = Object.entries(tracks).map(([name, t]) => {
      const whole = trackVsMix(t, mix, 0, mix.hops);
      const sum = summarize(t);
      const contrib = Object.fromEntries(
        BANDS.map(([band]) => [band, result.overall.bandEnergy[band] > 0 ? Math.round((100 * sum.bandEnergy[band]) / result.overall.bandEnergy[band]) : 0])
      );
      const mixHighs = result.overall.bandEnergy.himid + result.overall.bandEnergy.high;
      contrib.highs = mixHighs > 0 ? Math.round((100 * (sum.bandEnergy.himid + sum.bandEnergy.high)) / mixHighs) : 0;
      return {
        name,
        ...whole,
        peakDb: sum.peakDb,
        clips: sum.clips,
        bands: sum.bands,
        shareOfMixBands: contrib, // % of the mix's energy in each band (approximate: parts don't add exactly)
        sections: Object.fromEntries(sections.map((s) => [s.name, trackVsMix(t, mix, s.h0, s.h1)])),
      };
    });
  }
  if (tracks) {
    const h = Math.round(result.overall.peakAt / HOP_SECONDS);
    result.overall.peakTracks = Object.entries(tracks)
      .map(([name, t]) => ({ name, peakDb: round(dbAmp(t.peak[h] ?? 0)) }))
      .filter((x) => x.peakDb !== null && x.peakDb > -30)
      .sort((a, b) => b.peakDb - a.peakDb)
      .slice(0, 4);
  }
  result.problems = findProblems(result);
  for (const s of [result.overall, ...result.sections]) delete s.bandEnergy;
  return result;
}

function findProblems(r) {
  const p = [];
  const L = LIMITS;
  const o = r.overall;
  const at = `at ${o.peakAt} s` + (o.peakTracks?.length ? ` (${o.peakTracks.map((t) => `${t.name} ${t.peakDb}`).join(", ")} dBFS soloed)` : "");
  if (o.clips > 0) p.push({ kind: "clipping", where: "song", detail: `${o.clips} samples at/over 0 dBFS, peak ${o.peakDb} dBFS ${at}` });
  else if (o.peakDb > L.hotPeakDb) p.push({ kind: "hot", where: "song", detail: `peak ${o.peakDb} dBFS ${at}, less than ${-L.hotPeakDb} dB headroom` });
  for (const s of r.sections) {
    if (s.clips > 0) p.push({ kind: "clipping", where: s.name, detail: `${s.clips} samples clipped, peak ${s.peakDb} dBFS` });
    if (s.lufs === null || s.lufs < L.silentLufs) p.push({ kind: "silent", where: s.name, detail: `${s.lufs ?? "-inf"} LUFS` });
    else {
      // only in full-range sections: a pad-only breakdown naturally lives in the low mids
      if (s.bands.lowmid > L.mudPct && s.bands.sub + s.bands.low >= L.mudMinLowPct) p.push({ kind: "mud", where: s.name, detail: `250–500 Hz is ${s.bands.lowmid}% of the energy` });
      const highs = Math.round((s.bands.himid + s.bands.high) * 10) / 10;
      if (highs > L.harshPct) p.push({ kind: "harsh", where: s.name, detail: `2–20 kHz is ${highs}% of the energy` });
      if (s.correlation < 0) p.push({ kind: "phase", where: s.name, detail: `L/R correlation ${s.correlation}` });
    }
  }
  if (r.tracks) {
    for (const t of r.tracks) {
      if (t.relDb === null) {
        p.push({ kind: "silent-track", where: t.name, detail: "never audible in this range" });
        continue;
      }
      for (const [sec, v] of Object.entries(t.sections)) {
        if (v.relDb === null || v.activePct < 10) continue;
        const others = r.tracks.filter((o) => o !== t && o.sections[sec]?.relDb !== null && o.sections[sec]?.activePct >= 10).length;
        if (v.relDb < L.inaudibleDb) p.push({ kind: "inaudible", where: `${t.name} @ ${sec}`, detail: `${v.relDb} dB under the mix` });
        else if (v.relDb > L.dominatesDb && others >= 3) p.push({ kind: "dominates", where: `${t.name} @ ${sec}`, detail: `${v.relDb} dB vs the whole mix with ${others} other parts playing` });
      }
    }
  }
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tables
// ─────────────────────────────────────────────────────────────────────────────

const fmt = (x, d = 1) => (x === null || x === undefined ? "-inf" : typeof x === "number" ? x.toFixed(d) : String(x));
function table(headers, rows, align) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => (align?.[i] === "l" ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join("  ");
  return [line(headers), widths.map((w) => "─".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

export function printReport(r, { renderInfo } = {}) {
  const o = r.overall;
  const out = [];
  out.push(`🎚️  ${r.name} (${r.song}) — ${r.bpm} BPM, bars ${r.from + 1}–${r.from + r.bars}, ${r.seconds} s @ ${r.sampleRate} Hz${renderInfo ? `  [${renderInfo}]` : ""}`);
  out.push(
    `   Integrated ${fmt(o.lufs)} LUFS · short-term max ${fmt(o.shortTermMax)} LUFS · LRA ${fmt(o.lra)} LU · sample peak ${fmt(o.peakDb)} dBFS @ ${o.peakAt} s` +
      ` · clipped ${o.clips} · RMS ${fmt(o.rmsDb)} dBFS · crest ${fmt(o.crestDb)} dB · PLR ${fmt(o.plr)} dB · corr ${fmt(o.correlation, 2)} · width ${fmt(o.widthDb)} dB`
  );
  out.push("");
  out.push("Sections  (LUFS = BS.1770 integrated; RMS unweighted; band columns = % of energy; width = side/mid dB)");
  out.push(
    table(
      ["section", "bars", "LUFS", "RMS", "peak", "clip", "crest", ...BANDS.map(([n]) => n), "corr", "width", "silent%"],
      r.sections.map((s) => [s.name, `${s.startBar + 1}-${s.startBar + s.bars}`, fmt(s.lufs), fmt(s.rmsDb), fmt(s.peakDb), s.clips, fmt(s.crestDb),
        ...BANDS.map(([n]) => fmt(s.bands[n])), fmt(s.correlation, 2), fmt(s.widthDb), s.silentPct]),
      ["l", "l"]
    )
  );
  if (r.tracks) {
    out.push("");
    out.push("Tracks (soloed)  LUFS = where the track plays; vs mix = track minus the full mix over the same moments; share = % of the mix's energy in that band");
    out.push(
      table(
        ["track", "LUFS", "vs mix", "active%", "peak", "share sub", "low", "lowmid", "mid", "highs"],
        r.tracks.map((t) => [t.name, fmt(t.lufs), fmt(t.relDb), t.activePct, fmt(t.peakDb), t.shareOfMixBands.sub, t.shareOfMixBands.low, t.shareOfMixBands.lowmid, t.shareOfMixBands.mid,
          t.shareOfMixBands.highs]),
        ["l"]
      )
    );
    out.push("");
    out.push("Track level vs mix per section (dB; blank = not playing)");
    const names = r.sections.map((s) => s.name);
    out.push(
      table(
        ["track", ...names],
        r.tracks.map((t) => [t.name, ...names.map((n) => (t.sections[n]?.relDb === null || t.sections[n]?.activePct < 10 ? "" : fmt(t.sections[n].relDb)))]),
        ["l"]
      )
    );
  }
  if (r.silentRuns.length) out.push(`\nNear-silence (< -60 dBFS RMS, ≥ 1 s): ${r.silentRuns.map(([a, b]) => `${a}–${b} s`).join(", ")}`);
  out.push("");
  if (r.problems.length) {
    out.push(`Problems (${r.problems.length}):`);
    for (const p of r.problems) out.push(`  ⚠️  ${p.kind.padEnd(12)} ${p.where}: ${p.detail}`);
  } else out.push("No problems found.");
  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2), { flags: ["--no-tracks", "--json", "--jobs=", "--wav="] });
  const id = opts.positional[0];
  if (opts.help || (!id && !opts.wav)) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 1);
  }
  const log = (...a) => console.error(...a);

  if (opts.wav) {
    const { sampleRate, channels } = readWav(opts.wav);
    const info = id ? await songInfo(id) : { id: opts.wav, name: opts.wav, bpm: opts.bpm ?? 120, sections: null, totalBars: null };
    const mix = measure(channels, sampleRate);
    const from = opts.from ?? 0;
    const bars = opts.bars ?? Math.floor((mix.length / sampleRate) * (info.bpm / 240));
    const r = analyze({ info, from, bars, mix, tracks: null });
    console.log(opts.json ? JSON.stringify(r, null, 2) : printReport(r));
    return;
  }

  const info = await songInfo(id);
  const { from, bars } = resolveRange(info, opts);
  const withTracks = !opts["no-tracks"] && info.tracks && info.tracks.length > 1;
  const jobs = Number(opts.jobs ?? defaultJobs());
  const env = await openEnv(opts);
  const t0 = Date.now();
  let mix, tracks = null;
  const warnings = new Set();
  try {
    const renders = [{ name: null, solo: [] }, ...(withTracks ? info.tracks.map((t) => ({ name: t, solo: [t] })) : [])];
    log(`Rendering ${info.name}: mix${withTracks ? ` + ${info.tracks.length} soloed tracks` : ""}, bars ${from + 1}–${from + bars}, ${jobs} at a time …`);
    let done = 0;
    const measured = await pool(renders, jobs, async (job) => {
      const res = await render(env, { songId: id, bpm: info.bpm, from, bars, tail: 0, solo: job.solo, mute: opts.mute, maxPolyphony: opts.maxPolyphony });
      if (job.name === null) {
        for (const w of res.warnings) warnings.add(w);
        if (opts.out) {
          const { clipped } = writeWav(opts.out, res.channels, res.sampleRate);
          log(`  saved ${relative(process.cwd(), opts.out)}${clipped ? ` (${clipped} samples clipped)` : ""}`);
        }
      }
      const m = measure(res.channels, res.sampleRate);
      log(`  ${++done}/${renders.length} ${job.name ?? "mix"} (${(res.renderMs / 1000).toFixed(1)} s)`);
      return m;
    });
    mix = measured[0];
    if (withTracks) tracks = Object.fromEntries(info.tracks.map((t, i) => [t, measured[i + 1]]));
  } finally {
    await env.close();
  }
  const secs = (Date.now() - t0) / 1000;
  const r = analyze({ info, from, bars, mix, tracks });
  r.warnings = [...warnings].map((w) => w.replace(/%c|background-color[^;]*;color:[^;]*;border-radius:\S+/g, "").trim());
  const audioSecs = r.seconds * (1 + (tracks ? Object.keys(tracks).length : 0));
  const renderInfo = `${audioSecs.toFixed(0)} s of audio rendered in ${secs.toFixed(0)} s`;

  mkdirSync(join(ROOT, "renders"), { recursive: true });
  const jsonFile = join(ROOT, "renders", `${id}.analysis.json`);
  writeFileSync(jsonFile, JSON.stringify(r, null, 2));
  if (opts.json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(printReport(r, { renderInfo }));
    if (r.warnings.length) console.log(`\nEngine warnings:\n${r.warnings.map((w) => `  ${w}`).join("\n")}`);
    console.log(`\nJSON: ${relative(process.cwd(), jsonFile)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e?.stack ?? e);
    process.exit(1);
  });
}
