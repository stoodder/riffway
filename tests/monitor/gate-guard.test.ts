/**
 * Noise gate and runaway/feedback guard on synthetic level/spectrum sequences.
 */
import { describe, expect, it } from 'vitest';
import { GATE_TIMING, GUARD, NoiseGate, RunawayGuard, type GuardTrip } from '@core/dsp/amp';
import { harmonicTone, noise, pluckedTone, sawPartials, sine } from '../helpers/signals';
import { db, rms } from './helpers';

const SR = 48000;

function gateRun(gate: NoiseGate, x: Float32Array): { y: Float32Array; transitions: number } {
  const y = new Float32Array(x.length);
  let transitions = 0;
  let open = gate.isOpen;
  for (let i = 0; i < x.length; i++) {
    y[i] = gate.tick(x[i]!);
    if (gate.isOpen !== open) {
      transitions++;
      open = gate.isOpen;
    }
  }
  return { y, transitions };
}

describe('noise gate', () => {
  it('passes playing at unity gain and silences hiss below the threshold', () => {
    const gate = new NoiseGate(SR);
    gate.setThreshold(-60);
    gate.reset();
    const note = sine(220, 0.5, SR, 0.1); // −20 dBFS
    const { y } = gateRun(gate, note);
    // Fully open after the 0.5 ms attack.
    const settled = Math.ceil(0.005 * SR);
    for (let i = settled; i < y.length; i++) expect(y[i]).toBe(note[i]);
    const hiss = noise(Math.round(1.5 * SR), 10 ** (-80 / 20), 3); // −80 dBFS RMS
    const h = gateRun(gate, hiss).y;
    // Closed after the detector decay + hold, then −80 dB after ≈ 9 release time constants.
    expect(gate.isOpen).toBe(false);
    const tail = h.subarray(Math.round((0.15 + GATE_TIMING.holdSec + 10 * GATE_TIMING.releaseSec) * SR));
    expect(tail.every((v) => v === 0)).toBe(true);
  });

  it('opens within a millisecond of a pick attack (no look-ahead needed)', () => {
    const gate = new NoiseGate(SR);
    gate.setThreshold(-60);
    gate.reset();
    const pluck = pluckedTone(110, 0.2, SR, { amp: 0.3, attackMs: 1 });
    const { y } = gateRun(gate, pluck);
    const ms1 = Math.round(0.002 * SR);
    expect(gate.isOpen).toBe(true);
    expect(Math.abs(y[ms1]! - pluck[ms1]!)).toBeLessThan(0.02 * Math.abs(pluck[ms1]!) + 1e-6);
  });

  it('hysteresis + hold: a note decaying through the threshold closes once, without chatter', () => {
    const gate = new NoiseGate(SR);
    gate.setThreshold(-50);
    gate.reset();
    // Decay from −10 dBFS through the threshold, with −70 dBFS noise riding on it.
    const x = pluckedTone(196, 3, SR, { amp: 0.3, decaySec: 0.4 });
    const n = noise(x.length, 10 ** (-70 / 20), 8);
    for (let i = 0; i < x.length; i++) x[i] = x[i]! + n[i]!;
    const { y, transitions } = gateRun(gate, x);
    expect(transitions).toBe(2); // closed → open on the pick, open → closed once in the tail
    expect(rms(y, y.length - SR / 2)).toBe(0);
  });

  it('a disabled gate (null threshold) is transparent', () => {
    const gate = new NoiseGate(SR);
    gate.setThreshold(null);
    gate.reset();
    const x = noise(4800, 1e-5, 1);
    const { y } = gateRun(gate, x);
    expect(Array.from(y)).toEqual(Array.from(x));
  });
});

/** Feed a signal through the guard in 128-sample blocks; return the first trip and its time (s). */
function guardRun(x: Float32Array, guard = new RunawayGuard(SR)): { trip: GuardTrip | null; at: number } {
  for (let i = 0; i < x.length; i += 128) {
    const trip = guard.process(x.subarray(i, Math.min(x.length, i + 128)));
    if (trip) return { trip, at: i / SR };
  }
  return { trip: null, at: -1 };
}

/** A feedback howl: a pure tone growing exponentially from `fromDb` to `toDb` over `riseSec`, then held. */
function howl(freq: number, fromDb: number, toDb: number, riseSec: number, totalSec: number): Float32Array {
  const x = sine(freq, totalSec, SR, 1);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    const d = t < riseSec ? fromDb + ((toDb - fromDb) * t) / riseSec : toDb;
    x[i] = x[i]! * 10 ** (d / 20) * Math.SQRT2; // peak so RMS = d
  }
  return x;
}

