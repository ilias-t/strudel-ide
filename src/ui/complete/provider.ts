// ═══════════════════════════════════════════════════════════════════════════
// The Monaco side: one completion provider, the in-string hover, the ▶ command
// ═══════════════════════════════════════════════════════════════════════════
//
// TypeScript's own completion provider is off (editor-lang.ts sets
// completionItems: false); this one replaces it:
//
//   - inside a Strudel string (./context.ts stringContextAt): our items only
//     (./values.ts), no TypeScript round trip. TypeScript's string items
//     would replace the whole string (their replacementSpan covers it).
//   - everywhere else: TypeScript's worker (getCompletionsAtPosition), mapped
//     the way Monaco's SuggestAdapter maps it (insertText, snippets,
//     replacementSpan, kinds). A Pattern member list (after a dot) is ranked
//     and labelled by ./members.ts. resolveCompletionItem adds TypeScript's
//     signature and docs (plus the catalog's line for a Pattern method) and
//     returns only those two fields: Monaco merges the result into the item.
//   - our extra trigger characters (space, quotes, : [ < ,) mean something
//     only inside strings: in code they return nothing at once, so a space
//     never pops TypeScript's list.
//
// The member list is cached per word (the text before the word and after
// the caret unchanged), so a list re-asked on every keystroke (an alias was
// folded: `incomplete`) costs no worker round trip.
//
// Registered once per page however many editors mount (reference counted).

import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";
import type { CompletionsCatalog } from "../discover/catalog";
import { callChainBefore, lex, stringContextAt } from "./context.ts";
import { valueItems, type ValueItem, type ValueKind } from "./values.ts";
import { isPatternMemberList, memberDocLine, rankMembers, type TsEntry } from "./members.ts";
import { hoverFor, PLAY_COMMAND, type PlayArg } from "./hover.ts";
import { composeDoc, type StrudelCompletion } from "./browse.ts";
import type { LiveSoundRegistry } from "./registry.ts";
import type { Theory } from "./types.ts";

export interface ProviderEnv {
  registry: LiveSoundRegistry;
  theory(): Theory | null;
  /** completions.json (loaded on the first member list); null if it won't load */
  completions(): Promise<CompletionsCatalog | null>;
  /** While samples load: how many sounds are registered, of about how many */
  loading(): { count: number; total: number } | null;
  /** The previews line for sound rows (./browse.ts) */
  hint(): string;
}

export interface Timings {
  /** In-string lists, ms */
  strings: number[];
  /** Pattern member lists: our post-processing only, ms */
  members: number[];
  /** TypeScript worker round trips, ms */
  ts: number[];
}

export interface Providers extends Monaco.IDisposable {
  /** The last in-string list (browse.ts rewrites its sound rows' details) */
  lastItems(): readonly StrudelCompletion[];
  readonly timings: Timings;
  /** TypeScript completion round trips so far */
  tsCalls(): number;
}

/** What TypeScript's worker answers (the parts used here) */
interface TsWorker {
  getCompletionsAtPosition(file: string, offset: number): Promise<{ entries: TsEntry[]; isMemberCompletion?: boolean } | undefined>;
  getCompletionEntryDetails(
    file: string,
    offset: number,
    name: string
  ): Promise<{ displayParts?: { text: string }[]; documentation?: { text: string }[]; tags?: { name: string; text?: string | { text: string }[] }[] } | undefined>;
}

/** Where an item came from in TypeScript, for resolveCompletionItem */
interface TsOrigin {
  uri: string;
  offset: number;
  name: string;
  /** A Pattern method: add the catalog's line */
  member?: boolean;
}
type Item = StrudelCompletion & { strudelTs?: TsOrigin };

const TIMING_LIMIT = 100;
const push = (list: number[], ms: number) => {
  list.push(ms);
  if (list.length > TIMING_LIMIT) list.shift();
};

const parts = (p: { text: string }[] | undefined) => (p ? p.map((x) => x.text).join("") : "");

/** TypeScript's JSDoc tag as Monaco's adapter renders it */
function tagToString(tag: { name: string; text?: string | { text: string }[] }): string {
  let label = `*@${tag.name}*`;
  if (tag.name === "param" && Array.isArray(tag.text) && tag.text.length) {
    const [name, ...rest] = tag.text;
    label += `\`${name.text}\``;
    if (rest.length) label += ` — ${rest.map((r) => r.text).join(" ")}`;
  } else if (Array.isArray(tag.text)) label += ` — ${tag.text.map((r) => r.text).join(" ")}`;
  else if (tag.text) label += ` — ${tag.text}`;
  return label;
}

/** Is `offset` inside a string literal (one stringContextAt said nothing about)? */
function inString(text: string, offset: number): boolean {
  for (const t of lex(text)) {
    if (t.start >= offset) return false;
    if (t.kind === "str" && offset < (t.closed ? t.end : t.end + 1)) return true;
  }
  return false;
}

