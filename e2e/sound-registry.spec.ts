// The sounds the engine registers are the sounds the catalog (and so the
// library, the palette, completions and check-songs) says exist. The catalog
// once listed zzfx and its six z_* sounds while the stage never registered
// them, so s("zzfx") failed with "sound zzfx not found".

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./fixture.ts";
import { expect, test } from "./player.ts";

interface SoundsJson {
  sounds: Record<string, { source?: string; count?: number }>;
  banks: Record<string, { aliases: string[]; parts: string[] }>;
}

const catalog = JSON.parse(readFileSync(join(ROOT, "src/catalog/sounds.json"), "utf8")) as SoundsJson;

test.afterEach(async ({ player }) => {
  expect(player.errors, "console/page errors").toEqual([]);
});

test("every sound and bank part the catalog lists is registered once samples are loaded", async ({ player, page }) => {
  await player.boot();
  const live = new Set(await page.evaluate(() => window.__strudel!.sounds()));

  for (const name of ["zzfx", "z_sine", "z_sawtooth", "z_triangle", "z_square", "z_tan", "z_noise"]) {
    expect(live.has(name), `${name} is registered`).toBe(true);
  }
  const unbanked = Object.entries(catalog.sounds)
    .filter(([, info]) => info.count !== undefined || info.source === "superdough")
    .map(([name]) => name.toLowerCase());
  expect(unbanked.filter((name) => !live.has(name)), "unbanked sounds missing from the engine").toEqual([]);
  const banked = Object.entries(catalog.banks).flatMap(([bank, info]) =>
    [bank, ...info.aliases].flatMap((b) => info.parts.map((part) => `${b}_${part}`.toLowerCase()))
  );
  expect(banked.filter((key) => !live.has(key)), "bank parts missing from the engine").toEqual([]);
});
