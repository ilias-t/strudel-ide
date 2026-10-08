// Doc examples come from strudel.cc, whose transpiler turns every string into a pattern, so they
// call methods on string literals: n("0 2".add(3)). This IDE has no transpiler (CLAUDE.md), so the
// catalog rewrites them to the IDE form: n(mini("0 2").add(3)). Pure and mechanical:
//   - a string literal whose property is a Pattern member is wrapped in mini(…): "a".fast(2) and
//     operator chains like "110".mul.out(…) alike. Only Pattern members count, so "a b".split(" ")
//     stays, while "0 2".sub(1) is wrapped (String.prototype.sub is a legacy HTML method).
//   - strudel.cc's inline visuals (._scope(), ._pianoroll(), …) become the IDE's .scope(), … when
//     the name without the underscore is a Pattern member (the d.ts leaves `_x` names out).
// Everything else (comments, layout, string arguments) stays byte-identical.

import ts from "typescript";

/**
 * strudel.cc example → IDE form.
 * @param {string} code
 * @param {Set<string>} patternMembers names on the Pattern interface (from the d.ts)
 */
export function ideExample(code, patternMembers) {
  const sf = ts.createSourceFile("example.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (sf.parseDiagnostics?.length) return code; // not valid JS: leave it as written
  /** @type {{ start: number, end: number, text: string }[]} */
  const edits = [];
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      const receiver = node.expression;
      const name = node.name.text;
      const isString = ts.isStringLiteral(receiver) || ts.isNoSubstitutionTemplateLiteral(receiver);
      if (isString && patternMembers.has(name)) {
        edits.push({ start: receiver.getStart(sf), end: receiver.getStart(sf), text: "mini(" });
        edits.push({ start: receiver.end, end: receiver.end, text: ")" });
      } else if (name.startsWith("_") && patternMembers.has(name.slice(1))) {
        edits.push({ start: node.name.getStart(sf), end: node.name.getStart(sf) + 1, text: "" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // Edits never overlap (each touches its own literal's edges or one underscore): apply from the end
  let out = code;
  for (const { start, end, text } of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    out = out.slice(0, start) + text + out.slice(end);
  }
  return out;
}
