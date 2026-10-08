// ═══════════════════════════════════════════════════════════════════════════
// Timeline: the sequencer strip. Each section is a labelled bracket over one
// LED per bar (played / now / to come); click one to jump, loop it with L.
// ═══════════════════════════════════════════════════════════════════════════

import type { PlayerState, SectionInfo } from "../engine/types";

export interface TimelineActions {
  jumpToSection(index: number): void;
  toggleLoop(): void;
}

export class Timeline {
  private segments: HTMLButtonElement[] = [];
  /** one LED per bar, in song order */
  private leds: HTMLElement[] = [];
  private litBar = -2;
  private sectionsKey: string | null = null;
  private total = 0;
  /** segment geometry, measured on build/resize (null = re-measure) */
  private boxes: { left: number; width: number }[] | null = null;
  private lastX = -1;
  private lastSub = "";

  constructor(
    private els: {
      segments: HTMLElement;
      track: HTMLElement;
      playhead: HTMLElement;
      section: HTMLElement;
      sub: HTMLElement;
      loop: HTMLButtonElement;
    },
    actions: TimelineActions
  ) {
    els.segments.addEventListener("click", (e) => {
      const seg = (e.target as HTMLElement).closest<HTMLButtonElement>(".tl-seg");
      if (seg) actions.jumpToSection(Number(seg.dataset.index));
    });
    els.loop.addEventListener("click", () => actions.toggleLoop());
    new ResizeObserver(() => {
      this.boxes = null;
      this.lastX = -1;
    }).observe(els.track);
  }

  render(state: PlayerState) {
    const sections = state.sections;
    const key = sections ? sections.map((s) => `${s.name}:${s.bars}`).join("|") : "";
    if (key !== this.sectionsKey) {
      this.sectionsKey = key;
      this.build(sections);
    }
    const active = state.section?.index ?? -1;
    const pending = state.pendingJump?.index ?? -1;
    this.segments.forEach((seg, i) => {
      setAttr(seg, "data-active", String(i === active && pending < 0));
      setAttr(seg, "data-pending", String(i === pending));
      setAttr(seg, "data-loop", String(state.loop && i === (pending >= 0 ? pending : active)));
    });
    setAttr(this.els.loop, "aria-pressed", String(state.loop));
    this.els.loop.disabled = !sections;
    const name = state.section?.name ?? (sections ? "" : state.songName);
    if (this.els.section.textContent !== name) this.els.section.textContent = name;
    this.els.playhead.hidden = !sections;
  }

  /** Per animation frame: move the playhead, update the bar-in-section readout */
  frame(position: number, section: SectionInfo | null, bar: number, beat: number) {
    let sub: string;
    if (this.total && section) {
      const p = ((position % this.total) + this.total) % this.total;
      this.boxes ??= this.segments.map((seg) => ({ left: seg.offsetLeft, width: seg.offsetWidth }));
      const box = this.boxes[section.index];
      const x = box ? Math.round((box.left + ((p - section.start) / section.bars) * box.width) * 2) / 2 : 0;
      if (x !== this.lastX) {
        this.lastX = x;
        this.els.playhead.style.transform = `translateX(${x}px)`;
      }
      const inSection = Math.min(section.bars, Math.floor(p - section.start) + 1);
      sub = `bar ${String(inSection).padStart(2, "0")} of ${section.bars} · ${bar}.${beat}`;
      this.lightBar(Math.floor(p));
    } else {
      sub = `bar ${bar}.${beat}`;
    }
    if (sub !== this.lastSub) {
      this.lastSub = sub;
      this.els.sub.textContent = sub;
    }
  }

  /** LEDs: bars before `now` played, `now` lit (-1: none) */
  private lightBar(now: number) {
    if (now === this.litBar) return;
    this.litBar = now;
    this.leds.forEach((led, i) => {
      const cls = i === now ? "now" : i < now ? "played" : "";
      if (led.className !== cls) led.className = cls;
    });
  }

  /** Stopped: no bar is "now" */
  idle() {
    this.lightBar(-1);
  }

  private build(sections: SectionInfo[] | null) {
    this.segments = [];
    this.leds = [];
    this.litBar = -2;
    this.total = 0;
    this.lastX = -1;
    this.boxes = null;
    if (!sections) {
      const note = document.createElement("div");
      note.className = "tl-bars-only";
      note.textContent = "No sections in this song. Give it a sections table to jump and loop.";
      this.els.segments.replaceChildren(note);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const s of sections) {
      const seg = document.createElement("button");
      seg.className = "tl-seg";
      seg.dataset.testid = "timeline-section";
      seg.dataset.index = String(s.index);
      seg.dataset.name = s.name;
      seg.style.flex = `${s.bars} 1 0`;
      seg.title = `${s.name}: bars ${s.start + 1}–${s.start + s.bars}. Click to jump there on the next bar.`;
      const name = document.createElement("span");
      name.className = "tl-seg-name";
      name.textContent = s.name;
      const bars = document.createElement("small");
      bars.className = "tl-seg-bars";
      bars.textContent = String(s.bars);
      name.append(bars);
      const bracket = document.createElement("span");
      bracket.className = "tl-seg-bracket";
      const leds = document.createElement("span");
      leds.className = "tl-seg-leds";
      for (let b = 0; b < s.bars; b++) {
        const led = document.createElement("i");
        leds.append(led);
        this.leds.push(led);
      }
      seg.append(name, bracket, leds);
      frag.append(seg);
      this.segments.push(seg);
      this.total = s.start + s.bars;
    }
    this.els.segments.replaceChildren(frag);
  }
}

function setAttr(el: Element, name: string, value: string) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}
