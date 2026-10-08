// Keep highlight offsets valid while you type (pure, no vscode).
//
// The player's highlights and onsets index into one version of a song's text
// (the saved file or an evaluated buffer; `version` = contentVersion(text)).
// While you edit, the document moves on, but most tokens only shift: a range
// can be carried across each edit since that version, and is dropped only
// when the edit touches it. So highlights keep playing on the code you're not
// changing, and the next live eval catches up with the rest.

export interface TextChange {
  /** Offset of the replaced range in the text before the change event */
  offset: number;
  /** Length of the replaced range */
  length: number;
  /** Length of the inserted text */
  inserted: number;
}

interface Base {
  version: string;
  /** change events since `version` (each against the text before it) */
  events: TextChange[][];
}

/** Map [start, end) through one change event; null when an edit touches it */
export function mapRange(range: readonly [number, number], changes: readonly TextChange[]): [number, number] | null {
  const [a, b] = range;
  let delta = 0;
  for (const c of changes) {
    const end = c.offset + c.length;
    if (c.offset <= b && end >= a) return null; // inside, overlapping or right next to the token
    if (end < a) delta += c.inserted - c.length;
  }
  return [a + delta, b + delta];
}

/**
 * Per-document history: the text versions the player may refer to ("bases")
 * and the change events since each. Bounded: a few bases, a few hundred events.
 */
export class EditHistory {
  private bases: Base[] = [];
  private readonly maxBases: number;
  private readonly maxEvents: number;

  constructor(maxBases = 4, maxEvents = 400) {
    this.maxBases = maxBases;
    this.maxEvents = maxEvents;
  }

  /** The document's text is `version` right now (sent for eval, saved, or just matched) */
  mark(version: string): void {
    const newest = this.bases.at(-1);
    if (newest?.version === version && newest.events.length === 0) return;
    this.bases = this.bases.filter((b) => b.version !== version);
    this.bases.push({ version, events: [] });
    if (this.bases.length > this.maxBases) this.bases.shift();
  }

  /** One change event of the document (changes against the text before it) */
  record(changes: readonly TextChange[]): void {
    if (!changes.length) return;
    const event = changes.map((c) => ({ ...c }));
    for (const base of this.bases) base.events.push(event);
    this.bases = this.bases.filter((b) => b.events.length <= this.maxEvents);
  }

  /** Does `version` describe the text right now (no edits since)? */
  isCurrent(version: string): boolean {
    const base = this.bases.find((b) => b.version === version);
    return !!base && base.events.length === 0;
  }

  knows(version: string): boolean {
    return this.bases.some((b) => b.version === version);
  }

  /**
   * Ranges given against `version`, carried onto the current text (ranges an
   * edit touched are dropped). null when `version` is unknown.
   */
  map(version: string, ranges: readonly (readonly [number, number])[]): [number, number][] | null {
    const base = this.bases.find((b) => b.version === version);
    if (!base) return null;
    const out: [number, number][] = [];
    for (const r of ranges) {
      if (!Array.isArray(r) || typeof r[0] !== "number" || typeof r[1] !== "number") continue;
      let cur: [number, number] | null = [r[0], r[1]];
      for (const event of base.events) {
        cur = mapRange(cur, event);
        if (!cur) break;
      }
      if (cur) out.push(cur);
    }
    return out;
  }
}
