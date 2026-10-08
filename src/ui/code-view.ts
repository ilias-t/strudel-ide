// ═══════════════════════════════════════════════════════════════════════════
// Live code view: the song's source with the sounding tokens lit up
// ═══════════════════════════════════════════════════════════════════════════
//
// Read-only, syntax-coloured (tokenize.ts) and laid over the visualization.
// Highlights are absolutely positioned boxes in an overlay, never DOM changes
// to the text: a range's position is measured once with a DOM Range (exact,
// whatever the font does with emoji or wrapping) and cached until the text,
// width or font changes. Per frame the view only moves/creates a few boxes,
// with all layout reads before any writes.
//
// Two signals light it up, like strudel.cc:
//   setRanges()  the tokens sounding now (createHighlighter, ≤ 30 Hz): outlined
//   flash()      a hap just started on that token: a short pulse, so "bd*4"
//                visibly hits four times while staying outlined
//
// Each `knob("name", …)` call gets an inline chip after its closing paren
// showing the knob's live value (knobChips(); the text is CSS-generated, so it
// is never copied with the code). Clicking a chip calls onKnobChip.
// Clicking a token or line reports its position (onPick), which the stage
// uses to open that spot in the editor.

import { tokenize, type Token, type TokenKind } from "./tokenize";
import type { Range } from "../live/highlights";

const PACK = 2 ** 22;
const key = (start: number, end: number) => start * PACK + end;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Box {
  el: HTMLDivElement;
  flash: HTMLDivElement;
  color: string;
  /** still in the current range set (lit) */
  lit: boolean;
  /** a transient box created only for a flash; removed when it fades */
  transientUntil: number;
  fade?: Animation;
}

export interface CodeViewOptions {
  scroller: HTMLElement;
  content: HTMLElement;
  lines: HTMLElement;
  overlay: HTMLElement;
  /** Shown when the user scrolled away; clicking it resumes following */
  followChip: HTMLElement;
  /** A knob chip in the code was clicked */
  onKnobChip?: (name: string) => void;
  /** A click on the code (not a text selection): offset into the text, 1-based line/column */
  onPick?: (pos: { offset: number; line: number; column: number }) => void;
}

/** A `knob("name", …)` call in the text: `end` is just past its closing paren */
export interface KnobCall {
  name: string;
  start: number;
  end: number;
}

/**
 * Find `knob("name", …)` calls with the tokenizer (not in comments or
 * strings, not `.knob(`), and where each call's parentheses close.
 */
export function findKnobCalls(text: string, tokens: Token[] = tokenize(text)): KnobCall[] {
  const calls: KnobCall[] = [];
  const significant = tokens.filter((t) => t.kind !== "" || text.slice(t.start, t.end).trim() !== "");
  for (let i = 0; i < significant.length; i++) {
    const t = significant[i];
    if (t.kind !== "f" || text.slice(t.start, t.end) !== "knob" || text[t.start - 1] === ".") continue;
    const open = significant[i + 1];
    const name = significant[i + 2];
    if (!open || open.kind !== "p" || text[open.start] !== "(" || !name || name.kind !== "s") continue;
    let depth = 0;
    let end = -1;
    for (let j = i + 1; j < significant.length && end < 0; j++) {
      const p = significant[j];
      if (p.kind !== "p") continue;
      for (let k = p.start; k < p.end; k++) {
        if (text[k] === "(") depth++;
        else if (text[k] === ")" && --depth === 0) {
          end = k + 1;
          break;
        }
      }
    }
    if (end > 0) calls.push({ name: text.slice(name.start + 1, name.end - 1), start: t.start, end });
  }
  return calls;
}

export class CodeView {
  private text = "";
  private version: string | undefined;
  /** text node per rendered token piece, ordered by offset */
  private nodeStarts: number[] = [];
  private nodes: Text[] = [];
  private lineEls: HTMLElement[] = [];
  private errorLine: number | null = null;
  private chips = new Map<string, HTMLElement[]>();

  private rectCache = new Map<number, Rect | null>();
  private boxes = new Map<number, Box>();
  private ranges: Range[] = [];
  private rangesDirty = false;
  private pendingFlashes = new Map<number, string>();
  private colorFor: (start: number, end: number) => string | undefined = () => undefined;
  private enabled = true;

  private following = true;
  private lastAutoScroll = 0;
  private programmaticUntil = 0;
  private viewportH = 0;

