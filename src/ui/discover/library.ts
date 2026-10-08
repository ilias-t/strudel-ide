// Library — placeholder until the feature lands (a lazy chunk, see ./hooks.ts)

import type { Discovery, FeatureHandle } from "./hooks";

export function createLibrary(d: Discovery): FeatureHandle {
  const root = document.getElementById("library")!;
  return {
    open() {
      d.claimDrawer("library");
      root.hidden = false;
    },
    close() {
      root.hidden = true;
      d.releaseDrawer("library");
    },
    isOpen: () => !root.hidden,
  };
}
