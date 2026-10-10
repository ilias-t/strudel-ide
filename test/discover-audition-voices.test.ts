// Audition voices (src/ui/discover/audition-voices.ts): superdough chokes only samples in a cut
// group, so every audition voice plays through a gate of its own, and a new audition fades the
// ones still sounding (synths too) out in a few ms.
// Run: node --test test/discover-audition-voices.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditionVoices, CUT_FADE, type GateNode, type Trigger, type VoiceHandle } from "../src/ui/discover/audition-voices.ts";

/** A fake GainNode: its gain events, and what connected to it */
function fakeGate() {
  const events: [string, number, number?][] = [];
  const gate = {
    events,
    inputs: [] as unknown[],
    disconnected: false,
    gain: {
      value: 1,
      cancelScheduledValues: (t: number) => events.push(["cancel", t]),
      setValueAtTime: (v: number, t: number) => events.push(["set", v, t]),
      linearRampToValueAtTime: (v: number, t: number) => events.push(["ramp", v, t]),
    },
    disconnect() {
      gate.disconnected = true;
    },
  };
  return gate;
}
type FakeGate = ReturnType<typeof fakeGate>;

/** A fake voice (an oscillator's handle): what it connected to, when it was told to stop, its onended */
function fakeVoice() {
  const v = { to: null as FakeGate | null, stops: [] as number[], end: () => {} };
  const handle: VoiceHandle = {
    node: { connect: (to: never) => (v.to = to as FakeGate) },
    stop: (t: number) => v.stops.push(t),
  };
  const trigger: Trigger = (_t, _value, onended) => {
    v.end = onended;
    return handle;
  };
  return { v, trigger, handle };
}

function setup() {
  const gates: FakeGate[] = [];
  const voices = new AuditionVoices(() => {
    const g = fakeGate();
    gates.push(g);
    return g as GateNode;
  });
  return { voices, gates };
}

test("a voice plays through a gate of its own: superdough gets the gate as the source node", () => {
  const { voices, gates } = setup();
  const sine = fakeVoice();
  const node = voices.source(sine.trigger, 1)(0.5, { s: "sine" }, 0.6, 0.5);
  assert.equal(node, gates[0]);
  assert.equal(sine.v.to, gates[0], "the voice feeds the gate");
  assert.deepEqual(voices.voices(), [{ tag: 1, gain: 1, cut: false }]);
});

test("cut(): every live voice fades out in a few ms and stops, synths included; a new one plays on", () => {
  const { voices, gates } = setup();
  const sine = fakeVoice();
  voices.source(sine.trigger, 1)(0.5, { s: "sine" }, 0.6, 0.5);
  voices.cut(0.7); // the next audition starts
  const square = fakeVoice();
  voices.source(square.trigger, 2)(0.73, { s: "square" }, 0.6, 0.5);
  assert.deepEqual(gates[0].events, [
    ["cancel", 0.7],
    ["set", 1, 0.7],
    ["ramp", 0, 0.7 + CUT_FADE],
  ]);
  assert.deepEqual(sine.v.stops, [0.7 + CUT_FADE]);
  assert.deepEqual(gates[1].events, [], "the new voice is untouched");
  assert.deepEqual(square.v.stops, []);
  assert.ok(CUT_FADE > 0 && CUT_FADE <= 0.03);
});

test("a voice that ended leaves (its gate disconnects) and isn't cut again", () => {
  const { voices, gates } = setup();
  const sine = fakeVoice();
  voices.source(sine.trigger, 1)(0.5, { s: "sine" }, 0.6, 0.5);
  sine.v.end();
  assert.equal(gates[0].disconnected, true);
  assert.equal(voices.size, 0);
  voices.cut(2);
  assert.deepEqual(gates[0].events, []);
});

test("a sample whose voice arrives after a cut: connected, but stopped at once", async () => {
  const { voices, gates } = setup();
  const late = fakeVoice();
  let resolve!: (h: VoiceHandle) => void;
  const trigger: Trigger = (t, value, onended) => {
    late.trigger(t, value, onended, 0.5);
    return new Promise<VoiceHandle>((r) => (resolve = r));
  };
  voices.source(trigger, 1)(0.5, { s: "piano" }, 0.6, 0.5);
  voices.cut(0.52);
  resolve(late.handle);
  await Promise.resolve();
  assert.equal(late.v.to, gates[0]);
  assert.deepEqual(late.v.stops, [0.52 + CUT_FADE]);
  assert.deepEqual(gates[0].events.at(-1), ["ramp", 0, 0.52 + CUT_FADE]);
});

test("a trigger with nothing to play (speed 0): its gate goes at once", () => {
  const { voices, gates } = setup();
  voices.source(() => undefined, 1)(0.5, { s: "bd", speed: 0 }, 0.6, 0.5);
  assert.equal(gates[0].disconnected, true);
  assert.equal(voices.size, 0);
});

test("a trigger that throws: its gate goes, and the error reaches superdough", () => {
  const { voices, gates } = setup();
  const source = voices.source(() => {
    throw new Error("no such sound");
  }, 1);
  assert.throws(() => source(0.5, { s: "nope" }, 0.6, 0.5), /no such sound/);
  assert.equal(gates[0].disconnected, true);
  assert.equal(voices.size, 0);
});
