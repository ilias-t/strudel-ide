// The editor and the stage as one instrument, end to end: a Node WebSocket
// client plays the VS Code extension against the real page through the relay.
//   - editor presence reaches the stage's LED
//   - song position / sections in `state` follow jumps and loops
//   - mute from the editor silences the track
//   - per-hit onset pulses for a retriggered token (like "bd*4")
//   - clicking the code (or the error location) reveals it in the editor,
//     or falls back to a cursor:// / vscode:// link without one

import type { Page } from "@playwright/test";
import type { OnsetsMsg, RevealMsg } from "../src/live/protocol.ts";
import { EditorClient, type Msg } from "./editor.ts";
import {
  APP_ROOT,
  BUILD_ERROR_MESSAGE,
  FIXTURE_FILE,
  FIXTURE_ID,
  PULSE_SOUND,
  PULSE_TOKEN,
  PULSE_TRACK,
  fixtureSource,
  lineOf,
} from "./fixture.ts";
import { expect, test } from "./player.ts";

let editor: EditorClient | undefined;
test.afterEach(() => editor?.close());

const baseURL = () => test.info().project.use.baseURL!;
const LED = (page: Page) => page.getByTestId("editor-link");

/** 1-based line and column of the first `needle` in `source` */
function positionOf(source: string, needle: string) {
  const line = lineOf(source, needle);
  return { line, column: source.split("\n")[line - 1].indexOf(needle) + 1 };
}

/** Click the middle of `token`'s 2nd character in the stage's code view */
async function clickToken(page: Page, token: string) {
  const point = await page.evaluate((token) => {
    for (const ln of document.querySelectorAll('[data-testid="code-line"]')) {
      const walker = document.createTreeWalker(ln, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent!.indexOf(token);
        if (i < 0) continue;
        (ln as HTMLElement).scrollIntoView({ block: "center" });
        const r = document.createRange();
        r.setStart(n, i + 1);
        r.setEnd(n, i + 2);
        const b = r.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }
    }
    return null;
  }, token);
  expect(point, `"${token}" in the code view`).not.toBeNull();
  await page.mouse.click(point!.x, point!.y);
}

/** Record `<scheme>://file` fallback URLs instead of letting the page open them */
async function captureOpenedUrls(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __e2eOpened: string[] };
    w.__e2eOpened = [];
    window.addEventListener("strudel:open-url", (e) => {
      e.preventDefault();
      w.__e2eOpened.push((e as CustomEvent<{ url: string }>).detail.url);
    });
  });
  return () => page.evaluate(() => (window as unknown as { __e2eOpened: string[] }).__e2eOpened);
}

test("the stage's editor LED shows whether an editor is attached", async ({ player, page }) => {
  await player.boot();
  // dev server bridge up, no editor
  await expect(LED(page)).toHaveAttribute("data-state", "bridge");
  await expect(LED(page)).toHaveAttribute("data-connected", "false");

  editor = await EditorClient.connect(baseURL(), { scheme: "cursor" });
  await expect(LED(page)).toHaveAttribute("data-state", "editor");
  await expect(LED(page)).toHaveAttribute("data-editors", "1");
  await expect(LED(page)).toHaveAttribute("data-connected", "true");
  await expect(LED(page)).toContainText("Cursor");
  const second = await EditorClient.connect(baseURL(), { scheme: "vscode" });
  await expect(LED(page)).toHaveAttribute("data-editors", "2");
  second.close();
  await expect(LED(page)).toHaveAttribute("data-editors", "1");
  expect(await page.evaluate(() => window.__strudel!.editorLink!())).toMatchObject({
    state: "editor",
    editors: 1,
    clients: ["e2e"],
  });

  editor.close();
  await expect(LED(page)).toHaveAttribute("data-state", "bridge");
  await expect(LED(page)).toHaveAttribute("data-editors", "0");
});

