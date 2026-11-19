/**
 * End-to-end timing through the analysis core and the real judge, in Node (T-036): the starter
 * song "Ode to Joy" played as Karplus–Strong plucks at known times with a simulated 23 ms input
 * latency, one wrong note, one omitted note and deliberate early/late plucks; calibrated with a
 * play-to-click pass; analysed quantum by quantum by `AnalysisCore` (the worklet's engine) with the
 * exact quantum each message is posted in; judged on a 60 Hz frame loop through `inputHorizon`.
 * The browser twin (`worklet.browser.test.ts`) runs the same plan through the real AudioWorklet.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadSong } from '@core/import/load-song';
import { CONFIRM_MS } from '@core/dsp/onset';
import { GUITAR_ANALYSIS_DELAY_SEC, INPUT_LAG_SEC } from '@core/judge/constants';
import type { Song } from '@shared/song';
import { errorStats } from './evaluate';
import {
  calibrateInputOffsetMs,
  checkScenario,
  judgeRun,
  linearClock,
  ODE_TO_JOY_DEVIATIONS,
  planScenario,
  renderScenario,
  runCoreTimed,
  type Deviation,
} from './scenario';

const SR = 48000;
const LATENCY_SEC = 0.023;

function odeToJoy(): Song {
  const data = new Uint8Array(readFileSync(new URL('../../starter/ode-to-joy.atex', import.meta.url)));
  return loadSong({ fileName: 'ode-to-joy.atex', data, id: 'starter:ode-to-joy' });
}

describe('song → plucks → analysis core → judge', { timeout: 60_000 }, () => {
  const song = odeToJoy();

  for (const speed of [1, 0.7]) {
    it(`judges Ode to Joy at ${speed * 100}% as planned, timing error mean ≤ 5 ms and p95 ≤ 10 ms`, () => {
      const plan = planScenario(song, { sampleRate: SR, speed, latencySec: LATENCY_SEC, deviations: ODE_TO_JOY_DEVIATIONS });
      const events = runCoreTimed(renderScenario(plan), SR, [plan.hint], 0.01);
      const offsetMs = calibrateInputOffsetMs(
        events.map((e) => e.ev),
        plan.clicks,
        SR,
      );
      expect(offsetMs).not.toBeNull();
      // Calibration recovers the simulated latency (plus the detector's own small bias).
      expect(Math.abs(offsetMs! - LATENCY_SEC * 1000)).toBeLessThan(5);
      const run = judgeRun(song, linearClock(plan.leadInSec, speed), events, { sampleRate: SR, inputOffsetMs: offsetMs!, endSec: plan.durationSec });
      const check = checkScenario(plan, run);
      const t = check.timingErrorMs;
      console.info(
        `[T-036 e2e node ${speed * 100}%] offset ${offsetMs!.toFixed(2)} ms; timing error n ${t.n} mean ${t.mean.toFixed(2)} ms, ` +
          `|mean| ${t.meanAbs.toFixed(2)} ms, p95 ${t.p95Abs.toFixed(2)} ms, max ${t.maxAbs.toFixed(2)} ms; counts ${JSON.stringify(run.summary.counts)}`,
      );
      expect(check.mismatches).toEqual([]);
      expect(run.lateArrivals).toBe(0);
      expect(Math.abs(check.timingErrorMs.mean)).toBeLessThanOrEqual(5);
      expect(check.timingErrorMs.p95Abs).toBeLessThanOrEqual(10);
      expect(run.summary.counts).toMatchObject({ WrongNote: 1, Miss: 1 });
      expect(run.strays.filter((s) => s.songTime >= 0)).toEqual([]);
    });
  }

  it('posts every onset within the analysis budget the judge horizon assumes', () => {
    const plan = planScenario(song, { sampleRate: SR, latencySec: LATENCY_SEC });
    const events = runCoreTimed(renderScenario(plan), SR, [plan.hint], 0);
    const delays = events.filter((e) => e.ev.type === 'onset').map((e) => e.arrivalSec - (e.ev as { frame: number }).frame / SR);
    const stats = errorStats(delays.map((d) => d * 1000));
    expect(stats.n).toBe(plan.plucks.length);
    // 25 ms wait + 2048-sample window (or a held suspect onset's CONFIRM_MS) + ≤ 1 quantum at 48 kHz.
    expect(stats.maxAbs).toBeLessThanOrEqual((Math.max(0.025 + 2048 / SR, CONFIRM_MS / 1000) + 128 / SR) * 1000 + 1e-6);
    expect(stats.maxAbs / 1000).toBeLessThanOrEqual(GUITAR_ANALYSIS_DELAY_SEC);
  });

  it('keeps every outcome while delivery stays within INPUT_LAG_SEC.guitar, and loses a late Good beyond it', () => {
    // A single late-Good pluck (+115 ms) is the first to suffer when messages arrive late.
    const late = new Map<number, Deviation>([[3, { timingMs: 115 }]]);
    const plan = planScenario(song, { sampleRate: SR, latencySec: LATENCY_SEC, deviations: late });
    const posted = runCoreTimed(renderScenario(plan), SR, [plan.hint], 0);
    const offsetMs = calibrateInputOffsetMs(
      posted.map((e) => e.ev),
      plan.clicks,
      SR,
    )!;
    const outcome = (deliverySec: number): string | undefined => {
      const events = posted.map((e) => ({ ev: e.ev, arrivalSec: e.arrivalSec + deliverySec }));
      const run = judgeRun(song, linearClock(plan.leadInSec, 1), events, { sampleRate: SR, inputOffsetMs: offsetMs, endSec: plan.durationSec });
      return run.judgements.get(plan.expected[3].noteId)?.outcome;
    };
    const budget = INPUT_LAG_SEC.guitar - (0.025 + (2048 + 128) / SR);
    expect(outcome(0)).toBe('Good');
    expect(outcome(budget - 0.02)).toBe('Good');
    expect(outcome(budget + 0.03)).toBe('Miss');
  });
});
