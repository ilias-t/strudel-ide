// ═══════════════════════════════════════════════════════════════════════════
// Fuzzy matching for the ⌘K palette (pure, no dependencies)
// ═══════════════════════════════════════════════════════════════════════════
//
// A subsequence scorer in the spirit of fzf's: every query character must
// appear in the text, in order, case-insensitively (spaces in the query are
// skipped, so "jump b" finds "jump to section b"). Among all the ways the
// query fits, the best-scoring one wins (a small dynamic programme, not the
// first greedy fit), and its indices are returned for highlighting.
//
//   each matched character       +16
//   at a word start              +8  (start of text, after a space _ - . ( / :)
//   at a hump                    +7  (camelCase, a letter↔digit change: TR|909)
//   the query's first character  its word-start bonus counts twice (prefixes win)
//   in a consecutive run         at least +4, and the run keeps its start's bonus
//   a gap between matches        −3, then −1 per extra character skipped
//   the whole text, exactly      +32
//
// rank() scores a list against a query and sorts: score, then the item's
// weight (the palette puts actions and songs first on ties), then the shorter
// name, then input order. An item is scored on its best field:
//
//   name          fuzzy, as above
//   alts          fuzzy, −4      synonyms, bank aliases, an intent's phrases
//   phrases       fuzzy, −6      what an intent says about a function ("wetter" → room)
//   words         −48            description words (a summary), never fuzzy: each
//                                query word must be a whole word or a word's start
//
// A fuzzy fit broken into more stretches than the query has words loses 12 per
// extra stretch, so "reverb" scattered over "Crash every 4 bars" can't beat a
// real word. ~1100 items per keystroke is well under a millisecond or two.

export interface Match {
  score: number;
  /** Indices into the text of the matched characters, ascending */
  indices: number[];
}

const MATCH = 16;
const BOUNDARY = 8;
const HUMP = 7;
const CONSECUTIVE = 4;
const GAP_START = -3;
const GAP_EXTEND = -1;
const EXACT = 32;
/** An alternative name's match counts for a little less than the same match on the name */
const ALT_PENALTY = 4;
/** A phrase (an intent's way of describing what a function does) a little less again */
const PHRASE_PENALTY = 6;
/** A description word counts for much less: names, synonyms and phrases come first */
const WORDS_PENALTY = 48;
/** Each stretch a fuzzy fit is broken into beyond one per query word */
const SCATTER = 12;
/** Description words only answer a query at least this long, and only words of 2+ letters in it */
const WORDS_MIN = 3;

const NONE = -Infinity;

const isLower = (c: string) => c !== c.toUpperCase() && c === c.toLowerCase();
const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();
const isDigit = (c: string) => c >= "0" && c <= "9";
const isLetter = (c: string) => c.toLowerCase() !== c.toUpperCase();
const isWord = (c: string) => isLetter(c) || isDigit(c);

/** How much matching text[j] is worth on top of MATCH */
function bonusAt(text: string, j: number): number {
  const c = text[j];
  if (!isWord(c)) return 0;
  if (j === 0) return BOUNDARY;
  const p = text[j - 1];
  if (!isWord(p)) return BOUNDARY;
  if (isLower(p) && isUpper(c)) return HUMP;
  if ((isLetter(p) && isDigit(c)) || (isDigit(p) && isLetter(c))) return HUMP;
  return 0;
}

const normalizeQuery = (query: string) => query.replace(/\s+/g, "").toLowerCase();

// scratch rows, grown as needed (one match runs at a time)
let score = new Float64Array(0);
let run = new Float64Array(0);
let from = new Int32Array(0);

function scratch(size: number) {
  if (score.length >= size) return;
  score = new Float64Array(size * 2);
  run = new Float64Array(size * 2);
  from = new Int32Array(size * 2);
}

/** `q` is already normalized (lower case, no spaces) */
function matchNormalized(q: string, text: string): Match | null {
  const m = q.length;
  if (m === 0) return { score: 0, indices: [] };
  const n = text.length;
  if (m > n) return null;
  const lower = text.toLowerCase();
  // quick reject: is it a subsequence at all?
  for (let i = 0, j = 0; i < m; i++, j++) {
    j = lower.indexOf(q[i], j);
    if (j < 0) return null;
  }
  // toLowerCase() can change the length (e.g. "İ"): fall back to a plain fit
  if (lower.length !== n) return greedy(q, lower);

  const bonus = new Array<number>(n);
  for (let j = 0; j < n; j++) bonus[j] = bonusAt(text, j);

  scratch(m * n);
  // row i, column j: the best score with q[i] matched at text[j] (NONE if it can't be)
  for (let j = 0; j < n; j++) {
    const hit = lower[j] === q[0];
    score[j] = hit ? MATCH + bonus[j] * 2 : NONE;
    run[j] = hit ? bonus[j] : 0;
    from[j] = -1;
  }
  for (let i = 1; i < m; i++) {
    const row = i * n;
    const prev = row - n;
    let gapBest = NONE; // best score of q[i-1] at some k < j-1, gap penalty included
    let gapFrom = -1;
    for (let j = 0; j < n; j++) {
      if (j >= 2) {
        const extended = gapBest + GAP_EXTEND;
        const opened = score[prev + j - 2] + GAP_START;
        if (opened >= extended) {
          gapBest = opened;
          gapFrom = j - 2;
        } else gapBest = extended;
      }
      score[row + j] = NONE;
      run[row + j] = 0;
      from[row + j] = -1;
      if (j < i || lower[j] !== q[i]) continue;
      let best = NONE;
      if (j >= 1 && score[prev + j - 1] > NONE) {
        const r = run[prev + j - 1];
        best = score[prev + j - 1] + MATCH + Math.max(bonus[j], r, CONSECUTIVE);
        run[row + j] = Math.max(r, bonus[j]);
        from[row + j] = j - 1;
      }
      if (gapBest > NONE) {
        const gapped = gapBest + MATCH + bonus[j];
        if (gapped > best) {
          best = gapped;
          run[row + j] = bonus[j];
          from[row + j] = gapFrom;
        }
      }
      score[row + j] = best;
    }
  }

  const last = (m - 1) * n;
  let end = -1;
  for (let j = m - 1; j < n; j++) if (score[last + j] > NONE && (end < 0 || score[last + j] > score[last + end])) end = j;
  if (end < 0) return null;
  const indices = new Array<number>(m);
  for (let i = m - 1, j = end; i >= 0; i--) {
    indices[i] = j;
    j = from[i * n + j];
  }
  let total = score[last + end];
  if (m === n) total += EXACT;
  return { score: total, indices };
}

