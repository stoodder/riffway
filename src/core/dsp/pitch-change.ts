/**
 * Legato detector (hammer-ons, pull-offs, slides): during a sustained note, a tracked pitch that
 * moves ≥ 0.8 semitone from the note's reference and holds there for ≥ 25 ms, with no amplitude
 * onset in between, is a new note. Allocation-free.
 * @module
 */
import type { PitchChangeDetector, PitchEstimate } from './index';

/** Minimum move from the reference pitch, semitones. */
export const PITCH_CHANGE_SEMITONES = 0.8;
/** The new pitch must hold this long, ms. */
export const PITCH_CHANGE_HOLD_MS = 25;
/** Pitch frames below this clarity carry no information (ignored). */
const MIN_CLARITY = 0.8;
/** A candidate is still "the same pitch" while frames stay within this many semitones of it. */
const CANDIDATE_TOLERANCE = 0.5;
/** Frames this soon after an amplitude onset are skipped (inharmonic attack). */
const SETTLE_MS = 25;
/**
 * After this long without a valid pitch frame the note is over and the reference is dropped. Long
 * enough to bridge the unclear frames in the middle of a slide (~60 ms for 5 semitones in 80 ms).
 */
const NOTE_END_MS = 150;

/** {@link PitchChangeDetector} that also reports where the change began. */
export interface LegatoDetector extends PitchChangeDetector {
  /** Frame of the first pitch frame at the new pitch, for the change last returned by `push` (−1 before any). */
  readonly changeFrame: number;
}

/**
 * Create a pitch-change detector. Feed it every pitch frame with the frame it describes (the centre
 * of the analysis window times best); call `onset(frame)` for every amplitude onset. The first
 * valid pitch at least 25 ms after an onset, or after 150 ms without a valid pitch, becomes the
 * note's reference; a change returns the new MIDI note and becomes the next reference.
 */
export function createPitchChangeDetector(opts: { sampleRate: number }): LegatoDetector {
  return new PitchChangeTracker(opts.sampleRate);
}

class PitchChangeTracker implements LegatoDetector {
  changeFrame = -1;
  private readonly holdFrames: number;
  private readonly settleFrames: number;
  private readonly noteEndFrames: number;
  /** Fractional MIDI of the current note; NaN = no reference. */
  private reference = NaN;
  /** Fractional MIDI of the pending change; NaN = none. */
  private candidate = NaN;
  private candidateFrame = 0;
  private settleUntil = -Infinity;
  private lastValidFrame = -Infinity;

  constructor(sampleRate: number) {
    if (!(sampleRate > 0)) throw new RangeError(`sample rate must be > 0, got ${sampleRate}`);
    this.holdFrames = Math.round((PITCH_CHANGE_HOLD_MS / 1000) * sampleRate);
    this.settleFrames = Math.round((SETTLE_MS / 1000) * sampleRate);
    this.noteEndFrames = Math.round((NOTE_END_MS / 1000) * sampleRate);
  }

  push(estimate: PitchEstimate | null, frame: number): number {
    if (frame < this.settleUntil) return -1;
    if (!estimate || estimate.clarity < MIN_CLARITY || !(estimate.freq > 0)) {
      if (frame - this.lastValidFrame > this.noteEndFrames) {
        this.reference = NaN;
        this.candidate = NaN;
      }
      return -1;
    }
    this.lastValidFrame = frame;
    const pitch = estimate.midi + estimate.cents / 100;
    if (Number.isNaN(this.reference)) {
      this.reference = pitch;
      return -1;
    }
    if (Math.abs(pitch - this.reference) < PITCH_CHANGE_SEMITONES) {
      this.candidate = NaN;
      return -1;
    }
    if (Number.isNaN(this.candidate) || Math.abs(pitch - this.candidate) > CANDIDATE_TOLERANCE) {
      this.candidate = pitch;
      this.candidateFrame = frame;
      return -1;
    }
    if (frame - this.candidateFrame < this.holdFrames) return -1;
    this.reference = pitch;
    this.candidate = NaN;
    this.changeFrame = this.candidateFrame;
    return estimate.midi;
  }

  onset(frame: number): void {
    this.reference = NaN;
    this.candidate = NaN;
    this.settleUntil = frame + this.settleFrames;
  }

  reset(): void {
    this.reference = NaN;
    this.candidate = NaN;
    this.candidateFrame = 0;
    this.settleUntil = -Infinity;
    this.lastValidFrame = -Infinity;
    this.changeFrame = -1;
  }
}
