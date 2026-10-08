// Audio measurements for rendered songs (pure Node, no dependencies).
//
//   - loudness: ITU-R BS.1770-4 K-weighting, 400 ms blocks (75 % overlap), integrated
//     loudness with the -70 LUFS absolute and -10 LU relative gates, 3 s short-term, LRA
//   - sample peak, clipped samples (|x| >= 0.999), unweighted RMS, crest factor
//   - spectral balance per band (FFT, Hann window)
//   - stereo correlation and side/mid width
//   - near-silence
//
// Everything is computed from a per-hop (100 ms) table, so any range of hops (a section)
// can be summarized without touching the samples again.

export const HOP_SECONDS = 0.1;
export const CLIP_LEVEL = 0.999;
export const SILENCE_DB = -60; // RMS dBFS below which a hop counts as near-silent

/** Bands for spectral balance (Hz) */
export const BANDS = [
  ["sub", 20, 60],
  ["low", 60, 250],
  ["lowmid", 250, 500],
  ["mid", 500, 2000],
  ["himid", 2000, 6000],
  ["high", 6000, 20000],
];

export const db = (x) => (x > 0 ? 10 * Math.log10(x) : -Infinity); // power → dB
export const dbAmp = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity); // amplitude → dB
const lufsOf = (meanSquare) => (meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity);

// ─────────────────────────────────────────────────────────────────────────────
// K-weighting (BS.1770): high-shelf pre-filter + RLB high-pass, any sample rate
// ─────────────────────────────────────────────────────────────────────────────

function kWeightingBiquads(fs) {
  // Stage 1: high shelf (+4 dB above ~1.7 kHz)
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: RLB high-pass (~38 Hz)
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const hp = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

function biquad(input, { b0, b1, b2, a1, a2 }) {
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
  }
  return out;
}

export function kWeight(channel, fs) {
  const [shelf, hp] = kWeightingBiquads(fs);
  return biquad(biquad(channel, shelf), hp);
}

// ─────────────────────────────────────────────────────────────────────────────
// FFT (iterative radix-2, in place)
// ─────────────────────────────────────────────────────────────────────────────

export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const hannCache = new Map();
function hann(n) {
  if (!hannCache.has(n)) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache.set(n, w);
  }
  return hannCache.get(n);
}

/** Power spectrum of one windowed frame starting at `start` (channels summed by energy). */
function framePower(channels, start, n) {
  const w = hann(n);
  const power = new Float64Array(n / 2);
  for (const ch of channels) {
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = (ch[start + i] ?? 0) * w[i];
    fft(re, im);
    for (let k = 0; k < n / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k];
  }
  return power;
}