/** The first fit, scored plainly (only for texts whose case mapping changes length) */
function greedy(q: string, lower: string): Match {
  const indices: number[] = [];
  for (let i = 0, j = 0; i < q.length; i++, j++) {
    j = lower.indexOf(q[i], j);
    indices.push(j);
  }
  return { score: q.length * MATCH, indices };
}

/** Match `query` against `text`: null when it doesn't fit */
export function fuzzyMatch(query: string, text: string): Match | null {
  return matchNormalized(normalizeQuery(query), text);
}

export interface Candidate {
  /** What's shown and highlighted */
  name: string;
  /** Other names that find it too (synonyms, aliases) */
  alts?: string[];
  /** Ways of describing it that find it a little lower (an intent's phrases on a function) */
  phrases?: string[];
  /** Description words, lowercased (wordsOf(summary)): found by whole word or a word's start, well below names */
  words?: string[];
  /** Lower ranks first among equal scores (default 0) */
  weight?: number;
}

/** Which of a candidate's fields matched */
export type MatchField = "name" | "alt" | "phrase" | "words";

export interface Ranked<T> {
  item: T;
  score: number;
  /** Indices into item.name (empty when only another field matched) */
  indices: number[];
  /** The alternative name or phrase that matched, if it wasn't the name */
  via?: string;
  /** Where the best match was (absent for an empty query) */
  field?: MatchField;
}

export interface RankOptions {
  /** At most this many results (default 80) */
  limit?: number;
}

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

/** A text's words, lowercased, for Candidate.words */
export function wordsOf(text: string): string[] {
  return text.toLowerCase().split(WORD_SPLIT).filter(Boolean);
}

/** How many stretches of consecutive characters a fit is broken into */
function stretches(indices: number[]): number {
  let n = indices.length ? 1 : 0;
  for (let i = 1; i < indices.length; i++) if (indices[i] !== indices[i - 1] + 1) n++;
  return n;
}

/** A fuzzy match, less SCATTER for each stretch beyond one per query word */
function fit(q: string, words: number, text: string): Match | null {
  const m = matchNormalized(q, text);
  if (!m) return null;
  const extra = stretches(m.indices) - Math.max(1, words);
  return extra > 0 ? { score: m.score - extra * SCATTER, indices: m.indices } : m;
}

/** Each term must start one of `words`: the sum of the best such matches, or null */
function wordsScore(terms: string[], words: readonly string[]): number | null {
  let total = 0;
  for (const t of terms) {
    let best = NONE;
    for (const w of words) {
      if (!w.startsWith(t)) continue;
      const m = matchNormalized(t, w);
      if (m && m.score > best) best = m.score;
    }
    if (best === NONE) return null;
    total += best;
  }
  return total;
}

/** The items that match `query`, best first (input order, capped, for an empty query) */
export function rank<T extends Candidate>(items: readonly T[], query: string, { limit = 80 }: RankOptions = {}): Ranked<T>[] {
  const q = normalizeQuery(query);
  if (!q) return items.slice(0, limit).map((item) => ({ item, score: 0, indices: [] }));
  const queryWords = query.trim().split(/\s+/).length;
  const terms = q.length >= WORDS_MIN ? wordsOf(query).filter((t) => t.length >= 2) : [];
  const found: { r: Ranked<T>; order: number }[] = [];
  items.forEach((item, order) => {
    let best: Ranked<T> | null = null;
    const m = fit(q, queryWords, item.name);
    if (m) best = { item, score: m.score, indices: m.indices, field: "name" };
    const other = (texts: string[] | undefined, penalty: number, field: MatchField) => {
      for (const text of texts ?? []) {
        const a = fit(q, queryWords, text);
        // the name's highlight stays when the name fits too
        if (a && (!best || a.score - penalty > best.score))
          best = { item, score: a.score - penalty, indices: m?.indices ?? [], via: text, field };
      }
    };
    other(item.alts, ALT_PENALTY, "alt");
    other(item.phrases, PHRASE_PENALTY, "phrase");
    if (terms.length && item.words?.length) {
      const w = wordsScore(terms, item.words);
      if (w !== null && (!best || w - WORDS_PENALTY > best.score))
        best = { item, score: w - WORDS_PENALTY, indices: m?.indices ?? [], field: "words" };
    }
    if (best) found.push({ r: best, order });
  });
  found.sort(
    (a, b) =>
      b.r.score - a.r.score ||
      (a.r.item.weight ?? 0) - (b.r.item.weight ?? 0) ||
      a.r.item.name.length - b.r.item.name.length ||
      a.order - b.order
  );
  return found.slice(0, limit).map((f) => f.r);
}
