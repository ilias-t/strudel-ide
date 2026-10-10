// "Hear sounds as you browse" (src/ui/discover/preview-setting.ts): off by default, toggled, remembered.
// Run: node --test test/discover-preview-setting.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};

const setting = await import("../src/ui/discover/preview-setting.ts");

test("off by default; toggling turns it on, tells listeners, and is remembered under strudel-ide:previews", () => {
  assert.equal(setting.previewsEnabled(), false);
  const seen: boolean[] = [];
  const off = setting.onPreviewsChange((on) => seen.push(on));
  assert.equal(setting.togglePreviews(), true);
  assert.equal(setting.previewsEnabled(), true);
  assert.equal(store.get("strudel-ide:previews"), "on");
  setting.setPreviewsEnabled(false);
  assert.equal(store.get("strudel-ide:previews"), "off");
  off();
  setting.togglePreviews();
  assert.deepEqual(seen, [true, false]);
});

test("a stored choice is read back (a reload)", () => {
  store.set("strudel-ide:previews", "on");
  setting.resetForTests();
  assert.equal(setting.previewsEnabled(), true);
  store.set("strudel-ide:previews", "garbage");
  setting.resetForTests();
  assert.equal(setting.previewsEnabled(), false);
});