/** Register the provider, the hover and the ▶ command (once per page: call dispose() as often as this) */
export function registerProviders(monaco: typeof Monaco, env: ProviderEnv): Providers {
  const K = monaco.languages.CompletionItemKind;
  const KIND: Record<ValueKind, Monaco.languages.CompletionItemKind> = {
    sound: K.Constant,
    variant: K.Value,
    bank: K.Enum,
    note: K.Value,
    root: K.Value,
    scale: K.EnumMember,
    chord: K.EnumMember,
    word: K.Value,
    operator: K.Operator,
    loading: K.Text,
  };
  const timings: Timings = { strings: [], members: [], ts: [] };
  let tsCalls = 0;
  let last: Item[] = [];
  let cache: { uri: string; wordStart: number; before: string; after: string; info: { entries: TsEntry[]; isMemberCompletion?: boolean } } | null = null;

  const worker = async (uri: Monaco.Uri): Promise<TsWorker> => {
    const get = await monaco.languages.typescript.getTypeScriptWorker();
    return (await get(uri)) as unknown as TsWorker;
  };

  /** TypeScript kinds as Monaco's adapter maps them (let/const as variables too) */
  const kindOf = (kind: string): Monaco.languages.CompletionItemKind => {
    switch (kind) {
      case "primitive type":
      case "keyword":
        return K.Keyword;
      case "var":
      case "local var":
      case "let":
      case "const":
        return K.Variable;
      case "property":
      case "getter":
      case "setter":
        return K.Field;
      case "function":
      case "local function":
      case "method":
      case "construct":
      case "call":
      case "index":
        return K.Function;
      case "enum":
        return K.Enum;
      case "module":
        return K.Module;
      case "class":
        return K.Class;
      case "interface":
        return K.Interface;
      case "warning":
        return K.File;
      default:
        return K.Property;
    }
  };

  const rangeOf = (model: Monaco.editor.ITextModel, a: number, b: number) => {
    const p = model.getPositionAt(a);
    const q = model.getPositionAt(b);
    return new monaco.Range(p.lineNumber, p.column, q.lineNumber, q.column);
  };

  /** One of our in-string items as Monaco wants it (`ranges` caches the few distinct ranges of one list) */
  const toMonaco = (i: ValueItem, model: Monaco.editor.ITextModel, hint: string, ranges: Map<string, Item["range"]>): Item => {
    const key = `${i.range.start}:${i.range.end}:${i.insertEnd ?? ""}`;
    let range = ranges.get(key);
    if (!range) {
      const replace = rangeOf(model, i.range.start, i.range.end);
      range = i.insertEnd !== undefined && i.insertEnd !== i.range.end ? { insert: rangeOf(model, i.range.start, i.insertEnd), replace } : replace;
      ranges.set(key, range);
    }
    const item: Item = { label: { label: i.label, detail: i.detail, description: i.description }, kind: KIND[i.kind], insertText: i.insertText, range, sortText: i.sortText };
    if (i.filterText !== undefined) item.filterText = i.filterText;
    if (i.snippet) item.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
    if (i.retrigger) item.command = { id: "editor.action.triggerSuggest", title: "suggest" };
    if (i.strudel) {
      item.strudel = i.strudel;
      item.strudelDoc = i.documentation ?? "";
      item.documentation = { value: composeDoc(item.strudelDoc, { hint }) };
    } else if (i.documentation) item.documentation = { value: i.documentation };
    return item;
  };

  /** TypeScript's entries at `offset`, cached while the text around the word stays the same */
  const tsEntries = async (model: Monaco.editor.ITextModel, text: string, offset: number, wordStart: number) => {
    const uri = model.uri.toString();
    const before = text.slice(0, wordStart);
    const after = text.slice(offset);
    if (cache && cache.uri === uri && cache.wordStart === wordStart && cache.after === after && cache.before === before) return cache.info;
    const t0 = performance.now();
    const w = await worker(model.uri);
    if (model.isDisposed()) return undefined;
    const info = await w.getCompletionsAtPosition(uri, offset);
    tsCalls++;
    push(timings.ts, performance.now() - t0);
    if (info) cache = { uri, wordStart, before, after, info };
    return info;
  };

  const QUOTES = ["`", '"', "'"];

  const completion = monaco.languages.registerCompletionItemProvider("typescript", {
    triggerCharacters: [".", ...QUOTES, " ", ":", "[", "<", ","],
    async provideCompletionItems(model, position, context) {
      const t0 = performance.now();
      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const ctx = stringContextAt(text, offset);
      if (ctx) {
        const reg = env.registry;
        const list = valueItems(ctx, offset, { registry: reg, theory: env.theory(), loading: reg.ready() ? null : env.loading() });
        const hint = env.hint();
        const ranges = new Map<string, Item["range"]>();
        last = list.items.map((i) => toMonaco(i, model, hint, ranges));
        push(timings.strings, performance.now() - t0);
        return { suggestions: last, incomplete: list.incomplete };
      }
      const trigger = context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter ? context.triggerCharacter : undefined;
      if (trigger && trigger !== ".") {
        // a quote opening a string TypeScript knows the values of (room: "|") is the one exception
        if (!QUOTES.includes(trigger) || !inString(text, offset)) return { suggestions: [] };
      }
      const word = model.getWordUntilPosition(position);
      const wordStart = offset - (position.column - word.startColumn);
      const info = await tsEntries(model, text, offset, wordStart);
      if (!info || model.isDisposed()) return { suggestions: [] };
      const t1 = performance.now();
      const uri = model.uri.toString();
      const wordRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const range = (e: TsEntry) => (e.replacementSpan ? rangeOf(model, e.replacementSpan.start, e.replacementSpan.start + e.replacementSpan.length) : wordRange);
      const snippet = (e: TsEntry) => (e.isSnippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined);
      const catalog = isPatternMemberList(info, null) ? await env.completions() : null;
      if (catalog && isPatternMemberList(info, catalog)) {
        const { rows, folded } = rankMembers(info.entries, catalog, { chain: callChainBefore(text, offset), typed: word.word });
        const suggestions = rows.map(
          (r): Item => ({
            label: { label: r.label, detail: r.detail, description: r.description },
            kind: kindOf(r.entry.kind),
            insertText: r.insertText,
            insertTextRules: snippet(r.entry),
            sortText: r.sortText,
            range: range(r.entry),
            tags: r.deprecated ? [monaco.languages.CompletionItemTag.Deprecated] : [],
            strudelTs: { uri, offset, name: r.entry.name, member: true },
          })
        );
        push(timings.members, performance.now() - t1);
        return { suggestions, incomplete: folded };
      }
      const suggestions = info.entries.map(
        (e): Item => ({
          label: e.name,
          kind: kindOf(e.kind),
          insertText: e.insertText ?? e.name,
          insertTextRules: snippet(e),
          sortText: e.sortText,
          range: range(e),
          tags: e.kindModifiers?.includes("deprecated") ? [monaco.languages.CompletionItemTag.Deprecated] : [],
          strudelTs: { uri, offset, name: e.name },
        })
      );
      return { suggestions };
    },
    async resolveCompletionItem(item) {
      const origin = (item as Item).strudelTs;
      if (!origin) return item; // ours carry their details already
      const w = await worker(monaco.Uri.parse(origin.uri));
      const details = await w.getCompletionEntryDetails(origin.uri, origin.offset, origin.name).catch(() => undefined);
      let doc = details ? [parts(details.documentation), ...(details.tags ?? []).map(tagToString)].filter(Boolean).join("\n\n") : "";
      if (origin.member) {
        const catalog = await env.completions();
        const line = catalog ? memberDocLine(origin.name, catalog) : undefined;
        if (line) doc = doc ? `${doc}\n\n---\n\n${line}` : line;
      }
      // only these two: a string label from here would replace our label object
      const resolved: Partial<Monaco.languages.CompletionItem> = { documentation: { value: doc } };
      if (details?.displayParts) resolved.detail = parts(details.displayParts);
      return resolved as Monaco.languages.CompletionItem;
    },
  });

  const hover = monaco.languages.registerHoverProvider("typescript", {
    provideHover(model, position) {
      const offset = model.getOffsetAt(position);
      const ctx = stringContextAt(model.getValue(), offset);
      if (!ctx) return null;
      const reg = env.registry;
      const h = hoverFor(ctx, offset, { registry: reg, theory: env.theory(), banksWith: (p) => reg.banksWith(p) });
      if (!h) return null;
      return { range: rangeOf(model, h.range.start, h.range.end), contents: [{ value: h.markdown, isTrusted: { enabledCommands: [PLAY_COMMAND] } }] };
    },
  });

  // ▶ in a hover: one sound, or a little pattern (a scale going up, a chord)
  const command = monaco.editor.registerCommand(PLAY_COMMAND, (_accessor: unknown, arg: PlayArg) => {
    if (!arg || typeof arg !== "object") return;
    void import("../discover/audition").then((m) =>
      arg.type === "code" ? m.previewCode(arg.code, { label: arg.label }) : m.auditionSound(arg.sound, { bank: arg.bank, n: arg.n, pitched: arg.pitched, note: arg.note })
    );
  });

  return {
    lastItems: () => last,
    timings,
    tsCalls: () => tsCalls,
    dispose() {
      completion.dispose();
      hover.dispose();
      command.dispose();
      last = [];
      cache = null;
    },
  };
}
