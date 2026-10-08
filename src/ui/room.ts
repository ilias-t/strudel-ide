// ═══════════════════════════════════════════════════════════════════════════
// The room: lamps that are the mix, lighting the gear from outside
// ═══════════════════════════════════════════════════════════════════════════
//
// The stage is gear on a desk in a dim room. Each lamp follows a part of the
// mix (by track role, src/engine/tracks.ts):
//
//   dusk   floor lamp = kick, window wash = pads, right pool = bass,
//          left wall = snare, a small drifting light = arp / lead
//   club   white floor strobe = kick, acid field = 303, UV = hats,
//          magenta wall = clap, cold pool = bass
//
// Cheap by construction:
//   - the room is a canvas at 1/10 of the window, upscaled by the browser,
//     painted only while something moves (stopped and settled: no paint)
//   - a copy is screen-blended over the gear at low opacity (.spill-canvas);
//     screens sit above it, so code stays untinted
//   - each unit (.mod) gets rim / shade layers with fixed box-shadows; per
//     frame only their opacity changes
// prefers-reduced-motion holds the lamps at a steady level instead.

import { trackRole, type TrackRole } from "../engine/tracks";

export type RoomLook = "dusk" | "club";

/** [attack, decay] in seconds, per role */
type Envelopes = Record<TrackRole, [number, number]>;

const ENVELOPES: Record<RoomLook, Envelopes> = {
  // soft and lush
  dusk: {
    kick: [0.004, 0.3],
    snare: [0.006, 0.34],
    hats: [0.002, 0.09],
    perc: [0.002, 0.2],
    bass: [0.01, 0.22],
    pads: [0.35, 1.6],
    arp: [0.003, 0.12],
    lead: [0.02, 0.5],
    acid: [0.002, 0.15],
    fx: [0.1, 1],
    other: [0.01, 0.3],
  },
  // hard transients, short tails (909)
  club: {
    kick: [0.0005, 0.11],
    snare: [0.0008, 0.12],
    hats: [0.0005, 0.035],
    perc: [0.0005, 0.05],
    bass: [0.001, 0.07],
    pads: [0.4, 1.5],
    arp: [0.001, 0.14],
    lead: [0.01, 0.3],
    acid: [0.001, 0.09],
    fx: [0.1, 1],
    other: [0.001, 0.1],
  },
};

const ROLES = Object.keys(ENVELOPES.dusk) as TrackRole[];

/** How hard the club strobe may flash (0..1); the knob for a future comfort setting */
const STROBE = 1;
/** Room canvas resolution: 1 px per SCALE css px */
const SCALE = 10;

interface Lit {
  el: HTMLElement;
  rect: DOMRect;
  shade: HTMLElement;
  b: HTMLElement;
  t: HTMLElement;
  r: HTMLElement;
  l: HTMLElement;
  painted: string;
}

interface Envelope {
  /** time of the last hit (s), its peak */
  at: number;
  peak: number;
}

export class Room {
  private room: HTMLCanvasElement;
  private spill: HTMLCanvasElement;
  private rctx: CanvasRenderingContext2D;
  private sctx: CanvasRenderingContext2D;
  private W = 0;
  private H = 0;
  private vw = 0;
  private vh = 0;
  private mods: Lit[] = [];
  private measured = false;
  private env = new Map<TrackRole, Envelope>(ROLES.map((r) => [r, { at: -99, peak: 0 }]));
  private look: RoomLook = "dusk";
  private playing = false;
  /** last frame painted at rest (nothing moving): skip until something changes */
  private settled = false;
  private reduce = matchMedia("(prefers-reduced-motion: reduce)");

  constructor(stage: HTMLElement) {
    this.room = canvas("room-canvas");
    this.spill = canvas("spill-canvas");
    document.body.prepend(this.room);
    document.body.append(this.spill);
    this.rctx = this.room.getContext("2d")!;
    this.sctx = this.spill.getContext("2d")!;

    for (const el of stage.querySelectorAll<HTMLElement>(".mod")) {
      el.insertAdjacentHTML(
        "afterbegin",
        '<span class="shade"></span><span class="rim b"></span><span class="rim t"></span><span class="rim r"></span><span class="rim l"></span>'
      );
      const q = (sel: string) => el.querySelector<HTMLElement>(`:scope > ${sel}`)!;
      this.mods.push({ el, rect: el.getBoundingClientRect(), shade: q(".shade"), b: q(".rim.b"), t: q(".rim.t"), r: q(".rim.r"), l: q(".rim.l"), painted: "" });
    }
    const remeasure = () => {
      this.measured = false;
      this.settled = false;
    };
    const ro = new ResizeObserver(remeasure);
    for (const m of this.mods) ro.observe(m.el);
    window.addEventListener("resize", remeasure);
    this.reduce.addEventListener("change", remeasure);
  }

