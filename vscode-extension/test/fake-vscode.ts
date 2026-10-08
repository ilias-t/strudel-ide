// Minimal in-memory stand-in for the `vscode` module: just the API surface
// extension.ts uses, recording what the extension does so tests can assert it.

type Listener<T> = (e: T) => unknown;

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (l: Listener<T>) => {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
  };
  fire(e: T) {
    for (const l of [...this.listeners]) l(e);
  }
  dispose() {
    this.listeners = [];
  }
}

export class Position {
  line: number;
  character: number;
  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }
}

export class Range {
  start: Position;
  end: Position;
  constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
    if (typeof a === "number") {
      this.start = new Position(a, b as number);
      this.end = new Position(c!, d!);
    } else {
      this.start = a;
      this.end = b as Position;
    }
  }
}

export class ThemeColor {
  id: string;
  constructor(id: string) {
    this.id = id;
  }
}

export class Selection extends Range {
  get active() {
    return this.end;
  }
}

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
export const TextEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 };
export const StatusBarAlignment = { Left: 1, Right: 2 };
export const DecorationRangeBehavior = { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 };

export class Diagnostic {
  range: Range;
  message: string;
  severity: number;
  source?: string;
  constructor(range: Range, message: string, severity: number) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

export class CodeLens {
  range: Range;
  command?: { title: string; command: string; arguments?: unknown[] };
  constructor(range: Range, command?: CodeLens["command"]) {
    this.range = range;
    this.command = command;
  }
}

export const Uri = {
  file(fsPath: string) {
    return { scheme: "file", fsPath, toString: () => `file://${fsPath}` };
  },
  parse(s: string) {
    return { scheme: s.split(":")[0], fsPath: "", toString: () => s };
  },
};
type FakeUri = ReturnType<typeof Uri.file>;

// ─────────────────────────────────────────────────────────────────────────────
// Documents & editors
// ─────────────────────────────────────────────────────────────────────────────

export class FakeDocument {
  uri: FakeUri;
  version = 1;
  isDirty = false;
  saves = 0;
  private text: string;
  constructor(fsPath: string, text: string) {
    this.uri = Uri.file(fsPath);
    this.text = text;
    this.savedText = text;
  }
  getText() {
    return this.text;
  }
  /** Replace the whole text (reported as one minimal change, like VS Code does for a typed edit) */
  edit(text: string) {
    const old = this.text;
    let a = 0;
    while (a < old.length && a < text.length && old[a] === text[a]) a++;
    let b = 0;
    while (b < old.length - a && b < text.length - a && old[old.length - 1 - b] === text[text.length - 1 - b]) b++;
    this.editRange(a, old.length - a - b, text.slice(a, text.length - b));
  }
  /** Replace `length` characters at `offset` with `insert` */
  editRange(offset: number, length: number, insert: string) {
    const old = this.text;
    this.text = old.slice(0, offset) + insert + old.slice(offset + length);
    this.version++;
    this.isDirty = this.text !== this.savedText;
    workspace._onChange.fire({
      document: this,
      contentChanges: [{ rangeOffset: offset, rangeLength: length, text: insert }],
    });
  }
  /** The text as on disk (isDirty compares against it) */
  savedText: string;
  async save() {
    this.saves++;
    this.isDirty = false;
    this.savedText = this.text;
    workspace._onSave.fire(this);
    return true;
  }
  get lineCount() {
    return this.text.split("\n").length;
  }
  lineAt(n: number) {
    const len = this.text.split("\n")[n].length;
    return { range: new Range(n, 0, n, len) };
  }
  positionAt(o: number) {
    const before = this.text.slice(0, o).split("\n");
    return new Position(before.length - 1, before.at(-1)!.length);
  }
  offsetAt(p: Position) {
    const lines = this.text.split("\n");
    let o = 0;
    for (let i = 0; i < p.line && i < lines.length; i++) o += lines[i].length + 1;
    return Math.min(this.text.length, o + p.character);
  }
}

export interface FakeDecorationType {
  key: string;
  opts: Record<string, unknown>;
  dispose(): void;
}

export class FakeEditor {
  document: FakeDocument;
  viewColumn = 1;
  selection: Selection | undefined;
  decorations = new Map<unknown, Range[]>();
  setDecorationsCalls = 0;
  revealed: Range[] = [];
  constructor(document: FakeDocument) {
    this.document = document;
  }
  setDecorations(type: unknown, ranges: Range[]) {
    this.setDecorationsCalls++;
    this.decorations.set(type, ranges);
  }
  revealRange(range: Range) {
    this.revealed.push(range);
  }
  /** Ranges of the decoration type whose options match `pick` ([] when never set) */
  decorationsOf(pick: (opts: Record<string, unknown>) => boolean): Range[] {
    const type = decorationTypes.find((t) => pick(t.opts));
    return (type && this.decorations.get(type)) ?? [];
  }
}

/** Every decoration type the extension created, in order */
export const decorationTypes: FakeDecorationType[] = [];
export const isHighlight = (o: Record<string, unknown>) => o.outlineStyle === "solid";
export const isPulse = (o: Record<string, unknown>) => (o.backgroundColor as ThemeColor)?.id === "strudel.pulseBackground";
export const isDim = (o: Record<string, unknown>) => o.opacity !== undefined;
export const isKnobHint = (o: Record<string, unknown>) => o.after !== undefined;

/** A createQuickPick() the extension opened: drive it like a user */
export class FakeQuickPick<T extends { label: string }> {
  items: T[] = [];
  activeItems: T[] = [];
  selectedItems: T[] = [];
  title = "";
  placeholder = "";
  value = "";
  visible = false;
  disposed = false;
  private accept = new EventEmitter<void>();
  private hidden = new EventEmitter<void>();
  onDidAccept = this.accept.event;
  onDidHide = this.hidden.event;
  show() {
    this.visible = true;
  }
  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.hidden.fire();
  }
  dispose() {
    this.disposed = true;
  }
  /** Pick the item whose label contains `label` and press Enter */
  async pick(label: string) {
    const item = this.items.find((i) => i.label.includes(label));
    if (!item) throw new Error(`no quick pick item "${label}" in ${this.items.map((i) => i.label).join(", ")}`);
    this.selectedItems = [item];
    this.activeItems = [item];
    this.accept.fire();
    await new Promise((r) => setTimeout(r, 0));
    this.selectedItems = [];
  }
  /** Type `text` and press Enter */
  async type(text: string) {
    this.value = text;
    this.selectedItems = [];
    this.activeItems = [];
    this.accept.fire();
    await new Promise((r) => setTimeout(r, 0));
  }
}
export const quickPicks: FakeQuickPick<any>[] = [];

