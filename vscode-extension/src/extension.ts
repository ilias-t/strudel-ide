// VS Code glue for Strudel Live. Logic lives in the vscode-free modules next to
// this file (unit-tested in Node); this file only wires them to the editor UI.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  contentVersion,
  editorFileUrl,
  type CommandMsg,
  type EvalResultMsg,
  type KnobState,
  type KnobWriteMsg,
  type RevealMsg,
} from "../../src/live/protocol.ts";
import { BridgeConnection } from "./connection.ts";
import { readDiscovery, resolveEndpoint, type Endpoint } from "./discovery.ts";
import { EditHistory } from "./edits.ts";
import {
  findKnobCalls,
  formatValue,
  knobHints,
  knobValueEdits,
  parseKnobInput,
  stepKnob,
  type KnobCall,
} from "./knobs.ts";
import { DEFAULT_DELAY_MS, LiveEvaluator, liveEvalMode } from "./live-eval.ts";
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
    { version: number; index: LineIndex; hash?: string; tracks?: SongTracks; knobCalls?: KnobCall[] }
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
  const knobCallsIn = (doc: vscode.TextDocument): KnobCall[] => {
    const info = docInfo(doc);
    info.knobCalls ??= findKnobCalls(doc.getText());
    return info.knobCalls;
  };
  const hashOf = (doc: vscode.TextDocument): string => {
    const info = docInfo(doc);
    info.hash ??= contentVersion(doc.getText());
    return info.hash;
  };
  /** Text versions the player may refer to, and the edits since (highlights survive typing) */
  const histories = new WeakMap<vscode.TextDocument, EditHistory>();
  const historyOf = (doc: vscode.TextDocument): EditHistory => {
    let h = histories.get(doc);
    if (!h) histories.set(doc, (h = new EditHistory()));
    return h;
  };
  const toRange = (index: LineIndex, start: number, end: number) => {
    const a = index.positionAt(start);
    const b = index.positionAt(end);
    return new vscode.Range(a.line, a.character, b.line, b.character);
  };
  /**
   * Offsets refer to one version of the text (the saved file, or an evaluated
   * buffer): shown when the document's text is that version, carried across
   * the edits made since when it was (ranges an edit touched are dropped), and
   * skipped otherwise. Unversioned offsets are only trusted on saved documents.
   */
  const rangesFor = (
    doc: vscode.TextDocument,
    msg: { ranges: unknown; version?: string } | undefined,
  ): vscode.Range[] => {
    if (!msg) return [];
    const info = docInfo(doc);
    let ranges: unknown = msg.ranges;
    if (msg.version !== undefined) {
      if (hashOf(doc) === msg.version) historyOf(doc).mark(msg.version);
      else {
        const mapped = Array.isArray(msg.ranges) ? histories.get(doc)?.map(msg.version, msg.ranges) : null;
        if (!mapped) return [];
        ranges = mapped;
      }
    } else if (doc.isDirty) return [];
    return toSpans(info.index, ranges).map(
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
    knobHints: true,
    knobLens: true,
  };
  const readSettings = () => {
    const c = config();
    settings.highlights = c.get<boolean>("highlights.enabled", true);
    settings.pulses = c.get<boolean>("highlights.pulses", true);
    settings.dim = c.get<boolean>("mixer.dimMuted", true);
    settings.mixerLens = c.get<boolean>("mixer.codeLens", true);
    settings.knobHints = c.get<boolean>("knobs.hints", true);
    settings.knobLens = c.get<boolean>("knobs.codeLens", true);
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

  // Knob values: an inline hint after each knob(…) call, amber while the live
  // value differs from the code. Redrawn only when an editor's hints change.
  const knobHintType = vscode.window.createTextEditorDecorationType({
    after: { margin: "0 0 0 0.5em" },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const hintKeys = new WeakMap<vscode.TextEditor, string>();
  const renderKnobHints = () => {
    for (const ed of vscode.window.visibleTextEditors) {
      const rel = relOf(ed.document);
      const knobs = settings.knobHints && isSongPath(rel) ? model.knobsOf(rel) : [];
      const hints = knobs.length ? knobHints(knobCallsIn(ed.document), knobs) : [];
      const key = hints.map((h) => `${h.offset}:${h.text}:${h.dirty}`).join("|");
      if ((hintKeys.get(ed) ?? "") === key) continue;
      hintKeys.set(ed, key);
      const index = docInfo(ed.document).index;
      ed.setDecorations(
        knobHintType,
        hints.map((h) => ({
          range: toRange(index, h.offset, h.offset),
          hoverMessage: h.title,
          renderOptions: {
            after: {
              contentText: h.text,
              color: new vscode.ThemeColor(h.dirty ? "strudel.knobDirtyForeground" : "strudel.knobForeground"),
            },
          },
        })),
      );
    }
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
      if (settings.knobLens) lenses.push(...knobLenses(doc, model.knobsOf(file)));
      return lenses;
    },
  };
  /** "write" / "reset" above each knob whose live value differs from the code */
  function knobLenses(doc: vscode.TextDocument, knobs: KnobState[]) {
    const out: vscode.CodeLens[] = [];
    const calls = knobCallsIn(doc);
    for (const k of knobs) {
      if (!k.dirty) continue;
      const call = calls.find((c) => c.name === k.name);
      if (!call) continue;
      const where = doc.isDirty ? "into the editor (unsaved)" : "into the file";
      out.push(lens(doc, call.start, `◉ ${k.name} changed · write`, `Write the live value of ${k.name} ${where}`, "strudel.writeKnob", [k.name]));
      out.push(lens(doc, call.start, "reset", `Back to the value in the code (${formatValue(k, k.def)})`, "strudel.resetKnob", [k.name]));
    }
    return out;
  }
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
    if (ch.knobs) {
      renderKnobHints();
      for (const l of knobListeners) l();
    }
    if (ch.knobWrite) onKnobWrite(ch.knobWrite);
    if (ch.evalResult) onEvalResult(ch.evalResult);
  }

  // ── Live eval: the unsaved buffer → the player ────────────────────────────

  const docOfFile = (file: string) => vscode.workspace.textDocuments.find((d) => songFileOf(d) === file);
  /** Ctrl/Cmd+Enter evaluates unsaved text instead of saving it */
  const liveOn = () => liveEvalMode(config().get<string>("liveEval")) !== "off";
  const liveEval = new LiveEvaluator({
    mode: () => liveEvalMode(config().get<string>("liveEval")),
    delay: () => config().get<number>("liveEvalDelay", DEFAULT_DELAY_MS),
    // pauses only update the song that's loaded: typing elsewhere never switches the music
    eligible: (file) => model.player && model.isCurrent(file),
    send: (file, text, version, play) => {
      const sent = conn.send({ type: "eval", file, text, version, ...(play ? { play } : {}) });
      const doc = sent ? docOfFile(file) : undefined;
      if (doc && hashOf(doc) === version) historyOf(doc).mark(version);
      return sent;
    },
  });

  const shownErrors = new Map<string, number>();
  function onEvalResult(r: EvalResultMsg) {
    out.appendLine(
      `Eval ${r.file}@${r.version}: ${r.ok ? (r.applied ? "playing" : "kept for when the song is selected") : r.error?.message ?? "failed"}`,
    );
    // located errors become diagnostics (state.error); setup problems need a message
    if (r.ok || !r.error || r.error.line !== undefined) return;
    const now = Date.now();
    if ((shownErrors.get(r.error.message) ?? 0) > now - 5000) return;
    shownErrors.set(r.error.message, now);
    void vscode.window.showWarningMessage(`Strudel: ${r.error.message}`);
  }

  // ── Knobs ──────────────────────────────────────────────────────────────────

  /** Open knob steppers redraw when values arrive */
  const knobListeners = new Set<() => void>();
  const knobNamed = (name: string) => model.knobs?.knobs.find((k) => k.name === name);

  function onKnobWrite(r: KnobWriteMsg) {
    if (r.ok) {
      const what = (r.changes ?? []).map((c) => `${c.name} = ${c.literal}`).join(", ");
      if (what) out.appendLine(`Wrote ${what} into ${r.file}`);
    } else void vscode.window.showWarningMessage(`Strudel: ${r.error ?? "could not write the knob"}`);
  }

  /** The knob(…) call under the cursor in the active editor */
  function knobAtCursor(): string | undefined {
    const ed = vscode.window.activeTextEditor;
    const pos = ed?.selection?.active;
    if (!ed || !pos || !songFileOf(ed.document)) return undefined;
    const offset = ed.document.offsetAt(pos);
    return knobCallsIn(ed.document).find((c) => offset >= c.start && offset <= c.end)?.name;
  }

  async function pickKnob(arg: unknown, only?: (k: KnobState) => boolean): Promise<KnobState | undefined> {
    if (!(await ensurePlayer())) return undefined;
    if (typeof arg === "string") return knobNamed(arg);
    const knobs = (model.knobs?.knobs ?? []).filter((k) => !only || only(k));
    if (!knobs.length) {
      void vscode.window.showInformationMessage(
        only
          ? "No knob has been turned away from the value in the code."
          : 'This song has no knobs. Put knob("name", value, min, max) where a number goes.',
      );
      return undefined;
    }
    const atCursor = knobAtCursor();
    const cursorKnob = atCursor ? knobs.find((k) => k.name === atCursor) : undefined;
    if (cursorKnob) return cursorKnob;
    if (knobs.length === 1) return knobs[0];
    type Item = vscode.QuickPickItem & { name: string };
    const pick = await vscode.window.showQuickPick<Item>(
      knobs.map((k) => ({
        label: `◉ ${k.name}`,
        description: `${formatValue(k)}${k.dirty ? ` (code: ${formatValue(k, k.def)})` : ""}`,
        detail: `${formatValue(k, k.min)}–${formatValue(k, k.max)}${k.log ? ", log" : ""}`,
        name: k.name,
      })),
      { title: "Strudel: knob", placeHolder: model.state?.songName ?? undefined },
    );
    return pick && knobNamed(pick.name);
  }

  const knobCommand = (msg: Omit<CommandMsg, "type">) => conn.send({ type: "command", ...msg });

  /**
   * A stepper for one knob: −/+ a step, −/+ 5% of its travel, type a value
   * (or just type a number and Enter), reset, write. It stays open while you
   * step, and holds the knob meanwhile so file edits don't reset it.
   */
  async function adjustKnob(arg?: unknown) {
    const knob = await pickKnob(arg);
    if (!knob) return;
    const name = knob.name;
    type Item = vscode.QuickPickItem & { steps?: number; coarse?: boolean; action?: "type" | "reset" | "write" };
    const qp = vscode.window.createQuickPick<Item>();
    let value = knob.value;
    const items = (k: KnobState): Item[] => [
      { label: "$(remove) step down", description: `−${formatValue(k, k.step)}`, steps: -1 },
      { label: "$(add) step up", description: `+${formatValue(k, k.step)}`, steps: 1 },
      { label: "$(chevron-down) down 5%", steps: -1, coarse: true },
      { label: "$(chevron-up) up 5%", steps: 1, coarse: true },
      { label: "$(edit) type a value…", action: "type" },
      { label: `$(discard) reset to ${formatValue(k, k.def)}`, description: "the value in the code", action: "reset" },
      {
        label: "$(save) write to file",
        description: docOfFile(model.knobs?.file ?? "")?.isDirty ? "into the editor (unsaved)" : undefined,
        action: "write",
      },
    ];
    const render = () => {
      const k = knobNamed(name);
      if (!k) return void qp.hide(); // the song changed
      qp.title = `◉ ${name} = ${formatValue(k, value)}${k.dirty ? `  (code: ${formatValue(k, k.def)})` : ""}`;
      qp.placeholder = `${formatValue(k, k.min)}–${formatValue(k, k.max)}, step ${formatValue(k, k.step)}: pick a step, or type a number and press Enter`;
    };
    const onValues = () => {
      const k = knobNamed(name);
      if (k) value = k.value;
      render();
    };
    qp.items = items(knob);
    render();
    knobListeners.add(onValues);
    const set = (v: number) => {
      value = v;
      knobCommand({ command: "setKnob", knob: name, value: v });
      render();
    };
    qp.onDidAccept(async () => {
      const k = knobNamed(name);
      if (!k) return qp.hide();
      const typed = qp.value.trim();
      if (typed && /^[-+.\d]/.test(typed)) {
        const parsed = parseKnobInput(k, typed);
        if ("error" in parsed) qp.placeholder = parsed.error;
        else set(parsed.value);
        qp.value = "";
        return;
      }
      const item = qp.selectedItems[0] ?? qp.activeItems[0];
      if (!item) return;
      if (item.steps) return set(stepKnob({ ...k, value }, item.steps, item.coarse));
      if (item.action === "reset") {
        value = k.def;
        knobCommand({ command: "resetKnob", knob: name });
        return render();
      }
      qp.hide();
      if (item.action === "write") return void writeKnobs([name]);
      if (item.action === "type") {
        const input = await vscode.window.showInputBox({
          title: `◉ ${name}`,
          value: formatValue(k, value),
          prompt: `${formatValue(k, k.min)}–${formatValue(k, k.max)}`,
          validateInput: (v: string) => {
            const r = parseKnobInput(k, v);
            return "error" in r ? r.error : undefined;
          },
        });
        const r = input === undefined ? null : parseKnobInput(k, input);
        if (r && "value" in r) knobCommand({ command: "setKnob", knob: name, value: r.value });
      }
    });
    qp.onDidHide(() => {
      knobListeners.delete(onValues);
      knobCommand({ command: "grabKnob", knob: name, on: false });
      qp.dispose();
    });
    knobCommand({ command: "grabKnob", knob: name, on: true });
    qp.show();
  }

  /**
   * Write knobs' live values into the code. A saved document: the dev server
   * rewrites the file (Vite HMR swaps it, seamlessly). A document with unsaved
   * changes: the file isn't what plays, so the values go into the editor
   * buffer instead (and are evaluated right away unless live eval is off).
   */
  async function writeKnobs(names?: string[]) {
    if (!(await ensurePlayer())) return;
    const msg = model.knobs;
    const knobs = (msg?.knobs ?? []).filter((k) => (names ? names.includes(k.name) : k.dirty));
    if (!msg || !knobs.length) {
      void vscode.window.showInformationMessage("No knob has been turned away from the value in the code.");
      return;
    }
    const doc = docOfFile(msg.file);
    if (!doc?.isDirty) {
      knobCommand({ command: "writeKnobs", knobs: knobs.map((k) => k.name), file: msg.file });
      return;
    }
    const text = doc.getText();
    const edit = new vscode.WorkspaceEdit();
    const index = docInfo(doc).index;
    for (const k of knobs) {
      const r = knobValueEdits(text, k.name, k.value);
      if ("error" in r) {
        void vscode.window.showWarningMessage(`Strudel: ${r.error}`);
        return;
      }
      for (const e of r.edits) edit.replace(doc.uri, toRange(index, e.start, e.end), e.text);
    }
    if (!(await vscode.workspace.applyEdit(edit))) return;
    out.appendLine(`Wrote ${knobs.map((k) => `${k.name} = ${formatValue(k)}`).join(", ")} into the unsaved ${msg.file}`);
    if (liveOn()) liveEval.evaluate(msg.file, doc.getText());
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
    const sends = actions.filter((a) => a.kind !== "save");
    if (sends.length && !(await ensurePlayer())) {
      // still save: saving is how changes are applied
      if (doc && actions.some((a) => a.kind === "save")) await doc.save();
      return;
    }
    for (const a of actions) {
      if (a.kind === "save") await doc?.save();
      else if (a.kind === "eval") {
        const file = songFileOf(doc);
        if (doc && file) liveEval.evaluate(file, doc.getText(), a.play);
      } else conn.send(a.msg);
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
    const doc = ed?.document;
    const file = songFileOf(doc);
    const opts = { live: liveOn(), version: doc && file ? hashOf(doc) : undefined };
    await run(planEvaluate(model, file, !!doc?.isDirty, opts), doc);
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
    const plan: Action[] = !doc?.isDirty
      ? planPlayFile(model, file)
      : liveOn()
        ? [{ kind: "eval", play: true }]
        : [{ kind: "save" }, ...planPlayFile(model, file)];
    await run(plan, doc);
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
  reg("strudel.adjustKnob", adjustKnob);
  reg("strudel.writeKnob", async (name?: unknown) => {
    const k = await pickKnob(name, (x) => x.dirty);
    if (k) await writeKnobs([k.name]);
  });
  reg("strudel.writeKnobs", () => writeKnobs());
  reg("strudel.resetKnob", async (name?: unknown) => {
    const k = await pickKnob(name, (x) => x.dirty);
    if (k) knobCommand({ command: "resetKnob", knob: k.name });
  });
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
    knobHintType,
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
      renderKnobHints();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!e.contentChanges.length) return;
      const file = songFileOf(e.document);
      if (file) {
        // carry the highlights' offsets across the edit (touched tokens go dark)
        histories.get(e.document)?.record(
          e.contentChanges.map((c) => ({ offset: c.rangeOffset, length: c.rangeLength, inserted: c.text.length })),
        );
        liveEval.changed({ file, text: () => e.document.getText(), dirty: () => e.document.isDirty });
      }
      if (highlights.showsDocument(e.document)) renderHighlights();
      if (pulses.showsDocument(e.document)) renderPulses();
      if (file && model.knobs?.file === file) renderKnobHints();
      if (dimmed.showsDocument(e.document) || (model.state?.muted?.length || model.state?.soloed?.length)) {
        if (file) scheduleDim();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const rel = relOf(doc);
      const file = songFileOf(doc);
      if (file) {
        liveEval.saved(file); // Vite HMR takes it from here
        historyOf(doc).mark(hashOf(doc));
      }
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
      if (e.affectsConfiguration("strudel.knobs")) renderKnobHints();
      if (["strudel.codeLens", "strudel.mixer", "strudel.knobs"].some((k) => e.affectsConfiguration(k))) lensChanged.fire();
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
    liveEval.dispose();
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