test("position and section follow a jump; mute from the editor silences the track; onsets pulse", async ({ player }) => {
  await player.boot({ fixture: { sections: true, pulse: true } });
  editor = await EditorClient.connect(baseURL());
  await editor.waitFor((m) => m.type === "player" && m.connected === true, "player connected");

  let pending = editor.nextState((s) => s.songId === FIXTURE_ID && !!s.sections, "fixture with sections");
  editor.send({ command: "select", file: FIXTURE_FILE });
  let state = await pending;
  expect(state.sections).toEqual([
    { name: "a", start: 0, bars: 2 },
    { name: "b", start: 2, bars: 2 },
  ]);
  expect(state.tracks).toEqual(["lead", PULSE_TRACK]);
  expect(state.position ?? null).toBeNull(); // stopped

  pending = editor.nextState((s) => s.playing && typeof s.position === "number", "playing with a position");
  editor.send({ command: "play" });
  state = await pending;
  expect(state.section).toBe(0);

  // ── onsets: the retriggered token is reported hit after hit ────────────────
  const source = fixtureSource({ sections: true, pulse: true });
  const tokenStart = source.indexOf(PULSE_TOKEN);
  const isPulseHit = (m: Msg) =>
    m.type === "onsets" &&
    m.file === FIXTURE_FILE &&
    // the atom ("c4" of "c4*4")
    (m as unknown as OnsetsMsg).ranges.some(([a, b]) => a === tokenStart && b <= tokenStart + PULSE_TOKEN.length);
  const from = editor.messages.length;
  // 120 BPM = 0.5 cycles/s: "c4*4" hits twice a second
  await expect
    .poll(() => editor!.messages.slice(from).filter(isPulseHit).length, { timeout: 8_000, message: "4 pulse hits" })
    .toBeGreaterThanOrEqual(4);
  const hits = editor.messages.slice(from).filter((m) => m.type === "onsets") as unknown as OnsetsMsg[];
  expect(hits.every((h) => h.ranges.length > 0 && typeof h.version === "string")).toBe(true);

  // ── jump to section b: the state follows ───────────────────────────────────
  pending = editor.nextState((s) => s.section === 1 && !s.pendingJump, "landed in section b");
  editor.send({ command: "jump", section: "b" });
  state = await pending;
  const wrapped = state.position! % 4;
  expect(wrapped).toBeGreaterThanOrEqual(2);
  expect(wrapped).toBeLessThan(4);

  // loop it: the state says so, and the music stays in b
  pending = editor.nextState((s) => s.loop === true, "looping");
  editor.send({ command: "loop" });
  await pending;
  // longer than b (2 bars = 4 s at 0.5 cps): without the loop it would be back in a
  await player.listen(4500);
  const local = await player.state();
  expect(local.loop).toBe(true);
  expect(local.section?.name).toBe("b");

  // ── mute from the editor: state + the music (muted haps become rests) ─────
  expect(await player.probe(PULSE_SOUND)).not.toBeNull();
  pending = editor.nextState((s) => !!s.muted?.includes(PULSE_TRACK), "pulse muted");
  editor.send({ command: "mute", track: PULSE_TRACK });
  await pending;
  await expect.poll(() => player.probe(PULSE_SOUND), { message: "no audible pulse haps" }).toBeNull();
  // …and its token stops pulsing in the editor
  await player.listen(300); // frames in flight
  const afterMute = editor.messages.length;
  await player.listen(1500);
  expect(editor.messages.slice(afterMute).filter(isPulseHit)).toEqual([]);

  pending = editor.nextState((s) => !s.muted?.includes(PULSE_TRACK), "pulse unmuted");
  editor.send({ command: "mute", track: PULSE_TRACK });
  await pending;
  await expect.poll(() => player.probe(PULSE_SOUND)).not.toBeNull();
  await player.stop();
});

test("clicking code reveals it in the attached editor", async ({ player, page }) => {
  await player.boot({ fixture: { pulse: true } });
  await player.select(FIXTURE_ID);
  editor = await EditorClient.connect(baseURL());
  await expect(LED(page)).toHaveAttribute("data-state", "editor");

  const source = fixtureSource({ pulse: true });
  const at = positionOf(source, PULSE_TOKEN);
  const from = editor.messages.length;
  await clickToken(page, PULSE_TOKEN);
  const reveal = await editor.waitFor<RevealMsg & Msg>((m) => m.type === "reveal", "reveal", { from });
  expect(reveal.file).toBe(FIXTURE_FILE);
  expect(reveal.line).toBe(at.line);
  // the click hit the token's 2nd character: the caret lands on either side of it
  expect([at.column + 1, at.column + 2]).toContain(reveal.column);
});

test("the error location opens in the editor", async ({ player, page }) => {
  await player.boot({ fixture: { buildError: true } });
  await player.select(FIXTURE_ID);
  editor = await EditorClient.connect(baseURL());
  await expect(LED(page)).toHaveAttribute("data-state", "editor");
  await player.waitForError((e) => e.line !== undefined, "located build error");
  const source = fixtureSource({ buildError: true });

  const from = editor.messages.length;
  await page.getByTestId("error-location").click();
  const reveal = await editor.waitFor<RevealMsg & Msg>((m) => m.type === "reveal", "reveal", { from });
  expect(reveal).toMatchObject({ file: FIXTURE_FILE, line: lineOf(source, BUILD_ERROR_MESSAGE) });
});

test("without an editor, clicking code opens a cursor:// or vscode:// link", async ({ player, page }) => {
  await player.boot({ fixture: { pulse: true } });
  await player.select(FIXTURE_ID);
  await expect(LED(page)).toHaveAttribute("data-state", "bridge");
  const opened = await captureOpenedUrls(page);
  const at = positionOf(fixtureSource({ pulse: true }), PULSE_TOKEN);

  await clickToken(page, PULSE_TOKEN);
  await expect.poll(opened).toHaveLength(1);
  const [url] = await opened();
  const path = `${APP_ROOT}/${FIXTURE_FILE}`.split("/").map(encodeURIComponent).join("/");
  expect(url).toMatch(new RegExp(`^(cursor|vscode|vscode-insiders)://file${escapeRe(path)}:${at.line}:\\d+$`));

  // an editor that attached once sets the scheme (the extension says it's Cursor)…
  const once = await EditorClient.connect(baseURL(), { scheme: "cursor" });
  await expect(LED(page)).toHaveAttribute("data-state", "editor");
  once.close();
  await expect(LED(page)).toHaveAttribute("data-state", "bridge");
  await clickToken(page, PULSE_TOKEN);
  await expect.poll(opened).toHaveLength(2);
  expect((await opened())[1]).toMatch(/^cursor:\/\/file\//);

  // …and a per-browser override beats it
  await page.evaluate(() => localStorage.setItem("strudel-ide:editor-scheme", "vscode"));
  await clickToken(page, PULSE_TOKEN);
  await expect.poll(opened).toHaveLength(3);
  expect((await opened())[2]).toMatch(/^vscode:\/\/file\//);
  await page.evaluate(() => localStorage.removeItem("strudel-ide:editor-scheme"));
});

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
