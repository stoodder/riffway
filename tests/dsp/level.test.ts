import { describe, expect, it } from 'vitest';
import { ampToDb, createLevelMeter, SILENCE_DB } from '@core/dsp';
import { sine } from '../helpers/signals';

describe('level meter', () => {
  it('reports peak and RMS of a sine in dBFS across blocks, then resets', () => {
    const meter = createLevelMeter();
    const sig = sine(1000, 0.05, 48000, 0.5);
    for (let i = 0; i + 128 <= sig.length; i += 128) meter.process(sig.subarray(i, i + 128));
    const r = meter.read();
    expect(r.peakDb).toBeCloseTo(-6.02, 1);
    expect(r.rmsDb).toBeCloseTo(-9.03, 1);
    const again = meter.read();
    expect(again).toBe(r);
    expect(again).toEqual({ peakDb: SILENCE_DB, rmsDb: SILENCE_DB });
  });

  it('tracks the peak of negative samples and full scale', () => {
    const meter = createLevelMeter();
    meter.process(new Float32Array([0, -1, 0.25, 0]));
    const r = meter.read();
    expect(r.peakDb).toBe(0);
    expect(r.rmsDb).toBeCloseTo(20 * Math.log10(Math.sqrt((1 + 0.0625) / 4)), 9);
  });

  it('clamps silence to SILENCE_DB', () => {
    const meter = createLevelMeter();
    meter.process(new Float32Array(128));
    expect(meter.read()).toEqual({ peakDb: SILENCE_DB, rmsDb: SILENCE_DB });
    expect(ampToDb(0)).toBe(SILENCE_DB);
    expect(ampToDb(1e-9)).toBe(SILENCE_DB);
    expect(ampToDb(0.1)).toBeCloseTo(-20, 9);
  });
});
