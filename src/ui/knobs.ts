// ═══════════════════════════════════════════════════════════════════════════
// Knob panel: a rotary control per knob() in the current song
// ═══════════════════════════════════════════════════════════════════════════
//
// Each dial is a role="slider" element:
//   drag        up/right turns it up (relative, like a hardware knob: grabbing
//               never jumps the value); Shift for fine control
//   wheel       turns it (Shift: fine)
//   keys        ←/↓ →/↑ one step, PageUp/PageDown 10% of the travel,
//               Home/End min/max, Delete/Backspace back to the file's value
//   dblclick    back to the file's value
// A knob that differs from its file value is "dirty": a lit dot, an arc from
// the file's value to the live one, and a Write button (dev server only). The
// file's value is always marked on the scale.
//
// Each knob gets a coloured cap from what its name says it does (filter →
// cobalt, drive → ember, space → lilac, time → teal, the rest cream).

import { formatKnob, knobPosition, knobTextWidth, knobValueAt, type KnobInfo } from "../engine/knobs";

export interface KnobActions {
  setKnob(name: string, value: number): number | null;
  resetKnob(name: string): number | null;
  grabKnob(name: string, on: boolean): void;
  writeKnobs(names?: string[]): Promise<{ ok: boolean; error?: string; changes?: { name: string; literal: string; line: number }[] }>;
}

export interface KnobElements {
  root: HTMLElement;
  grid: HTMLElement;
  writeAll: HTMLButtonElement;
  status: HTMLElement;
}

interface Dial {
  el: HTMLElement;
  dial: HTMLElement;
  value: HTMLElement;
  arc: SVGPathElement;
  pointer: SVGGElement;
  home: SVGGElement;
  write: HTMLButtonElement;
  knob: KnobInfo;
}

/** Arc from 7:30 to 4:30 o'clock (270°), as an SVG path in a 48×48 box */
const SWEEP = 270;
const R = 21.5;
const C = 24;
const CAP_R = 14;
const polar = (deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return `${(C + R * Math.cos(a)).toFixed(2)} ${(C + R * Math.sin(a)).toFixed(2)}`;
};
const ARC = `M ${polar(-SWEEP / 2)} A ${R} ${R} 0 1 1 ${polar(SWEEP / 2)}`;
const SVG_NS = "http://www.w3.org/2000/svg";

/** Cap colour by what the knob's name says it does */
const CAPS: [RegExp, string, boolean][] = [
  [/res|acid|q$/i, "var(--acid)", true],
  [/cut|filter|lpf|hpf|bpf|freq|tone|bright|wobble/i, "var(--cobalt)", false],
  [/drive|shape|dist|crush|kick|pump|duck|punch|gain|level/i, "var(--ember)", false],
  [/reverb|room|space|size|hiss|shore|wet|wash|pad/i, "var(--lilac)", false],
  [/delay|echo|time|rate|speed|lfo/i, "var(--teal)", false],
];

function capFor(name: string): { color: string; dark: boolean } {
  const hit = CAPS.find(([re]) => re.test(name));
  return hit ? { color: hit[1], dark: hit[2] } : { color: "var(--cream)", dark: true };
}

/** Shared highlight gradient for the caps (one per document) */
function ensureShine() {
  if (document.getElementById("knob-shine")) return;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute";
  svg.innerHTML =
    '<defs><radialGradient id="knob-shine" cx="38%" cy="30%" r="75%">' +
    '<stop offset="0" stop-color="white" stop-opacity=".45"/><stop offset=".45" stop-color="white" stop-opacity="0"/>' +
    '<stop offset="1" stop-color="black" stop-opacity=".3"/></radialGradient></defs>';
  document.body.append(svg);
}

/** Drag distance (px) for the full travel */
const DRAG_PX = 220;

export class KnobPanel {
  private dials = new Map<string, Dial>();
  private key = "";
  private canWrite: boolean;
  private statusTimer = 0;

  constructor(private o: KnobElements, private actions: KnobActions, options: { canWrite: boolean }) {
    this.canWrite = options.canWrite;
    o.root.dataset.canWrite = String(options.canWrite);
    o.writeAll.addEventListener("click", () => void this.write());
  }

