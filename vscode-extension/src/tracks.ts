// Where is each track defined? (pure, no vscode)
//
// A song's tracks are the keys of the object createPattern() returns:
//
//   createPattern() {
//     const kick = s("bd*4");                ← `kick` is defined here
//     return { kick, hats: s("hh*8") };      ← `hats` right here, as a property
//   }
//
// findTracks() maps each key to its definition: for a shorthand (`kick`) or an
// identifier value (`drums: kick`) the `const`/`let` statement that declares it
// (inside createPattern, else at the top level), otherwise the property itself
// (`kick: track({...})`). A small JS/TS scanner, not a parser: it skips strings,
// template literals, comments and regex literals and tracks bracket depth,
// which is all this needs.

export interface TrackDef {
  name: string;
  /** [start, end) offsets of the definition (the whole statement or property) */
  start: number;
  end: number;
  kind: "declaration" | "property";
}

export interface SongTracks {
  tracks: TrackDef[];
  /** Offset of the `return` statement that returns the tracks */
  returnAt: number | null;
}

interface Tok {
  /** "id" | "str" | "num" | "punct" */
  t: "id" | "str" | "num" | "punct";
  v: string;
  start: number;
  end: number;
  /** bracket depth before this token */
  depth: number;
  /** first token on its line */
  nl: boolean;
}

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);
const REGEX_AFTER_KEYWORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await"]);

/** Tokenize, skipping comments, strings (as one token), templates and regexes. */
export function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let depth = 0;
  let nl = true;
  let i = 0;
  const n = text.length;

  const skipString = (q: string, from: number): number => {
    let j = from + 1;
    while (j < n && text[j] !== q) {
      if (text[j] === "\\") j++;
      else if (text[j] === "\n" && q !== "`") return j; // unterminated
      j++;
    }
    return Math.min(n, j + 1);
  };
  // `…${ code }…`: code may hold strings, templates and braces of its own
  const skipTemplate = (from: number): number => {
    let j = from + 1;
    while (j < n && text[j] !== "`") {
      if (text[j] === "\\") j += 2;
      else if (text[j] === "$" && text[j + 1] === "{") {
        j += 2;
        let d = 1;
        while (j < n && d > 0) {
          const c = text[j];
          if (c === "{") d++;
          else if (c === "}") d--;
          else if (c === "'" || c === '"') {
            j = skipString(c, j);
            continue;
          } else if (c === "`") {
            j = skipTemplate(j);
            continue;
          } else if (c === "/" && text[j + 1] === "/") {
            while (j < n && text[j] !== "\n") j++;
            continue;
          } else if (c === "/" && text[j + 1] === "*") {
            const e = text.indexOf("*/", j + 2);
            j = e < 0 ? n : e + 2;
            continue;
          }
          j++;
        }
      } else j++;
    }
    return Math.min(n, j + 1);
  };
  const regexAllowed = () => {
    const prev = out[out.length - 1];
    if (!prev) return true;
    if (prev.t === "id") return REGEX_AFTER_KEYWORD.has(prev.v);
    if (prev.t === "punct") return !(prev.v === ")" || prev.v === "]" || prev.v === "}");
    return false;
  };

  while (i < n) {
    const c = text[i];
    if (c === "\n") {
      nl = true;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      if (text.slice(i, end).includes("\n")) nl = true;
      i = end;
      continue;
    }
    const start = i;
    let t: Tok["t"];
    if (c === "'" || c === '"') {
      i = skipString(c, i);
      t = "str";
    } else if (c === "`") {
      i = skipTemplate(i);
      t = "str";
    } else if (c === "/" && regexAllowed()) {
      let j = i + 1;
      let cls = false;
      while (j < n && text[j] !== "\n") {
        if (text[j] === "\\") j++;
        else if (text[j] === "[") cls = true;
        else if (text[j] === "]") cls = false;
        else if (text[j] === "/" && !cls) break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(text[j])) j++;
      i = j;
      t = "str";
    } else if (/[A-Za-z_$ -￿]/.test(c)) {
      while (i < n && /[\w$ -￿]/.test(text[i])) i++;
      t = "id";
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      while (i < n && /[\w.]/.test(text[i])) i++;
      t = "num";
    } else if (text.startsWith("...", i)) {
      i += 3;
      t = "punct";
    } else if (text.startsWith("=>", i)) {
      i += 2;
      t = "punct";
    } else {
      i++;
      t = "punct";
    }
    const v = text.slice(start, i);
    if (t === "punct" && CLOSE.has(v)) depth = Math.max(0, depth - 1);
    out.push({ t, v, start, end: i, depth, nl });
    nl = false;
    if (t === "punct" && OPEN.has(v)) depth++;
  }
  return out;
}

/** Index of the token closing the bracket opened at `open` (or the last token). */
function matching(toks: Tok[], open: number): number {
  const d = toks[open].depth;
  for (let j = open + 1; j < toks.length; j++) {
    if (toks[j].depth === d && CLOSE.has(toks[j].v) && toks[j].t === "punct") return j;
  }
  return toks.length - 1;
}