export class WorkspaceEdit {
  edits: { uri: FakeUri; range: Range; text: string }[] = [];
  replace(uri: FakeUri, range: Range, text: string) {
    this.edits.push({ uri, range, text });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Namespaces
// ─────────────────────────────────────────────────────────────────────────────

export const recorded = {
  log: [] as string[],
  messages: [] as { level: string; text: string }[],
  opened: [] as string[],
  shown: [] as { path: string; selection?: Range; preserveFocus?: boolean }[],
  context: new Map<string, unknown>(),
  terminals: [] as { name: string; sent: string[] }[],
};

export const statusItem = {
  text: "",
  tooltip: "" as unknown,
  command: "" as unknown,
  backgroundColor: undefined as ThemeColor | undefined,
  name: "",
  show() {},
  dispose() {},
};

const activeEditorChanged = new EventEmitter<unknown>();
const visibleEditorsChanged = new EventEmitter<unknown>();

export const window = {
  visibleTextEditors: [] as FakeEditor[],
  activeTextEditor: undefined as FakeEditor | undefined,
  terminals: [] as { name: string; show(): void }[],
  quickPickAnswer: undefined as ((items: any[]) => any) | undefined,
  createOutputChannel: () => ({ appendLine: (s: string) => recorded.log.push(s), dispose() {} }),
  createStatusBarItem: () => statusItem,
  createTextEditorDecorationType: (opts: Record<string, unknown>) => {
    const type: FakeDecorationType = { key: `strudel-deco-${decorationTypes.length}`, opts, dispose() {} };
    decorationTypes.push(type);
    return type;
  },
  onDidChangeActiveTextEditor: activeEditorChanged.event,
  onDidChangeVisibleTextEditors: visibleEditorsChanged.event,
  showWarningMessage: async (text: string) => void recorded.messages.push({ level: "warning", text }),
  showInformationMessage: async (text: string) => void recorded.messages.push({ level: "info", text }),
  showErrorMessage: async (text: string) => void recorded.messages.push({ level: "error", text }),
  showQuickPick: async (items: any[]) => window.quickPickAnswer?.(items),
  inputBoxAnswer: undefined as string | undefined,
  showInputBox: async (opts: { validateInput?: (v: string) => string | undefined }) => {
    const v = window.inputBoxAnswer;
    if (v !== undefined && opts.validateInput?.(v)) return undefined;
    return v;
  },
  createQuickPick: () => {
    const qp = new FakeQuickPick();
    quickPicks.push(qp);
    return qp;
  },
  showTextDocument: async (doc: FakeDocument, opts: { selection?: Range; preserveFocus?: boolean } = {}) => {
    recorded.shown.push({ path: doc.uri.fsPath, selection: opts.selection, preserveFocus: opts.preserveFocus });
    const ed = window.visibleTextEditors.find((e) => e.document === doc) ?? new FakeEditor(doc);
    window.activeTextEditor = ed;
    return ed;
  },
  createTerminal: (o: { name: string }) => {
    const t = { name: o.name, sent: [] as string[], show() {}, sendText: (s: string) => t.sent.push(s) };
    recorded.terminals.push(t);
    return t;
  },
  // test helpers
  _setEditors(editors: FakeEditor[], active?: FakeEditor) {
    window.visibleTextEditors = editors;
    visibleEditorsChanged.fire(editors);
    window.activeTextEditor = active;
    activeEditorChanged.fire(active);
  },
};

export const config: Record<string, unknown> = {};

export const workspace = {
  workspaceFolders: [] as { uri: FakeUri }[],
  textDocuments: [] as FakeDocument[],
  getConfiguration: (section: string) => ({
    get: (key: string, def?: unknown) => config[`${section}.${key}`] ?? def,
  }),
  applyEdit: async (edit: WorkspaceEdit) => {
    // one document, edits on the same text: apply from the end
    const byDoc = new Map<FakeDocument, { start: number; end: number; text: string }[]>();
    for (const e of edit.edits) {
      const doc = workspace.textDocuments.find((d) => d.uri.fsPath === e.uri.fsPath);
      if (!doc) return false;
      const list = byDoc.get(doc) ?? [];
      list.push({ start: doc.offsetAt(e.range.start), end: doc.offsetAt(e.range.end), text: e.text });
      byDoc.set(doc, list);
    }
    for (const [doc, list] of byDoc) {
      for (const e of list.sort((a, b) => b.start - a.start)) doc.editRange(e.start, e.end - e.start, e.text);
    }
    return true;
  },
  openTextDocument: async (uri: FakeUri) =>
    workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath) ?? new FakeDocument(uri.fsPath, ""),
  _onChange: new EventEmitter<unknown>(),
  _onSave: new EventEmitter<unknown>(),
  _onOpen: new EventEmitter<unknown>(),
  _onConfig: new EventEmitter<unknown>(),
  _onFolders: new EventEmitter<unknown>(),
  get onDidChangeTextDocument() {
    return this._onChange.event;
  },
  get onDidSaveTextDocument() {
    return this._onSave.event;
  },
  get onDidOpenTextDocument() {
    return this._onOpen.event;
  },
  get onDidChangeConfiguration() {
    return this._onConfig.event;
  },
  get onDidChangeWorkspaceFolders() {
    return this._onFolders.event;
  },
};

export const diagnostics = new Map<string, Diagnostic[]>();
export const codeLensProviders: any[] = [];

export const languages = {
  createDiagnosticCollection: () => ({
    clear: () => diagnostics.clear(),
    set: (uri: FakeUri, d: Diagnostic[]) => diagnostics.set(uri.fsPath, d),
    dispose() {},
  }),
  registerCodeLensProvider: (_selector: unknown, provider: unknown) => {
    codeLensProviders.push(provider);
    return { dispose() {} };
  },
};

const registered = new Map<string, (...args: any[]) => unknown>();

export const commands = {
  registerCommand: (id: string, fn: (...args: any[]) => unknown) => {
    registered.set(id, fn);
    return { dispose: () => registered.delete(id) };
  },
  executeCommand: async (id: string, ...args: any[]) => {
    if (id === "setContext") return void recorded.context.set(args[0], args[1]);
    return registered.get(id)?.(...args);
  },
};

export const env = {
  appName: "Cursor",
  uriScheme: "cursor",
  appRoot: undefined as string | undefined,
  openExternal: async (uri: { toString(): string }) => {
    recorded.opened.push(uri.toString());
    return true;
  },
};
