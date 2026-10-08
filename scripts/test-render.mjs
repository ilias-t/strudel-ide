#!/usr/bin/env node
// Proves the offline renderer and the meters are correct, using known test signals.
//
//   npm run test:render [-- --url http://localhost:5330]
//
// 1. Meter: a 997 Hz sine at -20 dBFS on both channels must read -20.0 LUFS (BS.1770).
// 2. Tone: one sine note at gain 0.5 held for 4 bars through the real engine must come out
//    at the expected peak/RMS (superdough's oscillators are scaled by 0.3), at 440 Hz,
//    for exactly 4 bars, with no dropouts (sample-to-sample continuity, steady envelope).
// 3. Gain law: gain 0.25 vs 0.5 is -6.02 dB.
// 4. Timing: 64 clicks on quarter notes land on the beat grid (no drift across chunks).
// 5. Sidechain: `duckorbit` dips a held tone on every beat (the offline duck checkpoints).

import { openEnv, parseArgs } from "./render.mjs";
import { render } from "./lib/render.mjs";
import { measure, summarize, dominantFrequency, dbAmp } from "./lib/audio-analysis.mjs";

const opts = parseArgs(process.argv.slice(2));
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const near = (x, want, tol) => Math.abs(x - want) <= tol;

// ── 1. meter ────────────────────────────────────────────────────────────────
{
  const fs = 48000;
  const n = fs * 5;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = 0.1 * Math.sin((2 * Math.PI * 997 * i) / fs);
  const m = summarize(measure([s, s], fs));
  check("meter: 997 Hz sine at -20 dBFS, both channels → -20.0 LUFS", near(m.lufs, -20, 0.1), `${m.lufs} LUFS, peak ${m.peakDb} dBFS, RMS ${m.rmsDb} dB, crest ${m.crestDb} dB`);
}

