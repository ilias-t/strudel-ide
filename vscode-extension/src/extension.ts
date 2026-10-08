// VS Code glue for Strudel Live. Logic lives in the vscode-free modules next to
// this file (unit-tested in Node); this file only wires them to the editor UI.

import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { contentVersion, type CommandMsg, type HighlightMsg } from "../../src/live/protocol.ts";
import { BridgeConnection } from "./connection.ts";
import { readDiscovery, resolveEndpoint, type Endpoint } from "./discovery.ts";
import { LiveModel, planEvaluate, planPlayFile, type Action, type Changes } from "./model.ts";
import { isSongPath, relativeTo, resolveIn } from "./paths.ts";
import { LineIndex, findCreatePattern, toSpans } from "./ranges.ts";
import { formatError, formatStatus } from "./status.ts";

let disposeAll: (() => void) | undefined;

export function activate(ctx: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel("Strudel");
  const model = new LiveModel();
  let endpoint: Endpoint = resolveEndpoint(undefined, null);

  // ── Roots & files ──────────────────────────────────────────────────────────

  const folders = () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  /** Vite root: from the discovery file, else the folder that has src/songs. Cached (hot path). */
  let rootCache: { key: string; root: string | null } | undefined;
  const root = (): string | null => {
    const key = endpoint.root ?? `folders:${folders().join("|")}`;
    if (rootCache?.key !== key)
      rootCache = {
        key,
        root:
          endpoint.root ?? folders().find((f) => existsSync(path.join(f, "src", "songs"))) ?? folders()[0] ?? null,
      };
    return rootCache.root;
  };
  const relOf = (doc: vscode.TextDocument): string | null => {
    const r = root();
    return doc.uri.scheme === "file" && r ? relativeTo(r, doc.uri.fsPath) : null;
  };
  const songFileOf = (doc: vscode.TextDocument | undefined): string | null => {
    const rel = doc ? relOf(doc) : null;
    return isSongPath(rel) ? rel : null;
  };

  // ── Connection ─────────────────────────────────────────────────────────────

  const conn = new BridgeConnection({
    url: () => {
      const setting = vscode.workspace.getConfiguration("strudel").get<string>("serverUrl");
      const next = resolveEndpoint(setting, readDiscovery(folders()));
      if (next.wsUrl !== endpoint.wsUrl) out.appendLine(`Bridge: ${next.wsUrl} (${next.source})`);
      endpoint = next;
      return endpoint.wsUrl;
    },
    onStatus: (s) => {
      if (s !== model.bridge) out.appendLine(`Bridge ${s}`);
      apply(model.setBridge(s));
    },
    onMessage: (msg) => {
      if (msg.type === "player") out.appendLine(`Player ${msg.connected ? "connected" : "disconnected"}`);
      apply(model.handle(msg));
    },
  });

  // ── Status bar ─────────────────────────────────────────────────────────────

  const status = vscode.window.createStatusBarItem("strudel.status", vscode.StatusBarAlignment.Left, 100);
  status.name = "Strudel";
  status.show();
  let lastStatus = "";
  const renderStatus = () => {
    const v = formatStatus(model, Date.now(), endpoint.httpUrl);
    const key = `${v.kind}|${v.text}|${v.tooltip}`;
    if (key === lastStatus) return;
    lastStatus = key;
    status.text = v.text;
    status.tooltip = v.tooltip;
    status.command = v.command;
    status.backgroundColor = v.kind === "error" ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
  };
  // Tick the bar number while playing.
  let ticker: ReturnType<typeof setInterval> | undefined;
  const updateTicker = () => {
    if (model.playing && !ticker) ticker = setInterval(renderStatus, 250);
    else if (!model.playing && ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };

  // ── Context keys ───────────────────────────────────────────────────────────

  const ctxCache = new Map<string, unknown>();
  const setContext = (key: string, value: unknown) => {
    if (ctxCache.get(key) === value) return;
    ctxCache.set(key, value);
    void vscode.commands.executeCommand("setContext", key, value);
  };
  const updateContext = () => {
    setContext("strudel.connected", model.bridge === "connected");
    setContext("strudel.playerConnected", model.player);
    setContext("strudel.playing", model.playing);
    setContext("strudel.isSongFile", !!songFileOf(vscode.window.activeTextEditor?.document));
  };

  // ── Highlights ─────────────────────────────────────────────────────────────

  const deco = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("strudel.highlightBackground"),
    outlineColor: new vscode.ThemeColor("strudel.highlightBorder"),
    outlineStyle: "solid",
    outlineWidth: "1px",
    borderRadius: "2px",
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const decorated = new Set<vscode.TextEditor>();
  const docCache = new WeakMap<vscode.TextDocument, { version: number; index: LineIndex; hash?: string }>();
  const docInfo = (doc: vscode.TextDocument) => {
    let info = docCache.get(doc);
    if (!info || info.version !== doc.version) {
      info = { version: doc.version, index: new LineIndex(doc.getText()) };
      docCache.set(doc, info);
    }
    return info;
  };
  /** Offsets refer to the file on disk: skip dirty docs and version mismatches. */
  const rangesFor = (doc: vscode.TextDocument, hl: HighlightMsg | undefined): vscode.Range[] => {
    if (!hl || doc.isDirty) return [];
    const info = docInfo(doc);
    if (hl.version !== undefined) {
      info.hash ??= contentVersion(doc.getText());
      if (info.hash !== hl.version) return [];
    }
    return toSpans(info.index, hl.ranges).map(
      (s) => new vscode.Range(s.start.line, s.start.character, s.end.line, s.end.character),
    );
  };
  const readEnabled = () => vscode.workspace.getConfiguration("strudel").get<boolean>("highlights.enabled", true);
  let highlightsEnabled = readEnabled();
  const renderHighlights = (files?: Set<string>) => {
    const enabled = highlightsEnabled;
    for (const ed of vscode.window.visibleTextEditors) {
      const rel = relOf(ed.document);
      if (files && !(rel && files.has(rel))) continue;
      const ranges = enabled && rel ? rangesFor(ed.document, model.highlights.get(rel)) : [];
      if (ranges.length === 0 && !decorated.has(ed)) continue;
      ed.setDecorations(deco, ranges);
      if (ranges.length) decorated.add(ed);
      else decorated.delete(ed);
    }
    for (const ed of decorated) if (!vscode.window.visibleTextEditors.includes(ed)) decorated.delete(ed);
  };

  // ── Diagnostics ────────────────────────────────────────────────────────────

  const diagnostics = vscode.languages.createDiagnosticCollection("strudel");
  const renderDiagnostics = () => {
    diagnostics.clear();
    const err = model.state?.error;
    const r = root();
    if (!err?.file || !r) return;
    const uri = vscode.Uri.file(resolveIn(r, err.file));
    const line = Math.max(0, (err.line ?? 1) - 1);
    const col = Math.max(0, (err.column ?? 1) - 1);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    const end = doc && line < doc.lineCount ? doc.lineAt(line).range.end.character : col + 1;
    const d = new vscode.Diagnostic(
      new vscode.Range(line, col, line, Math.max(end, col + 1)),
      err.message,
      vscode.DiagnosticSeverity.Error,
    );
    d.source = "strudel";
    diagnostics.set(uri, [d]);
  };

  // ── CodeLens ───────────────────────────────────────────────────────────────

  const lensChanged = new vscode.EventEmitter<void>();
  const lensProvider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: lensChanged.event,
    provideCodeLenses(doc) {
      const file = songFileOf(doc);
      if (!file || !vscode.workspace.getConfiguration("strudel").get<boolean>("codeLens", true)) return [];
      const playingThis = model.playing && model.isCurrent(file);
      return findCreatePattern(doc.getText()).map((offset) => {
        const pos = doc.positionAt(offset);
        return new vscode.CodeLens(new vscode.Range(pos, pos), {
          title: playingThis ? "■ Stop" : "▶ Play",
          tooltip: playingThis ? "Stop playback (Ctrl+.)" : "Play this song in the Strudel player",
          command: playingThis ? "strudel.stop" : "strudel.playFile",
          arguments: playingThis ? [] : [doc.uri],
        });
      });
    },
  };

  // ── Change fan-out ─────────────────────────────────────────────────────────

  function apply(ch: Changes) {
    if (ch.status) {
      renderStatus();
      updateContext();
      updateTicker();
    }
    if (ch.error) renderDiagnostics();
    if (ch.lens) lensChanged.fire();
    if (ch.highlights.size) renderHighlights(ch.highlights);
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  async function ensurePlayer(): Promise<boolean> {
    if (model.bridge !== "connected") {
      const pick = await vscode.window.showWarningMessage(
        `Strudel dev server not reachable at ${endpoint.httpUrl}.`,
        "Start dev server",
        "Retry",
      );
      if (pick === "Start dev server") startDevServer();
      if (pick === "Retry") conn.reconnect();
      return false;
    }
    if (!model.player) {
      const pick = await vscode.window.showWarningMessage("Strudel player not connected.", "Open Player");
      if (pick === "Open Player") openPlayer();
      return false;
    }
    return true;
  }

  async function sendCommand(msg: Omit<CommandMsg, "type">) {
    if (await ensurePlayer()) conn.send({ type: "command", ...msg });
  }

  async function run(actions: Action[], doc?: vscode.TextDocument) {
    const sends = actions.filter((a) => a.kind === "send");
    if (sends.length && !(await ensurePlayer())) {
      // still save: saving is how changes are applied
      if (doc && actions.some((a) => a.kind === "save")) await doc.save();
      return;
    }
    for (const a of actions) {
      if (a.kind === "save") await doc?.save();
      else conn.send(a.msg);
    }
  }

  function openPlayer() {
    void vscode.env.openExternal(vscode.Uri.parse(endpoint.httpUrl));
  }

  function startDevServer() {
    const cwd = root();
    const existing = vscode.window.terminals.find((t) => t.name === "Strudel dev server");
    if (existing) return existing.show();
    const term = vscode.window.createTerminal({
      name: "Strudel dev server",
      cwd: cwd ?? undefined,
      env: { NO_OPEN: "" },
    });
    term.show();
    term.sendText("npm run dev");
    setTimeout(() => conn.reconnect(), 2000);
  }

  async function pickTrack(command: "mute" | "solo") {
    if (!(await ensurePlayer())) return;
    const s = model.state;
    const tracks = s?.tracks ?? [];
    if (!tracks.length) {
      void vscode.window.showInformationMessage(
        "This song has no named tracks (return a record of patterns from createPattern).",
      );
      return;
    }
    const muted = new Set(s?.muted ?? []);
    const soloed = new Set(s?.soloed ?? []);
    type Item = vscode.QuickPickItem & { track?: string; all?: boolean };
    const items: Item[] = tracks.map((t) => ({
      label: `${soloed.has(t) ? "$(star-full)" : muted.has(t) ? "$(mute)" : "$(unmute)"} ${t}`,
      description: [muted.has(t) && "muted", soloed.has(t) && "solo"].filter(Boolean).join(", "),
      track: t,
    }));
    if (muted.size || soloed.size) items.push({ label: "$(clear-all) Unmute all", all: true });
    const pick = await vscode.window.showQuickPick(items, {
      title: command === "mute" ? "Strudel: toggle mute" : "Strudel: toggle solo",
      placeHolder: s?.songName ?? undefined,
    });
    if (!pick) return;
    conn.send(pick.all ? { type: "command", command: "unmuteAll" } : { type: "command", command, track: pick.track });
  }

  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg("strudel.evaluate", async () => {
    const ed = vscode.window.activeTextEditor;
    const file = songFileOf(ed?.document);
    await run(planEvaluate(model, file, !!ed?.document.isDirty), ed?.document);
  });
  reg("strudel.toggle", () => sendCommand({ command: "toggle" }));
  reg("strudel.play", () => sendCommand({ command: "play" }));
  reg("strudel.stop", () => sendCommand({ command: "stop" }));
  reg("strudel.next", () => sendCommand({ command: "next" }));
  reg("strudel.prev", () => sendCommand({ command: "prev" }));
  reg("strudel.playFile", async (uri?: vscode.Uri) => {
    const doc = uri
      ? await vscode.workspace.openTextDocument(uri)
      : vscode.window.activeTextEditor?.document;
    const file = songFileOf(doc);
    if (!file) {
      void vscode.window.showInformationMessage("Not a song file (src/songs/<name>.ts).");
      return;
    }
    await run(doc?.isDirty ? [{ kind: "save" }, ...planPlayFile(model, file)] : planPlayFile(model, file), doc);
  });
  reg("strudel.openPlayer", openPlayer);
  reg("strudel.startDevServer", startDevServer);
  reg("strudel.reconnect", () => conn.reconnect());
  reg("strudel.muteTrack", () => pickTrack("mute"));
  reg("strudel.soloTrack", () => pickTrack("solo"));
  reg("strudel.showError", async () => {
    const err = model.state?.error;
    if (!err) return;
    const r = root();
    if (err.file && r) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolveIn(r, err.file)));
      const pos = new vscode.Position(Math.max(0, (err.line ?? 1) - 1), Math.max(0, (err.column ?? 1) - 1));
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
    } else {
      void vscode.window.showErrorMessage(`Strudel: ${formatError(err)}`);
    }
  });

  // ── Editor events ──────────────────────────────────────────────────────────

  ctx.subscriptions.push(
    out,
    status,
    deco,
    diagnostics,
    lensChanged,
    vscode.languages.registerCodeLensProvider(
      [{ scheme: "file", language: "typescript", pattern: "**/src/songs/*.ts" }],
      lensProvider,
    ),
    vscode.window.onDidChangeActiveTextEditor(() => updateContext()),
    vscode.window.onDidChangeVisibleTextEditors(() => renderHighlights()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      // Edited → on-disk offsets no longer match: clear right away.
      if (e.contentChanges.length && [...decorated].some((ed) => ed.document === e.document)) renderHighlights();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const rel = relOf(doc);
      if (rel && model.highlights.has(rel)) renderHighlights(new Set([rel]));
    }),
    vscode.workspace.onDidOpenTextDocument(() => {
      if (model.state?.error) renderDiagnostics();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("strudel.serverUrl")) conn.reconnect();
      if (e.affectsConfiguration("strudel.highlights")) {
        highlightsEnabled = readEnabled();
        renderHighlights();
      }
      if (e.affectsConfiguration("strudel.codeLens")) lensChanged.fire();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      rootCache = undefined;
      conn.reconnect();
    }),
  );

  renderStatus();
  updateContext();
  conn.start();

  disposeAll = () => {
    conn.dispose();
    if (ticker) clearInterval(ticker);
  };
  ctx.subscriptions.push({ dispose: () => disposeAll?.() });
}

export function deactivate(): void {
  disposeAll?.();
  disposeAll = undefined;
}
