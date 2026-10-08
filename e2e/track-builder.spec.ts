// The track builder (src/ui/discover/track-builder.ts): the mixer's "+ track"
// key opens a unit over the rack; a role, a snippet and a name add
//   const <name> = <snippet>;   and   <name> in createPattern's record
// to the song in the editor, as one undoable edit evaluated like typing, so a
// playing song picks the track up. Songs the planner can't read are refused
// and left byte-for-byte alone.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { FIXTURE_ID, ROOT, fixtureSource } from "./fixture.ts";
import { expect, test } from "./player.ts";

test.afterEach(async ({ player }) => {
  expect(player.errors, "console/page errors").toEqual([]);
});

const snippets = JSON.parse(readFileSync(resolve(ROOT, "src/catalog/snippets.json"), "utf8")) as {
  snippets: { id: string; role: string; code: string }[];
};
const snippetCode = (id: string) => snippets.snippets.find((s) => s.id === id)!.code;

const buffer = (page: Page) => page.evaluate(() => window.__strudelEditor?.value() ?? null);
const role = (page: Page, r: string) => page.locator(`[data-testid=builder-role][data-role=${r}]`);
const snippet = (page: Page, id: string) => page.locator(`[data-testid=builder-snippet][data-id=${id}]`);

test("adds a hats track to the playing song; one undo takes it out again", async ({ player, page }) => {
  await player.boot();
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await player.play();
  const { swapCount } = await player.state();

  const addKey = page.getByTestId("add-track");
  await addKey.click();
  const builder = page.getByTestId("track-builder");
  await expect(builder).toBeVisible();
  await expect(addKey).toHaveAttribute("aria-expanded", "true");
  await expect(role(page, "kick")).toBeFocused(); // the first control

  await role(page, "hats").click();
  await expect(role(page, "hats")).toHaveAttribute("aria-pressed", "true");
  await snippet(page, "hats-eighths").click();
  await expect(snippet(page, "hats-eighths")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("builder-name")).toHaveValue("hats");
  const code = snippetCode("hats-eighths");
  await expect(page.getByTestId("builder-preview")).toContainText(`const hats = ${code};`);

  // ▶ auditions the snippet next to the song
  await page.getByTestId("builder-snippet-play").click();
  await expect
    .poll(async () => {
      const recs = await page.evaluate(() => window.__strudelDiscover!.auditions());
      return recs.some((r) => r.label === "hats-eighths" && r.status !== "error" && r.events.some((e) => e.s === "hh"));
    }, { message: "an audition of the snippet" })
    .toBe(true);

  await page.getByTestId("builder-add").click();
  await expect(builder).toBeHidden();
  await expect(addKey).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("code-toast")).toContainText("added hats");

  const original = fixtureSource();
  const added = (await buffer(page))!;
  expect(added).toContain(`    const hats = ${code};\n    return { lead, hats };`);
  expect(added.replace(`    const hats = ${code};\n`, "").replace("{ lead, hats }", "{ lead }")).toBe(original);

  // evaluated like typing: swapped in, a mixer strip, heard in the scheduler's pattern
  await player.waitForSwapAfter(swapCount);
  await expect.poll(async () => (await player.state()).tracks).toEqual(["lead", "hats"]);
  await expect(page.locator("[data-testid=mixer-strip][data-track=hats]")).toBeVisible();
  await expect.poll(() => player.probe("hh"), { message: "hh in the playing pattern" }).toMatchObject({ s: "hh", bank: "RolandTR909" });

  // one undo step reverts both edits, and the next swap drops the track
  const { swapCount: afterAdd } = await player.state();
  await page.evaluate(() => window.__strudelEditor!.focus());
  await page.keyboard.press("Control+z");
  await expect.poll(() => buffer(page)).toBe(original);
  await player.waitForSwapAfter(afterAdd);
  await expect.poll(async () => (await player.state()).tracks).toEqual(["lead"]);
  await expect(page.locator("[data-testid=mixer-strip][data-track=hats]")).toHaveCount(0);
});

test("a song that returns a variable is refused and left untouched", async ({ player, page }) => {
  await player.boot();
  expect(await player.select("tour")).toBe(true);
  const tour = readFileSync(resolve(ROOT, "src/songs/tour.ts"), "utf8");

  await page.getByTestId("add-track").click();
  await role(page, "hats").click();
  await snippet(page, "hats-eighths").click();
  // the builder already knows (from the worker) and says so
  await expect(page.getByTestId("builder-message")).toContainText("can't find the track list");

  await page.getByTestId("builder-add").click();
  await expect(page.getByTestId("code-toast")).toContainText("can't find the track list");
  await expect(page.getByTestId("builder-message")).toContainText("can't find the track list");
  await expect(page.getByTestId("track-builder")).toBeVisible();
  expect(await buffer(page)).toBe(tour);

  // no undo step was made
  await page.evaluate(() => window.__strudelEditor!.focus());
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  expect(await buffer(page)).toBe(tour);
});

test("the palette's preset role and snippet; sound choices; Esc closes and gives focus back", async ({ player, page }) => {
  await player.boot();
  expect(await player.select(FIXTURE_ID)).toBe(true);

  await page.getByTestId("add-track").focus();
  await page.evaluate(() => window.__strudelDiscover!.open("builder", { snippet: "bass-sub" }));
  await expect(role(page, "bass")).toHaveAttribute("aria-pressed", "true");
  await expect(snippet(page, "bass-sub")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("builder-name")).toHaveValue("bass");

  // a melodic role: a sound, no bank
  await expect(page.getByTestId("builder-bank")).toBeHidden();
  await page.getByTestId("builder-sound").selectOption("piano");
  await expect(page.getByTestId("builder-preview")).toContainText('const bass = note("<a1 f1 c2 g1>").s("piano")');
  await page.getByTestId("builder-preview-play").click();
  await expect
    .poll(async () => (await page.evaluate(() => window.__strudelDiscover!.auditions())).some((r) => r.events.some((e) => e.s === "piano")))
    .toBe(true);

  // a drum role: banks that have the part
  await role(page, "kick").click();
  await expect(page.getByTestId("builder-sound")).toBeHidden();
  await page.getByTestId("builder-bank").selectOption("RolandTR808");
  await expect(page.getByTestId("builder-preview")).toContainText('.bank("RolandTR808")');

  // a name that's taken is flagged and can't be added
  await page.getByTestId("builder-name").fill("lead");
  await expect(page.getByTestId("builder-add")).toBeDisabled();
  await page.getByTestId("builder-name").fill("kick");
  await expect(page.getByTestId("builder-add")).toBeEnabled();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("track-builder")).toBeHidden();
  await expect(page.getByTestId("add-track")).toBeFocused();
  await expect(page.getByTestId("add-track")).toHaveAttribute("aria-expanded", "false");
});
