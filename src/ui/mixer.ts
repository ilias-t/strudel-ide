// ═══════════════════════════════════════════════════════════════════════════
// Mixer: a strip per track with an activity LED and Mute / Solo
// ═══════════════════════════════════════════════════════════════════════════

import { trackColor } from "../engine/tracks";
import type { PlayerState } from "../engine/types";

interface Strip {
  el: HTMLElement;
  glow: HTMLElement;
  mute: HTMLButtonElement;
  solo: HTMLButtonElement;
}

export interface MixerActions {
  toggleTrack(mode: "mute" | "solo", track: string): void;
  unmuteAll(): void;
}

export class Mixer {
  private strips = new Map<string, Strip>();
  private tracksKey = "";
  /** LED hits waiting for the next frame */
  private hits = new Set<string>();

  constructor(
    private root: HTMLElement,
    private empty: HTMLElement,
    unmuteAll: HTMLButtonElement,
    actions: MixerActions
  ) {
    unmuteAll.addEventListener("click", () => actions.unmuteAll());
    root.addEventListener("click", (e) => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-mode]");
      const strip = button?.closest<HTMLElement>(".strip");
      if (!button || !strip) return;
      actions.toggleTrack(button.dataset.mode as "mute" | "solo", strip.dataset.track!);
    });
  }

  render(state: PlayerState) {
    const tracks = state.tracks ?? [];
    const key = tracks.join("\n");
    if (key !== this.tracksKey) {
      this.tracksKey = key;
      this.build(tracks);
    }
    this.empty.hidden = tracks.length > 0;
    const muted = new Set(state.muted);
    const soloed = new Set(state.soloed);
    for (const [name, strip] of this.strips) {
      const isMuted = muted.has(name);
      const isSoloed = soloed.has(name);
      const audible = soloed.size ? isSoloed : !isMuted;
      setAttr(strip.el, "data-muted", String(isMuted));
      setAttr(strip.el, "data-soloed", String(isSoloed));
      setAttr(strip.el, "data-audible", String(audible));
      setAttr(strip.mute, "aria-pressed", String(isMuted));
      setAttr(strip.solo, "aria-pressed", String(isSoloed));
    }
  }

  /** A track just played a note */
  hit(track: string) {
    this.hits.add(track);
  }

  frame() {
    if (!this.hits.size) return;
    for (const track of this.hits) {
      this.strips
        .get(track)
        ?.glow.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: "cubic-bezier(0.2, 0, 0.6, 1)" });
    }
    this.hits.clear();
  }

  private build(tracks: string[]) {
    this.strips.clear();
    const frag = document.createDocumentFragment();
    tracks.forEach((name, i) => {
      const el = document.createElement("div");
      el.className = "strip";
      el.dataset.testid = "mixer-strip";
      el.dataset.track = name;
      el.style.setProperty("--c", trackColor(i));

      const led = document.createElement("span");
      led.className = "led";
      led.dataset.testid = "track-led";
      const glow = document.createElement("span");
      glow.className = "led-glow";
      led.append(glow);

      const keyHint = document.createElement("span");
      keyHint.className = "strip-key";
      keyHint.textContent = i < 9 ? String(i + 1) : "";

      const label = document.createElement("span");
      label.className = "strip-name";
      label.textContent = name;
      label.title = name;

      const buttons = document.createElement("span");
      buttons.className = "strip-buttons";
      const mute = button("M", "mute", `Mute ${name}${i < 9 ? ` (${i + 1})` : ""}`);
      const solo = button("S", "solo", `Solo ${name}${i < 9 ? ` (Shift+${i + 1})` : ""}`);
      buttons.append(mute, solo);

      el.append(led, keyHint, label, buttons);
      frag.append(el);
      this.strips.set(name, { el, glow, mute, solo });
    });
    this.root.replaceChildren(frag);
  }
}

function button(text: string, mode: "mute" | "solo", title: string) {
  const b = document.createElement("button");
  b.className = `${mode}-button`;
  b.dataset.mode = mode;
  b.dataset.testid = `${mode}-button`;
  b.textContent = text;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.setAttribute("aria-pressed", "false");
  return b;
}

function setAttr(el: Element, name: string, value: string) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}
