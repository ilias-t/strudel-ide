// ═══════════════════════════════════════════════════════════════════════════
// Seven-segment digits for the clock unit's tempo and bar readouts
// ═══════════════════════════════════════════════════════════════════════════
//
// Unlit segments stay faintly visible (ghost segments), like a real LCD. A
// "." lights a decimal point under the previous digit. Each digit is a group
// of seven paths built once; updates only flip fills.

const SVG_NS = "http://www.w3.org/2000/svg";

/** Lit segments per character */
const DIGITS: Record<string, string> = {
  "0": "abcdef",
  "1": "bc",
  "2": "abged",
  "3": "abgcd",
  "4": "fgbc",
  "5": "afgcd",
  "6": "afgedc",
  "7": "abc",
  "8": "abcdefg",
  "9": "abfgcd",
  "-": "g",
  " ": "",
};

/** One digit in a 14×24 cell */
const SEGMENTS: Record<string, string> = {
  a: "M3 1h8l-1.5 2h-5z",
  b: "M11.6 1.6l.4 9.4-1.6 1-1-1.5.4-7z",
  c: "M12 13l-.4 9.4-2-1.8-.4-7 1-1.5z",
  d: "M3 23h8l-1.5-2h-5z",
  e: "M2.4 22.4l-.4-9.4 1.6-1 1 1.5-.4 7z",
  f: "M2 1.6l.4 9.4 1.6-1 1-1.5-.4-6.2z",
  g: "M3.5 12l1.5-1h4l1.5 1-1.5 1h-4z",
};

const ON = "var(--px)";
const OFF = "#17171a";
const PITCH = 15;

export class SegmentDisplay {
  private svg: SVGSVGElement;
  private digits: { paths: Map<string, SVGPathElement>; dot: SVGCircleElement }[] = [];
  private shown = "";

  /** `width`: digit cells (text is right-aligned in them) */
  constructor(host: HTMLElement, private width: number) {
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("viewBox", `-1 0 ${width * PITCH + 1} 24`);
    for (let i = 0; i < width; i++) {
      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("transform", `translate(${i * PITCH} 0) skewX(-6)`);
      const paths = new Map<string, SVGPathElement>();
      for (const [name, d] of Object.entries(SEGMENTS)) {
        const p = document.createElementNS(SVG_NS, "path");
        p.setAttribute("d", d);
        p.setAttribute("fill", OFF);
        g.append(p);
        paths.set(name, p);
      }
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("cx", "14.4");
      dot.setAttribute("cy", "22.4");
      dot.setAttribute("r", "1.25");
      dot.setAttribute("fill", "transparent");
      g.append(dot);
      this.svg.append(g);
      this.digits.push({ paths, dot });
    }
    host.replaceChildren(this.svg);
  }

  /** Show `text`: digits, spaces, "-" and "." (a point after a digit) */
  set(text: string) {
    if (text === this.shown) return;
    this.shown = text;
    const cells: { ch: string; dot: boolean }[] = [];
    for (const ch of text) {
      if (ch === "." && cells.length) cells[cells.length - 1].dot = true;
      else cells.push({ ch, dot: false });
    }
    const pad = Math.max(0, this.width - cells.length);
    this.digits.forEach((digit, i) => {
      const cell = cells[i - pad] ?? { ch: " ", dot: false };
      const lit = DIGITS[cell.ch] ?? "";
      for (const [name, p] of digit.paths) {
        const fill = lit.includes(name) ? ON : OFF;
        if (p.getAttribute("fill") !== fill) p.setAttribute("fill", fill);
      }
      digit.dot.setAttribute("fill", cell.dot ? ON : "transparent");
    });
  }
}
