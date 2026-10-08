// Command palette — placeholder until the feature lands (a lazy chunk, see ./hooks.ts)

import type { Discovery, FeatureHandle } from "./hooks";

export function createPalette(d: Discovery): FeatureHandle {
  void d;
  const root = document.getElementById("palette")!;
  return {
    open() {
      root.hidden = false;
    },
    close() {
      root.hidden = true;
    },
    isOpen: () => !root.hidden,
  };
}
