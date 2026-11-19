/**
 * Test-only emulation of the analysis worklet's use of the DSP core (the real shell is T-022):
 * 128-sample hops into the onset detector; an MPM estimate every 2 hops on the newest window feeds
 * the pitch-change detector (frame = window centre); each onset's pitch is measured on the window
 * starting 25 ms after it.
 */
import {
  createOnsetDetector,
  createPitchChangeDetector,
  createPitchDetector,
  type PitchDetector,
  type PitchWindowSize,
} from '@core/dsp';

export const HOP = 128;
/** Pitch frames for the legato detector every this many samples. */
export const PITCH_STEP = 256;
/** Onset pitch is measured this long after the onset (docs/audio-input.md). */
export const ONSET_PITCH_DELAY_SEC = 0.025;

export interface OnsetEvent {
  /** Onset frame (sample-accurate). */
  frame: number;
  /** Frame at which the detector reported it (end of the hop that triggered). */
  detectedAt: number;
  midi: number | null;
  cents: number;
  clarity: number;
}

export interface PitchChangeEvent {
  /** First pitch frame at the new pitch. */
  frame: number;
  /** Frame at which the change was confirmed. */
  detectedAt: number;
  midi: number;
}

export interface AnalysisResult {
  onsets: OnsetEvent[];
  pitchChanges: PitchChangeEvent[];
}

/** Run the onset / pitch / legato chain over `signal` (window `size`, optional MIDI search range). */
export function analyse(
  signal: Float32Array,
  sampleRate: number,
  opts: { size?: PitchWindowSize; range?: { minMidi: number; maxMidi: number } | null } = {},
): AnalysisResult {
  const size = opts.size ?? 2048;
  const onsetDetector = createOnsetDetector({ sampleRate });
  const legato = createPitchChangeDetector({ sampleRate });
  const tracker: PitchDetector = createPitchDetector({ sampleRate, size });
  const onsetPitch: PitchDetector = createPitchDetector({ sampleRate, size });
  tracker.setRange(opts.range ?? null);
  onsetPitch.setRange(opts.range ?? null);
  const onsets: OnsetEvent[] = [];
  const pitchChanges: PitchChangeEvent[] = [];
  const pendingPitch: OnsetEvent[] = [];
  const delay = Math.round(ONSET_PITCH_DELAY_SEC * sampleRate);

  for (let start = 0; start + HOP <= signal.length; start += HOP) {
    const end = start + HOP;
    const onset = onsetDetector.process(signal.subarray(start, end), start);
    if (onset >= 0) {
      const ev: OnsetEvent = { frame: onset, detectedAt: end, midi: null, cents: 0, clarity: 0 };
      onsets.push(ev);
      pendingPitch.push(ev);
      legato.onset(onset);
    }
    for (let i = pendingPitch.length - 1; i >= 0; i--) {
      const ev = pendingPitch[i];
      if (end < ev.frame + delay + size) continue;
      const est = onsetPitch.detect(signal, ev.frame + delay);
      if (est && est.clarity >= 0.6) {
        ev.midi = est.midi;
        ev.cents = est.cents;
        ev.clarity = est.clarity;
      }
      pendingPitch.splice(i, 1);
    }
    if (end % PITCH_STEP === 0 && end >= size) {
      const est = tracker.detect(signal, end - size);
      const midi = legato.push(est, end - size / 2);
      if (midi >= 0) pitchChanges.push({ frame: legato.changeFrame, detectedAt: end, midi });
    }
  }
  return { onsets, pitchChanges };
}