  setLook(look: RoomLook) {
    if (look === this.look) return;
    this.look = look;
    document.documentElement.dataset.room = look;
    this.settled = false;
  }

  setPlaying(playing: boolean) {
    if (playing === this.playing) return;
    this.playing = playing;
    this.settled = false;
  }

  /** A track just played a note; `level` 0..1 */
  hit(track: string, level: number, now: number) {
    const e = this.env.get(trackRole(track))!;
    const t = now / 1000;
    if (this.value(trackRole(track), t) <= level) {
      e.at = t;
      e.peak = level;
    }
    this.settled = false;
  }

  frame(now: number) {
    if (!this.measured) this.measure();
    if (this.settled) return;
    const t = now / 1000;
    const E = {} as Record<TrackRole, number>;
    let moving = false;
    for (const role of ROLES) {
      E[role] = this.playing ? this.value(role, t) : 0;
      if (E[role] > 0.002) moving = true;
    }
    if (this.playing && this.look === "dusk") {
      // sidechain: the pads dip under each kick
      E.pads = E.pads * (1 - 0.55 * E.kick);
    }
    if (this.reduce.matches) {
      for (const role of ROLES) E[role] = this.playing ? 0.35 : 0;
      moving = false;
    }
    this.paintRoom(E, t);
    this.lightGear(E);
    // stopped (or steady) and every envelope has run out: hold this frame
    this.settled = !moving && (!this.playing || this.reduce.matches);
  }

  private value(role: TrackRole, t: number) {
    const e = this.env.get(role)!;
    const [attack, decay] = ENVELOPES[this.look][role];
    const since = t - e.at;
    if (since < 0 || since > 8) return 0;
    if (since < attack) return (e.peak * since) / attack;
    return e.peak * Math.exp(-(since - attack) / decay);
  }

  private measure() {
    this.measured = true;
    this.vw = window.innerWidth;
    this.vh = window.innerHeight;
    this.W = Math.ceil(this.vw / SCALE);
    this.H = Math.ceil(this.vh / SCALE);
    for (const c of [this.room, this.spill]) {
      if (c.width !== this.W) c.width = this.W;
      if (c.height !== this.H) c.height = this.H;
    }
    for (const m of this.mods) {
      m.rect = m.el.getBoundingClientRect();
      m.painted = "";
    }
  }

