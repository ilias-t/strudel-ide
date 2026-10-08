// Cold start: the very first play() in a fresh page of a sound that needs an
// AudioWorklet (supersaw) must not fail because the worklets aren't loaded yet.

import { FIXTURE_ID } from "./fixture.ts";
import { expect, test } from "./player.ts";

test("first play of a worklet-based sound has no AudioWorklet errors", async ({ player }) => {
  await player.boot({ fixture: { sound: "supersaw" } });
  expect(await player.select(FIXTURE_ID)).toBe(true); // stopped: validates only
  expect((await player.state()).swapCount, "nothing has played yet").toBe(0);

  await player.play();
  await player.listen(3000);

  const state = await player.state();
  expect(state.playing).toBe(true);
  expect(await player.probe("supersaw"), "supersaw is what's playing").not.toBeNull();
  // The failure mode is logged (not thrown) by Strudel, e.g. "[getTrigger]
  // error: Failed to construct 'AudioWorkletNode': ... is not defined in
  // AudioWorkletGlobalScope". superdough's "AudioWorklets loaded" is fine.
  const workletProblems = player.messages
    .filter((m) => /AudioWorklet|getTrigger/i.test(m.text) && !/AudioWorklets loaded/.test(m.text))
    .map((m) => `${m.type}: ${m.text}`);
  expect(workletProblems).toEqual([]);
  expect(state.error).toBeNull();
  expect(player.errors).toEqual([]);
});