  /** Show the current song's knobs (cheap when only values changed) */
  render(knobs: KnobInfo[], songId: string) {
    const key = `${songId}\n${knobs.map((k) => k.name).join("\n")}`;
    if (key !== this.key) {
      this.key = key;
      this.build(knobs);
    }
    this.o.root.hidden = knobs.length === 0;
    let dirty = 0;
    for (const knob of knobs) {
      const d = this.dials.get(knob.name);
      if (!d) continue;
      d.knob = knob;
      this.paint(d);
      if (knob.dirty) dirty++;
    }
    // one changed knob: its own Write button is enough
    this.o.writeAll.hidden = !this.canWrite || dirty < 2;
    this.o.writeAll.textContent = `Write all (${dirty})`;
    this.o.writeAll.title = "Write every changed knob into the song file (one edit, one hot-swap)";
  }

  /** Move keyboard focus to a knob (e.g. from its chip in the code) */
  focus(name: string) {
    const d = this.dials.get(name);
    if (!d) return;
    d.dial.focus();
    d.el.scrollIntoView({ block: "nearest" });
    d.el.animate([{ boxShadow: "0 0 0 2px var(--knob-accent)" }, { boxShadow: "0 0 0 2px transparent" }], { duration: 700 });
  }

  private paint(d: Dial) {
    const { knob } = d;
    const p = knobPosition(knob, knob.value);
    const text = formatKnob(knob, knob.value);
    setAttr(d.el, "data-dirty", String(knob.dirty));
    setAttr(d.dial, "aria-valuenow", String(knob.value));
    setAttr(d.dial, "aria-valuetext", knob.dirty ? `${text} (file: ${formatKnob(knob, knob.def)})` : text);
    if (d.value.textContent !== text) d.value.textContent = text;
    // dirty: the arc runs from the file's value to the live one
    const h = knobPosition(knob, knob.def);
    d.arc.style.strokeDasharray = `${(Math.abs(p - h) * 100).toFixed(2)} 200`;
    d.arc.style.strokeDashoffset = `${(-Math.min(p, h) * 100).toFixed(2)}`;
    d.pointer.style.transform = `rotate(${(-SWEEP / 2 + p * SWEEP).toFixed(2)}deg)`;
    d.home.style.transform = `rotate(${(-SWEEP / 2 + knobPosition(knob, knob.def) * SWEEP).toFixed(2)}deg)`;
    d.write.hidden = !this.canWrite || !knob.dirty;
  }

  private build(knobs: KnobInfo[]) {
    this.dials.clear();
    const frag = document.createDocumentFragment();
    for (const knob of knobs) {
      const el = document.createElement("div");
      el.className = "knob";
      el.dataset.testid = "knob";
      el.dataset.knob = knob.name;

      const dial = document.createElement("div");
      dial.className = "knob-dial";
      dial.tabIndex = 0;
      dial.setAttribute("role", "slider");
      dial.setAttribute("aria-label", knob.name);
      dial.setAttribute("aria-valuemin", String(knob.min));
      dial.setAttribute("aria-valuemax", String(knob.max));
      dial.dataset.testid = "knob-dial";
      dial.title = `${knob.name}: ${formatKnob(knob, knob.min)}–${formatKnob(knob, knob.max)}${knob.log ? " (log)" : ""}\nDrag or scroll (Shift: fine) · arrow keys · double-click: back to the file's value`;

      const { color, dark } = capFor(knob.name);
      dial.style.setProperty("--cap", color);
      if (dark) dial.dataset.darkPointer = "true";

      ensureShine();
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", "0 0 48 48");
      svg.setAttribute("aria-hidden", "true");
      const track = path(ARC, "knob-track");
      track.setAttribute("pathLength", "100");
      const arc = path(ARC, "knob-arc");
      arc.setAttribute("pathLength", "100");
      const home = document.createElementNS(SVG_NS, "g");
      home.setAttribute("class", "knob-home");
      home.append(line(C, C - R, C, C - R + 0.01));
      const pointer = document.createElementNS(SVG_NS, "g");
      pointer.setAttribute("class", "knob-pointer");
      pointer.append(line(C, C - CAP_R + 2.5, C, C - CAP_R + 8));
      const cap = circle(CAP_R, "knob-cap");
      const shine = circle(CAP_R, "knob-shine");
      shine.setAttribute("fill", "url(#knob-shine)");
      svg.append(track, arc, home, cap, shine, pointer);
      dial.append(svg);

      const name = document.createElement("span");
      name.className = "knob-name";
      name.textContent = knob.name;
      name.title = knob.name;

      const value = document.createElement("span");
      value.className = "knob-value";
      value.dataset.testid = "knob-value";
      // fixed width: the label doesn't jitter while turning
      const widest = knobTextWidth(knob);
      value.style.minWidth = `${widest}ch`;

      const write = document.createElement("button");
      write.className = "knob-write";
      write.dataset.testid = "knob-write";
      write.textContent = "write";
      write.title = `Write ${knob.name}'s value into the song file`;
      write.hidden = true;
      write.addEventListener("click", () => void this.write([knob.name]));

      el.append(dial, name, value, write);
      frag.append(el);
      const d: Dial = { el, dial, value, arc, pointer, home, write, knob };
      this.dials.set(knob.name, d);
      this.wire(d);
    }
    this.o.grid.replaceChildren(frag);
  }

