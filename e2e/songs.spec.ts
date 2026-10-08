// Every real song loads and plays cleanly. The list comes from the running
// app (window.__strudel.songs()), so new songs are covered automatically.

import { FIXTURE_ID } from "./fixture.ts";
import { expect, test } from "./player.ts";

const LISTEN_MS = 3000;

test("every song loads and plays for a few seconds without errors", async ({ player }) => {
  await player.boot();
  const ids = (await player.songIds()).filter((id) => id !== FIXTURE_ID);
  expect(ids.length, "songs found").toBeGreaterThan(0);
  test.setTimeout(30_000 + ids.length * (LISTEN_MS + 4000));

  for (const id of ids) {
    await test.step(id, async () => {
      // Start each song from a stop, so its own first-play path is exercised
      // and an error can't be blamed on the previous song.
      await player.stop();
      player.clearErrors();
      expect(await player.select(id), `selectSong(${id}) builds`).toBe(true);
      await player.play();
      await player.listen(LISTEN_MS);

      const state = await player.state();
      expect.soft(state.songId).toBe(id);
      expect.soft(state.playing, `${id} still playing`).toBe(true);
      expect.soft(state.cycle, `${id} clock advanced`).toBeGreaterThan(0.5 * state.cps * (LISTEN_MS / 1000));
      expect.soft(state.error, `${id} state.error`).toBeNull();
      expect.soft(player.errors, `${id} console/page errors`).toEqual([]);
    });
  }
  await player.stop();
});
