/** Tuner display model and level-meter model (T-022). */
import { describe, expect, it } from 'vitest';
import { createTunerSmoother } from '@core/dsp';
import { STANDARD_TUNING } from '@core/model';
import {
  CLIP_HOLD_MS,
  LevelModel,
  METER_MIN_DB,
  NO_SIGNAL_MS,
  PEAK_HOLD_MS,
  formatDb,
} from '../../src/ui/panels/input/level-model';
import {
  clampA4,
  formatCents,
  instruction,
  nearestString,
  splitName,
  stringTargets,
  tunerView,
} from '../../src/ui/panels/tuner/model';
import { midiToHz } from '../helpers/signals';

const DROP_D = [64, 59, 55, 50, 45, 38];

/** Feed a steady frequency to a real smoother for `sec` seconds at ~23 Hz; return the last reading. */
function settle(freq: number, a4 = 440, sec = 1) {
  const s = createTunerSmoother({ a4 });
  let r = null;
  for (let t = 0; t <= sec; t += 2048 / 48000) r = s.push({ freq, midi: 0, cents: 0, clarity: 0.99 }, t);
  return r!;
}

describe('tuner model', () => {
  it('lists string targets from the tuning', () => {
    expect(stringTargets(DROP_D).map((t) => `${t.string}:${t.name}${t.octave}`)).toEqual(['1:E4', '2:B3', '3:G3', '4:D3', '5:A2', '6:D2']);
    expect(splitName(61)).toEqual({ name: 'C#', octave: 4 });
  });

  it('finds the nearest string', () => {
    const t = stringTargets(STANDARD_TUNING);
    expect(t[nearestString(40.3, t)].string).toBe(6);
    expect(t[nearestString(47.5, t)].string).toBe(5);
    expect(t[nearestString(61.5, t)].string).toBe(2);
  });

  it('guides a standard low E tuned down to Drop D', () => {
    const targets = stringTargets(DROP_D);
    // Low string still at E2: nearest target is string 6 (D2), two semitones high.
    const v = tunerView(settle(midiToHz(40)), targets, 440)!;
    expect(v.note).toEqual({ name: 'E', octave: 2, midi: 40 });
    expect(v.target.string).toBe(6);
    expect(v.centsFromTarget).toBeCloseTo(200, 0);
    expect(v.direction).toBe('down');
    expect(v.inTune).toBe(false);
    expect(instruction(v)).toBe('Tune down to D2 (2 semitones)');
  });

  it('reports in tune only on the target note', () => {
    const targets = stringTargets(DROP_D);
    const v = tunerView(settle(midiToHz(38) * 2 ** (1.5 / 1200)), targets, 440)!;
    expect(v.target.string).toBe(6);
    expect(v.direction).toBe('ok');
    expect(v.inTune).toBe(true);
    expect(instruction(v)).toBe('String 6 in tune');
    const flat = tunerView(settle(midiToHz(45) * 2 ** (-20 / 1200)), targets, 440)!;
    expect(flat.direction).toBe('up');
    expect(Math.round(flat.cents)).toBe(-20);
    expect(instruction(flat)).toBe('Tune up to A2');
  });

  it('applies the A4 reference to notes and targets', () => {
    const targets = stringTargets(STANDARD_TUNING);
    const v = tunerView(settle(442, 442), targets, 442)!;
    expect(v.note.name).toBe('A');
    expect(Math.abs(v.cents)).toBeLessThan(0.5);
    const at440 = tunerView(settle(442, 440), targets, 440)!;
    expect(at440.cents).toBeCloseTo(7.85, 1);
  });

  it('returns null without a pitch and formats numbers', () => {
    expect(tunerView({ freq: 0, midi: 0, cents: 0, inTune: false, live: false }, stringTargets(DROP_D), 440)).toBeNull();
    expect(formatCents(0.4)).toBe('0');
    expect(formatCents(3.6)).toBe('+4');
    expect(formatCents(-12.2)).toBe('−12');
    expect(clampA4(400)).toBe(415);
    expect(clampA4(441.4)).toBe(441);
    expect(clampA4(500)).toBe(466);
  });
});

describe('level model', () => {
  it('holds the peak for 1 s and lets the bar fall', () => {
    const m = new LevelModel(0);
    m.push(-6, 0);
    expect(m.view(0)).toMatchObject({ barDb: -6, holdDb: -6, clip: false });
    m.push(-30, 100);
    const v = m.view(500);
    expect(v.barDb).toBeLessThan(-6);
    expect(v.barDb).toBeGreaterThan(-30);
    expect(v.holdDb).toBe(-6);
    expect(m.view(PEAK_HOLD_MS + 600).holdDb).toBe(m.view(PEAK_HOLD_MS + 600).barDb);
    expect(m.view(10_000).barDb).toBe(METER_MIN_DB);
  });

  it('lights the clip lamp for 2 s', () => {
    const m = new LevelModel(0);
    m.push(-0.3, 1000);
    expect(m.view(1000).clip).toBe(true);
    expect(m.view(1000 + CLIP_HOLD_MS).clip).toBe(true);
    expect(m.view(1001 + CLIP_HOLD_MS).clip).toBe(false);
  });

  it('says "No signal" after 5 s of silence and recovers', () => {
    const m = new LevelModel(0);
    for (let t = 0; t < NO_SIGNAL_MS; t += 50) m.push(-90, t);
    expect(m.view(NO_SIGNAL_MS - 1).noSignal).toBe(false);
    expect(m.view(NO_SIGNAL_MS).noSignal).toBe(true);
    m.push(-40, NO_SIGNAL_MS + 10);
    expect(m.view(NO_SIGNAL_MS + 20).noSignal).toBe(false);
    m.restart(20_000);
    expect(m.view(20_000 + NO_SIGNAL_MS - 1).noSignal).toBe(false);
  });

  it('formats dB', () => {
    expect(formatDb(-12.4)).toBe('−12 dB');
    expect(formatDb(-60)).toBe('−∞ dB');
    expect(formatDb(0.2)).toBe('0 dB');
  });
});
