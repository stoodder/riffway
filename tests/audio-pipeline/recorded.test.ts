/**
 * Recorded guitar through the analysis core (T-036, DEC-22): Iowa MIS single notes and two
 * GuitarSet solo excerpts (`tests/fixtures/audio/`, see ATTRIBUTION.md), scored against their
 * reference onsets at ±30 ms, then judged against a song made from the same annotations.
 *
 * Detector-level metrics come in two flavours (docs/audio-input.md § Recorded guitar):
 * - **raw**: detections vs reference onsets as they are;
 * - **calibrated**: the clip's median detection offset removed first, as the game's latency
 *   calibration would (GuitarSet's annotations sit ~10–15 ms after the steep part of the attack).
 * Legato notes (no pick attack) count when the detector reports them as `pitch-change`.
 *
 * Iowa and the pickup excerpt (closest to the owner's DI electric) meet the T-036 targets (≥ 90 %
 * onset recall and precision, ≥ 95 % pitch) since T-104's DSP fixes (docs/audio-input.md
 * § Audio-pipeline results). The microphone excerpt does not yet (slides annotated at their start);
 * its target is an `it.fails` and its measured values are pinned as regression floors.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readWav } from './wav';
import type { ClipAnnotation, FixtureManifest } from './manifest';
import { detectedNotes, detectedNotesWithLegato, formatScore, medianOffset, scoreDetections, type DetectionScore, type ReferenceNote } from './evaluate';
import { judgeRun, linearClock, runCoreTimed } from './scenario';
import { makeSong } from '../judge/helpers';
import type { AnalysisCommand } from '@shared/audio-events';
import type { StringNumber } from '@shared/song';

const FIXTURES = new URL('../fixtures/audio/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('annotations.json', FIXTURES), 'utf8')) as FixtureManifest;
const TOLERANCE_SEC = 0.03;

interface ClipRun {
  clip: ClipAnnotation;
  samples: Float32Array;
  reference: ReferenceNote[];
}

function load(clip: ClipAnnotation): ClipRun {
  const wav = readWav(new Uint8Array(readFileSync(new URL(clip.file, FIXTURES))));
  expect(wav.sampleRate).toBe(clip.sampleRate);
  expect(wav.channels).toHaveLength(1);
  return { clip, samples: wav.channels[0], reference: clip.notes.map((n) => ({ sec: n.onsetSec, midi: n.midi })) };
}

/** The `expect` hint a game would send for this clip's notes. */
function hintFor(run: ClipRun): AnalysisCommand {
  const midis = run.reference.map((r) => r.midi);
  return { type: 'expect', range: { minMidi: Math.min(...midis), maxMidi: Math.max(...midis) } };
}

interface ClipResult {
  raw: DetectionScore;
  calibrated: DetectionScore;
  offsetMs: number;
}

function evaluate(run: ClipRun, hint: boolean): ClipResult {
  const sr = run.clip.sampleRate;
  const events = runCoreTimed(run.samples, sr, hint ? [hintFor(run)] : [], 0).map((e) => e.ev);
  const onsets = detectedNotes(events, sr);
  const offset = medianOffset(onsets, run.reference);
  return {
    raw: scoreDetections(onsets, run.reference, TOLERANCE_SEC),
    calibrated: scoreDetections(detectedNotesWithLegato(events, sr), run.reference, TOLERANCE_SEC, offset),
    offsetMs: offset * 1000,
  };
}

function report(id: string, hint: boolean, r: ClipResult): void {
  console.info(`[T-036 recorded] ${id} hint=${hint} offset ${r.offsetMs.toFixed(1)} ms`);
  console.info(`  ${formatScore('raw', r.raw)}`);
  console.info(`  ${formatScore('calibrated+legato', r.calibrated)}`);
  const c = r.calibrated;
  if (c.missed.length) console.info(`  missed ${JSON.stringify(c.missed)}`);
  if (c.extra.length) console.info(`  extra ${JSON.stringify(c.extra.map((e) => [e.kind, +e.sec.toFixed(3), e.midi]))}`);
  if (c.wrongPitch.length) console.info(`  wrong pitch ${JSON.stringify(c.wrongPitch.map((w) => [+w.sec.toFixed(3), w.expected, w.got, Math.round(w.cents)]))}`);
}

/** T-036 acceptance targets. */
function meetsTargets(s: DetectionScore): void {
  expect(s.recall).toBeGreaterThanOrEqual(0.9);
  expect(s.precision).toBeGreaterThanOrEqual(0.9);
  expect(s.pitchAccuracy).toBeGreaterThanOrEqual(0.95);
}

const clip = (id: string): ClipRun => {
  const c = manifest.clips.find((x) => x.id === id);
  if (!c) throw new Error(`no clip ${id}`);
  return load(c);
};

