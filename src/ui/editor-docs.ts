// ════════════════════════════════════════════════════════════════════════════
// Strudel JSDoc → Monaco-friendly docs
// ════════════════════════════════════════════════════════════════════════════
//
// Monaco's TypeScript hovers and completion details render JSDoc tags as
// `*@tag* — text`, which flattens an `@example` into one run-on paragraph. So
// before the Strudel declaration files go to Monaco as extra libs, every
// `@example` is moved into the description (the text before the first tag,
// which Monaco renders as Markdown) as a fenced ```ts block. `@param` and the
// other tags stay real tags, so signature help still documents each argument;
// Monaco lists them after the description.
//
// Pure string work, no DOM or Monaco: it runs in the browser on the raw .d.ts
// text and in Node for the tests (test/editor-docs.test.ts).

const DOC_COMMENT = /\/\*\*[\s\S]*?\*\//g;
const TAG_LINE = /^@(\w+)(.*)$/;

/** Rewrites every JSDoc block in a declaration file (see `formatDocComment`). */
export function formatDocComments(source: string): string {
  return source.replace(DOC_COMMENT, formatDocComment);
}

/**
 * Rewrites one `/** … *\/` block so its `@example` tags become fenced ```ts
 * blocks at the end of the description, each example's lines (comments,
 * indentation, inner blank lines) kept exactly. Blocks without examples, and
 * any block it can't rewrite faithfully, come back unchanged.
 */
export function formatDocComment(comment: string): string {
  const lines = comment.split("\n");
  if (lines.length < 3 || lines[0].trim() !== "/**" || lines[lines.length - 1].trim() !== "*/") return comment;

  // Each inner line as written, plus its text after the ` * ` prefix.
  const inner: { raw: string; text: string }[] = [];
  for (const raw of lines.slice(1, -1)) {
    const m = /^\s*\* ?(.*)$/.exec(raw);
    if (!m) return comment;
    inner.push({ raw, text: m[1] ?? "" });
  }
  const indent = /^(\s*)\*/.exec(inner[0]?.raw ?? "")?.[1] ?? "";

  // Split into the description and the tags (a tag runs until the next tag line).
  const description: typeof inner = [];
  const tags: { name: string; first: string; lines: typeof inner }[] = [];
  for (const line of inner) {
    const tag = TAG_LINE.exec(line.text);
    if (tag) tags.push({ name: tag[1], first: tag[2].trim(), lines: [line] });
    else if (tags.length) tags[tags.length - 1].lines.push(line);
    else description.push(line);
  }
  const examples = tags.filter((t) => t.name === "example");
  if (!examples.length) return comment;

  // TypeScript starts a tag at any `@word` that follows whitespace, so such an
  // example would be cut short wherever it sits. Leave those blocks as they are.
  const startsTag = /(^|\s)@\w/;
  if (examples.some((t) => startsTag.test(t.first) || t.lines.slice(1).some((l) => startsTag.test(l.text)))) {
    return comment;
  }

  const out = trimBlankLines(description).map((l) => l.raw);
  const add = (text: string) => out.push(text ? `${indent}* ${text}` : `${indent}*`);
  for (const example of examples) {
    const body = trimBlankLines(example.lines.slice(1)).map((l) => l.text);
    if (!body.length && !example.first) continue;
    if (out.length) add("");
    if (example.first) {
      add(example.first);
      if (body.length) add("");
    }
    if (!body.length) continue;
    if (body[0].trimStart().startsWith("```")) {
      body.forEach(add);
      continue;
    }
    const fence = "`".repeat(Math.max(3, longestBacktickRun(body) + 1));
    add(`${fence}ts`);
    body.forEach(add);
    add(fence);
  }
  for (const tag of tags) if (tag.name !== "example") out.push(...tag.lines.map((l) => l.raw));

  return [lines[0], ...out, lines[lines.length - 1]].join("\n");
}

function trimBlankLines<T extends { text: string }>(lines: T[]): T[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].text.trim()) start++;
  while (end > start && !lines[end - 1].text.trim()) end--;
  return lines.slice(start, end);
}

/** The longest run of backticks in `lines`, when it's long enough (3+) to close a fence. */
function longestBacktickRun(lines: string[]): number {
  let longest = 0;
  for (const line of lines) for (const run of line.match(/`{3,}/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}
