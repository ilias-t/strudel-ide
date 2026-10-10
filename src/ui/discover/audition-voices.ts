// ═══════════════════════════════════════════════════════════════════════════
// Audition voices: a new audition (or a stop) silences the ones still sounding
// ═══════════════════════════════════════════════════════════════════════════
//
// The shared cut group (./audition-values.ts) only chokes samples: superdough
// implements `cut` in its sampler (node_modules/superdough/sampler.mjs), and
// its synths ignore it, so browsing synths stacked their voices until each
// one's envelope ended. So every audition voice plays through a gate of its
// own: superdough's `source` control (superdough.mjs: when a value has one,
// superdough takes its node as the voice instead of calling the sound's
// onTrigger) gets a function that calls the sound's own onTrigger, wires the
// voice into a GainNode and hands superdough that. cut() fades every live gate
// out in a few ms and stops its voice; a voice that ends on its own leaves.
//
// Pure: the gate is made by an injected function, so Node tests use fakes.

/** The parts of an AudioParam a gate uses */
export interface GateParam {
  value: number;
  cancelScheduledValues(t: number): unknown;
  setValueAtTime(v: number, t: number): unknown;
  linearRampToValueAtTime(v: number, t: number): unknown;
}

/** The parts of a GainNode a gate uses */
export interface GateNode {
  gain: GateParam;
  disconnect(): void;
}

/** What a sound's onTrigger resolves to (superdough.mjs: soundHandle) */
export interface VoiceHandle {
  node: { connect(to: never): unknown };
  stop?(t: number): void;
}

/** A sound's onTrigger, as superdough calls it */
export type Trigger = (t: number, value: Record<string, unknown>, onended: () => void, cps: number) => VoiceHandle | undefined | Promise<VoiceHandle | undefined>;

/** What superdough calls for a value with `source`: (t, value, duration, cps) → the voice's node */
export type Source = (t: number, value: Record<string, unknown>, duration: number, cps: number) => GateNode;

/** How long a cut voice takes to fade out (s): short, but no click */
export const CUT_FADE = 0.015;

interface Voice {
  tag: number;
  gate: GateNode;
  handle?: VoiceHandle;
  /** When it was cut (audio clock), if it was */
  cutAt?: number;
}

export class AuditionVoices {
  private live = new Set<Voice>();
  private makeGate: () => GateNode;

  constructor(makeGate: () => GateNode) {
    this.makeGate = makeGate;
  }

  /** A `source` for superdough that plays `trigger`'s voice through a gate of its own; `tag` names it (tests) */
  source(trigger: Trigger, tag = 0): Source {
    return (t, value, _duration, cps) => {
      const gate = this.makeGate();
      const voice: Voice = { tag, gate };
      this.live.add(voice);
      let gone = false;
      const ended = () => {
        if (gone) return;
        gone = true;
        this.live.delete(voice);
        gate.disconnect();
      };
      const attach = (h: VoiceHandle | undefined) => {
        if (!h || gone) return ended();
        voice.handle = h;
        h.node.connect(gate as never);
        if (voice.cutAt !== undefined) stopAt(h, voice.cutAt + CUT_FADE);
      };
      // a synth answers at once, a sample once its buffer is in
      let handle: ReturnType<Trigger>;
      try {
        handle = trigger(t, value, ended, cps);
      } catch (err) {
        ended();
        throw err; // superdough rejects: the audition records the error
      }
      if (handle instanceof Promise) handle.then(attach, ended);
      else attach(handle);
      return gate;
    };
  }

  /** Fade every live voice out from `at` (audio clock, s) and stop it */
  cut(at: number) {
    for (const v of this.live) {
      if (v.cutAt !== undefined) continue;
      v.cutAt = at;
      const g = v.gate.gain;
      g.cancelScheduledValues(at);
      g.setValueAtTime(1, at);
      g.linearRampToValueAtTime(0, at + CUT_FADE);
      if (v.handle) stopAt(v.handle, at + CUT_FADE);
    }
  }

  /** Voices still sounding or fading, oldest first, with their gate's level now (tests) */
  voices(): { tag: number; gain: number; cut: boolean }[] {
    return [...this.live].map((v) => ({ tag: v.tag, gain: v.gate.gain.value, cut: v.cutAt !== undefined }));
  }

  /** Any voice live (cut() has something to do) */
  get size(): number {
    return this.live.size;
  }
}

function stopAt(h: VoiceHandle, t: number) {
  try {
    h.stop?.(t);
  } catch {
    // already stopped: the fade has silenced it anyway
  }
}
