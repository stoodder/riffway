/**
 * The judge's guitar input horizon covers held onsets (T-111 check of T-104): an onset whose report
 * the detector holds back (a lone soft note after a loud one, contact noise before a pluck, a re-pick
 * on a ringing string) still reaches the main thread within `GUITAR_ANALYSIS_DELAY_SEC`, at 44.1 and
 * 48 kHz and with either pitch window, and the delivery margin left in `INPUT_LAG_SEC.guitar` keeps
 * a late Good (+115 ms) a Good when the worst measured main-thread delay is added on top
 * (docs/audio-input.md § Worklet → main-thread delay: ≤ 29.3 ms with 30 ms jank every 100 ms).
 */
import { describe, expect, it } from 'vitest';
import type { AnalysisCommand } from '@shared/audio-events';
import type { InputEvent } from '@shared/judge';
import { createJudge, inputHorizon } from '@core/judge';
import { GUITAR_ANALYSIS_DELAY_SEC, INPUT_DELIVERY_MARGIN_SEC, INPUT_LAG_SEC } from '@core/judge/constants';
import { runCoreTimed } from '../audio-pipeline/scenario';
import { addPickTransient, dbToAmp, fadeOut, karplusStrong, mixInto, noise, renderTimeline, type TimelineNote } from '../helpers/signals';
import { makeSong } from './helpers';

/** Worst main-thread delivery delay measured in Chromium under 30 ms jank (docs/audio-input.md). */
const MEASURED_DELIVERY_MAX_SEC = 0.0293;

function pluckAt(freq: number, durSec: number, sampleRate: number, db: number, seed: number): Float32Array {
  const amp = dbToAmp(db);
  const tone = karplusStrong(freq, durSec, sampleRate, { amp, seed });
  addPickTransient(tone, sampleRate, amp * 0.3, 1, seed + 1);
  return fadeOut(tone, sampleRate, 8);
}

function contact(sampleRate: number, rmsDb: number, seed: number): Float32Array {
  const burst = noise(Math.round(0.01 * sampleRate), dbToAmp(rmsDb), seed);
  const tau = 0.004 * sampleRate;
  for (let i = 0; i < burst.length; i++) burst[i]! *= Math.exp(-i / tau);
  return burst;
}

/** Signals whose onsets the detector holds before reporting them, with the plucks' true times. */
function heldScenarios(sr: number): { label: string; signal: Float32Array }[] {
  const out: { label: string; signal: Float32Array }[] = [];
  // A lone soft note after a loud one: held until CONFIRM_MS.
  out.push({
    label: 'soft after loud',
    signal: renderTimeline(
      [
        { atSec: 0.1, signal: pluckAt(110, 0.3, sr, -6, 1) },
        { atSec: 0.6, signal: pluckAt(220, 0.3, sr, -34, 2) },
        { atSec: 1.1, signal: pluckAt(330, 0.3, sr, -8, 3) },
        { atSec: 1.6, signal: pluckAt(392, 0.3, sr, -36, 4) },
      ],
      2.2,
      sr,
      -75,
    ),
  });
  // Contact noise 20–65 ms before the pluck: held and re-anchored to the pluck.
  for (const gapMs of [20, 45, 65]) {
    const notes: TimelineNote[] = [
      { atSec: 0.1, signal: pluckAt(165, 0.45, sr, -8, 3) },
      { atSec: 0.7, signal: contact(sr, -44, gapMs) },
      { atSec: 0.7 + gapMs / 1000, signal: pluckAt(220, 0.4, sr, -10, gapMs) },
    ];
    out.push({ label: `contact ${gapMs} ms`, signal: renderTimeline(notes, 1.4, sr, -75) });
  }
  // A re-pick on a ringing string: held until it has sustained.
  const ring = karplusStrong(196, 1.4, sr, { amp: dbToAmp(-12), feedback: 0.999, seed: 5 });
  mixInto(ring, contact(sr, -34, 9), Math.round(0.8 * sr));
  out.push({ label: 're-pick', signal: renderTimeline([{ atSec: 0.1, signal: fadeOut(ring, sr, 8) }], 1.6, sr, -75) });
  return out;
}

/** Pitch-window hints: low notes (N = 2048) and high notes only (N = 1024). */
const HINTS: { label: string; cmd: AnalysisCommand }[] = [
  { label: 'N=2048', cmd: { type: 'expect', range: { minMidi: 40, maxMidi: 76 } } },
  { label: 'N=1024', cmd: { type: 'expect', range: { minMidi: 55, maxMidi: 76 } } },
];

describe('held onsets stay inside the judge input horizon', () => {
  for (const sr of [44100, 48000]) {
    it(`${sr} Hz: every onset message (held or not) is posted within GUITAR_ANALYSIS_DELAY_SEC`, () => {
      let worst = 0;
      let onsets = 0;
      for (const { label, signal } of heldScenarios(sr)) {
        for (const hint of HINTS) {
          const events = runCoreTimed(signal, sr, [hint.cmd], 0);
          for (const e of events) {
            if (e.ev.type !== 'onset') continue;
            onsets++;
            const delay = e.arrivalSec - e.ev.frame / sr;
            worst = Math.max(worst, delay);
            expect(delay, `${label}, ${hint.label}`).toBeLessThanOrEqual(GUITAR_ANALYSIS_DELAY_SEC + 1e-9);
          }
        }
      }
      console.info(`[T-111] held-onset check @${sr} Hz: ${onsets} onsets, worst post delay ${(worst * 1000).toFixed(1)} ms (budget ${(GUITAR_ANALYSIS_DELAY_SEC * 1000).toFixed(1)} ms)`);
      expect(onsets).toBeGreaterThan(20);
      // The budget is not padded far beyond the real worst case either.
      expect(worst).toBeGreaterThan(GUITAR_ANALYSIS_DELAY_SEC - 0.01);
    });
  }

  it('analysis budget + the worst measured delivery delay fits the horizon with the delivery margin', () => {
    expect(GUITAR_ANALYSIS_DELAY_SEC + MEASURED_DELIVERY_MAX_SEC).toBeLessThanOrEqual(INPUT_LAG_SEC.guitar);
    expect(MEASURED_DELIVERY_MAX_SEC).toBeLessThan(INPUT_DELIVERY_MARGIN_SEC);
  });

  it('a late Good (+115 ms) delivered after the worst analysis + delivery delay is still a Good', () => {
    const song = makeSong([{ time: 1, midi: 64 }]);
    const clock = { songTimeAt: (c: number) => c, ctxTimeAt: (s: number) => s };
    const judge = createJudge(song, { clock });
    const ev: InputEvent = { ctxTime: 1.115, kind: 'onset', midi: 64, cents: 0, clarity: 0.95, source: 'guitar' };
    const arrives = ev.ctxTime + GUITAR_ANALYSIS_DELAY_SEC + MEASURED_DELIVERY_MAX_SEC;
    const outcomes: string[] = [];
    let pushed = false;
    for (let now = 0; now < 2; now += 1 / 60) {
      if (!pushed && now >= arrives) {
        pushed = true;
        for (const j of judge.push(ev).judgements) outcomes.push(`${j.outcome}/${j.timing}`);
      }
      for (const j of judge.advance(inputHorizon(now, 'guitar', 0)).judgements) outcomes.push(`${j.outcome}/${j.timing}`);
    }
    expect(outcomes).toEqual(['Good/late']);
  });
});
