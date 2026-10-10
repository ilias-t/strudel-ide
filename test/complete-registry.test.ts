// The editor's live sound registry (src/ui/complete/registry.ts) over a fake of superdough's soundMap
// (test/fixtures/complete/sound-map.ts: the stage's real map after loading) and src/catalog/sounds.json.
// Run: node --test test/complete-registry.test.ts
import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../src/ui/complete/registry.ts";
import { fakeRegistry, fakeSoundMap, soundsCatalog } from "./fixtures/complete/sound-map.ts";

describe("what is registered", () => {
  const r = fakeRegistry();

  test("variant counts: arrays, pitched objects, synths, absent", () => {
    assert.equal(r.variants("bd"), 8);
    assert.equal(r.variants("rolandtr909_bd"), 4);
    assert.equal(r.variants("piano"), 29);
    assert.equal(r.variants("sawtooth"), 0);
    assert.equal(r.variants("wt_digital"), 0);
    assert.equal(r.variants("bdd"), null);
  });

  test("keys in any case; bank aliases are real keys", () => {
    assert.ok(r.has("bd"));
    assert.ok(r.has("BD"));
    assert.ok(r.has("RolandTR909_bd"));
    assert.ok(r.has("tr909_bd"));
    assert.equal(r.variants("TR909_bd"), 4);
    assert.ok(!r.has("bdd"));
  });

  test("zzfx is registered (the stage registers it, like the catalog says)", () => {
    assert.ok(r.has("zzfx"));
    assert.equal(r.type("zzfx"), "synth");
  });

  test("junk keys are dropped", () => {
    for (const junk of ["_base", "oberheimdmx_"]) {
      assert.ok(!r.has(junk), junk);
      assert.equal(r.variants(junk), null, junk);
    }
    assert.ok(!r.unbanked().includes("_base"));
    assert.ok(!r.bankParts("oberheimdmx").includes(""));
  });

  test("type and pitched", () => {
    assert.equal(r.type("bd"), "sample");
    assert.equal(r.type("sine"), "synth");
    assert.equal(r.type("wt_digital"), "wavetable");
    assert.equal(r.type("nope"), undefined);
    assert.ok(r.pitched("piano"));
    assert.ok(r.pitched("sawtooth"));
    assert.ok(r.pitched("wt_digital"));
    assert.ok(!r.pitched("bd"));
    assert.ok(!r.pitched("nope"));
  });

  test("kind comes from the catalog", () => {
    assert.equal(r.kind("bd"), "kick");
    assert.equal(r.kind("piano"), "keys");
    assert.equal(r.kind("sawtooth"), "synth");
    assert.equal(r.kind("nope"), undefined);
  });

  test("bankParts by canonical name or alias, any case", () => {
    const parts = r.bankParts("TR909");
    assert.ok(parts.includes("bd") && parts.includes("sd") && parts.includes("hh"), parts.join(" "));
    assert.deepEqual(r.bankParts("RolandTR909"), parts);
    assert.deepEqual(r.bankParts("rolandtr909"), parts);
    assert.deepEqual(r.bankParts("RolandTR90"), []);
  });

  test("banks(): every canonical name and alias with its parts", () => {
    const banks = r.banks();
    const tr = banks.find((b) => b.name === "RolandTR909");
    assert.ok(tr);
    assert.equal(tr.canonical, "RolandTR909");
    const alias = banks.find((b) => b.name === "TR909");
    assert.equal(alias?.canonical, "RolandTR909");
    assert.deepEqual(alias?.parts, tr.parts);
    assert.equal(new Set(banks.map((b) => b.canonical)).size, Object.keys(soundsCatalog().banks).length);
  });

  test("unbanked(): plays without a bank; no bank keys", () => {
    const u = r.unbanked();
    for (const s of ["bd", "piano", "sawtooth", "z_sine", "wt_digital"]) assert.ok(u.includes(s), s);
    assert.ok(!u.some((k) => k.startsWith("rolandtr909_") || k.startsWith("tr909_")));
  });

  test("banksWith(): the drum machines that have a part", () => {
    assert.ok(r.banksWith("lt").includes("RolandTR909"));
    assert.deepEqual(r.banksWith("piano"), []);
  });

  test("not degraded when every map loaded; catalogHas mirrors the catalog", () => {
    assert.equal(r.degraded(), false);
    assert.ok(r.catalogHas("bd") && r.catalogHas("tr909_bd") && r.catalogHas("RolandTR909_bd"));
    assert.ok(!r.catalogHas("bdd"));
  });
});

