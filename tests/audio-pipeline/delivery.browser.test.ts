/**
 * Worklet → main-thread delivery delay of the real analysis worklet in a running (real-time)
 * `AudioContext` (T-036, R1-C-09). The judge's guitar horizon assumes every onset message is on the
 * main thread no later than `INPUT_LAG_SEC.guitar` after the onset (docs/audio-input.md § Delivery).
 *
 * Measured per message, on receipt: `ctx.currentTime − frame / sampleRate`, i.e. the same clock the
 * judge's `inputHorizon(ctx.currentTime, …)` uses (messages from before the source starts, such as
 * the first level after start-up, are left out).
 * - `onset` (frame = onset): the whole lag the horizon must cover (analysis wait + window + delivery).
 * - `level` (frame = end of the quantum that posted it): delivery alone.
 *
 * Runs idle and with a janky main thread (a 30 ms busy block every 100 ms, a slow-frame stand-in).
 * Headless Chromium renders to a fake audio sink; numbers on a Mac with CoreAudio differ
 * (docs/audio-input.md records both the measurement and the derived budget).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AnalysisEvent } from '@shared/audio-events';
import { GUITAR_ANALYSIS_DELAY_SEC, INPUT_LAG_SEC } from '../../src/core/judge/constants';
import { createAnalysisNode } from '../../src/audio/input';
import { errorStats } from './evaluate';
import { melody } from '../input/helpers';

const SR = 48000;

interface Received {
  ev: AnalysisEvent;
  /** `ctx.currentTime` on receipt, s. */
  now: number;
}

/** Lag statistics in ms (all values ≥ 0). */
interface LagStats {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

function lagStats(valuesSec: readonly number[]): LagStats {
  const ms = valuesSec.map((v) => v * 1000).sort((a, b) => a - b);
  const at = (q: number): number => ms[Math.min(ms.length - 1, Math.max(0, Math.ceil(q * ms.length) - 1))];
  return { n: ms.length, p50: at(0.5), p95: at(0.95), max: errorStats(ms).maxAbs };
}

let ctx: AudioContext | null = null;
let jank: ReturnType<typeof setInterval> | null = null;

afterEach(async () => {
  if (jank !== null) clearInterval(jank);
  jank = null;
  await ctx?.close();
  ctx = null;
});

/** Play 24 plucks (E2–E5, 250 ms apart) through the worklet in real time and record every message. */
async function measure(withJank: boolean): Promise<{ onsets: LagStats; levels: LagStats; clockStepMs: number }> {
  ctx = new AudioContext({ sampleRate: SR, latencyHint: 'interactive' });
  await ctx.resume();
  const node = await createAnalysisNode(ctx, { channel: 0, tuner: false });
  const received: Received[] = [];
  const c = ctx;
  node.port.onmessage = (e: MessageEvent<AnalysisEvent>) => received.push({ ev: e.data, now: c.currentTime });
  const notes = Array.from({ length: 24 }, (_, i) => ({ atSec: 0.1 + i * 0.25, midi: 40 + ((i * 5) % 37) }));
  const signal = melody(notes, 6.4);
  const buffer = ctx.createBuffer(1, signal.length, SR);
  buffer.getChannelData(0).set(signal);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(node);
  if (withJank) {
    jank = setInterval(() => {
      const until = performance.now() + 30;
      while (performance.now() < until) {
        /* busy: main-thread jank */
      }
    }, 100);
  }
  const startAt = ctx.currentTime + 0.2;
  src.start(startAt);
  const ended = new Promise<void>((resolve) => {
    src.onended = () => resolve();
  });
  // How coarsely the main thread sees the context clock move (render-callback size).
  let clockStepMs = Infinity;
  for (let last = c.currentTime, t0 = performance.now(); performance.now() - t0 < 300; ) {
    await new Promise((r) => setTimeout(r, 0));
    const t = c.currentTime;
    if (t > last) clockStepMs = Math.min(clockStepMs, (t - last) * 1000);
    last = t;
  }
  await ended;
  await new Promise((r) => setTimeout(r, 300));
  if (jank !== null) clearInterval(jank);
  jank = null;

  const fromFrame = startAt * SR;
  const lags = (type: AnalysisEvent['type']): number[] =>
    received.filter((r) => r.ev.type === type && 'frame' in r.ev && r.ev.frame >= fromFrame).map((r) => r.now - (r.ev as { frame: number }).frame / SR);
  const onsetLags = lags('onset');
  const levelLags = lags('level');
  expect(onsetLags.length).toBe(notes.length);
  return { onsets: lagStats(onsetLags), levels: lagStats(levelLags), clockStepMs };
}

describe('analysis worklet delivery delay (real-time AudioContext)', () => {
  it('delivers every onset within the judge’s guitar input horizon (idle main thread)', async () => {
    const r = await measure(false);
    console.info(
      `[T-036 delivery idle] onset lag ms p50 ${r.onsets.p50.toFixed(1)} p95 ${r.onsets.p95.toFixed(1)} max ${r.onsets.max.toFixed(1)} (n ${r.onsets.n}); ` +
        `level delivery ms p50 ${r.levels.p50.toFixed(1)} p95 ${r.levels.p95.toFixed(1)} max ${r.levels.max.toFixed(1)}; clock step ${r.clockStepMs.toFixed(1)} ms; ` +
        `analysis budget ${(GUITAR_ANALYSIS_DELAY_SEC * 1000).toFixed(1)} ms, INPUT_LAG_SEC.guitar ${(INPUT_LAG_SEC.guitar * 1000).toFixed(1)} ms`,
    );
    // Never before the pitch window can have completed (25 ms + 2048 samples).
    expect(r.onsets.p50).toBeGreaterThanOrEqual((0.025 + 2048 / SR) * 1000 - 0.5);
    expect(r.onsets.max).toBeLessThanOrEqual(INPUT_LAG_SEC.guitar * 1000);
  });

  it('measures the lag with a janky main thread (30 ms block every 100 ms)', async () => {
    const r = await measure(true);
    console.info(
      `[T-036 delivery jank] onset lag ms p50 ${r.onsets.p50.toFixed(1)} p95 ${r.onsets.p95.toFixed(1)} max ${r.onsets.max.toFixed(1)} (n ${r.onsets.n}); ` +
        `level delivery ms p50 ${r.levels.p50.toFixed(1)} p95 ${r.levels.p95.toFixed(1)} max ${r.levels.max.toFixed(1)}`,
    );
    // A message can wait for at most one busy block on top of the idle lag.
    expect(r.onsets.max).toBeLessThanOrEqual(INPUT_LAG_SEC.guitar * 1000 + 30);
  });
});
