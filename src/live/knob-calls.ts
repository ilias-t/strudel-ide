// ═══════════════════════════════════════════════════════════════════════════
// knob("name", value, …) calls in song source text
// ═══════════════════════════════════════════════════════════════════════════
//
// Shared by the stage's code view (a chip after each call) and the VS Code
// extension (inline value hints, writing a value into the editor buffer).
// Dependency-free apart from the tokenizer, so Node (the extension's tests)
// and esbuild (its bundle) load it as is.

import { tokenize, type Token } from "../ui/tokenize.ts";

/** A `knob("name", …)` call in the text */
export interface KnobCall {
  name: string;
  /** offset of `knob` */
  start: number;
  /** just past the call's closing paren */
  end: number;
  /** The value argument when it is a number literal (`2200`, `-3`, `0.15`): what a write replaces */
  value?: { start: number; end: number; text: string };
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
    if (end < 0) continue;
    const call: KnobCall = { name: text.slice(name.start + 1, name.end - 1), start: t.start, end };
    const value = numberArg(text, significant, i + 3);
    if (value) call.value = value;
    calls.push(call);
  }
  return calls;
}

/** The number literal right after the name: `, 2200,` / `, -3)` / `,-0.5 ,` */
function numberArg(text: string, tokens: Token[], at: number): KnobCall["value"] | undefined {
  const comma = tokens[at];
  if (!comma || comma.kind !== "p") return;
  const sep = text.slice(comma.start, comma.end);
  let sign = /^,([-+])$/.test(sep) ? comma.end - 1 : -1;
  if (sep !== "," && sign < 0) return;
  let i = at + 1;
  if (sign < 0 && tokens[i]?.kind === "p" && /^[-+]$/.test(text.slice(tokens[i].start, tokens[i].end))) sign = tokens[i++].start;
  const num = tokens[i];
  const after = tokens[i + 1];
  if (!num || num.kind !== "n" || !after || after.kind !== "p" || !/^[,)]/.test(text[after.start])) return;
  const start = sign >= 0 ? sign : num.start;
  return { start, end: num.end, text: text.slice(start, num.end) };
}
