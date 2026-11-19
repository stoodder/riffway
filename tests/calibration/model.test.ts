// @vitest-environment happy-dom
/**
 * Calibration panel view model (formatting, labels, failure advice, "how it is applied", residual
 * strip) and a graceful mount with an empty context (registry smoke test).
 */
import { describe, expect, it } from 'vitest';
import type { AppContext } from '@shared/ui';
import { clickPlan, estimateOffset, measuredTimes } from '../../src/audio/calibration';
import { mountPanel } from '../../src/ui/panels';
import {
  appliedSentence,
  deviceLine,
  failureMessage,
  fmtMs,
  fmtSignedMs,
  fmtSpread,
  perfectShare,
  residualDots,
  visualSentence,
} from '../../src/ui/panels/calibration/model';
import { simulate } from './helpers';

describe('formatting', () => {
  it('formats offsets, signed offsets and spreads', () => {
    expect(fmtMs(41.6)).toBe('42 ms');
    expect(fmtMs(-8.2)).toBe('−8 ms');
    expect(fmtSignedMs(10)).toBe('+10 ms');
    expect(fmtSignedMs(-5)).toBe('−5 ms');
    expect(fmtSignedMs(0.3)).toBe('0 ms');
    expect(fmtSpread(2.44)).toBe('±2.4 ms');
  });

  it('describes the device pair', () => {
    expect(deviceLine({ input: { deviceId: 'a', label: 'Scarlett', channel: 0 }, output: { sinkId: '', label: null } })).toBe('Scarlett → Default output');
  });
});

describe('sentences', () => {
  it('explains how an offset changes judging', () => {
    expect(appliedSentence('guitar', 42)).toBe(
      'Riffway subtracts 42 ms from every pluck before judging it, so a note you play right on the beat scores Perfect (±35 ms).',
    );
    expect(appliedSentence('keyboard', -12)).toContain('adds 12 ms to every key press');
    expect(appliedSentence('guitar', 0.2)).toBe('Every pluck is judged as it arrives. Perfect is ±35 ms.');
    expect(visualSentence(15)).toContain('15 ms later');
    expect(visualSentence(-10)).toContain('10 ms earlier');
    expect(visualSentence(0)).toBe('The highway is drawn in sync with what you hear.');
  });

  it('gives specific advice per failure and kind', () => {
    expect(failureMessage('no-events', 'guitar', { kept: 0, spreadMs: null }).title).toBe('No plucks were detected');
    expect(failureMessage('no-events', 'keyboard', { kept: 0, spreadMs: null }).title).toBe('No taps were heard');
    expect(failureMessage('no-events', 'loopback', { kept: 0, spreadMs: null }).advice).toMatch(/cable/);
    expect(failureMessage('too-few', 'guitar', { kept: 5, spreadMs: 3 }).title).toBe('Only 5 usable plucks');
    expect(failureMessage('inconsistent', 'keyboard', { kept: 12, spreadMs: 21.3 }).title).toBe('Timing too uneven (±21.3 ms)');
  });
});

describe('residual strip', () => {
  it('places each pair after the offset and counts Perfect hits', () => {
    const clicks = measuredTimes(clickPlan(1));
    const e = estimateOffset(clicks, simulate(clicks, { offsetMs: 40, outliers: { 8: 200, 9: 60 } }));
    const dots = residualDots(e);
    expect(dots).toHaveLength(16);
    expect(dots[0]).toMatchObject({ ms: expect.closeTo(0, 6), x: expect.closeTo(0.5, 6), status: 'settling', clipped: false });
    expect(dots[8]).toMatchObject({ x: 1, clipped: true, status: 'rejected' });
    expect(dots[9]!.ms).toBeCloseTo(60, 6);
    expect(perfectShare(e)).toBe(1);
    expect(residualDots({ pairs: [], offsetMs: null })).toEqual([]);
  });
});

describe('panel mount', () => {
  it('mounts gracefully with an empty context and unmounts', async () => {
    const el = document.createElement('div');
    const handle = await mountPanel('calibration', el, {} as AppContext, {});
    expect(el.textContent).toContain('Calibration is unavailable');
    handle.unmount();
    expect(el.childNodes).toHaveLength(0);
  });
});