describe('runaway guard', () => {
  it('trips on a fast-growing pure tone once it has been loud for ~300 ms', () => {
    const x = howl(2200, -40, -6, 0.5, 2);
    const { trip, at } = guardRun(x);
    expect(trip).toBe('feedback');
    // −10 dBFS is crossed at t = 0.5·30/34 ≈ 0.44 s; trip ≈ 300 ms later.
    const cross = (0.5 * 30) / 34;
    expect(at - cross).toBeGreaterThan(GUARD.sustainSec - 0.03);
    expect(at - cross).toBeLessThan(GUARD.sustainSec + 0.05);
  });

  it('does not trip on loud playing: chords, a single sustained note, noise', () => {
    // A bright power chord (E2 B2 E3, saw-like partials).
    const chord = new Float32Array(2 * SR);
    for (const f of [82.41, 123.47, 164.81]) {
      const note = harmonicTone(f, 2, SR, sawPartials(40), 1);
      for (let i = 0; i < chord.length; i++) chord[i] = chord[i]! + note[i]!;
    }
    const gain = 10 ** (-8 / 20) / rms(chord); // −8 dBFS RMS: loud, but below the runaway level
    const scaled = chord.map((v) => v * gain);
    const quietFirst = new Float32Array(SR * 3);
    quietFirst.set(scaled, SR);
    expect(db(rms(scaled))).toBeGreaterThan(GUARD.levelDb);
    expect(guardRun(quietFirst).trip).toBeNull();
    const note = harmonicTone(220, 2, SR, [1, 0.6, 0.4, 0.3, 0.2, 0.15, 0.1], 1);
    const noteGain = 10 ** (-8 / 20) / rms(note);
    const loudNote = new Float32Array(SR * 3);
    loudNote.set(note.map((v) => v * noteGain), SR);
    expect(guardRun(loudNote).trip).toBeNull();
    const loudNoise = new Float32Array(SR * 3);
    loudNoise.set(noise(SR * 2, 10 ** (-8 / 20), 4), SR);
    expect(guardRun(loudNoise).trip).toBeNull();
  });

  it('does not trip on a tone that never rose (no 12 dB rise within 1 s)', () => {
    expect(guardRun(howl(1000, -8, -8, 0.01, 3).subarray(Math.round(0.02 * SR))).trip).toBe('feedback');
    // Same steady tone, but the guard has been listening to it for > 1 s already.
    const guard = new RunawayGuard(SR);
    const steady = howl(1000, -12, -12, 0.01, 2);
    expect(guardRun(steady, guard).trip).toBeNull();
    const louder = howl(1000, -8, -8, 0.01, 2);
    expect(guardRun(louder, guard).trip).toBeNull(); // 4 dB rise only
  });

  it('does not trip on quiet tones (below −10 dBFS), however tonal', () => {
    expect(guardRun(howl(3000, -60, -14, 0.3, 3)).trip).toBeNull();
  });

  it('trips "runaway-level" on input pinned near full scale for 500 ms, even if not tonal', () => {
    const x = new Float32Array(SR * 2);
    x.set(noise(SR, 10 ** (-1 / 20), 6), SR / 2);
    const { trip, at } = guardRun(x);
    expect(trip).toBe('runaway-level');
    expect(at - 0.5).toBeGreaterThan(GUARD.runawaySec - 0.03);
    expect(at - 0.5).toBeLessThan(GUARD.runawaySec + 0.03);
  });

  it('reports a trip once, and re-arms after reset()', () => {
    const guard = new RunawayGuard(SR);
    const x = howl(1500, -40, -4, 0.3, 2);
    expect(guardRun(x, guard).trip).toBe('feedback');
    expect(guard.isTripped).toBe(true);
    expect(guardRun(x, guard).trip).toBeNull();
    guard.reset();
    expect(guard.isTripped).toBe(false);
    expect(guardRun(x, guard).trip).toBe('feedback');
  });

  it('measures tonality: ~1 for a sine, ≈ 0.8 for a square-ish howl, low for noise', () => {
    const g1 = new RunawayGuard(SR);
    g1.process(sine(1234, 0.1, SR, 0.5));
    expect(g1.tonality()).toBeGreaterThan(0.9);
    const g3 = new RunawayGuard(SR);
    g3.process(sine(1234, 0.1, SR, 1).map((v) => Math.tanh(8 * v)));
    expect(g3.tonality()).toBeGreaterThan(GUARD.tonality);
    const g2 = new RunawayGuard(SR);
    g2.process(noise(4800, 0.3, 2));
    expect(g2.tonality()).toBeLessThan(0.1);
  });

  it('ignores a DC offset (not sound), however large', () => {
    const x = new Float32Array(SR * 2);
    x.fill(0.8, SR / 2);
    expect(guardRun(x).trip).toBeNull();
  });

  it('ignores non-finite samples', () => {
    const x = new Float32Array(SR).fill(Number.NaN);
    expect(guardRun(x).trip).toBeNull();
  });
});
