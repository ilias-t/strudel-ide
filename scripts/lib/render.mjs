// Offline (faster than real time) rendering of songs through the real app + superdough.
//
// How it works:
//   1. A Vite dev server serves the app (we start one, or use --url).
//   2. Headless Chromium loads it with an init script that replaces `window.AudioContext`
//      with a factory returning one OfflineAudioContext. superdough creates its context
//      lazily through `new AudioContext()`, so the whole engine (synths, samples,
//      worklets, orbits, delay, reverb) ends up rendering into it.
//   3. In the page we build the song's pattern (optionally soloing/muting named tracks),
//      then drive rendering in ~0.1 s chunks with `ctx.suspend(t)`: at each suspension
//      we query the next chunk of haps and trigger them through Strudel's own trigger
//      path (getTrigger + webaudioOutput), awaiting sample loads before resuming.
//      That mirrors the real-time scheduler (a short lookahead, same voice limits),
//      but nothing can arrive late.
//   4. superdough's `duck` (sidechain) runs its automation from a ConstantSourceNode
//      `onended` callback. Offline, the render thread would race past that callback,
//      so those timers are re-routed to exact `ctx.suspend()` checkpoints.
//   5. The float buffer is pulled back to Node in chunks (no clipping applied).
//
// Each render uses a fresh page: superdough binds its output graph to the first context
// it sees and never lets go.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import { ROOT } from "./song-info.mjs";

export const DEFAULT_SAMPLE_RATE = 48000;
const CACHE_DIR = join(ROOT, "node_modules/.cache/strudel-render");

// ─────────────────────────────────────────────────────────────────────────────
// Playwright (project devDependency if present, else the global install)
// ─────────────────────────────────────────────────────────────────────────────

