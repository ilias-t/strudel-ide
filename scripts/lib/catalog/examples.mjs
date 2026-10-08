// Doc examples come from strudel.cc, whose transpiler turns every string into a pattern, so they
// call methods on string literals: n("0 2".add(3)). This IDE has no transpiler (CLAUDE.md), so the
// catalog rewrites them to the IDE form: n(mini("0 2").add(3)). Pure and mechanical: only a string
// literal that is the receiver of a call to a non-String method is wrapped; everything else
// (comments, layout, string arguments, "a b".split(" ")) stays byte-identical.

import ts from "typescript";

/** strudel.cc example → the same code with `mini(…)` around string literals that receive pattern methods */
export function ideExample(code) {
  const sf = ts.createSourceFile("example.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (sf.parseDiagnostics?.length) return code; // not valid JS: leave it as written
  /** @type {{ start: number, end: number }[]} */
  const wraps = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression;
      const isString = ts.isStringLiteral(receiver) || ts.isNoSubstitutionTemplateLiteral(receiver);
      if (isString && !(node.expression.name.text in String.prototype)) {
        wraps.push({ start: receiver.getStart(sf), end: receiver.end });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // String literals never nest, so the ranges are disjoint: apply from the end
  let out = code;
  for (const { start, end } of wraps.sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, start)}mini(${out.slice(start, end)})${out.slice(end)}`;
  }
  return out;
}
