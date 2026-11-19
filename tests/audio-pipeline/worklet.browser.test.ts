/**
 * The audio pipeline through the real analysis AudioWorklet in Chromium (T-036): an
 * `OfflineAudioContext` plays (1) the Ode to Joy scenario of `pipeline.test.ts` (calibration
 * plucks, one wrong note, one omitted note, early/late plucks) into the worklet, whose events go
 * through `analysisToInputEvent` to the real judge; and (2) the recorded clips, whose detections must
 * match the Node `AnalysisCore` run exactly and meet the same targets.
 */
import { describe, expect, it } from 'vitest';
import type { AnalysisCommand, AnalysisEvent } from '@shared/audio-events';
import { loadSong } from '@core/import/load-song';
import { createAnalysisNode } from '../../src/audio/input';
import odeToJoy from '../../starter/ode-to-joy.atex?raw';
import manifestJson from '../fixtures/audio/annotations.json';
import iowaUrl from '../fixtures/audio/iowa-single-notes.wav?url';
import rock1Url from '../fixtures/audio/guitarset-rock1-mic.wav?url';
import rock2Url from '../fixtures/audio/guitarset-rock2-pickup.wav?url';
import { detectedNotes, scoreDetections } from './evaluate';
import type { FixtureManifest } from './manifest';
import {
  calibrateInputOffsetMs,
  checkScenario,
  judgeRun,
  linearClock,
  ODE_TO_JOY_DEVIATIONS,
  planScenario,
  renderScenario,
  runCoreTimed,
  worstCaseArrival,
} from './scenario';
import { readWav } from './wav';

const SR = 48000;
const manifest = manifestJson as FixtureManifest;
const URLS: Record<string, string> = {
  'iowa-single-notes': iowaUrl,
  'guitarset-rock1-mic': rock1Url,
  'guitarset-rock2-pickup': rock2Url,
};

/** Render `signal` through the worklet offline (after `commands`); resolves with every posted event. */
async function analyseOffline(signal: Float32Array, commands: readonly AnalysisCommand[]): Promise<AnalysisEvent[]> {
  const length = signal.length + SR / 4;
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length, sampleRate: SR });
  const node = await createAnalysisNode(ctx, { channel: 0, tuner: false });
  const events: AnalysisEvent[] = [];
  node.port.onmessage = (e: MessageEvent<AnalysisEvent>) => events.push(e.data);
  for (const cmd of commands) node.port.postMessage(cmd);
  // Let the idle audio thread take the commands before the first quantum.
  await new Promise((r) => setTimeout(r, 50));
  const buffer = ctx.createBuffer(1, signal.length, SR);
  buffer.getChannelData(0).set(signal);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(node);
  src.start(0);
  await ctx.startRendering();
  // Port messages arrive asynchronously after rendering; wait for the last level message.
  const levels = Math.floor(length / 128 / Math.round((0.05 * SR) / 128));
  for (let i = 0; i < 200 && events.filter((e) => e.type === 'level').length < levels; i++) await new Promise((r) => setTimeout(r, 20));
  return events;
}

describe('song → plucks → analysis worklet → judge (OfflineAudioContext)', { timeout: 60_000 }, () => {
  it('judges Ode to Joy as planned, timing error mean ≤ 5 ms and p95 ≤ 10 ms', async () => {
    const song = loadSong({ fileName: 'ode-to-joy.atex', data: new TextEncoder().encode(odeToJoy), id: 'starter:ode-to-joy' });
    const plan = planScenario(song, { sampleRate: SR, latencySec: 0.023, deviations: ODE_TO_JOY_DEVIATIONS });
    const signal = renderScenario(plan);
    const events = await analyseOffline(signal, [plan.hint]);
    // The real worklet and the Node core agree event for event.
    const core = runCoreTimed(signal, SR, [plan.hint], 0).map((e) => e.ev);
    expect(detectedNotes(events, SR)).toEqual(detectedNotes(core, SR));

    const offsetMs = calibrateInputOffsetMs(events, plan.clicks, SR);
    expect(offsetMs).not.toBeNull();
    const run = judgeRun(song, linearClock(plan.leadInSec, 1), worstCaseArrival(events, SR), { sampleRate: SR, inputOffsetMs: offsetMs!, endSec: plan.durationSec });
    const check = checkScenario(plan, run);
    const t = check.timingErrorMs;
    console.info(`[T-036 e2e worklet] offset ${offsetMs!.toFixed(2)} ms; timing error mean ${t.mean.toFixed(2)} ms, p95 ${t.p95Abs.toFixed(2)} ms; counts ${JSON.stringify(run.summary.counts)}`);
    expect(check.mismatches).toEqual([]);
    expect(run.lateArrivals).toBe(0);
    expect(Math.abs(t.mean)).toBeLessThanOrEqual(5);
    expect(t.p95Abs).toBeLessThanOrEqual(10);
    expect(run.summary.counts).toMatchObject({ Perfect: 89, Great: 2, Good: 3, WrongNote: 1, Miss: 1 });
  });
});

describe('recorded guitar through the analysis worklet', { timeout: 60_000 }, () => {
  for (const clip of manifest.clips) {
    it(`${clip.id}: same detections as the Node core`, async () => {
      const wav = readWav(new Uint8Array(await (await fetch(URLS[clip.id])).arrayBuffer()));
      const signal = wav.channels[0];
      const midis = clip.notes.map((n) => n.midi);
      const hint: AnalysisCommand = { type: 'expect', range: { minMidi: Math.min(...midis), maxMidi: Math.max(...midis) } };
      const worklet = detectedNotes(await analyseOffline(signal, [hint]), SR);
      const core = detectedNotes(
        runCoreTimed(signal, SR, [hint], 0).map((e) => e.ev),
        SR,
      );
      expect(worklet).toEqual(core);
      if (clip.id === 'iowa-single-notes') {
        const score = scoreDetections(worklet, clip.notes.map((n) => ({ sec: n.onsetSec, midi: n.midi })), 0.03);
        expect(score.recall).toBeGreaterThanOrEqual(0.9);
        expect(score.precision).toBeGreaterThanOrEqual(0.9);
        expect(score.pitchAccuracy).toBe(1);
      }
    });
  }
});