export function loadPlaywright() {
  const tries = [join(ROOT, "package.json")];
  try {
    tries.push(join(execSync("npm root -g", { encoding: "utf8" }).trim(), "noop.js"));
  } catch {}
  for (const from of tries) {
    for (const pkg of ["playwright", "@playwright/test"]) {
      try {
        const mod = createRequire(from)(pkg);
        if (mod?.chromium) return mod;
      } catch {}
    }
  }
  throw new Error(
    "Playwright not found. Install it globally (npm i -g playwright && npx playwright install chromium) or as a devDependency."
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Vite server
// ─────────────────────────────────────────────────────────────────────────────

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "localhost");
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "localhost", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Start `vite --port 5330 --strictPort` (or a free port if 5330 is taken). Returns { url, close }.
 * `fallback: false` fails instead of picking another port (for an explicit --port).
 */
export async function startVite({ port = 5330, quiet = true, fallback = true } = {}) {
  if (!(await portFree(port))) {
    if (!fallback) throw new Error(`port ${port} is in use`);
    port = await freePort();
  }
  const vite = join(ROOT, "node_modules/.bin/vite");
  const child = spawn(vite, ["--port", String(port), "--strictPort"], {
    cwd: ROOT,
    env: { ...process.env, NO_OPEN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`vite did not start:\n${log}`)), 30000);
    const onData = (d) => {
      log += d;
      if (!quiet) process.stderr.write(d);
      // eslint-disable-next-line no-control-regex
      const m = log.replace(/\x1b\[[0-9;]*m/g, "").match(/Local:\s+(http:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1].replace(/\/$/, ""));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => reject(new Error(`vite exited (${code}):\n${log}`)));
  });
  return {
    url,
    close: () => {
      child.kill();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser + sample cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Launch headless Chromium. Remote requests (sample maps, sample files) are cached on
 * disk in node_modules/.cache/strudel-render so repeated renders don't refetch from the CDN.
 */
export async function launchBrowser() {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const context = await browser.newContext();
  mkdirSync(CACHE_DIR, { recursive: true });
  await context.route(
    (url) => url.hostname !== "localhost" && url.hostname !== "127.0.0.1",
    async (route) => {
      const req = route.request();
      if (req.method() !== "GET") return route.continue();
      const key = createHash("sha1").update(req.url()).digest("hex");
      const bodyFile = join(CACHE_DIR, key);
      const metaFile = `${bodyFile}.json`;
      const cors = { "access-control-allow-origin": "*" };
      if (existsSync(bodyFile) && existsSync(metaFile)) {
        const meta = JSON.parse(readFileSync(metaFile, "utf8"));
        return route.fulfill({ status: 200, body: readFileSync(bodyFile), headers: { ...cors, "content-type": meta.contentType } });
      }
      try {
        const res = await route.fetch();
        const body = await res.body();
        const contentType = res.headers()["content-type"] ?? "application/octet-stream";
        if (res.ok()) {
          writeFileSync(bodyFile, body);
          writeFileSync(metaFile, JSON.stringify({ url: req.url(), contentType }));
        }
        return route.fulfill({ status: res.status(), body, headers: { ...cors, "content-type": contentType } });
      } catch {
        return route.abort();
      }
    }
  );
  return { browser, context, close: () => browser.close() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render one song (or a code snippet) to float PCM.
 *
 * @param {object} env  { context, url } from launchBrowser()/startVite()
 * @param {object} opts
 *   songId    song id (src/songs/<id>.ts)        — or —  code: a Strudel expression (string)
 *   module    optional: import the song from this dev-server path instead of the app's
 *             registry (starters: "/src/starters/<id>.ts", which the app doesn't list)
 *   bpm       tempo (1 bar = 1 cycle = 4 beats)
 *   from      first bar to render (0-based, default 0)
 *   bars      number of bars
 *   tail      seconds rendered after the last bar for reverb/delay tails (default 0)
 *   solo      track names to keep (others muted)
 *   mute      track names to drop
 *   sampleRate (default 48000)
 *   maxPolyphony  voice limit (default: superdough's 128, as live)
 * @returns {Promise<{sampleRate, channels: [Float32Array, Float32Array], seconds, renderMs, warnings: string[], tracks}>}
 */
export async function render(env, opts) {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const cps = opts.bpm / 240;
  const tail = opts.tail ?? 0;
  const seconds = opts.bars / cps + tail;
  const length = Math.ceil(seconds * sampleRate);
  const cfg = {
    songId: opts.songId ?? null,
    module: opts.module ?? null,
    code: opts.code ?? null,
    cps,
    from: opts.from ?? 0,
    bars: opts.bars,
    solo: opts.solo ?? [],
    mute: opts.mute ?? [],
    chunk: opts.chunk ?? 0.1,
    maxPolyphony: opts.maxPolyphony ?? null, // superdough's default is 128, like the live app
    preciseTimers: process.env.RENDER_IMPRECISE_TIMERS !== "1", // only for proving the duck test
    sampleRate,
    length,
  };

  const page = await env.context.newPage();
  const warnings = [];
  page.on("console", (m) => {
    const text = m.text();
    if (/error|not found|cannot schedule|skip hap|still loading/i.test(text) && !/favicon/.test(text)) warnings.push(text);
  });
  page.on("pageerror", (e) => warnings.push(`pageerror: ${e.message}`));
  const t0 = Date.now();
  try {
    await page.addInitScript(installOfflineContext, { sampleRate, length });
    await page.goto(env.url + "/", { waitUntil: "load" });
    await page.waitForFunction(() => window.__strudel?.getState().ready, null, { timeout: 120000 });
    const info = await page.evaluate(renderInPage, cfg);
    const channels = [];
    const CHUNK = 1 << 20;
    for (let ch = 0; ch < 2; ch++) {
      const out = new Float32Array(length);
      for (let off = 0; off < length; off += CHUNK) {
        const b64 = await page.evaluate(
          ([c, o, n]) => {
            const data = window.__rendered[c].subarray(o, o + n);
            const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            let s = "";
            for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            return btoa(s);
          },
          [ch, off, CHUNK]
        );
        const buf = Buffer.from(b64, "base64");
        out.set(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4), off);
      }
      channels.push(out);
    }
    return {
      sampleRate,
      channels,
      seconds,
      renderMs: Date.now() - t0,
      warnings: [...warnings, ...info.warnings],
      tracks: info.tracks,
      triggered: info.triggered,
    };
  } finally {
    await page.close();
  }
}

// Runs in the page before any app script: every `new AudioContext()` returns one
// OfflineAudioContext. resume() is a no-op until rendering starts (offline contexts
// reject resume() before startRendering, which would abort superdough's initAudio).
function installOfflineContext({ sampleRate, length }) {
  const RealAC = window.AudioContext;
  function OfflineAsAudioContext() {
    if (!window.__offlineCtx) {
      const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
      const realResume = ctx.resume.bind(ctx);
      ctx.__rendering = false;
      ctx.resume = () => (ctx.__rendering ? realResume() : Promise.resolve());
      window.__offlineCtx = ctx;
    }
    return window.__offlineCtx;
  }
  OfflineAsAudioContext.prototype = RealAC.prototype;
  window.AudioContext = OfflineAsAudioContext;
  window.webkitAudioContext = OfflineAsAudioContext;
}

// Runs in the page (serialized by Playwright: must be self-contained).
async function renderInPage(cfg) {
  const g = globalThis;
  const warnings = [];
  const ctx = g.getAudioContext();
  if (ctx !== window.__offlineCtx) throw new Error("superdough is not using the offline context");

  // superdough adds createFeedbackDelay/createReverb/... to AudioContext.prototype only
  for (const [k, desc] of Object.entries(Object.getOwnPropertyDescriptors(AudioContext.prototype))) {
    if (typeof desc.value === "function" && k !== "constructor" && !(k in OfflineAudioContext.prototype)) {
      OfflineAudioContext.prototype[k] = desc.value;
    }
  }
  await g.initAudio(); // loads the AudioWorklets into our context
  if (cfg.maxPolyphony) g.setMaxPolyphony(cfg.maxPolyphony);
  // Like the app's warmOrbits(): create orbit busses 1-16 up front, so a duckorbit that
  // fires before its target orbit has played anything still ducks.
  for (let orbit = 1; orbit <= 16; orbit++) await g.superdough({ s: "~", orbit }, 0, 0.01);

  // ── the pattern ──
  let pattern;
  let tracks = null;
  if (cfg.code) {
    pattern = new Function(`return (${cfg.code});`)();
  } else {
    // Starters aren't in the app's song registry: import the module through Vite instead
    const song = cfg.module ? (await import(cfg.module)).default : window.__strudel.songs()[cfg.songId];
    if (!song) throw new Error(`song "${cfg.songId}" not found in the page`);
    const result = song.createPattern();
    if (typeof result?.queryArc === "function") {
      if (cfg.solo.length || cfg.mute.length) throw new Error("this song has no named tracks to solo/mute");
      pattern = result;
    } else {
      tracks = Object.keys(result);
      for (const name of [...cfg.solo, ...cfg.mute]) {
        if (!tracks.includes(name)) throw new Error(`unknown track "${name}" (tracks: ${tracks.join(", ")})`);
      }
      const audible = tracks.filter((n) => (cfg.solo.length ? cfg.solo.includes(n) : true) && !cfg.mute.includes(n));
      pattern = audible.length ? g.stack(...audible.map((n) => result[n])) : g.silence;
    }
  }

  // ── suspend checkpoints, quantized to the 128-frame render quantum ──
  const sr = ctx.sampleRate;
  const quantum = 128 / sr;
  const endTime = cfg.length / sr;
  const checkpoints = new Map(); // quantum index -> callbacks
  const errors = [];
  const at = (time, fn) => {
    let q = Math.ceil(time / quantum - 1e-9);
    if (q * quantum <= ctx.currentTime + 1e-9) q = Math.floor(ctx.currentTime / quantum + 1e-9) + 1;
    if (q * quantum >= endTime) return; // past the end: never needed
    let fns = checkpoints.get(q);
    if (!fns) {
      fns = [];
      checkpoints.set(q, fns);
      ctx.suspend(q * quantum).then(async () => {
        checkpoints.delete(q);
        for (const f of fns) {
          try {
            await f();
          } catch (e) {
            errors.push(String(e?.stack ?? e));
          }
        }
        ctx.resume();
      });
    }
    fns.push(fn);
  };

  // superdough's webAudioTimeout (used by duck/sidechain with start time 0) fires from
  // `onended`; offline, the render thread races ahead of it. Run those callbacks at
  // exact checkpoints instead.
  const RealCSN = window.ConstantSourceNode;
  window.ConstantSourceNode = class extends RealCSN {
    start(when = 0) {
      this.__startAt = when;
      return super.start(when);
    }
    stop(when = 0) {
      if (cfg.preciseTimers && this.context === ctx && this.__startAt === 0 && typeof this.onended === "function") {
        const cb = this.onended;
        this.onended = null;
        at(when, () => cb.call(this));
      }
      return super.stop(when);
    }
  };

  // ── scheduling: Strudel's own trigger path, one chunk ahead ──
  const trigger = g.getTrigger({ getTime: () => ctx.currentTime, defaultOutput: g.webaudioOutput });
  const cps = cfg.cps;
  const endCycle = cfg.from + cfg.bars;
  let queried = cfg.from;
  let triggered = 0;
  const scheduleUntil = async (time) => {
    const until = Math.min(endCycle, cfg.from + time * cps);
    if (until <= queried) return;
    const haps = pattern.queryArc(queried, until, { _cps: cps });
    queried = until;
    const pending = [];
    for (const hap of haps) {
      if (!hap.hasOnset()) continue;
      const t = (hap.whole.begin.valueOf() - cfg.from) / cps;
      // superdough mutates hap.value (s → "bank_s"). Haps made by ply()/etc. can share one
      // value object, so the second trigger would look up "bank_bank_s". Live, the 50 ms
      // scheduler windows usually split such haps; our 0.1 s chunks would not. Copy it.
      const own = hap.withValue((v) => (v && typeof v === "object" ? { ...v } : v));
      pending.push(trigger(own, 0, hap.duration.valueOf() / cps, cps, t));
      triggered++;
    }
    await Promise.all(pending);
  };

  const CHUNK = quantum * Math.max(1, Math.round(cfg.chunk / quantum));
  await scheduleUntil(2 * CHUNK);
  const tick = (time) =>
    at(time, async () => {
      await scheduleUntil(time + 2 * CHUNK);
      if (time + CHUNK < endTime && queried < endCycle) tick(time + CHUNK);
    });
  tick(CHUNK);

  ctx.__rendering = true;
  const buffer = await ctx.startRendering();
  window.__rendered = [buffer.getChannelData(0), buffer.getChannelData(1 % buffer.numberOfChannels)];
  if (errors.length) warnings.push(...errors);
  return { warnings, tracks, triggered };
}

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency helper
// ─────────────────────────────────────────────────────────────────────────────

/** Run async jobs with at most `limit` in flight; results keep input order. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
