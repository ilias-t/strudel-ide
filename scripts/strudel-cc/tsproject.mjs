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
// Parsed declaration/lib files, shared by every program this process makes
// (the Strudel declarations alone are ~12k lines; parsing them once matters
// when an import type-checks a song several times over)
const parsed = new Map();
let previous;

export function createSongProgram(file, text) {
  file = resolve(file);
  const opts = compilerOptions();
  const host = ts.createCompilerHost(opts, true);
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (name, lang, ...rest) => {
    if (resolve(name) === file) {
      return text !== undefined ? ts.createSourceFile(name, text, lang, true) : getSourceFile.call(host, name, lang, ...rest);
    }
    if (!name.endsWith(".d.ts")) return getSourceFile.call(host, name, lang, ...rest);
    let sf = parsed.get(name);
    if (!sf) parsed.set(name, (sf = getSourceFile.call(host, name, lang, ...rest)));
    return sf;
  };
  if (text !== undefined) {
    host.fileExists = (name) => resolve(name) === file || fileExists.call(host, name);
    host.readFile = (name) => (resolve(name) === file ? text : readFile.call(host, name));
  }
  const program = ts.createProgram({ rootNames: [file, ...ambientFiles()], options: opts, host, oldProgram: previous });
  previous = program;
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
