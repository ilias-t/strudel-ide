// ═══════════════════════════════════════════════════════════════════════════
// Visualization: the full-screen pianoroll / scope behind the stage
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

/** Stage defaults: the roll sits behind the code, so keep it calm and wide */
const PIANOROLL_DEFAULTS: PianorollOptions = {
  cycles: 4,
  playhead: 0.5,
  autorange: true,
  fold: 1,
  playheadColor: "rgba(255, 255, 255, 0.5)",
};

/**
 * Create the shared canvas ourselves (same id, so @strudel/draw reuses it) so
 * it exists before the first draw and tracks the window size and pixel ratio.
 */
export function ensureCanvas(): HTMLCanvasElement {
  let canvas = document.getElementById(DRAW_CANVAS_ID) as HTMLCanvasElement | null;
  if (canvas) return canvas;
  canvas = document.createElement("canvas");
  canvas.id = DRAW_CANVAS_ID;
  canvas.className = "viz-canvas";
  canvas.setAttribute("aria-hidden", "true");
  const size = () => {
    const ratio = window.devicePixelRatio || 1;
    canvas!.width = Math.round(window.innerWidth * ratio);
    canvas!.height = Math.round(window.innerHeight * ratio);
  };
  size();
  let timer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(size, 150);
  });
  document.body.prepend(canvas);
  return canvas;
}

/** A neon time-domain scope with a glow; one colour (strudel's flickers per hap colour) */
function neonScope(pattern: Pattern): Pattern {
  const ctx = ensureCanvas().getContext("2d")!;
  return internals((pattern as any).analyze(DRAW_ID)).draw(
    () => {
      const { width, height } = ctx.canvas;
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.shadowColor = "rgba(5, 217, 232, 0.9)";
      ctx.shadowBlur = 18;
      web.drawTimeScope(web.analysers[DRAW_ID], {
        ctx,
        color: "rgba(5, 217, 232, 0.85)",
        thickness: 3 * (window.devicePixelRatio || 1),
        scale: 0.3,
        pos: 0.58,
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
      return neonScope(pattern);
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