/** Frequency of the strongest bin in [start, start+n) with parabolic interpolation (Hz). */
export function dominantFrequency(channel, fs, start = 0, n = 1 << 16) {
  const p = framePower([channel], start, n);
  let best = 1;
  for (let k = 2; k < p.length - 1; k++) if (p[k] > p[best]) best = k;
  const [a, b, c] = [Math.log(p[best - 1] + 1e-30), Math.log(p[best] + 1e-30), Math.log(p[best + 1] + 1e-30)];
  const delta = (0.5 * (a - c)) / (a - 2 * b + c);
  return ((best + delta) * fs) / n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-hop table
// ─────────────────────────────────────────────────────────────────────────────

const FFT_SIZE = 4096;

/**
 * Measure a stereo buffer hop by hop.
 * @returns per-hop arrays: kms (K-weighted mean square, L+R summed per BS.1770), ms (plain
 * mean square, averaged over channels), peak, clips, sumLR/sumLL/sumRR (correlation),
 * mid/side energy, and band energies.
 */
export function measure(channels, fs) {
  const [L, R = L] = channels;
  const hop = Math.round(HOP_SECONDS * fs);
  const hops = Math.ceil(L.length / hop);
  const kL = kWeight(L, fs), kR = kWeight(R, fs);
  const t = {
    fs, hop, hops, length: L.length,
    kms: new Float64Array(hops), ms: new Float64Array(hops), peak: new Float32Array(hops),
    clips: new Uint32Array(hops), lr: new Float64Array(hops), ll: new Float64Array(hops),
    rr: new Float64Array(hops), mid: new Float64Array(hops), side: new Float64Array(hops),
    bands: BANDS.map(() => new Float64Array(hops)),
  };
  for (let h = 0; h < hops; h++) {
    const a = h * hop, b = Math.min(L.length, a + hop), n = b - a;
    let kss = 0, ss = 0, pk = 0, clip = 0, lr = 0, ll = 0, rr = 0, mid = 0, side = 0;
    for (let i = a; i < b; i++) {
      const l = L[i], r = R[i];
      kss += kL[i] * kL[i] + kR[i] * kR[i];
      ll += l * l; rr += r * r; lr += l * r;
      const al = Math.abs(l), ar = Math.abs(r);
      if (al > pk) pk = al;
      if (ar > pk) pk = ar;
      if (al >= CLIP_LEVEL) clip++;
      if (ar >= CLIP_LEVEL) clip++;
      const m = (l + r) / 2, s = (l - r) / 2;
      mid += m * m; side += s * s;
    }
    t.kms[h] = kss / n; t.ms[h] = (ll + rr) / (2 * n); t.peak[h] = pk; t.clips[h] = clip;
    t.lr[h] = lr; t.ll[h] = ll; t.rr[h] = rr; t.mid[h] = mid; t.side[h] = side;
  }
  // Spectrum: one FFT frame per FFT_SIZE samples, energy credited to the hop it starts in
  const binHz = fs / FFT_SIZE;
  const bandBins = BANDS.map(([, lo, hi]) => [Math.max(1, Math.ceil(lo / binHz)), Math.min(FFT_SIZE / 2 - 1, Math.floor(hi / binHz))]);
  for (let start = 0; start + FFT_SIZE <= L.length; start += FFT_SIZE) {
    const p = framePower([L, R], start, FFT_SIZE);
    const h = Math.floor(start / hop);
    bandBins.forEach(([lo, hi], i) => {
      let e = 0;
      for (let k = lo; k <= hi; k++) e += p[k];
      t.bands[i][h] += e;
    });
  }
  return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// Summaries over hop ranges
// ─────────────────────────────────────────────────────────────────────────────

/** 400 ms block loudness powers (75 % overlap) for hops [h0, h1) */
function blockPowers(t, h0, h1) {
  const out = [];
  for (let h = h0; h + 4 <= h1; h++) out.push({ h, z: (t.kms[h] + t.kms[h + 1] + t.kms[h + 2] + t.kms[h + 3]) / 4 });
  if (!out.length && h1 > h0) {
    let z = 0;
    for (let h = h0; h < h1; h++) z += t.kms[h];
    out.push({ h: h0, z: z / (h1 - h0) });
  }
  return out;
}

/** BS.1770 gating; returns { lufs, blocks: the block start hops that passed } */
export function gatedLoudness(blocks) {
  const abs = blocks.filter((b) => lufsOf(b.z) > -70);
  if (!abs.length) return { lufs: -Infinity, passed: [] };
  const ungated = abs.reduce((s, b) => s + b.z, 0) / abs.length;
  const rel = lufsOf(ungated) - 10;
  const passed = abs.filter((b) => lufsOf(b.z) > rel);
  return { lufs: lufsOf(passed.reduce((s, b) => s + b.z, 0) / passed.length), passed };
}

/** Loudness of `t` over exactly these blocks (no gating), e.g. the mix where a track plays */
export function loudnessOverBlocks(t, blockHops) {
  if (!blockHops.length) return -Infinity;
  let z = 0;
  for (const h of blockHops) z += (t.kms[h] + t.kms[h + 1] + t.kms[h + 2] + t.kms[h + 3]) / 4;
  return lufsOf(z / blockHops.length);
}

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

/** Summarize hops [h0, h1) */
export function summarize(t, h0 = 0, h1 = t.hops) {
  h1 = Math.min(h1, t.hops);
  const blocks = blockPowers(t, h0, h1);
  const { lufs } = gatedLoudness(blocks);
  // short-term (3 s) loudness, every 100 ms
  const st = [];
  for (let h = h0; h + 30 <= h1; h++) {
    let z = 0;
    for (let k = 0; k < 30; k++) z += t.kms[h + k];
    st.push(lufsOf(z / 30));
  }
  const stGated = st.filter((x) => x > -70);
  const relGate = lufs - 20;
  const lraVals = stGated.filter((x) => x > relGate).sort((a, b) => a - b);
  let ms = 0, peak = 0, clips = 0, lr = 0, ll = 0, rr = 0, mid = 0, side = 0, silent = 0;
  const bands = BANDS.map(() => 0);
  for (let h = h0; h < h1; h++) {
    ms += t.ms[h];
    if (t.peak[h] > peak) peak = t.peak[h];
    clips += t.clips[h];
    lr += t.lr[h]; ll += t.ll[h]; rr += t.rr[h]; mid += t.mid[h]; side += t.side[h];
    if (dbAmp(Math.sqrt(t.ms[h])) < SILENCE_DB) silent++;
    t.bands.forEach((b, i) => (bands[i] += b[h]));
  }
  const n = Math.max(1, h1 - h0);
  const rmsDb = dbAmp(Math.sqrt(ms / n));
  const peakDb = dbAmp(peak);
  const bandTotal = bands.reduce((a, b) => a + b, 0);
  return {
    seconds: (h1 - h0) * HOP_SECONDS,
    lufs: round(lufs),
    shortTermMax: round(st.length ? Math.max(...st) : lufs),
    lra: round(lraVals.length > 1 ? percentile(lraVals, 95) - percentile(lraVals, 10) : 0),
    rmsDb: round(rmsDb),
    peakDb: round(peakDb),
    clips,
    crestDb: round(peakDb - rmsDb),
    plr: round(peakDb - lufs), // peak-to-loudness ratio
    correlation: round(ll && rr ? lr / Math.sqrt(ll * rr) : 1, 2),
    widthDb: round(mid > 0 ? db(side / mid) : -Infinity), // side vs mid energy
    silentPct: Math.round((100 * silent) / n),
    bands: Object.fromEntries(BANDS.map(([name], i) => [name, bandTotal > 0 ? round((100 * bands[i]) / bandTotal, 1) : 0])),
    bandEnergy: Object.fromEntries(BANDS.map(([name], i) => [name, bands[i]])),
  };
}

/** Ranges (seconds) of near-silence at least `minSeconds` long */
export function silentRuns(t, minSeconds = 1, h0 = 0, h1 = t.hops) {
  const runs = [];
  let start = null;
  for (let h = h0; h <= h1; h++) {
    const quiet = h < h1 && dbAmp(Math.sqrt(t.ms[h])) < SILENCE_DB;
    if (quiet && start === null) start = h;
    if (!quiet && start !== null) {
      if ((h - start) * HOP_SECONDS >= minSeconds) runs.push([start * HOP_SECONDS, h * HOP_SECONDS]);
      start = null;
    }
  }
  return runs;
}

/**
 * A soloed track against the mix over hops [h0, h1): the track's gated loudness where it
 * plays, and the mix loudness over those same blocks.
 */
export function trackVsMix(track, mix, h0, h1) {
  const { lufs, passed } = gatedLoudness(blockPowers(track, h0, Math.min(h1, track.hops)));
  if (!passed.length) return { lufs: -Infinity, mixLufs: -Infinity, relDb: null, activePct: 0 };
  const hops = passed.map((b) => b.h);
  const mixLufs = loudnessOverBlocks(mix, hops);
  const blocks = Math.max(1, h1 - h0 - 3);
  return { lufs: round(lufs), mixLufs: round(mixLufs), relDb: round(lufs - mixLufs), activePct: Math.round((100 * passed.length) / blocks) };
}

export function round(x, d = 1) {
  if (!Number.isFinite(x)) return x === -Infinity ? null : x;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
