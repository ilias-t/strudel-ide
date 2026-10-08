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

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
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
  }
  getText() {
    return this.text;
  }
  edit(text: string) {
    this.text = text;
    this.version++;
    this.isDirty = true;
    workspace._onChange.fire({ document: this, contentChanges: [{}] });
  }
  async save() {
    this.saves++;
    this.isDirty = false;
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
}

export class FakeEditor {
  document: FakeDocument;
  decorations = new Map<unknown, Range[]>();
  setDecorationsCalls = 0;
  constructor(document: FakeDocument) {
    this.document = document;
  }
  setDecorations(type: unknown, ranges: Range[]) {
    this.setDecorationsCalls++;
    this.decorations.set(type, ranges);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Namespaces
// ─────────────────────────────────────────────────────────────────────────────

export const recorded = {
  log: [] as string[],
  messages: [] as { level: string; text: string }[],
  opened: [] as string[],
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
  createTextEditorDecorationType: (opts: unknown) => ({ key: "strudel-highlight", opts, dispose() {} }),
  onDidChangeActiveTextEditor: activeEditorChanged.event,
  onDidChangeVisibleTextEditors: visibleEditorsChanged.event,
  showWarningMessage: async (text: string) => void recorded.messages.push({ level: "warning", text }),
  showInformationMessage: async (text: string) => void recorded.messages.push({ level: "info", text }),
  showErrorMessage: async (text: string) => void recorded.messages.push({ level: "error", text }),
  showQuickPick: async (items: any[]) => window.quickPickAnswer?.(items),
  showTextDocument: async () => undefined,
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
  openExternal: async (uri: { toString(): string }) => {
    recorded.opened.push(uri.toString());
    return true;
  },
};
