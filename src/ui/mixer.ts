// ═══════════════════════════════════════════════════════════════════════════
// Mixer: a vertical strip per track: activity LED, name, meter, Mute / Solo
// ═══════════════════════════════════════════════════════════════════════════
//
// The meter is a fixed segment strip under a cover that scales away (a
// transform, so it stays on the compositor). A hit sets the level from the
// hap's gain × velocity; it falls back at a fixed rate, like a peak meter.

import { trackColor } from "../engine/tracks";
import type { PlayerState } from "../engine/types";

interface Strip {
  el: HTMLElement;
  led: HTMLElement;
  cover: HTMLElement;
  mute: HTMLButtonElement;
  solo: HTMLButtonElement;
  /** meter level 0..1 and LED flash 0..1, as last painted */
  level: number;
  flash: number;
  painted: string;
}

/** Meter fall, per second */
const FALL = 1.5;
/** LED flash decay time constant, seconds */
const FLASH_TAU = 0.09;

export interface MixerActions {
  toggleTrack(mode: "mute" | "solo", track: string): void;
  unmuteAll(): void;
}

export class Mixer {
  private strips = new Map<string, Strip>();
  private tracksKey = "";
  /** Hits since the last frame: track → loudest level */
  private hits = new Map<string, number>();
  private lastFrame = 0;

  constructor(
    private root: HTMLElement,
    private empty: HTMLElement,
    unmuteAll: HTMLButtonElement,
    actions: MixerActions,
    private count?: HTMLElement
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

  /** A track just played a note; `level` 0..1 (gain × velocity) */
  hit(track: string, level = 0.8) {
    this.hits.set(track, Math.max(level, this.hits.get(track) ?? 0));
  }

  frame(now: number) {
    const dt = Math.min(0.1, Math.max(0, (now - (this.lastFrame || now)) / 1000));
    this.lastFrame = now;
    for (const [name, strip] of this.strips) {
      const hit = this.hits.get(name);
      let { level, flash } = strip;
      level = Math.max(0, level - FALL * dt);
      flash *= Math.exp(-dt / FLASH_TAU);
      if (hit !== undefined) {
        level = Math.max(level, hit);
        flash = 1;
      }
      if (level < 0.005) level = 0;
      if (flash < 0.01) flash = 0;
      strip.level = level;
      strip.flash = flash;
      const painted = `${level.toFixed(3)}|${flash.toFixed(2)}`;
      if (painted === strip.painted) continue;
      strip.painted = painted;
      strip.cover.style.transform = `scaleY(${(1 - level * 0.94).toFixed(3)})`;
      strip.led.style.opacity = (0.15 + 0.85 * flash).toFixed(2);
    }
    this.hits.clear();
  }

  private build(tracks: string[]) {
    this.strips.clear();
    if (this.count) this.count.textContent = tracks.length ? `${tracks.length} tracks` : "";
    this.root.dataset.dense = String(tracks.length > 11);
    const frag = document.createDocumentFragment();
    tracks.forEach((name, i) => {
      const el = document.createElement("div");
      el.className = "strip";
      el.dataset.testid = "mixer-strip";
      el.dataset.track = name;
      el.style.setProperty("--c", trackColor(name, i));

      const led = document.createElement("span");
      led.className = "led";
      led.dataset.testid = "track-led";

      const meter = document.createElement("span");
      meter.className = "meter";
      meter.setAttribute("aria-hidden", "true");
      const lit = document.createElement("span");
      lit.className = "meter-lit";
      const cover = document.createElement("span");
      cover.className = "meter-cover";
      meter.append(lit, cover);

      const keyHint = document.createElement("span");
      keyHint.className = "strip-key";
      keyHint.textContent = i < 9 ? String(i + 1) : "";

      const label = document.createElement("span");
      label.className = "strip-name";
      label.textContent = name;
      label.title = i < 9 ? `${name} (mute: ${i + 1}, solo: Shift+${i + 1})` : name;

      const buttons = document.createElement("span");
      buttons.className = "strip-buttons";
      const mute = button("m", "mute", `Mute ${name}${i < 9 ? ` (${i + 1})` : ""}`);
      const solo = button("s", "solo", `Solo ${name}${i < 9 ? ` (Shift+${i + 1})` : ""}`);
      buttons.append(mute, solo);

      el.append(led, keyHint, label, meter, buttons);
      frag.append(el);
      this.strips.set(name, { el, led, cover, mute, solo, level: 0, flash: 0, painted: "" });
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