  private wire(d: Dial) {
    const { dial } = d;
    const name = () => d.knob.name;
    const setPosition = (p: number) => this.actions.setKnob(name(), knobValueAt(d.knob, p));
    const nudge = (steps: number) => this.actions.setKnob(name(), d.knob.value + steps * d.knob.step);

    let drag: { id: number; x: number; y: number; from: number } | null = null;
    dial.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dial.focus();
      dial.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, from: knobPosition(d.knob, d.knob.value) };
      this.actions.grabKnob(name(), true);
      d.el.dataset.active = "true";
    });
    dial.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const px = drag.y - e.clientY + (e.clientX - drag.x);
      const p = drag.from + (px / DRAG_PX) * (e.shiftKey ? 0.1 : 1);
      setPosition(p);
      // past an end: re-anchor, so turning back responds immediately
      if (p < 0 || p > 1) drag = { ...drag, x: e.clientX, y: e.clientY, from: Math.min(1, Math.max(0, p)) };
    });
    const end = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      this.actions.grabKnob(name(), false);
      delete d.el.dataset.active;
    };
    dial.addEventListener("pointerup", end);
    dial.addEventListener("pointercancel", end);
    dial.addEventListener("lostpointercapture", end);

    dial.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; // lines → px
        const p = knobPosition(d.knob, d.knob.value) - (delta / 1500) * (e.shiftKey ? 0.1 : 1);
        // at least one step per notch, so fine knobs still move
        const next = knobValueAt(d.knob, p);
        if (Math.abs(next - d.knob.value) < d.knob.step) nudge(delta < 0 ? 1 : -1);
        else setPosition(p);
      },
      { passive: false }
    );

    dial.addEventListener("dblclick", () => this.actions.resetKnob(name()));

    dial.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const pos = knobPosition(d.knob, d.knob.value);
      const big = e.shiftKey ? 10 : 1;
      switch (e.key) {
        case "ArrowUp":
        case "ArrowRight":
          nudge(big);
          break;
        case "ArrowDown":
        case "ArrowLeft":
          nudge(-big);
          break;
        case "PageUp":
          setPosition(pos + 0.1);
          break;
        case "PageDown":
          setPosition(pos - 0.1);
          break;
        case "Home":
          this.actions.setKnob(name(), d.knob.min);
          break;
        case "End":
          this.actions.setKnob(name(), d.knob.max);
          break;
        case "Delete":
        case "Backspace":
          this.actions.resetKnob(name());
          break;
        default:
          return;
      }
      // the stage's shortcuts (←/→ change the song) must not see it
      e.preventDefault();
      e.stopPropagation();
    });
  }

  private async write(names?: string[]) {
    this.o.root.dataset.writing = "true";
    const result = await this.actions.writeKnobs(names);
    delete this.o.root.dataset.writing;
    if (!result.ok) {
      this.showStatus(`Couldn't write: ${result.error ?? "unknown error"}`, "error");
    } else if (result.changes?.length) {
      const what = result.changes.map((c) => `${c.name} = ${c.literal}`).join(", ");
      this.showStatus(`Wrote ${what}`, "ok");
    }
  }

  private showStatus(text: string, kind: "ok" | "error") {
    const { status } = this.o;
    status.textContent = text;
    status.dataset.kind = kind;
    status.hidden = false;
    clearTimeout(this.statusTimer);
    this.statusTimer = window.setTimeout(() => (status.hidden = true), kind === "error" ? 8000 : 3000);
  }
}

function path(d: string, cls: string) {
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", d);
  p.setAttribute("class", cls);
  return p;
}

function circle(r: number, cls: string) {
  const c = document.createElementNS(SVG_NS, "circle");
  c.setAttribute("cx", String(C));
  c.setAttribute("cy", String(C));
  c.setAttribute("r", String(r));
  c.setAttribute("class", cls);
  return c;
}

function line(x1: number, y1: number, x2: number, y2: number) {
  const l = document.createElementNS(SVG_NS, "line");
  l.setAttribute("x1", String(x1));
  l.setAttribute("y1", String(y1));
  l.setAttribute("x2", String(x2));
  l.setAttribute("y2", String(y2));
  return l;
}

function setAttr(el: Element, name: string, value: string) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}