  constructor(private o: CodeViewOptions) {
    const stopFollowing = () => {
      if (performance.now() < this.programmaticUntil) return;
      this.setFollowing(false);
    };
    o.scroller.addEventListener("wheel", stopFollowing, { passive: true });
    o.scroller.addEventListener("touchmove", stopFollowing, { passive: true });
    o.scroller.addEventListener("pointerdown", (e) => {
      // a drag on the scrollbar (outside the content box)
      if (e.target === o.scroller) stopFollowing();
    });
    o.scroller.addEventListener("keydown", (e) => {
      if (/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End)$/.test(e.key)) stopFollowing();
    });
    o.followChip.addEventListener("click", () => this.setFollowing(true));
    o.content.addEventListener("click", (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLElement>(".knob-chip");
      if (chip?.dataset.knob) o.onKnobChip?.(chip.dataset.knob);
    });
    o.lines.addEventListener("click", (e) => this.pick(e));

    new ResizeObserver(() => {
      this.viewportH = o.scroller.clientHeight;
      this.invalidate();
    }).observe(o.scroller);
    void document.fonts?.ready.then(() => this.invalidate());
  }

  /**
   * Show `text` (no-op when unchanged). `otherFile`: a different song, so start
   * at the top and follow the music; an edit of the same file keeps the scroll.
   */
  setSource(text: string, version: string | undefined, otherFile: boolean) {
    if (text === this.text && version === this.version) return;
    this.text = text;
    this.version = version;
    const scrollTop = this.o.scroller.scrollTop;
    this.errorLine = null;
    this.render();
    this.clearBoxes();
    this.ranges = [];
    this.rangesDirty = true;
    if (otherFile) {
      this.setFollowing(true);
      this.o.scroller.scrollTop = 0;
    } else {
      this.o.scroller.scrollTop = scrollTop;
    }
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) this.invalidate();
  }

  /** How to colour a range (the track that plays it) */
  setColorResolver(fn: (start: number, end: number) => string | undefined) {
    this.colorFor = fn;
  }

  /** The tokens sounding now. Applied on the next frame(). */
  setRanges(ranges: Range[]) {
    this.ranges = ranges;
    this.rangesDirty = true;
  }

  /** Chip elements per knob name (in the current text) */
  knobChips(): ReadonlyMap<string, HTMLElement[]> {
    return this.chips;
  }

  /** Current lit ranges (for tests) */
  litRanges(): Range[] {
    return this.ranges;
  }

  /** A hap started on [start, end): pulse it on the next frame */
  flash(start: number, end: number, color: string) {
    this.pendingFlashes.set(key(start, end), color);
  }

  setErrorLine(line: number | null) {
    if (this.errorLine !== null) this.lineEls[this.errorLine - 1]?.removeAttribute("data-error");
    this.errorLine = line;
    if (line === null) return;
    const el = this.lineEls[line - 1];
    if (!el) return;
    el.dataset.error = "true";
  }

  revealLine(line: number) {
    const el = this.lineEls[line - 1];
    if (!el) return;
    this.programmaticUntil = performance.now() + 900;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  setFollowing(on: boolean) {
    this.following = on;
    this.o.followChip.hidden = on;
    if (on) this.lastAutoScroll = 0;
  }

  /** Apply pending ranges/flashes. Call once per animation frame. */
  frame(now: number) {
    if (!this.enabled) {
      this.pendingFlashes.clear();
      return;
    }
    const hasFlashes = this.pendingFlashes.size > 0;
    const hasTransients = this.boxes.size > this.ranges.length;
    if (!this.rangesDirty && !hasFlashes && !hasTransients) return;

    // ── reads ───────────────────────────────────────────────────────────────
    const wanted: { k: number; rect: Rect; color: string }[] = [];
    let origin: DOMRect | null = null;
    const measure = (start: number, end: number): Rect | null => {
      const k = key(start, end);
      let rect = this.rectCache.get(k);
      if (rect === undefined) {
        origin ??= this.o.content.getBoundingClientRect();
        rect = this.measure(start, end, origin);
        this.rectCache.set(k, rect);
      }
      return rect;
    };
    if (this.rangesDirty) {
      for (const [start, end] of this.ranges) {
        const rect = measure(start, end);
        if (rect) wanted.push({ k: key(start, end), rect, color: this.colorFor(start, end) ?? "" });
      }
    }
    const flashes: { k: number; rect: Rect; color: string }[] = [];
    for (const [k, color] of this.pendingFlashes) {
      const rect = measure(Math.floor(k / PACK), k % PACK);
      if (rect) flashes.push({ k, rect, color });
    }
    this.pendingFlashes.clear();
    const scrollTop = this.rangesDirty && this.following ? this.o.scroller.scrollTop : 0;

    // ── writes ──────────────────────────────────────────────────────────────
    if (this.rangesDirty) {
      const keep = new Set<number>();
      for (const w of wanted) {
        keep.add(w.k);
        const box = this.boxes.get(w.k) ?? this.createBox(w.k, w.rect);
        box.lit = true;
        box.transientUntil = 0;
        box.fade?.cancel();
        box.fade = undefined;
        if (w.color && box.color !== w.color) {
          box.color = w.color;
          box.el.style.setProperty("--c", w.color);
        }
      }
      for (const [k, box] of this.boxes) {
        if (keep.has(k)) continue;
        box.lit = false;
        if (box.transientUntil < now) this.removeBox(k);
      }
      this.rangesDirty = false;
      if (this.following && wanted.length) this.autoScroll(wanted, scrollTop, now);
    }

    for (const f of flashes) {
      let box = this.boxes.get(f.k);
      if (!box) {
        box = this.createBox(f.k, f.rect);
        box.lit = false;
      }
      if (!box.lit) box.transientUntil = now + 260;
      if (f.color && box.color !== f.color) {
        box.color = f.color;
        box.el.style.setProperty("--c", f.color);
      }
      box.flash.animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: 240, easing: "ease-out" });
      if (!box.lit) {
        box.fade?.cancel();
        box.fade = box.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: "ease-in", fill: "forwards" });
      }
    }

    // drop transient boxes whose flash is over
    for (const [k, box] of this.boxes) {
      if (!box.lit && box.transientUntil && box.transientUntil < now) this.removeBox(k);
    }
  }

  /** Offset → 1-based line/column (UTF-16 columns, like VS Code) */
  lineColumnAt(offset: number): { line: number; column: number } {
    const o = Math.max(0, Math.min(this.text.length, offset));
    let line = 1;
    for (let i = this.text.indexOf("\n"); i >= 0 && i < o; i = this.text.indexOf("\n", i + 1)) line++;
    return { line, column: o - (this.text.lastIndexOf("\n", o - 1) + 1) + 1 };
  }

  // ───────────────────────────────────────────────────────────────────────────

  private pick(e: MouseEvent) {
    if (!this.o.onPick || e.button !== 0) return;
    if ((e.target as Element | null)?.closest?.(".knob-chip")) return; // knob chips focus the knob instead
    const selection = getSelection();
    if (selection && !selection.isCollapsed && selection.toString()) return; // selecting text
    const lineEl = (e.target as Element | null)?.closest?.<HTMLElement>(".ln");
    if (!lineEl) return;
    const lineNo = Number(lineEl.dataset.line);
    // the character under the pointer, else the start of the clicked line
    let offset = -1;
    const doc = document as Document & {
      caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
    };
    const caret = doc.caretPositionFromPoint?.(e.clientX, e.clientY);
    const range = caret ? null : document.caretRangeFromPoint?.(e.clientX, e.clientY);
    const node = caret?.offsetNode ?? range?.startContainer;
    const at = caret?.offset ?? range?.startOffset ?? 0;
    const i = node instanceof Text && lineEl.contains(node) ? this.nodes.indexOf(node) : -1;
    if (i >= 0) offset = this.nodeStarts[i] + at;
    else {
      offset = 0;
      for (let n = 1; n < lineNo && offset >= 0; n++) offset = this.text.indexOf("\n", offset) + 1;
      if (offset < 0) return;
    }
    this.o.onPick({ offset, ...this.lineColumnAt(offset) });
  }

  private render() {
    const text = this.text;
    const tokens = tokenize(text);
    const linesEl = this.o.lines;
    const frag = document.createDocumentFragment();
    this.nodeStarts = [];
    this.nodes = [];
    this.lineEls = [];
    this.chips = new Map();
    // knob chips go right after each call's closing paren
    const inlays = findKnobCalls(text, tokens).sort((a, b) => a.end - b.end);
    let nextInlay = 0;

    let lineNo = 0;
    let line!: HTMLElement;
    let lt!: HTMLElement;
    const newLine = () => {
      lineNo++;
      line = document.createElement("div");
      line.className = "ln";
      line.dataset.line = String(lineNo);
      line.dataset.testid = "code-line";
      lt = document.createElement("span");
      lt.className = "lt";
      line.append(lt);
      frag.append(line);
      this.lineEls.push(line);
    };
    newLine();

    const addChip = (call: KnobCall) => {
      const chip = document.createElement("span");
      chip.className = "knob-chip";
      chip.dataset.knob = call.name;
      chip.dataset.testid = "knob-chip";
      chip.setAttribute("aria-hidden", "true");
      chip.title = `${call.name}: click to focus the knob`;
      lt.append(chip);
      const list = this.chips.get(call.name) ?? [];
      list.push(chip);
      this.chips.set(call.name, list);
    };
    const addPiece = (kind: TokenKind, start: number, piece: string) => {
      // split the piece at chip positions
      while (nextInlay < inlays.length && inlays[nextInlay].end <= start) nextInlay++;
      const at = inlays[nextInlay]?.end;
      if (at !== undefined && at > start && at <= start + piece.length) {
        addText(kind, start, piece.slice(0, at - start));
        addChip(inlays[nextInlay++]);
        if (at < start + piece.length) addPiece(kind, at, piece.slice(at - start));
        return;
      }
      addText(kind, start, piece);
    };
    const addText = (kind: TokenKind, start: number, piece: string) => {
      const visible = piece.endsWith("\r") ? piece.slice(0, -1) : piece;
      if (!visible) return;
      const node = document.createTextNode(visible);
      this.nodeStarts.push(start);
      this.nodes.push(node);
      if (kind) {
        const span = document.createElement("span");
        span.className = `t-${kind}`;
        span.append(node);
        lt.append(span);
      } else {
        lt.append(node);
      }
    };

    for (const token of tokens) {
      let start = token.start;
      while (start < token.end) {
        const nl = text.indexOf("\n", start);
        if (nl < 0 || nl >= token.end) {
          addPiece(token.kind, start, text.slice(start, token.end));
          break;
        }
        addPiece(token.kind, start, text.slice(start, nl));
        newLine();
        start = nl + 1;
      }
    }
    // a trailing newline doesn't make an extra visible line
    if (text.endsWith("\n") && this.lineEls.length > 1) {
      frag.removeChild(this.lineEls.pop()!);
    }
    linesEl.replaceChildren(frag);
    this.invalidate();
  }

  /** The text node containing offset `at` (or ending at it, when `isEnd`) */
  private locate(at: number, isEnd: boolean): [Text, number] | null {
    const starts = this.nodeStarts;
    let lo = 0;
    let hi = starts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (isEnd ? starts[mid] < at : starts[mid] <= at) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0) return null;
    const node = this.nodes[found];
    return [node, Math.min(node.length, Math.max(0, at - starts[found]))];
  }

  private measure(start: number, end: number, origin: DOMRect): Rect | null {
    if (end <= start || end > this.text.length) return null;
    const a = this.locate(start, false);
    const b = this.locate(end, true);
    if (!a || !b) return null;
    const range = document.createRange();
    range.setStart(a[0], a[1]);
    range.setEnd(b[0], b[1]);
    const rects = range.getClientRects();
    if (!rects.length) return null;
    const r = rects[0];
    if (!r.width && !r.height) return null;
    return { x: r.left - origin.left - 1, y: r.top - origin.top, w: r.width + 2, h: r.height };
  }

  private createBox(k: number, rect: Rect): Box {
    const el = document.createElement("div");
    el.className = "hl";
    el.dataset.testid = "code-highlight";
    el.dataset.range = `${Math.floor(k / PACK)}-${k % PACK}`;
    const flash = document.createElement("div");
    flash.className = "hl-flash";
    el.append(flash);
    el.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
    el.style.width = `${rect.w}px`;
    el.style.height = `${rect.h}px`;
    this.o.overlay.append(el);
    const box: Box = { el, flash, color: "", lit: true, transientUntil: 0 };
    this.boxes.set(k, box);
    return box;
  }

  private removeBox(k: number) {
    this.boxes.get(k)?.el.remove();
    this.boxes.delete(k);
  }

  private clearBoxes() {
    for (const box of this.boxes.values()) box.el.remove();
    this.boxes.clear();
  }

  /** Text/width/font changed: re-measure everything on the next frame */
  private invalidate() {
    this.rectCache.clear();
    this.clearBoxes();
    this.rangesDirty = true;
  }

  /**
   * Keep the busiest part of the code in view: find the viewport-sized window
   * with the most lit tokens and glide there when most of them are off-screen.
   * Rate-limited, so the code doesn't twitch with every hit.
   */
  private autoScroll(lit: { rect: Rect }[], scrollTop: number, now: number) {
    if (now - this.lastAutoScroll < 1200) return;
    const h = this.viewportH || this.o.scroller.clientHeight;
    if (!h) return;
    const ys = lit.map((l) => l.rect.y + l.rect.h / 2).sort((a, b) => a - b);
    const span = h * 0.7;
    let best = 0;
    let bestI = 0;
    let bestJ = 0;
    for (let i = 0, j = 0; i < ys.length; i++) {
      while (j < ys.length && ys[j] - ys[i] <= span) j++;
      if (j - i > best) {
        best = j - i;
        bestI = i;
        bestJ = j - 1;
      }
    }
    const margin = h * 0.08;
    const inView = ys.filter((y) => y >= scrollTop + margin && y <= scrollTop + h - margin).length;
    if (inView >= best * 0.75) return;
    const target = Math.max(0, (ys[bestI] + ys[bestJ]) / 2 - h / 2);
    this.lastAutoScroll = now;
    this.programmaticUntil = now + 900;
    this.o.scroller.scrollTo({ top: target, behavior: "smooth" });
  }
}