describe("a sample map that failed", () => {
  test("piano missing → degraded, and catalogHas still knows it", () => {
    const r = fakeRegistry({ omit: (k) => k === "piano" });
    assert.ok(!r.has("piano"));
    assert.ok(r.catalogHas("piano"));
    assert.equal(r.degraded(), true);
  });

  test("drum machines missing → degraded", () => {
    const r = fakeRegistry({ omit: (k) => k.startsWith("rolandtr909_") });
    assert.equal(r.degraded(), true);
  });

  test("not ready → not degraded (still loading)", () => {
    const r = fakeRegistry({ ready: false, omit: (k) => k === "piano" });
    assert.equal(r.degraded(), false);
  });
});

describe("change notifications", () => {
  test("~1500 setKeys while loading → one debounced onChange; version bumps once", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const map = fakeSoundMap({ empty: true });
      const r = createRegistry({ soundMap: map, catalog: soundsCatalog(), ready: () => false, debounceMs: 150 });
      let calls = 0;
      r.onChange(() => calls++);
      const v0 = r.version();
      map.load();
      assert.ok(map.fired > 1000);
      assert.equal(calls, 0);
      // reads are live before the debounce settles
      assert.ok(r.has("bd"));
      assert.equal(r.bankParts("TR909").length > 0, true);
      mock.timers.tick(149);
      assert.equal(calls, 0);
      mock.timers.tick(1);
      assert.equal(calls, 1);
      assert.equal(r.version(), v0 + 1);
      r.dispose();
    } finally {
      mock.timers.reset();
    }
  });

  test("ready() follows the injected readiness; refresh() notifies", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let ready = false;
      const r = createRegistry({ soundMap: fakeSoundMap(), catalog: soundsCatalog(), ready: () => ready, debounceMs: 50 });
      let calls = 0;
      r.onChange(() => calls++);
      assert.equal(r.ready(), false);
      ready = true;
      assert.equal(r.ready(), true);
      r.refresh();
      mock.timers.tick(50);
      assert.equal(calls, 1);
    } finally {
      mock.timers.reset();
    }
  });

  test("setCatalog(): kinds and banks arrive with the catalog, and listeners hear about it", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const r = createRegistry({ soundMap: fakeSoundMap(), catalog: null, ready: () => true, debounceMs: 10 });
      assert.equal(r.kind("bd"), undefined);
      assert.deepEqual(r.banks(), []);
      assert.ok(r.has("bd"));
      let calls = 0;
      const off = r.onChange(() => calls++);
      r.setCatalog(soundsCatalog());
      mock.timers.tick(10);
      assert.equal(calls, 1);
      assert.equal(r.kind("bd"), "kick");
      assert.ok(r.banks().length > 0);
      off();
      r.setCatalog(soundsCatalog());
      mock.timers.tick(10);
      assert.equal(calls, 1, "unsubscribed");
    } finally {
      mock.timers.reset();
    }
  });

  test("dispose() stops listening to the map", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const map = fakeSoundMap({ empty: true });
      const r = createRegistry({ soundMap: map, catalog: soundsCatalog(), ready: () => true, debounceMs: 10 });
      let calls = 0;
      r.onChange(() => calls++);
      r.dispose();
      map.load();
      mock.timers.tick(100);
      assert.equal(calls, 0);
    } finally {
      mock.timers.reset();
    }
  });
});

test("reads are fast over the full map", () => {
  const r = fakeRegistry();
  r.bankParts("TR909");
  r.unbanked();
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) {
    r.has("bd");
    r.bankParts("TR909");
    r.variants("rolandtr909_bd");
    r.unbanked();
  }
  assert.ok(performance.now() - t0 < 50, `${performance.now() - t0} ms`);
});
