// Syntax errors of a TS song buffer (shared by the dev server's live eval,
// vite-plugins/strudel-live-eval.ts, and the browser compiler, ./compile.ts).

import type TS from "typescript";
import type { PlayerError } from "../live/protocol.ts";

/** The first syntax error of a TS buffer, located (1-based line/column), or null */
export function syntaxError(ts: typeof TS, text: string, file: string): PlayerError | null {
  const out = ts.transpileModule(text, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  const d = out.diagnostics?.find((x) => x.category === ts.DiagnosticCategory.Error && x.file && x.start !== undefined);
  if (!d) return null;
  const { line, character } = d.file!.getLineAndCharacterOfPosition(d.start!);
  return {
    message: `Syntax error: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
    file,
    line: line + 1,
    column: character + 1,
  };
}
