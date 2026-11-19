/**
 * Calibration through the real analysis worklet in Chromium:
 * - play-to-click: plucks 37 ms after each click of the real plan (count-in + 16 at 90 BPM) are
 *   rendered offline through the worklet; the estimator recovers 37 ms within ±3 ms (also with
 *   jitter, missed plucks and a wild outlier);
 * - loopback: the engine's real click voice through a 37 ms delay into the worklet;
 * - a live run on a running `AudioContext` (createLiveCalibration + CalibrationRun) with plucks
 *   scheduled on the same context.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AnalysisEvent } from '@shared/audio-events';
import { frameToEventCtx } from '@core/judge';
import { clickPlan, createLiveCalibration, estimateOffset, measuredTimes } from '../../src/audio/calibration';
import { createClickPlayer, createEngine } from '../../src/audio/engine';
import { createAnalysisNode } from '../../src/audio/input';
import type { AudioEngine } from '@shared/services';
import { addPickTransient, fadeOut, midiToHz, pluckedTone } from '../helpers/signals';
import { gauss, rng } from './helpers';

const SR = 48000;
const DELAY_MS = 37;

/** A picked open low E (or another string), faded out so its end is not an onset. */
function pluck(midi = 40, sampleRate = SR): Float32Array {
  const tone = pluckedTone(midiToHz(midi), 0.4, sampleRate, { amp: 0.5, decaySec: 0.5 });
  addPickTransient(tone, sampleRate, 0.15);
  return fadeOut(tone, sampleRate, 8);
}

/** Wait until port messages delivered after rendering have arrived. */
async function settleMessages(events: AnalysisEvent[], minLevels: number): Promise<void> {
  for (let i = 0; i < 100 && events.filter((e) => e.type === 'level').length < minLevels; i++) await new Promise((r) => setTimeout(r, 20));
}

/**
 * Render offline: `build` connects sources into the analysis node; returns the onset times in
 * context seconds (uncalibrated, as the input service delivers them).
 */
async function onsetsOffline(durSec: number, build: (ctx: OfflineAudioContext, node: AudioWorkletNode) => void): Promise<number[]> {
  const length = Math.round(durSec * SR);
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length, sampleRate: SR });
  const node = await createAnalysisNode(ctx, { channel: 0, tuner: false });
  const events: AnalysisEvent[] = [];
  node.port.onmessage = (e: MessageEvent<AnalysisEvent>) => events.push(e.data);
  build(ctx, node);
  await ctx.startRendering();
  await settleMessages(events, Math.floor(length / 128 / Math.round((0.05 * SR) / 128)));
  return events.filter((e) => e.type === 'onset').map((e) => frameToEventCtx(e.frame, SR, 0));
}

describe('play-to-click through the analysis worklet (OfflineAudioContext)', () => {
  const plan = clickPlan(0.5);
  const clicks = measuredTimes(plan);
  const duration = plan[plan.length - 1]!.ctxTime + 1;

  it(`recovers a synthetic ${DELAY_MS} ms delay within ±3 ms`, async () => {
    const buf = pluck();
    const onsets = await onsetsOffline(duration, (ctx, node) => {
      const audio = ctx.createBuffer(1, buf.length, SR);
      audio.getChannelData(0).set(buf);
      for (const t of clicks) {
        const src = new AudioBufferSourceNode(ctx, { buffer: audio });
        src.connect(node);
        src.start(t + DELAY_MS / 1000);
      }
    });
    expect(onsets).toHaveLength(16);
    const r = estimateOffset(clicks, onsets);
    expect(r.ok).toBe(true);
    expect(r.kept).toBe(14);
    expect(Math.abs(r.offsetMs! - DELAY_MS)).toBeLessThanOrEqual(3);
    expect(r.spreadMs!).toBeLessThan(1);
  }, 30_000);

  it('still recovers it with jitter, missed plucks, a wild outlier and different strings', async () => {
    const rand = rng(17);
    const strings = [40, 45, 50, 55, 59, 64];
    const missed = new Set([4, 9]);
    const onsets = await onsetsOffline(duration, (ctx, node) => {
      clicks.forEach((t, i) => {
        if (missed.has(i)) return;
        const buf = pluck(strings[i % strings.length]);
        const audio = ctx.createBuffer(1, buf.length, SR);
        audio.getChannelData(0).set(buf);
        const src = new AudioBufferSourceNode(ctx, { buffer: audio });
        src.connect(node);
        const dev = i === 12 ? 140 : gauss(rand) * 4;
        src.start(t + (DELAY_MS + dev) / 1000);
      });
    });
    const r = estimateOffset(clicks, onsets);
    expect(r.ok).toBe(true);
    expect(r.missed).toBe(2);
    expect(r.pairs.find((p) => p.click === 12)?.status).toBe('rejected');
    expect(Math.abs(r.offsetMs! - DELAY_MS)).toBeLessThanOrEqual(3);
  }, 30_000);
});

describe('loopback through the analysis worklet (OfflineAudioContext)', () => {
  it('measures the click voice coming back through a 37 ms delay', async () => {
    const plan = clickPlan(0.5);
    const onsets = await onsetsOffline(plan[plan.length - 1]!.ctxTime + 1, (ctx, node) => {
      const delay = new DelayNode(ctx, { delayTime: DELAY_MS / 1000, maxDelayTime: 1 });
      delay.connect(node);
      const clicks = createClickPlayer(ctx, delay);
      for (const c of plan) clicks.schedule(c.ctxTime, c.accent);
    });
    const r = estimateOffset(measuredTimes(plan), onsets);
    expect(r.ok).toBe(true);
    expect(r.quality).toBe('excellent');
    expect(Math.abs(r.offsetMs! - DELAY_MS)).toBeLessThanOrEqual(3);
  }, 30_000);
});

describe('live run on a running AudioContext', () => {
  let engine: AudioEngine | null = null;
  afterEach(async () => {
    await engine?.dispose();
    engine = null;
  });

  it('pairs plucks scheduled on the context with the run’s clicks', async () => {
    engine = await createEngine();
    await engine.resume();
    const ctx = engine.ctx;
    const node = await createAnalysisNode(ctx, { channel: 0, tuner: false });
    const listeners = new Set<(t: number) => void>();
    node.port.onmessage = (e: MessageEvent<AnalysisEvent>) => {
      if (e.data.type === 'onset') for (const cb of listeners) cb(frameToEventCtx(e.data.frame, ctx.sampleRate, 0));
    };
    const live = createLiveCalibration(
      engine,
      (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      { plan: { bpm: 150 } },
    );
    const done = live.run.start();
    const buf = pluck(40, ctx.sampleRate);
    const audio = ctx.createBuffer(1, buf.length, ctx.sampleRate);
    audio.getChannelData(0).set(buf);
    for (const t of measuredTimes(live.run.plan)) {
      const src = new AudioBufferSourceNode(ctx, { buffer: audio });
      src.connect(node);
      src.start(t + DELAY_MS / 1000);
    }
    const r = await done;
    live.dispose();
    node.disconnect();
    expect(r.ok).toBe(true);
    expect(Math.abs(r.offsetMs! - DELAY_MS)).toBeLessThanOrEqual(3);
  }, 30_000);
});
