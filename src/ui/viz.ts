// ═══════════════════════════════════════════════════════════════════════════
// Visualization: the pianoroll / scope on the visualizer unit's screen
// ═══════════════════════════════════════════════════════════════════════════

import * as strudelWeb from "@strudel/web";
import { engine, internals } from "../engine/strudel";
import type { VisualizationConfig } from "../songs";

/** All Strudel visualizations default to animation-frame id 1 */
const DRAW_ID = 1;
/** Canvas id that @strudel/draw's getDrawContext() creates and reuses */
const DRAW_CANVAS_ID = "test-canvas";

const web = strudelWeb as unknown as {
  analysers: Record<number, AnalyserNode | undefined>;
  drawTimeScope(analyser: AnalyserNode | undefined, options: Record<string, unknown>): void;
};

/** Stage defaults for a small screen: a calm roll with the playhead left of centre */
const PIANOROLL_DEFAULTS: PianorollOptions = {
  cycles: 4,
  playhead: 0.38,
  autorange: true,
  fold: 1,
  playheadColor: "rgba(238, 233, 222, 0.9)",
};

/** Where the canvas lives (the visualizer unit's screen); the body until the stage mounts */
const host = () => document.getElementById("view-screen") ?? document.body;

/**
 * Create the shared canvas ourselves (same id, so @strudel/draw reuses it) so
 * it exists before the first draw and tracks its screen's size and pixel ratio.
 */
export function ensureCanvas(): HTMLCanvasElement {
  let canvas = document.getElementById(DRAW_CANVAS_ID) as HTMLCanvasElement | null;
  if (canvas) return canvas;
  canvas = document.createElement("canvas");
  canvas.id = DRAW_CANVAS_ID;
  canvas.className = "viz-canvas";
  canvas.setAttribute("aria-hidden", "true");
  const screen = host();
  const size = () => {
    const ratio = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(screen.clientWidth * ratio));
    const h = Math.max(1, Math.round(screen.clientHeight * ratio));
    // resizing clears the canvas, so only when it really changed
    if (canvas!.width !== w) canvas!.width = w;
    if (canvas!.height !== h) canvas!.height = h;
  };
  size();
  new ResizeObserver(size).observe(screen);
  screen.prepend(canvas);
  return canvas;
}

/** A time-domain scope with a soft glow, in the room's signature colour */
function glassScope(pattern: Pattern): Pattern {
  const ctx = ensureCanvas().getContext("2d")!;
  return internals((pattern as any).analyze(DRAW_ID)).draw(
    () => {
      const { width, height } = ctx.canvas;
      const club = document.documentElement.dataset.room === "club";
      const color = club ? "185, 240, 58" : "95, 224, 198";
      const dpr = window.devicePixelRatio || 1;
      ctx.clearRect(0, 0, width, height);
      // a faint graticule
      ctx.strokeStyle = "#141416";
      ctx.lineWidth = dpr;
      ctx.beginPath();
      for (let i = 1; i < 8; i++) {
        const x = Math.round((width * i) / 8) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
      }
      for (let i = 1; i < 4; i++) {
        const y = Math.round((height * i) / 4) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      ctx.stroke();
      ctx.save();
      ctx.shadowColor = `rgba(${color}, 0.8)`;
      ctx.shadowBlur = 8 * dpr;
      web.drawTimeScope(web.analysers[DRAW_ID], {
        ctx,
        color: `rgba(${color}, 0.95)`,
        thickness: 1.6 * dpr,
        scale: 0.35,
        pos: 0.5,
      });
      ctx.restore();
    },
    { id: DRAW_ID }
  ) as Pattern;
}

export function applyVisualization(pattern: Pattern, config: VisualizationConfig): Pattern {
  ensureCanvas();
  switch (config.type) {
    case "pianoroll":
      return pattern.pianoroll({ ...PIANOROLL_DEFAULTS, ...config.options });
    case "scope":
      return glassScope(pattern);
    case "none":
    default:
      clearVisualization();
      return pattern;
  }
}

/**
 * Stop any running visualization loop and clear its canvas.
 * pianoroll()/scope() run a requestAnimationFrame loop keyed by id 1; a new
 * pianoroll()/scope() call replaces it. To stop it, register a no-op draw on
 * the same id. The shared canvas is kept (never removed): pianoroll() captures
 * its 2d context when called, so a removed canvas would keep being drawn to.
 */
export function clearVisualization() {
  internals(engine.silence).draw(() => {}, { id: DRAW_ID });
  const canvas = document.getElementById(DRAW_CANVAS_ID) as HTMLCanvasElement | null;
  canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
}
