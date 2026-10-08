// Test helpers: drive the player through its public debug hook
// (window.__strudel: getState/play/stop/selectSong/songs/scheduler) rather than
// the DOM, so the suite survives UI redesigns.

import { test as base, expect, type Page } from "@playwright/test";
import type { PlayerState } from "../src/main.ts";
import { FIXTURE_ID, FIXTURE_SOUND, writeFixture, type FixtureOptions } from "./fixture.ts";

export { expect };
export type { PlayerState };

/** Persisted setting the player reads on startup (src/main.ts STORAGE.follow) */
const FOLLOW_EDITS_KEY = "strudel-ide:follow-edits";

/** One scheduler sample taken in the page */
export interface CycleSample {
  t: number;
  cycle: number;
  started: boolean;
}

export interface BootOptions {
  /** Fixture contents written before the page loads (default: DEFAULT_FIXTURE) */
  fixture?: FixtureOptions;
  /** Initial "follow edits" setting (default: the app default, on) */
  followEdits?: boolean;
}

export class Player {
  /** console.error messages and uncaught page errors since the last clearErrors() */
  errors: string[] = [];
  /** Every console message (type + text) since the last clearErrors() */
  messages: { type: string; text: string }[] = [];

  constructor(readonly page: Page) {
    page.on("console", (msg) => {
      this.messages.push({ type: msg.type(), text: msg.text() });
      // Chromium asks for /favicon.ico, which the app doesn't have.
      if (msg.type() === "error" && !msg.location().url.endsWith("/favicon.ico")) {
        this.errors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => this.errors.push(`pageerror: ${err.stack ?? err.message}`));
  }

  clearErrors() {
    this.errors = [];
    this.messages = [];
  }

  /** Write the fixture, load the page and wait until samples are loaded. */
  async boot({ fixture = {}, followEdits }: BootOptions = {}) {
    // Before goto: an edit while the page loads would race an HMR update
    // against the initial import.
    writeFixture(fixture);
    if (followEdits !== undefined) {
      await this.page.addInitScript(
        ([key, value]) => localStorage.setItem(key, value),
        [FOLLOW_EDITS_KEY, String(followEdits)] as const
      );
    }
    await this.page.goto("/");
    await this.page.waitForFunction(
      () => {
        const s = window.__strudel?.getState();
        return !!s && s.ready && s.loading === null;
      },
      null,
      { timeout: 30_000 }
    );
    // The fixture must be registered before any test drives it.
    expect(await this.songIds()).toContain(FIXTURE_ID);
  }

  /**
   * The error panel: the one DOM check the suite makes. Prefers the stable
   * data-testid and falls back to the panel's role="alert".
   */
  errorPanel() {
    return this.page.getByTestId("error-panel").or(this.page.getByRole("alert"));
  }

  state(): Promise<PlayerState> {
    return this.page.evaluate(() => window.__strudel!.getState());
  }

  /** Song ids in registry order (the order next/prev and the selector use) */
  songIds(): Promise<string[]> {
    return this.page.evaluate(() => Object.keys(window.__strudel!.songs()));
  }

  /** The fixture's `name` as the page currently sees it (changes once Vite's HMR update lands) */
  fixtureName(): Promise<string | undefined> {
    return this.page.evaluate((id) => window.__strudel!.songs()[id]?.name, FIXTURE_ID);
  }

  async waitForFixtureName(name: string) {
    await expect.poll(() => this.fixtureName(), { message: "HMR update for the fixture" }).toBe(name);
  }

  select(id: string): Promise<boolean> {
    return this.page.evaluate((id) => window.__strudel!.selectSong(id), id);
  }

  /** play() and wait until the scheduler is running */
  async play() {
    const ok = await this.page.evaluate(() => window.__strudel!.play());
    expect(ok, "play() result").toBe(true);
    await expect.poll(async () => (await this.state()).playing).toBe(true);
  }

  async stop() {
    await this.page.evaluate(() => window.__strudel!.stop());
    await expect.poll(async () => (await this.state()).playing).toBe(false);
  }

  /** Let the music play for `ms` of wall-clock time. */
  async listen(ms: number) {
    await this.page.waitForTimeout(ms);
  }

  async waitForSwapAfter(swapCount: number) {
    await expect
      .poll(async () => (await this.state()).swapCount, { message: "a hot-swap" })
      .toBeGreaterThan(swapCount);
  }

  async waitForError(predicate: (error: NonNullable<PlayerState["error"]>) => boolean, message: string) {
    await expect
      .poll(async () => {
        const { error } = await this.state();
        return !!error && predicate(error);
      }, { message })
      .toBe(true);
  }

  /**
   * Value of the first fixture-track hap in the cycle after next, queried from
   * the pattern the scheduler is playing right now (through the player's
   * error guard, exactly like the scheduler queries it).
   */
  probe(sound = FIXTURE_SOUND): Promise<Record<string, unknown> | null> {
    return this.page.evaluate((sound) => {
      const { scheduler } = window.__strudel!;
      const from = Math.ceil(scheduler.now()) + 1;
      const haps = scheduler.pattern?.queryArc(from, from + 1) ?? [];
      const hap = haps.find((h) => (h.value as Record<string, unknown>).s === sound);
      return hap ? { ...(hap.value as Record<string, unknown>) } : null;
    }, sound);
  }

  /** Cycles per second the scheduler clock actually advances, measured in the page over `ms` */
  measureCps(ms = 1000): Promise<number> {
    return this.page.evaluate(async (ms) => {
      const { scheduler } = window.__strudel!;
      const t0 = performance.now();
      const c0 = scheduler.now();
      await new Promise((resolve) => setTimeout(resolve, ms));
      return (scheduler.now() - c0) / ((performance.now() - t0) / 1000);
    }, ms);
  }

  /** Sample the scheduler every `everyMs` in the page until stopSampler(). */
  async startSampler(everyMs = 25) {
    await this.page.evaluate((everyMs) => {
      const w = window as unknown as { __e2eSamples: CycleSample[]; __e2eSampler: number };
      w.__e2eSamples = [];
      w.__e2eSampler = window.setInterval(() => {
        const { scheduler } = window.__strudel!;
        w.__e2eSamples.push({ t: performance.now(), cycle: scheduler.now(), started: scheduler.started });
      }, everyMs);
    }, everyMs);
  }

  stopSampler(): Promise<CycleSample[]> {
    return this.page.evaluate(() => {
      const w = window as unknown as { __e2eSamples: CycleSample[]; __e2eSampler: number };
      clearInterval(w.__e2eSampler);
      return w.__e2eSamples;
    });
  }
}

/** Largest backwards step between consecutive samples (0 when monotonic) */
export function maxBackwardStep(samples: CycleSample[]): number {
  let max = 0;
  for (let i = 1; i < samples.length; i++) max = Math.max(max, samples[i - 1].cycle - samples[i].cycle);
  return max;
}

export const test = base.extend<{ player: Player }>({
  player: async ({ page }, use) => {
    await use(new Player(page));
  },
});
