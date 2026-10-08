// The browser editor's path into the engine (src/ui/editor-source.ts), through
// its injectable core: the engine may not exist yet (evalSource lands from
// another stream), may reject, and every call is recorded for e2e tests.
//
// Run: node --test test/editor-source.test.ts   (Node ≥ 22.18 strips TS types)

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createEditorSource } from "../src/ui/editor-source-core.ts";
import type { EvalResult, EvalSource } from "../src/ui/editor-types.ts";

function setup(engine?: EvalSource) {
  let current: EvalSource | undefined = engine;
  const logs: string[] = [];
  let now = 1000;
  const source = createEditorSource({
    getEngine: () => current,
    now: () => now++,
    log: (msg) => logs.push(msg),
  });
  return { source, logs, setEngine: (e: EvalSource | undefined) => (current = e) };
}

describe("editor source", () => {
  test("calls the engine with the browser origin and returns its result", async () => {
    const seen: unknown[] = [];
    const result: EvalResult = { ok: true, version: "abc" };
    const { source } = setup(async (songId, text, opts) => {
      seen.push([songId, text, opts]);
      return result;
    });
    assert.equal(source.hasEngine(), true);
    assert.deepEqual(await source.evalEdit("jynx", "TEXT", "typing"), result);
    assert.deepEqual(seen, [["jynx", "TEXT", { intent: "typing", origin: "browser" }]]);
  });

  test("without an engine the call is only recorded and resolves null", async () => {
    const { source } = setup();
    assert.equal(source.hasEngine(), false);
    assert.equal(await source.evalEdit("jynx", "T1", "commit"), null);
    assert.deepEqual(source.calls(), [{ songId: "jynx", text: "T1", intent: "commit", origin: "browser", at: 1000 }]);
  });

  test("without an engine it says so once, not per keystroke", async () => {
    const { source, logs } = setup();
    await source.evalEdit("jynx", "T1", "typing");
    await source.evalEdit("jynx", "T2", "typing");
    await source.evalEdit("jynx", "T3", "commit");
    assert.equal(logs.length, 1);
    assert.match(logs[0], /evalSource/);
  });

  test("the engine is looked up at call time, so it can appear later", async () => {
    const { source, setEngine } = setup();
    assert.equal(await source.evalEdit("jynx", "T1", "typing"), null);
    setEngine(async () => ({ ok: true, version: "v" }));
    assert.equal(source.hasEngine(), true);
    assert.deepEqual(await source.evalEdit("jynx", "T2", "typing"), { ok: true, version: "v" });
  });

  test("a rejected engine promise becomes an error result", async () => {
    const { source } = setup(async () => {
      throw new Error("import failed");
    });
    assert.deepEqual(await source.evalEdit("jynx", "T", "commit"), { ok: false, error: { message: "import failed" } });
  });

  test("an engine that throws synchronously becomes an error result", async () => {
    const { source } = setup(() => {
      throw "boom";
    });
    assert.deepEqual(await source.evalEdit("jynx", "T", "commit"), { ok: false, error: { message: "boom" } });
  });

  test("records engine calls too, newest last, bounded", async () => {
    const { source } = setup(async () => ({ ok: true, version: "v" }));
    for (let i = 0; i < 60; i++) await source.evalEdit("jynx", `T${i}`, "typing");
    const calls = source.calls();
    assert.equal(calls.length, 50);
    assert.equal(calls[0].text, "T10");
    assert.equal(calls.at(-1)?.text, "T59");
  });

  test("a non-function evalSource counts as no engine", async () => {
    const { source } = setup("nope" as unknown as EvalSource);
    assert.equal(source.hasEngine(), false);
    assert.equal(await source.evalEdit("jynx", "T", "typing"), null);
  });
});
