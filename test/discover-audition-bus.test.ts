// Auditions play on a bus of their own (src/ui/discover/audition-bus.ts): the
// orbit effects a sound reaches (djf, delay, reverb) are per orbit and shared
// by everything on it, so an audition on the song's orbit would filter the
// playing song, and keep filtering it after the audition ends.
//
// Run: node --test test/discover-audition-bus.test.ts

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AUDITION_ORBIT, AuditionBus } from "../src/ui/discover/audition-bus.ts";

describe("the audition bus", () => {
  test("every value goes to the audition orbit, whatever orbit it asked for", () => {
    const bus = new AuditionBus();
    assert.equal(bus.route({ s: "bd" }).orbit, AUDITION_ORBIT);
    assert.equal(bus.route({ s: "bd", orbit: 2 }).orbit, AUDITION_ORBIT);
    assert.ok(AUDITION_ORBIT > 16, "beyond the orbits songs use (and the stage warms)");
  });

  test("never ducks the song's orbits", () => {
    const v = new AuditionBus().route({ s: "bd", duckorbit: 2, duckattack: 0.2 });
    assert.equal("duckorbit" in v, false);
  });

  test("a DJ filter stays on the audition bus: the next audition without one is unfiltered (0.5)", () => {
    const bus = new AuditionBus();
    assert.equal("djf" in bus.route({ s: "bd" }), false, "no filter until an audition uses one");
    assert.equal(bus.route({ s: "bd", djf: 0.2 }).djf, 0.2);
    assert.equal(bus.route({ s: "hh" }).djf, 0.5);
  });

  test("the caller's value is left alone", () => {
    const value = { s: "bd", orbit: 3, duckorbit: 2 };
    new AuditionBus().route(value);
    assert.deepEqual(value, { s: "bd", orbit: 3, duckorbit: 2 });
  });
});
