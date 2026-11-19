/**
 * Scoring helpers for the audio-pipeline tests (T-036): turn analysis-worklet events into detected
 * notes, match them one-to-one against reference onsets, and summarise recall, precision, pitch
 * accuracy, octave errors and timing error. DOM-free; shared by the Node and browser tests.
 */
import type { AnalysisEvent } from '@shared/audio-events';

/**
 * One detected note start: an `onset` (pitched by itself or by its follow-up `pitch`), or a legato
 * `pitch-change` (a note without a pick attack: hammer-on, pull-off, slide).
 */
export interface DetectedNote {
  kind: 'onset' | 'legato';
  /** Onset time, s (`frame / sampleRate`). */
  sec: number;
  frame: number;
  /** Detected MIDI; null when the onset stayed unpitched. */
  midi: number | null;
  cents: number;
  /** True when the pitch came from the follow-up `pitch` message. */
  refined: boolean;
}

/** A reference note to match against. */
export interface ReferenceNote {
  sec: number;
  midi: number;
}

/** Statistics of a list of signed values. */
export interface ErrorStats {
  n: number;
  mean: number;
  meanAbs: number;
  /** 95th percentile of |value| (nearest rank). */
  p95Abs: number;
  maxAbs: number;
}

/** Result of {@link scoreDetections}. */
export interface DetectionScore {
  reference: number;
  detected: number;
  matched: number;
  /** matched / reference. */
  recall: number;
  /** matched / detected. */
  precision: number;
  /** Matched notes with exactly the reference MIDI / matched. */
  pitchAccuracy: number;
  /** Matched notes off by a whole number of octaves (≠ 0). */
  octaveErrors: number;
  /** Matched notes with another wrong pitch. */
  otherPitchErrors: number;
  /** Matched notes left unpitched. */
  unpitched: number;
  /** Matched notes found as legato (`pitch-change`) rather than onsets. */
  legato: number;
  /** Detected − reference onset, ms, over matched notes. */
  timingMs: ErrorStats;
  /** Reference notes without a detection. */
  missed: { sec: number; midi: number }[];
  /** Detections without a reference note. */
  extra: DetectedNote[];
  /** Matched notes whose pitch is wrong or missing. */
  wrongPitch: { sec: number; expected: number; got: number | null; cents: number }[];
}

/**
 * Collect detected notes from analysis events: every `onset`, with `midi` filled in by a later
 * `pitch` message for the same onset frame.
 */
export function detectedNotes(events: readonly AnalysisEvent[], sampleRate: number): DetectedNote[] {
  const notes: DetectedNote[] = [];
  const byFrame = new Map<number, DetectedNote>();
  for (const ev of events) {
    if (ev.type === 'onset') {
      const n: DetectedNote = { kind: 'onset', sec: ev.frame / sampleRate, frame: ev.frame, midi: ev.midi, cents: ev.cents, refined: false };
      notes.push(n);
      byFrame.set(ev.frame, n);
    } else if (ev.type === 'pitch') {
      const n = byFrame.get(ev.onsetFrame);
      if (n && n.midi === null) {
        n.midi = ev.midi;
        n.cents = ev.cents;
        n.refined = true;
      }
    }
  }
  return notes;
}

/** A `pitch-change` within this long after a note start of the same MIDI repeats it (s). */
export const LEGATO_REPEAT_SEC = 0.1;

/**
 * {@link detectedNotes} plus legato note starts: `pitch-change` events, except those that only
 * repeat the MIDI of a note start in the preceding {@link LEGATO_REPEAT_SEC} (the detector settling
 * on the note just plucked). Sorted by time.
 */
export function detectedNotesWithLegato(events: readonly AnalysisEvent[], sampleRate: number): DetectedNote[] {
  const notes = detectedNotes(events, sampleRate);
  for (const ev of events) {
    if (ev.type !== 'pitch-change') continue;
    const sec = ev.frame / sampleRate;
    const repeat = notes.some((n) => n.midi === ev.midi && sec - n.sec >= 0 && sec - n.sec <= LEGATO_REPEAT_SEC);
    if (!repeat) notes.push({ kind: 'legato', sec, frame: ev.frame, midi: ev.midi, cents: ev.cents, refined: false });
  }
  return notes.sort((a, b) => a.sec - b.sec);
}

/**
 * Median of detected − reference onset (s) over closest pairs within `windowSec`: the constant
 * offset a latency calibration would remove (annotation conventions differ: GuitarSet marks notes
 * ~10–15 ms after the steep part of the attack).
 */
