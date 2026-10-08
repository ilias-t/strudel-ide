// Safari: the audio destination can report maxChannelCount = 0. superdough
// copies that into destination.channelCount, which WebKit rejects ("Channel
// count cannot be 0"), so its audio controller is never created and every
// note fails: no sound at all. Playwright's WebKit can't run on every host,
// so this gives Chromium's destination node WebKit's behaviour
// (Source/WebCore/Modules/webaudio/DefaultAudioDestinationNode.cpp and
// AudioNode.cpp): maxChannelCount reads 0, setting 0 throws NotSupportedError
// and setting more than maxChannelCount throws IndexSizeError.

import { FIXTURE_ID } from "./fixture.ts";
import { expect, test } from "./player.ts";

test("a destination reporting maxChannelCount 0 (Safari) still plays", async ({ player, page }) => {
  await page.addInitScript(() => {
    const proto = AudioDestinationNode.prototype;
    const count = Object.getOwnPropertyDescriptor(AudioNode.prototype, "channelCount")!;
    Object.defineProperty(proto, "maxChannelCount", { configurable: true, get: () => 0 });
    Object.defineProperty(proto, "channelCount", {
      configurable: true,
      get() {
        return count.get!.call(this);
      },
      set(value: number) {
        if (!value) throw new DOMException("Channel count cannot be 0", "NotSupportedError");
        if (value > 0) throw new DOMException("Channel count exceeds maximum limit", "IndexSizeError");
        count.set!.call(this, value);
      },
    });
  });
  await player.boot();
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await player.play();
  await player.listen(2500);

  const state = await player.state();
  expect(state.playing).toBe(true);
  expect(state.error, "no sound error").toBeNull();
  const channelProblems = player.messages
    .filter((m) => /channel count|getTrigger/i.test(m.text))
    .map((m) => `${m.type}: ${m.text}`);
  expect(channelProblems).toEqual([]);
  expect(player.errors).toEqual([]);
});
