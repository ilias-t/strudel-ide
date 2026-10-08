// A TypeScript program for one song file with the project's settings and the
// ambient Strudel declarations (src/*.d.ts), optionally with the song's text
// supplied in memory (to type-check an import before writing it).

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { root } from "./runtime.mjs";

let options;

function compilerOptions() {
  if (options) return options;
  const configPath = join(root, "tsconfig.json");
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  options = ts.parseJsonConfigFileContent(config, ts.sys, root).options;
  return options;
}

/** Ambient declaration files under src/ (strudel*.d.ts, knobs.d.ts, vite-env.d.ts, …) */
export function ambientFiles() {
  return readdirSync(join(root, "src"))
    .filter((f) => f.endsWith(".d.ts"))
    .map((f) => join(root, "src", f));
}

/**
 * @param {string} file absolute path of the song (it need not exist when `text` is given)
 * @param {string} [text] in-memory contents for `file`
 */
export function createSongProgram(file, text) {
  file = resolve(file);
  const opts = compilerOptions();
  const host = ts.createCompilerHost(opts, true);
  if (text !== undefined) {
    const { getSourceFile, fileExists, readFile } = host;
    host.getSourceFile = (name, lang, ...rest) =>
      resolve(name) === file ? ts.createSourceFile(name, text, lang, true) : getSourceFile.call(host, name, lang, ...rest);
    host.fileExists = (name) => resolve(name) === file || fileExists.call(host, name);
    host.readFile = (name) => (resolve(name) === file ? text : readFile.call(host, name));
  }
  const program = ts.createProgram({ rootNames: [file, ...ambientFiles()], options: opts, host });
  return { program, checker: program.getTypeChecker(), sourceFile: program.getSourceFile(file) };
}

/** Type errors in `file` (syntactic + semantic) as { line, message } */
export function songDiagnostics(file, text) {
  const { program, sourceFile } = createSongProgram(file, text);
  const diags = [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)];
  return diags.map((d) => {
    const { line } = d.start !== undefined ? sourceFile.getLineAndCharacterOfPosition(d.start) : { line: -1 };
    return { line, start: d.start, code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, " ") };
  });
}

export { ts };