  private paintRoom(E: Record<TrackRole, number>, t: number) {
    const { W, H, rctx: ctx } = this;
    if (!W || !H) return;
    const club = this.look === "club";
    ctx.globalCompositeOperation = "source-over";
    const base = ctx.createLinearGradient(0, 0, 0, H);
    if (club) {
      base.addColorStop(0, "#0c0b18");
      base.addColorStop(1, "#07080c");
    } else {
      base.addColorStop(0, "#1f2150");
      base.addColorStop(0.55, "#1a1b3e");
      base.addColorStop(1, "#2a1c38");
    }
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";
    const slow = this.reduce.matches ? 0 : t * 0.05;
    const glow = (x: number, y: number, r: number, color: string, a: number) => {
      if (a <= 0.002) return;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(color, a));
      g.addColorStop(0.45, rgba(color, a * 0.45));
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    };
    if (!club) {
      // pads: the dusk window, a lavender wash from the top that swells with each chord
      glow(W * (0.32 + 0.05 * Math.sin(slow)), -H * 0.1, W * 0.62, "#8c78e8", 0.34 + 0.22 * E.pads);
      glow(W * 0.78, -H * 0.2, W * 0.45, "#5e6fd8", 0.22 + 0.08 * E.pads);
      // bass: a blue pool to the right
      glow(W * 1.04, H * 0.55, W * 0.4, "#3f78ff", 0.2 + 0.3 * E.bass);
      // arp and lead: a small light drifting along the top right
      glow(W * (0.62 + 0.18 * Math.sin(slow * 1.7)), H * 0.08, W * 0.18, "#3fd0b4", 0.06 + 0.16 * Math.max(E.arp, E.acid));
      glow(W * (0.2 + 0.1 * Math.sin(slow * 1.3)), H * 0.05, W * 0.16, "#f1ece1", 0.03 + 0.12 * E.lead);
      // snare: rose from the left wall
      glow(-W * 0.04, H * 0.62, W * 0.34, "#f0729a", 0.1 + 0.42 * Math.max(E.snare, E.fx * 0.5));
      // kick: a peach floor lamp that throws light up over the desk
      glow(W * 0.45, H * 1.18, W * 0.62, "#ff8a5a", 0.24 + 0.55 * E.kick);
      glow(W * 0.45, H * 1.05, W * 0.3, "#ffc9a8", 0.3 * E.kick);
    } else {
      // the 303: an acid-green field that breathes and flares on each note
      const cut = 0.55 + 0.45 * Math.sin(t * 0.23);
      glow(W * 0.7, H * 0.02, W * (0.3 + 0.28 * cut), "#a6e62e", 0.1 + 0.42 * E.acid * (0.6 + 0.4 * cut));
      // ultraviolet: hats flicker along the top edge
      glow(W * 0.28, -H * 0.12, W * 0.45, "#7a4dff", 0.16 + 0.22 * E.hats + 0.2 * E.perc);
      // pads and leads: a faint lilac haze
      glow(W * 0.5, -H * 0.15, W * 0.5, "#9c82f2", 0.04 + 0.14 * Math.max(E.pads, E.lead, E.arp));
      // bass: a cold blue pool, right
      glow(W * 1.06, H * 0.62, W * 0.38, "#2e55ff", 0.12 + 0.22 * E.bass);
      // clap: magenta from the left
      glow(-W * 0.05, H * 0.55, W * 0.36, "#ff3d9a", 0.06 + 0.55 * E.snare);
      // the kick: a white floor strobe with almost no tail, lifting the whole room
      const k = E.kick * STROBE;
      glow(W * 0.5, H * 1.15, W * 0.95, "#e4e0ff", 0.04 + 0.95 * k);
      glow(W * 0.5, H * 1.02, W * 0.4, "#ffffff", 0.55 * k);
      ctx.fillStyle = `rgba(220,215,255,${(0.08 * k).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
    }
    // vignette: the room falls off into the corners
    ctx.globalCompositeOperation = "source-over";
    const v = ctx.createRadialGradient(W / 2, H * 0.45, H * 0.3, W / 2, H * 0.5, W * 0.75);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,.55)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
    this.sctx.clearRect(0, 0, W, H);
    this.sctx.drawImage(this.room, 0, 0);
  }

  /** Rim light on the edge of each unit that faces a lamp; the kick throws a shadow up and back */
  private lightGear(E: Record<TrackRole, number>) {
    const club = this.look === "club";
    const kick = E.kick * (club ? STROBE : 1);
    const top = club ? Math.max(E.acid * 0.8, E.hats * 0.5) : E.pads;
    const right = E.bass;
    const left = E.snare;
    const restTop = club ? 0.25 : 0.45;
    const restB = club ? 0.05 : 0.22;
    const { vw, vh } = this;
    for (const m of this.mods) {
      const r = m.rect;
      if (!r.width) continue;
      const fB = Math.max(0, 1 - (1.1 - r.bottom / vh) * 0.9); // nearer the floor lamp: brighter bottom edge
      const fT = Math.max(0, 1 - (r.top / vh) * 0.9);
      const fR = Math.max(0, 1 - (1.05 - r.right / vw) * 1.4);
      const fL = Math.max(0, 1 - (r.left / vw) * 1.6);
      const b = Math.min(1, (restB + kick * (club ? 1.1 : 0.85)) * fB);
      const t = Math.min(1, (restTop + top * 0.55) * fT);
      const rr = Math.min(1, (0.12 + right * 0.8) * fR);
      const l = Math.min(1, (0.06 + left * 0.9) * fL);
      const shade = Math.min(1, kick * (club ? 0.95 : 0.7) * (0.4 + fB * 0.6));
      const painted = [b, t, rr, l, shade].map((x) => x.toFixed(2)).join("|");
      if (painted === m.painted) continue;
      m.painted = painted;
      m.b.style.opacity = b.toFixed(2);
      m.t.style.opacity = t.toFixed(2);
      m.r.style.opacity = rr.toFixed(2);
      m.l.style.opacity = l.toFixed(2);
      m.shade.style.opacity = shade.toFixed(2);
    }
  }
}

function canvas(className: string) {
  const c = document.createElement("canvas");
  c.className = className;
  c.setAttribute("aria-hidden", "true");
  return c;
}

function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${Math.min(1, a).toFixed(3)})`;
}