describe('recorded fixtures', () => {
  it('stay within DEC-22 limits (≤ 6 clips, 48 kHz mono 16-bit, ≤ 2 MB, attributed)', () => {
    expect(manifest.clips.length).toBeLessThanOrEqual(6);
    let bytes = 0;
    for (const c of manifest.clips) {
      const data = readFileSync(new URL(c.file, FIXTURES));
      bytes += data.length;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      expect({ channels: view.getUint16(22, true), rate: view.getUint32(24, true), bits: view.getUint16(34, true) }).toEqual({ channels: 1, rate: 48000, bits: 16 });
      expect(c.sources.length).toBeGreaterThan(0);
      expect(c.notes.length).toBeGreaterThan(10);
    }
    expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    const attribution = readFileSync(new URL(manifest.attribution, FIXTURES), 'utf8');
    expect(attribution).toContain('CC BY 4.0');
    expect(attribution).toContain('University of Iowa');
  });
});

describe('recorded guitar through the analysis core', { timeout: 30_000 }, () => {
  const iowa = clip('iowa-single-notes');
  const rock1 = clip('guitarset-rock1-mic');
  const rock2 = clip('guitarset-rock2-pickup');

  for (const hint of [false, true]) {
    it(`Iowa single notes (E2–A5, pp/mf) meet the targets, no octave errors (hint ${hint})`, () => {
      const r = evaluate(iowa, hint);
      report(iowa.clip.id, hint, r);
      meetsTargets(r.raw);
      meetsTargets(r.calibrated);
      expect(r.raw.pitchAccuracy).toBe(1);
      expect(r.raw.octaveErrors).toBe(0);
      expect(Math.abs(r.raw.timingMs.mean)).toBeLessThanOrEqual(3);
      expect(r.raw.timingMs.p95Abs).toBeLessThanOrEqual(5);
      // T-104: A5 (81) used to fire 33 ms early on fingertip contact noise; the onset is now re-anchored.
      expect(r.raw.missed).toEqual([]);
      expect(r.raw.extra).toEqual([]);
    });
  }

  it('GuitarSet rock 2 (pickup) meets the targets: pick-noise onsets re-anchored, the bend read at its target', () => {
    const r = evaluate(rock2, true);
    report(rock2.clip.id, true, r);
    meetsTargets(r.calibrated);
    expect(r.calibrated).toMatchObject({ recall: 1, precision: 1, pitchAccuracy: 1, octaveErrors: 0 });
    // Raw (uncalibrated) onsets: one note still sits > 30 ms before GuitarSet's late annotation.
    expect(r.raw.recall).toBeGreaterThanOrEqual(16 / 17);
    expect(r.raw.precision).toBe(1);
    // The bent note (annotated 60.14 at 3.789 s) is reported at its target, not 59 +43 cents.
    expect(r.calibrated.wrongPitch).toEqual([]);
    expect(r.offsetMs).toBeLessThan(0);
    expect(r.calibrated.timingMs.p95Abs).toBeLessThanOrEqual(15);
  });

  // Regression floors at the measured values (see docs/audio-input.md § Recorded guitar).
  it('GuitarSet rock 1 (microphone) holds its measured floor, without octave errors', () => {
    for (const hint of [false, true]) {
      const r = evaluate(rock1, hint);
      report(rock1.clip.id, hint, r);
      expect(r.raw.recall).toBeGreaterThanOrEqual(22 / 24);
      expect(r.raw.precision).toBeGreaterThanOrEqual(22 / 24);
      expect(r.calibrated.recall).toBeGreaterThanOrEqual(23 / 24);
      expect(r.calibrated.precision).toBeGreaterThanOrEqual(23 / 27);
      expect(r.calibrated.pitchAccuracy).toBeGreaterThanOrEqual(0.95);
      expect(r.calibrated.octaveErrors).toBe(0);
    }
  });

  it.fails('GuitarSet rock 1 (microphone) meets the T-036 targets [known gap: slides annotated at their start, one contact noise]', () => {
    meetsTargets(evaluate(rock1, true).calibrated);
  });
});

describe('recorded guitar judged against its annotations', { timeout: 30_000 }, () => {
  // Measured (T-104): Iowa 100 %; rock 2 94.1 % (the hammer-on the annotation-made song does not mark
  // as legato → Miss); rock 1 87.5 % (two slides, one slide-off pitch).
  const floors: Record<string, number> = { 'iowa-single-notes': 100, 'guitarset-rock2-pickup': 94, 'guitarset-rock1-mic': 87 };
  for (const c of manifest.clips) {
    it(`${c.id}: accuracy ≥ ${floors[c.id]} % with a calibrated offset`, () => {
      const run = load(c);
      const sr = c.sampleRate;
      const posted = runCoreTimed(run.samples, sr, [hintFor(run)], 0.01);
      const offsetMs = medianOffset(detectedNotes(posted.map((e) => e.ev), sr), run.reference) * 1000;
      const song = makeSong(c.notes.map((n) => ({ time: n.onsetSec, midi: n.midi, string: n.string as StringNumber })));
      const judged = judgeRun(song, linearClock(0, 1), posted, { sampleRate: sr, inputOffsetMs: offsetMs, endSec: c.durationSec + 0.5 });
      const s = judged.summary;
      console.info(`[T-036 recorded judge] ${c.id}: accuracy ${s.accuracy.toFixed(1)}% counts ${JSON.stringify(s.counts)} strays ${s.strays} late ${judged.lateArrivals}`);
      expect(judged.lateArrivals).toBe(0);
      expect(s.accuracy).toBeGreaterThanOrEqual(floors[c.id]);
    });
  }
});
