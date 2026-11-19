/**
 * Latency estimate maths and the speaker/mic label heuristics.
 */
import { describe, expect, it } from 'vitest';
import type { AudioDeviceInfo } from '@shared/services';
import { AMP_LATENCY_SAMPLES } from '@core/dsp/amp';
import { isBuiltInMic, isLaptopSpeaker, outputLabel } from '../../src/audio/monitor/devices';
import { estimateMonitorLatency, latencyBand, latencyBreakdown, type LatencyInputs } from '../../src/audio/monitor/latency';

const base: LatencyInputs = {
  inputLatencySec: 0.005,
  baseLatencySec: 0.00267,
  outputLatencySec: 0.012,
  sampleRate: 48000,
  dspSamples: AMP_LATENCY_SAMPLES,
  calibration: { method: 'none', inputOffsetMs: 0 },
};

describe('latency estimate', () => {
  it('sums input + base + output + one render quantum + amp DSP', () => {
    const e = estimateMonitorLatency(base);
    expect(e.parts.inputMs).toBeCloseTo(5, 9);
    expect(e.parts.baseMs).toBeCloseTo(2.67, 9);
    expect(e.parts.outputMs).toBeCloseTo(12, 9);
    expect(e.parts.quantumMs).toBeCloseTo(2.6667, 3);
    expect(e.parts.dspMs).toBeCloseTo((AMP_LATENCY_SAMPLES / 48000) * 1000, 9);
    expect(e.monitorMs).toBeCloseTo(5 + 2.67 + 12 + 2.6667 + e.parts.dspMs, 3);
    expect(e.band).toBe('playable');
    expect(e.assumed).toEqual({ input: false, output: false });
    expect(e.calibratedOffsetMs).toBeNull();
  });

  it('assumes 10 ms for unreported input/output latency and says so', () => {
    const e = estimateMonitorLatency({ ...base, inputLatencySec: null, outputLatencySec: 0 });
    expect(e.parts.inputMs).toBe(10);
    expect(e.parts.outputMs).toBe(10);
    expect(e.assumed).toEqual({ input: true, output: true });
    const nan = estimateMonitorLatency({ ...base, outputLatencySec: Number.NaN, baseLatencySec: Number.NaN });
    expect(nan.parts.outputMs).toBe(10);
    expect(nan.parts.baseMs).toBe(0);
  });

  it('bands: ≤ 15 great, ≤ 30 playable, else noticeable', () => {
    expect(latencyBand(15)).toBe('great');
    expect(latencyBand(15.01)).toBe('playable');
    expect(latencyBand(30)).toBe('playable');
    expect(latencyBand(30.5)).toBe('noticeable');
    expect(estimateMonitorLatency({ ...base, inputLatencySec: 0.02, outputLatencySec: 0.03 }).band).toBe('noticeable');
  });

  it('reports the calibrated offset only after a play-to-click calibration', () => {
    expect(estimateMonitorLatency({ ...base, calibration: { method: 'play-to-click', inputOffsetMs: 41 } }).calibratedOffsetMs).toBe(41);
    expect(estimateMonitorLatency({ ...base, calibration: { method: 'estimated', inputOffsetMs: 30 } }).calibratedOffsetMs).toBeNull();
    expect(estimateMonitorLatency({ ...base, calibration: { method: 'tap-to-click', inputOffsetMs: 30 } }).calibratedOffsetMs).toBeNull();
  });

  it('groups parts into input / processing / output for display', () => {
    const e = estimateMonitorLatency({ ...base, outputLatencySec: 0 });
    const b = latencyBreakdown(e);
    expect(b.inputMs).toBeCloseTo(5, 9);
    expect(b.processingMs).toBeCloseTo(e.parts.quantumMs + e.parts.dspMs, 9);
    expect(b.outputMs).toBeCloseTo(2.67 + 10, 9);
    expect(b.inputMs + b.processingMs + b.outputMs).toBeCloseTo(b.totalMs, 9);
    expect(b.assumedOutput).toBe(true);
    // A plain contract estimate (no DSP part, no flags) still works.
    const plain = latencyBreakdown({
      monitorMs: 20,
      band: 'playable',
      calibratedOffsetMs: null,
      parts: { inputMs: 5, baseMs: 3, outputMs: 9, quantumMs: 3 },
    });
    expect(plain).toEqual({ totalMs: 20, inputMs: 5, processingMs: 3, outputMs: 12, assumedInput: false, assumedOutput: false });
  });
});

describe('device labels', () => {
  it('recognises laptop speakers', () => {
    for (const l of ['MacBook Pro Speakers', 'Default - MacBook Air Speakers (Built-in)', 'Built-in Output', 'Internal Speakers']) {
      expect(isLaptopSpeaker(l)).toBe(true);
    }
    for (const l of ['External Headphones', 'Scarlett 2i2 USB', 'AirPods Pro', '', null, undefined]) expect(isLaptopSpeaker(l)).toBe(false);
  });

  it('recognises the built-in microphone', () => {
    expect(isBuiltInMic('MacBook Pro Microphone')).toBe(true);
    expect(isBuiltInMic('Built-in Microphone')).toBe(true);
    expect(isBuiltInMic('Scarlett 2i2 USB')).toBe(false);
  });

  it('resolves the label of the default output and of a chosen sinkId', () => {
    const dev = (deviceId: string, label: string): AudioDeviceInfo => ({ deviceId, label, groupId: 'g', kind: 'audiooutput' });
    const outs = [dev('default', 'Default - MacBook Pro Speakers (Built-in)'), dev('abc', 'External Headphones')];
    expect(outputLabel(outs, '', null)).toBe('Default - MacBook Pro Speakers (Built-in)');
    expect(outputLabel(outs, 'abc', null)).toBe('External Headphones');
    expect(outputLabel(outs, 'gone', 'Saved label')).toBe('Saved label');
    expect(outputLabel([dev('x', '')], 'x', null)).toBeNull();
    expect(outputLabel([dev('x', 'First output')], '', null)).toBe('First output');
  });
});
