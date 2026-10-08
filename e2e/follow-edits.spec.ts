// "Follow edits": saving a song that isn't playing switches to it (on), or
// leaves the current song alone (off).

import { FIXTURE_ID, writeFixture } from "./fixture.ts";
import { expect, test, type Player } from "./player.ts";

/** Play some other song (whichever comes first; its contents don't matter here). */
async function playOtherSong(player: Player): Promise<string> {
  const other = (await player.songIds()).find((id) => id !== FIXTURE_ID);
  if (!other) throw new Error("needs at least one song besides the fixture");
  expect(await player.select(other)).toBe(true);
  await player.play();
  return other;
}

test("on: saving the fixture while another song plays switches to it", async ({ player }) => {
  await player.boot({ followEdits: true });
  expect((await player.state()).followEdits).toBe(true);
  await playOtherSong(player);
  const before = await player.state();

  writeFixture({ name: "E2E Follow On" });
  await expect.poll(async () => (await player.state()).songId, { message: "followed the edit" }).toBe(FIXTURE_ID);
  await player.waitForSwapAfter(before.swapCount);
  const after = await player.state();
  expect(after.playing).toBe(true);
  expect(after.songName).toBe("E2E Follow On");
});

test("off: saving the fixture leaves the current song playing", async ({ player }) => {
  await player.boot({ followEdits: false });
  expect((await player.state()).followEdits).toBe(false);
  const other = await playOtherSong(player);
  const before = await player.state();

  writeFixture({ name: "E2E Follow Off" });
  await player.waitForFixtureName("E2E Follow Off"); // the HMR update landed
  await player.listen(500); // give a wrong swap time to happen
  const after = await player.state();
  expect(after.songId).toBe(other);
  expect(after.playing).toBe(true);
  expect(after.swapCount, "no swap").toBe(before.swapCount);
});
