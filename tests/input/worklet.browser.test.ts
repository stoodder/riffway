/**
 * The analysis worklet in real Chromium Web Audio (T-022): generated plucks played by an
 * `AudioBufferSource` into the worklet on an `OfflineAudioContext` must come back as onsets at the
 * right frames (±5 ms) with the right pitches; channel select, level and tuner frames work through
 * the real node; and the input service opens Chrome's fake capture device end to end.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AnalysisEvent, AnalysisProcessorOptions } from '@shared/audio-events';
import type { AudioEngine, TimedAnalysisEvent } from '@shared/services';
import { createEngine } from '../../src/audio/engine';
import { createAnalysisNode, createInputService } from '../../src/audio/input';
import { centsBetween, midiToHz } from '../helpers/signals';
import { melody, ofType } from './helpers';
import { memorySettings } from './fakes';

const SR = 48000;

/** Render `channels` through the worklet offline; resolves with every event the node posted. */
async function analyseOffline(channels: Float32Array[], opts: AnalysisProcessorOptions, startSec = 0): Promise<AnalysisEvent[]> {
  const length = channels[0].length + Math.round(startSec * SR) + SR / 4;
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length, sampleRate: SR });
  const node = await createAnalysisNode(ctx, opts);
  const events: AnalysisEvent[] = [];
  node.port.onmessage = (e: MessageEvent<AnalysisEvent>) => events.push(e.data);
  const buffer = ctx.createBuffer(channels.length, channels[0].length, SR);
  channels.forEach((c, i) => buffer.getChannelData(i).set(c));
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(node);
  src.start(startSec);
  await ctx.startRendering();
  // Port messages are delivered asynchronously after rendering.
  const want = Math.floor(length / 128 / Math.round((0.05 * SR) / 128));
  for (let i = 0; i < 100 && ofType(events, 'level').length < want; i++) await new Promise((r) => setTimeout(r, 20));
  return events;
}

describe('analysis worklet (OfflineAudioContext)', () => {
  const notes = [40, 47, 52, 57, 62, 67, 71, 76].map((midi, i) => ({ atSec: 0.25 + i * 0.35, midi }));
  const signal = melody(notes, 3.2);

  it('turns generated plucks into onsets at the right frames and pitches', async () => {
    const start = 0.5;
    const events = await analyseOffline([signal], { channel: 0, tuner: false }, start);
    expect(events[0]).toEqual({ type: 'ready', sampleRate: SR });
    const onsets = ofType(events, 'onset');
    expect(onsets.map((o) => o.midi)).toEqual(notes.map((n) => n.midi));
    onsets.forEach((o, i) => {
      const expected = (start + notes[i].atSec) * SR;
      expect(Math.abs(o.frame - expected)).toBeLessThanOrEqual(0.005 * SR);
    });
    const levels = ofType(events, 'level');
    expect(Math.max(...levels.map((l) => l.peakDb))).toBeGreaterThan(-12);
    expect(levels[0].peakDb).toBe(-120);
  });

  it('analyses the selected channel of a stereo input', async () => {
    const silent = new Float32Array(signal.length);
    const right = ofType(await analyseOffline([silent, signal], { channel: 1, tuner: false }), 'onset');
    expect(right.map((o) => o.midi)).toEqual(notes.map((n) => n.midi));
    expect(ofType(await analyseOffline([silent, signal], { channel: 0, tuner: false }), 'onset')).toHaveLength(0);
  });

  it('streams tuner frames for a sustained Drop D low D', async () => {
    const f = midiToHz(38) * 2 ** (6 / 1200);
    const tone = new Float32Array(SR * 1.5);
    for (let i = 0; i < tone.length; i++) {
      const t = i / SR;
      tone[i] = 0.3 * Math.exp(-t / 3) * (0.5 * Math.sin(2 * Math.PI * f * t) + Math.sin(4 * Math.PI * f * t + 0.7) + 0.6 * Math.sin(6 * Math.PI * f * t + 1.4));
    }
    const frames = ofType(await analyseOffline([tone], { channel: 0, tuner: true }), 'tuner').filter((t) => t.freq > 0);
    expect(frames.length).toBeGreaterThan(20);
    for (const fr of frames.slice(2, -2)) expect(Math.abs(centsBetween(fr.freq, f))).toBeLessThan(2);
  });
});

describe('input service with Chrome’s fake capture device', () => {
  let engine: AudioEngine | null = null;

  afterEach(async () => {
    await engine?.dispose();
    engine = null;
  });

  it('opens the device with processing off, reads back settings and delivers level events', async () => {
    engine = await createEngine();
    await engine.resume();
    const settings = memorySettings();
    const input = await createInputService(engine, settings);
    const inputs = await input.listInputs();
    expect(inputs.length).toBeGreaterThan(0);
    const res = await input.open();
    expect(res.device.label).not.toBe('');
    expect(res.channelCount).toBeGreaterThanOrEqual(1);
    expect(res.sampleRate).toBe(engine.ctx.sampleRate);
    expect(res.processingWarnings).toEqual([]);
    expect(settings.get().input.deviceId).toBe(res.device.deviceId);
    expect(input.getInputNode()).toBeInstanceOf(MediaStreamAudioSourceNode);
    const got: TimedAnalysisEvent[] = [];
    input.onAnalysis((e) => got.push(e));
    const deadline = performance.now() + 3000;
    while (ofType(got, 'level').length < 5 && performance.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const levels = ofType(got, 'level') as (TimedAnalysisEvent & { type: 'level' })[];
    expect(levels.length).toBeGreaterThanOrEqual(5);
    for (const l of levels) expect(Math.abs(l.ctxTime - engine.ctx.currentTime)).toBeLessThan(1);
    input.close();
    expect(input.current).toBeNull();
    expect(input.getInputNode()).toBeNull();
  });
});
