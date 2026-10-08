// VS Code glue for Strudel Live. Logic lives in the vscode-free modules next to
// this file (unit-tested in Node); this file only wires them to the editor UI.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { contentVersion, editorFileUrl, type CommandMsg, type RevealMsg } from "../../src/live/protocol.ts";
import { BridgeConnection } from "./connection.ts";
import { readDiscovery, resolveEndpoint, type Endpoint } from "./discovery.ts";
import { LiveModel, planEvaluate, planPlayFile, type Action, type Changes } from "./model.ts";
import { isSongPath, relativeTo, resolveIn } from "./paths.ts";
import { LineIndex, findCreatePattern, toSpans } from "./ranges.ts";
import { formatError, formatStatus, songPosition } from "./status.ts";
import { findTracks, isAudible, type SongTracks } from "./tracks.ts";

let disposeAll: (() => void) | undefined;

export function activate(ctx: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel("Strudel");
  const model = new LiveModel();
  let endpoint: Endpoint = resolveEndpoint(undefined, null);
  const config = () => vscode.workspace.getConfiguration("strudel");

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
    // the scheme tells the player which editor to open files with ("cursor", "vscode", …)
    client: `strudel-live (${vscode.env.appName ?? "VS Code"})`,
    scheme: vscode.env.uriScheme,
    url: () => {
      const setting = config().get<string>("serverUrl");
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
    setContext("strudel.hasSections", model.player && !!model.state?.sections?.length);
    setContext("strudel.looping", model.player && !!model.state?.loop);
    setContext("strudel.isSongFile", !!songFileOf(vscode.window.activeTextEditor?.document));
  };

  // ── Documents ──────────────────────────────────────────────────────────────

  const docCache = new WeakMap<
    vscode.TextDocument,
    { version: number; index: LineIndex; hash?: string; tracks?: SongTracks }
  >();
  const docInfo = (doc: vscode.TextDocument) => {
    let info = docCache.get(doc);
    if (!info || info.version !== doc.version) {
      info = { version: doc.version, index: new LineIndex(doc.getText()) };
      docCache.set(doc, info);
    }
    return info;
  };
  const tracksIn = (doc: vscode.TextDocument): SongTracks => {
    const info = docInfo(doc);
    info.tracks ??= findTracks(doc.getText());
    return info.tracks;
  };
  const toRange = (index: LineIndex, start: number, end: number) => {
    const a = index.positionAt(start);
    const b = index.positionAt(end);
    return new vscode.Range(a.line, a.character, b.line, b.character);
  };
  /** Offsets refer to the file on disk: skip dirty docs and version mismatches. */
  const rangesFor = (
    doc: vscode.TextDocument,
    msg: { ranges: unknown; version?: string } | undefined,
  ): vscode.Range[] => {
    if (!msg || doc.isDirty) return [];
    const info = docInfo(doc);
    if (msg.version !== undefined) {
      info.hash ??= contentVersion(doc.getText());
      if (info.hash !== msg.version) return [];
    }
    return toSpans(info.index, msg.ranges).map(
      (s) => new vscode.Range(s.start.line, s.start.character, s.end.line, s.end.character),
    );
  };

  // ── Decoration layers ──────────────────────────────────────────────────────
  // One decoration type each; setDecorations only on editors showing a file
  // the change is about, plus one clearing call when an editor stops matching.

  const layer = (options: vscode.DecorationRenderOptions) => {
    const type = vscode.window.createTextEditorDecorationType(options);
    const decorated = new Set<vscode.TextEditor>();
    return {
      type,
      render(files: Set<string> | undefined, compute: (ed: vscode.TextEditor, rel: string | null) => vscode.Range[]) {
        for (const ed of vscode.window.visibleTextEditors) {
          const rel = relOf(ed.document);
          if (files && !(rel && files.has(rel))) continue;
          const ranges = compute(ed, rel);
          if (ranges.length === 0 && !decorated.has(ed)) continue;
          ed.setDecorations(type, ranges);
          if (ranges.length) decorated.add(ed);
          else decorated.delete(ed);
        }
        for (const ed of decorated) if (!vscode.window.visibleTextEditors.includes(ed)) decorated.delete(ed);
      },
      showsDocument: (doc: vscode.TextDocument) => [...decorated].some((ed) => ed.document === doc),
    };
  };

  const settings = {
    highlights: true,
    pulses: true,
    dim: true,
    mixerLens: true,
  };
  const readSettings = () => {
    const c = config();
    settings.highlights = c.get<boolean>("highlights.enabled", true);
    settings.pulses = c.get<boolean>("highlights.pulses", true);
    settings.dim = c.get<boolean>("mixer.dimMuted", true);
    settings.mixerLens = c.get<boolean>("mixer.codeLens", true);
  };
  readSettings();

  // Sounding tokens: outlined while they play
  const highlights = layer({
    backgroundColor: new vscode.ThemeColor("strudel.highlightBackground"),
    outlineColor: new vscode.ThemeColor("strudel.highlightBorder"),
    outlineStyle: "solid",
    outlineWidth: "1px",
    borderRadius: "2px",
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const renderHighlights = (files?: Set<string>) =>
    highlights.render(files, (ed, rel) =>
      settings.highlights && rel ? rangesFor(ed.document, model.highlights.get(rel)) : [],
    );

  // Hit pulses: a brief flash on every onset ("bd*4" flashes four times a bar)
  const pulses = layer({
    backgroundColor: new vscode.ThemeColor("strudel.pulseBackground"),
    border: "1px solid",
    borderColor: new vscode.ThemeColor("strudel.pulseBorder"),
    borderRadius: "2px",
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  let pulseTimer: ReturnType<typeof setTimeout> | undefined;
  let pulseTimerAt = Infinity;
  const renderPulses = (files?: Set<string>) => {
    const now = Date.now();
    pulses.render(files, (ed, rel) =>
      settings.highlights && settings.pulses && rel
        ? rangesFor(ed.document, { ranges: model.pulses.active(rel, now), version: model.pulses.version(rel) })
        : [],
    );
    // redraw once more when the next pulse is over
    const next = model.pulses.nextExpiry();
    if (next !== null && next < pulseTimerAt) {
      if (pulseTimer) clearTimeout(pulseTimer);
      pulseTimerAt = next;
      pulseTimer = setTimeout(() => {
        pulseTimer = undefined;
        pulseTimerAt = Infinity;
        renderPulses();
      }, Math.max(5, next - now + 1));
    }
  };

  // Muted (or solo-silenced) tracks: their whole definition is dimmed
  const dimmed = layer({ opacity: "0.4", rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
  const silentTracks = (doc: vscode.TextDocument, rel: string | null) => {
    const mix = rel && isSongPath(rel) ? model.tracksOf(rel) : null;
    if (!mix) return [];
    return tracksIn(doc).tracks.filter((t) => mix.tracks.includes(t.name) && !isAudible(t.name, mix.muted, mix.soloed));
  };
  const renderDim = () =>
    dimmed.render(undefined, (ed, rel) => {
      if (!settings.dim) return [];
      const index = docInfo(ed.document).index;
      return silentTracks(ed.document, rel).map((t) => toRange(index, t.start, t.end));
    });

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

  // ── CodeLens: ▶ Play / ■ Stop, and a mute/solo strip above each track ──────

  const lensChanged = new vscode.EventEmitter<void>();
  const lens = (doc: vscode.TextDocument, offset: number, title: string, tooltip: string, command: string, args: unknown[] = []) => {
    const pos = doc.positionAt(offset);
    return new vscode.CodeLens(new vscode.Range(pos, pos), { title, tooltip, command, arguments: args });
  };
  const lensProvider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: lensChanged.event,
    provideCodeLenses(doc) {
      const file = songFileOf(doc);
      if (!file) return [];
      const lenses: vscode.CodeLens[] = [];
      if (config().get<boolean>("codeLens", true)) {
        const playingThis = model.playing && model.isCurrent(file);
        for (const offset of findCreatePattern(doc.getText())) {
          lenses.push(
            playingThis
              ? lens(doc, offset, "■ Stop", "Stop playback (Ctrl+.)", "strudel.stop")
              : lens(doc, offset, "▶ Play", "Play this song in the Strudel player", "strudel.playFile", [doc.uri]),
          );
        }
      }
      const mix = settings.mixerLens ? model.tracksOf(file) : null;
      if (mix) lenses.push(...mixerLenses(doc, mix));
      return lenses;
    },
  };
  function mixerLenses(doc: vscode.TextDocument, mix: { tracks: string[]; muted: string[]; soloed: string[] }) {
    const out: vscode.CodeLens[] = [];
    const found = tracksIn(doc);
    const soloing = mix.soloed.length > 0;
    for (const t of found.tracks) {
      if (!mix.tracks.includes(t.name)) continue;
      const muted = mix.muted.includes(t.name);
      const soloed = mix.soloed.includes(t.name);
      const mute = [t.name];
      const mTitle = muted ? "unmute" : "mute";
      const mTip = `${muted ? "Unmute" : "Mute"} ${t.name}`;
      const sTip = `${soloed ? "Unsolo" : "Solo"} ${t.name}`;
      if (soloed) {
        out.push(lens(doc, t.start, "🎧 solo · unsolo", sTip, "strudel.soloTrack", mute));
        out.push(lens(doc, t.start, mTitle, mTip, "strudel.muteTrack", mute));
      } else if (soloing) {
        out.push(lens(doc, t.start, `🔈 silent (solo)${muted ? ", muted" : ""} · solo`, sTip, "strudel.soloTrack", mute));
        out.push(lens(doc, t.start, mTitle, mTip, "strudel.muteTrack", mute));
      } else if (muted) {
        out.push(lens(doc, t.start, "🔇 muted · unmute", mTip, "strudel.muteTrack", mute));
        out.push(lens(doc, t.start, "solo", sTip, "strudel.soloTrack", mute));
      } else {
        out.push(lens(doc, t.start, "🔊 on · mute", mTip, "strudel.muteTrack", mute));
        out.push(lens(doc, t.start, "solo", sTip, "strudel.soloTrack", mute));
      }
    }
    if (found.returnAt !== null && (mix.muted.length || mix.soloed.length)) {
      const what = [mix.muted.length && `${mix.muted.length} muted`, mix.soloed.length && `${mix.soloed.length} soloed`]
        .filter(Boolean)
        .join(", ");
      out.push(lens(doc, found.returnAt, `🎚 ${what} · unmute all`, "Clear all mutes and solos", "strudel.unmuteAll"));
    }
    return out;
  }

  // ── Change fan-out ─────────────────────────────────────────────────────────

  function apply(ch: Changes) {
    if (ch.status) {
      renderStatus();
      updateContext();
      updateTicker();
    }
    if (ch.error) renderDiagnostics();
    if (ch.lens) lensChanged.fire();
    if (ch.mix) renderDim();
    if (ch.highlights.size) renderHighlights(ch.highlights);
    if (ch.pulses.size) renderPulses(ch.pulses);
    if (ch.reveal) void revealLocation(ch.reveal);
  }

  // ── Reveal: the player asks to open a file position ───────────────────────

  async function revealLocation(msg: RevealMsg) {
    const r = root();
    if (!r) return;
    const file = resolveIn(r, msg.file);
    if (!relativeTo(r, file)) return; // outside the project
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const line = Math.max(0, msg.line - 1);
      const pos = new vscode.Position(line, Math.max(0, (msg.column ?? 1) - 1));
      const shown = vscode.window.visibleTextEditors.find((ed) => ed.document === doc);
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: shown?.viewColumn,
        selection: new vscode.Range(pos, pos),
        preserveFocus: false,
      });
      editor?.revealRange?.(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      focusWindow(r, msg);
    } catch (e) {
      out.appendLine(`Reveal ${msg.file}:${msg.line} failed: ${e}`);
    }
  }

  /** Bring the editor window to the front (the click came from the browser). */
  function focusWindow(r: string, msg: RevealMsg) {
    const mode = config().get<string>("reveal.focusWindow", "auto");
    if (mode === "uri") {
      // the editor's own URL handler focuses the window that has the file
      void vscode.env.openExternal(
        vscode.Uri.parse(editorFileUrl(vscode.env.uriScheme, r, msg.file, msg.line, msg.column)),
      );
    } else if (mode === "auto" && process.platform === "darwin") {
      // activate the app (e.g. /Applications/Cursor.app), no prompt involved
      const app = /^(.*?\.app)(\/|$)/.exec(vscode.env.appRoot ?? "")?.[1];
      if (app) execFile("open", ["-a", app], () => {});
    }
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

  async function pickTrack(command: "mute" | "solo", track?: unknown) {
    if (!(await ensurePlayer())) return;
    if (typeof track === "string") {
      conn.send({ type: "command", command, track });
      return;
    }
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

  /** Section commands need a song with sections */
  async function withSections(): Promise<boolean> {
    if (!(await ensurePlayer())) return false;
    if (model.state?.sections?.length) return true;
    void vscode.window.showInformationMessage(
      "This song has no sections. Add `sections: FORM` (name + bars per section) to the song.",
    );
    return false;
  }

  async function jumpToSection(arg?: unknown) {
    if (!(await withSections())) return;
    if (typeof arg === "number" || typeof arg === "string") {
      conn.send({ type: "command", command: "jump", section: arg });
      return;
    }
    const s = model.state!;
    const sections = s.sections!;
    const pos = songPosition(s, model.stateAt, Date.now());
    const now = pos?.section?.index ?? s.section ?? null;
    type Item = vscode.QuickPickItem & { index: number };
    const items: Item[] = sections.map((sec, i) => ({
      label: `${i === now ? "$(play)" : i === s.pendingJump?.index ? "$(arrow-right)" : "$(blank)"} ${sec.name}`,
      description: `bars ${sec.start + 1}–${sec.start + sec.bars} · ${sec.bars} bars`,
      detail: i === now ? (s.loop ? "playing now, looping" : "playing now") : undefined,
      index: i,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      title: `Strudel: jump to section${s.playing ? " (on the next bar)" : " (play starts there)"}`,
      placeHolder: s.songName ?? undefined,
    });
    if (pick) conn.send({ type: "command", command: "jump", section: pick.index });
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
  reg("strudel.muteTrack", (track?: unknown) => pickTrack("mute", track));
  reg("strudel.soloTrack", (track?: unknown) => pickTrack("solo", track));
  reg("strudel.unmuteAll", () => sendCommand({ command: "unmuteAll" }));
  reg("strudel.jumpToSection", jumpToSection);
  reg("strudel.nextSection", async () => (await withSections()) && conn.send({ type: "command", command: "nextSection" }));
  reg("strudel.prevSection", async () => (await withSections()) && conn.send({ type: "command", command: "prevSection" }));
  reg("strudel.toggleLoop", async () => (await withSections()) && conn.send({ type: "command", command: "loop" }));
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

  // Track definitions move while you type: re-dim shortly after edits stop.
  let dimTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleDim = () => {
    if (dimTimer) clearTimeout(dimTimer);
    dimTimer = setTimeout(() => {
      dimTimer = undefined;
      renderDim();
    }, 150);
  };

  ctx.subscriptions.push(
    out,
    status,
    highlights.type,
    pulses.type,
    dimmed.type,
    diagnostics,
    lensChanged,
    vscode.languages.registerCodeLensProvider(
      [{ scheme: "file", language: "typescript", pattern: "**/src/songs/*.ts" }],
      lensProvider,
    ),
    vscode.window.onDidChangeActiveTextEditor(() => updateContext()),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      renderHighlights();
      renderPulses();
      renderDim();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!e.contentChanges.length) return;
      // Edited → on-disk offsets no longer match: clear right away.
      if (highlights.showsDocument(e.document)) renderHighlights();
      if (pulses.showsDocument(e.document)) renderPulses();
      if (dimmed.showsDocument(e.document) || (model.state?.muted?.length || model.state?.soloed?.length)) {
        if (songFileOf(e.document)) scheduleDim();
      }
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
      readSettings();
      if (e.affectsConfiguration("strudel.highlights")) {
        renderHighlights();
        renderPulses();
      }
      if (e.affectsConfiguration("strudel.mixer")) renderDim();
      if (e.affectsConfiguration("strudel.codeLens") || e.affectsConfiguration("strudel.mixer")) lensChanged.fire();
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
    if (pulseTimer) clearTimeout(pulseTimer);
    if (dimTimer) clearTimeout(dimTimer);
  };
  ctx.subscriptions.push({ dispose: () => disposeAll?.() });
}

export function deactivate(): void {
  disposeAll?.();
  disposeAll = undefined;
}