/** The createPattern body: indices of its `{` and `}` */
function createPatternBody(toks: Tok[]): [number, number] | null {
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].t !== "id" || toks[i].v !== "createPattern") continue;
    // createPattern(…) {   ·   createPattern: (…) => {   ·   createPattern: function (…) {
    let j = i + 1;
    while (j < toks.length && toks[j].v !== "(" && j - i < 4) j++;
    if (toks[j]?.v !== "(") continue;
    j = matching(toks, j) + 1;
    // skip a return type / arrow up to the body's `{` (at the same depth)
    const d = toks[i].depth;
    while (j < toks.length && !(toks[j].v === "{" && toks[j].depth === d)) {
      if (toks[j].depth < d || toks[j].v === ";") break;
      j++;
    }
    if (toks[j]?.v !== "{") continue;
    return [j, matching(toks, j)];
  }
  return null;
}

/** Statement end for a declaration starting at token `k` (inclusive index of its last token). */
function statementEnd(toks: Tok[], k: number, limit: number): number {
  const d = toks[k].depth;
  let last = k;
  for (let j = k + 1; j <= limit && j < toks.length; j++) {
    const tok = toks[j];
    if (tok.depth < d) break; // the enclosing block closes
    if (tok.depth === d) {
      if (tok.v === ";") return j;
      // ASI: a new statement starts on a new line
      if (tok.nl && tok.t === "id" && /^(const|let|var|return|function|export|if|for|while|class|type|interface|import)$/.test(tok.v))
        break;
    }
    last = j;
  }
  return last;
}

/** `const|let|var name` declared directly in [from, to] at depth `depth` */
function findDeclaration(toks: Tok[], name: string, from: number, to: number, depth: number): [number, number] | null {
  for (let j = from; j <= to && j < toks.length - 1; j++) {
    const tok = toks[j];
    if (tok.depth !== depth || tok.t !== "id" || !/^(const|let|var)$/.test(tok.v)) continue;
    if (toks[j + 1].v !== name) continue;
    const after = toks[j + 2]?.v;
    if (after !== "=" && after !== ":") continue;
    return [j, statementEnd(toks, j, to)];
  }
  return null;
}

export function findTracks(text: string): SongTracks {
  const toks = tokenize(text);
  const body = createPatternBody(toks);
  if (!body) return { tracks: [], returnAt: null };
  const [open, close] = body;
  const inner = toks[open].depth + 1;

  // the last `return {…}` / `return wrap({…})` (or `return name` of a `const name = {…}`) directly in the body
  let objOpen = -1;
  let returnAt: number | null = null;
  for (let j = open + 1; j < close; j++) {
    const tok = toks[j];
    if (tok.depth !== inner || tok.t !== "id" || tok.v !== "return") continue;
    let k = j + 1;
    while (toks[k]?.v === "(" && k < close) k++;
    // a wrapper call around the record, e.g. `return mixdown({ kick, … })`
    while (toks[k]?.t === "id" && toks[k + 1]?.v === "(" && toks[k + 2]?.v !== ")" && k < close) {
      k += 2;
      while (toks[k]?.v === "(" && k < close) k++;
    }
    if (toks[k]?.v === "{") {
      objOpen = k;
      returnAt = tok.start;
    } else if (toks[k]?.t === "id") {
      const decl = findDeclaration(toks, toks[k].v, open + 1, close - 1, inner);
      const eq = decl ? toks.findIndex((x, idx) => idx > decl[0] && idx <= decl[1] && x.v === "=") : -1;
      if (eq > 0 && toks[eq + 1]?.v === "{") {
        objOpen = eq + 1;
        returnAt = tok.start;
      }
    }
  }
  if (objOpen < 0) return { tracks: [], returnAt: null };
  const objClose = matching(toks, objOpen);
  const d = toks[objOpen].depth + 1;

  // entries: split on commas at the object's own depth
  const entries: [number, number][] = [];
  let s = objOpen + 1;
  for (let j = objOpen + 1; j <= objClose; j++) {
    if (j === objClose || (toks[j].depth === d && toks[j].v === ",")) {
      if (j > s) entries.push([s, j - 1]);
      s = j + 1;
    }
  }

  const resolve = (name: string): [number, number] | null =>
    findDeclaration(toks, name, open + 1, close - 1, inner) ?? findDeclaration(toks, name, 0, toks.length - 1, 0);

  const tracks: TrackDef[] = [];
  const seen = new Set<string>();
  for (const [a, b] of entries) {
    const first = toks[a];
    if (first.v === "..." || first.v === "[") continue; // spread / computed key
    if (first.t !== "id" && first.t !== "str") continue;
    const name = first.t === "str" ? first.v.slice(1, -1) : first.v;
    let def: [number, number] | null = null;
    let kind: TrackDef["kind"] = "property";
    if (a === b && first.t === "id") {
      def = resolve(name); // shorthand
      if (def) kind = "declaration";
    } else if (toks[a + 1]?.v === ":" && b === a + 2 && toks[b].t === "id") {
      def = resolve(toks[b].v); // name: someVariable
      if (def) kind = "declaration";
    }
    const [from, to] = def ?? [a, b];
    if (seen.has(name)) continue;
    seen.add(name);
    tracks.push({ name, start: toks[from].start, end: toks[to].end, kind });
  }
  return { tracks, returnAt };
}

/** Is `track` heard with this mix? (solo wins over mute, like the player's Mix) */
export function isAudible(track: string, muted: readonly string[] = [], soloed: readonly string[] = []): boolean {
  return soloed.length ? soloed.includes(track) : !muted.includes(track);
}
