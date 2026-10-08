// Track builder — placeholder until the feature lands (a lazy chunk, see ./hooks.ts)

import type { Discovery, FeatureHandle } from "./hooks";

export function createTrackBuilder(d: Discovery): FeatureHandle {
  const root = document.getElementById("track-builder")!;
  return {
    open() {
      d.claimDrawer("builder");
      root.hidden = false;
    },
    close() {
      root.hidden = true;
      d.releaseDrawer("builder");
    },
    isOpen: () => !root.hidden,
  };
}