const env = await openEnv(opts);
try {
  const BPM = 120; // 1 bar = 2 s
  const tone = (gain) => `note("a4").slow(4).s("sine").gain(${gain}).attack(0.002).decay(0).sustain(1).release(0.002)`;

  // ── 2. tone ───────────────────────────────────────────────────────────────
  const r = await render(env, { code: tone(0.5), bpm: BPM, bars: 4, tail: 0.5 });
  const [L, R] = r.channels;
  const fs = r.sampleRate;
  check("duration: 4 bars at 120 BPM + 0.5 s tail = 8.5 s", L.length === Math.ceil(8.5 * fs), `${L.length} frames = ${(L.length / fs).toFixed(4)} s`);
  check("no warnings from the engine", r.warnings.length === 0, r.warnings.join(" | "));

  const a = Math.round(0.05 * fs), b = Math.round(7.95 * fs); // steady part
  let peak = 0, ss = 0, maxStep = 0, lrDiff = 0;
  for (let i = a; i < b; i++) {
    peak = Math.max(peak, Math.abs(L[i]));
    ss += L[i] * L[i];
    if (i > a) maxStep = Math.max(maxStep, Math.abs(L[i] - L[i - 1]));
    lrDiff = Math.max(lrDiff, Math.abs(L[i] - R[i]));
  }
  const rms = Math.sqrt(ss / (b - a));
  const wantPeak = 0.5 * 0.3;
  check("tone peak = gain 0.5 × 0.3 (superdough oscillator scale) = 0.150", near(peak, wantPeak, wantPeak * 0.005), `${peak.toFixed(5)} (${dbAmp(peak).toFixed(2)} dBFS)`);
  check("tone RMS = peak / √2 = 0.1061", near(rms, wantPeak / Math.SQRT2, 0.001), `${rms.toFixed(5)} (${dbAmp(rms).toFixed(2)} dBFS)`);
  const f = dominantFrequency(L, fs, a, 1 << 18);
  check("tone pitch = 440 Hz", near(f, 440, 0.1), `${f.toFixed(3)} Hz`);
  const maxSlope = 2 * Math.PI * 440 / fs * wantPeak; // largest possible step of a clean sine
  check("continuity: no sample-to-sample jumps beyond a clean sine's slope", maxStep <= maxSlope * 1.01, `max step ${maxStep.toFixed(5)}, sine max ${maxSlope.toFixed(5)}`);
  // envelope: RMS of every 10 ms window in the steady part within ±1 %
  const win = Math.round(0.01 * fs) * 4; // 40 ms ≈ 17.6 periods of 440 Hz, window long enough to be steady
  let minW = Infinity, maxW = 0;
  for (let s = a; s + win <= b; s += win / 4) {
    let e = 0;
    for (let i = s; i < s + win; i++) e += L[i] * L[i];
    const w = Math.sqrt(e / win);
    minW = Math.min(minW, w);
    maxW = Math.max(maxW, w);
  }
  check("no dropouts: windowed RMS steady within ±1 % across all render chunks", maxW / minW < 1.02, `min ${minW.toFixed(5)} max ${maxW.toFixed(5)}`);
  check("stereo: centered mono source → identical channels", lrDiff < 1e-6, `max |L-R| ${lrDiff.toExponential(2)}`);
  const onset = L.findIndex((x) => Math.abs(x) > 0.01);
  let end = L.length - 1;
  while (end > 0 && Math.abs(L[end]) < 0.001) end--;
  check("tone starts at 0 s and stops at 8 s", onset / fs < 0.005 && near(end / fs, 8, 0.01), `first sound ${(onset / fs * 1000).toFixed(2)} ms, last ${(end / fs).toFixed(4)} s`);
  const m = summarize(measure(r.channels, fs), Math.round(0.5 / 0.1), Math.round(7.5 / 0.1));
  check("meter on the rendered tone: RMS dB matches", near(m.rmsDb, dbAmp(wantPeak / Math.SQRT2), 0.1), `${m.rmsDb} dB RMS, ${m.lufs} LUFS, crest ${m.crestDb} dB`);

  // ── 3. gain law ───────────────────────────────────────────────────────────
  const r2 = await render(env, { code: tone(0.25), bpm: BPM, bars: 4 });
  let peak2 = 0;
  for (let i = a; i < b; i++) peak2 = Math.max(peak2, Math.abs(r2.channels[0][i]));
  const diff = dbAmp(peak2) - dbAmp(peak);
  check("gain 0.25 vs 0.5 = -6.02 dB", near(diff, -6.02, 0.05), `${diff.toFixed(3)} dB`);

  // ── 4. timing ─────────────────────────────────────────────────────────────
  const r3 = await render(env, { code: `note("a5*4").s("sine").attack(0.001).decay(0.03).sustain(0).release(0.001)`, bpm: BPM, bars: 16 });
  const c = r3.channels[0];
  const onsets = [];
  for (let i = 1; i < c.length; i++) {
    if (Math.abs(c[i]) > 0.005 && (onsets.length === 0 || i - onsets[onsets.length - 1] > fs * 0.2)) onsets.push(i);
  }
  const errs = onsets.map((i, k) => Math.abs(i / fs - k * 0.5) * 1000);
  check("timing: 64 quarter-note clicks over 16 bars, all on the grid (±1 ms)", onsets.length === 64 && Math.max(...errs) < 1, `${onsets.length} onsets, worst error ${Math.max(...errs).toFixed(3)} ms`);

  // ── 5. sidechain duck ─────────────────────────────────────────────────────
  const r4 = await render(env, {
    code: `stack(note("a3").slow(4).s("sine").sustain(1).decay(0).orbit(2), note("c4*4").s("sine").gain(0).orbit(3).duckorbit(2).duckattack(0.2))`,
    bpm: BPM,
    bars: 4,
  });
  const d = r4.channels[0];
  const env10 = (t) => {
    const s = Math.round(t * fs), n = Math.round(0.01 * fs);
    let e = 0;
    for (let i = s; i < s + n; i++) e += d[i] * d[i];
    return Math.sqrt(e / n);
  };
  const dips = [], highs = [];
  for (let beat = 1; beat < 15; beat++) {
    dips.push(dbAmp(env10(beat * 0.5 + 0.005)));
    highs.push(dbAmp(env10(beat * 0.5 + 0.4)));
  }
  check("sidechain: the ducked tone dips on every beat and recovers between beats",
    Math.max(...dips) < Math.min(...highs) - 12,
    `on-beat ${Math.min(...dips).toFixed(1)}…${Math.max(...dips).toFixed(1)} dB, between beats ${Math.min(...highs).toFixed(1)}…${Math.max(...highs).toFixed(1)} dB`);

  const speed = r.seconds / (r.renderMs / 1000);
  console.log(`(tone render: ${r.seconds.toFixed(1)} s audio in ${(r.renderMs / 1000).toFixed(2)} s, ${speed.toFixed(1)}× real time incl. page load)`);
} finally {
  await env.close();
}
process.exit(failures ? 1 : 0);