export function medianOffset(detected: readonly DetectedNote[], reference: readonly ReferenceNote[], windowSec = 0.06): number {
  const diffs: number[] = [];
  for (const ref of reference) {
    let best: number | null = null;
    for (const det of detected) {
      const d = det.sec - ref.sec;
      if (Math.abs(d) <= windowSec && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
    if (best !== null) diffs.push(best);
  }
  if (diffs.length === 0) return 0;
  diffs.sort((a, b) => a - b);
  const mid = diffs.length >> 1;
  return diffs.length % 2 ? diffs[mid] : (diffs[mid - 1] + diffs[mid]) / 2;
}

/** Signed-error statistics (ms in, ms out). */
export function errorStats(values: readonly number[]): ErrorStats {
  if (values.length === 0) return { n: 0, mean: 0, meanAbs: 0, p95Abs: 0, maxAbs: 0 };
  const abs = values.map(Math.abs).sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil(0.95 * abs.length) - 1);
  return {
    n: values.length,
    mean: values.reduce((s, v) => s + v, 0) / values.length,
    meanAbs: abs.reduce((s, v) => s + v, 0) / abs.length,
    p95Abs: abs[rank],
    maxAbs: abs[abs.length - 1],
  };
}

/**
 * Match detections to reference notes one-to-one within `toleranceSec` (closest pairs first, as
 * in onset-evaluation practice) and score them. `offsetSec` is subtracted from every detection
 * first (a calibrated constant offset, see {@link medianOffset}); timing errors are reported after it.
 */
export function scoreDetections(
  detected: readonly DetectedNote[],
  reference: readonly ReferenceNote[],
  toleranceSec: number,
  offsetSec = 0,
): DetectionScore {
  const pairs: { r: number; d: number; dist: number }[] = [];
  reference.forEach((ref, r) => {
    detected.forEach((det, d) => {
      const dist = Math.abs(det.sec - offsetSec - ref.sec);
      if (dist <= toleranceSec) pairs.push({ r, d, dist });
    });
  });
  pairs.sort((a, b) => a.dist - b.dist);
  const refTaken = new Map<number, number>();
  const detTaken = new Set<number>();
  for (const p of pairs) {
    if (refTaken.has(p.r) || detTaken.has(p.d)) continue;
    refTaken.set(p.r, p.d);
    detTaken.add(p.d);
  }
  const timing: number[] = [];
  let correct = 0;
  let octaveErrors = 0;
  let otherPitchErrors = 0;
  let unpitched = 0;
  let legato = 0;
  const wrongPitch: DetectionScore['wrongPitch'] = [];
  for (const [r, d] of refTaken) {
    const ref = reference[r];
    const det = detected[d];
    timing.push((det.sec - offsetSec - ref.sec) * 1000);
    if (det.kind === 'legato') legato++;
    if (det.midi === ref.midi) {
      correct++;
      continue;
    }
    wrongPitch.push({ sec: ref.sec, expected: ref.midi, got: det.midi, cents: det.cents });
    if (det.midi === null) unpitched++;
    else if ((det.midi - ref.midi) % 12 === 0) octaveErrors++;
    else otherPitchErrors++;
  }
  const matched = refTaken.size;
  return {
    reference: reference.length,
    detected: detected.length,
    matched,
    recall: reference.length ? matched / reference.length : 1,
    precision: detected.length ? matched / detected.length : 1,
    pitchAccuracy: matched ? correct / matched : 1,
    octaveErrors,
    otherPitchErrors,
    unpitched,
    legato,
    timingMs: errorStats(timing),
    missed: reference.filter((_, r) => !refTaken.has(r)).map((n) => ({ sec: n.sec, midi: n.midi })),
    extra: detected.filter((_, d) => !detTaken.has(d)),
    wrongPitch,
  };
}

/** One-line summary for test logs and docs tables. */
export function formatScore(label: string, s: DetectionScore): string {
  const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
  const t = s.timingMs;
  return (
    `${label}: recall ${pct(s.recall)} (${s.matched}/${s.reference}), precision ${pct(s.precision)} (${s.matched}/${s.detected}), ` +
    `pitch ${pct(s.pitchAccuracy)} (octave ${s.octaveErrors}, other ${s.otherPitchErrors}, unpitched ${s.unpitched}), legato ${s.legato}, ` +
    `timing mean ${t.mean.toFixed(1)} ms, |mean| ${t.meanAbs.toFixed(1)} ms, p95 ${t.p95Abs.toFixed(1)} ms, max ${t.maxAbs.toFixed(1)} ms`
  );
}
