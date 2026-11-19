/**
 * Analysis engine run by the analysis worklet (`src/audio/worklets/analysis.worklet.ts`), kept free
 * of worklet globals so Node tests drive it quantum by quantum (docs/audio-input.md § Pitch and
 * onset detection worklet). It wraps the T-015 DSP from `@core/dsp`:
 *
 * - **Channel select:** channel 0, channel 1 (falls back to 0 on a mono input) or the mean of the
 *   first two channels.
 * - **Level:** peak/RMS every ~50 ms → `level`.
 * - **Onsets:** every 128-sample quantum through the onset detector. The onset's pitch is measured on
 *   the window starting 25 ms after it (N = 2048, or 1024 when an `expect` hint is above ~160 Hz) →
 *   `onset` (`midi: null` below clarity 0.6, then one retry 512 samples later → `pitch`). If the next
 *   onset arrives first, the latest window that ends at that onset is used instead (or the onset is
 *   unpitched when none fits), so a window never spans two plucks.
 * - **Legato:** a pitch frame on the newest window every 256 samples (frame = window centre) feeds the
 *   pitch-change detector → `pitch-change` at the detector's `changeFrame`.
 * - **Tuner** (when on): N = 4096, hop 2048 (~23 Hz at 48 kHz) → `tuner` frames, smoothed on the main
 *   thread.
 *
 * Allocation-free per quantum apart from the event objects handed to `emit`.
 * @module
 */
import {
  createLevelMeter,
  createOnsetDetector,
  createPitchChangeDetector,
  createPitchDetector,
  planPitchWindow,
  type LegatoDetector,
  type LevelMeter,
  type OnsetDetector,
  type PitchDetector,
  type PitchEstimate,
} from '@core/dsp';
import type { AnalysisCommand, AnalysisEvent, AnalysisProcessorOptions } from '@shared/audio-events';

/** Analysed channel (same values as the `input.channel` setting). */
type InputChannel = AnalysisProcessorOptions['channel'];

/** Render quantum (Web Audio) = onset hop. */
export const QUANTUM = 128;
/** Level events every this many seconds. */
export const LEVEL_INTERVAL_SEC = 0.05;
/** The onset's pitch window starts this long after the onset (past the inharmonic attack). */
export const ONSET_PITCH_DELAY_SEC = 0.025;
/** An onset whose first estimate is unclear is re-measured once, this many samples later. */
export const RETRY_SHIFT_FRAMES = 512;
/** Below this clarity an onset is reported unpitched (`midi: null`). */
export const ONSET_MIN_CLARITY = 0.6;
/** Legato pitch frames every this many samples. */
export const PITCH_STEP_FRAMES = 256;
/** Tuner window and hop. */
export const TUNER_WINDOW = 4096;
export const TUNER_HOP_FRAMES = 2048;
/**
 * Tuner search range: B1 (Drop C / B standard and below standard's low E with margin) to E6. The
 * onset path uses the `expect` hint instead.
 */
export const TUNER_RANGE = { minMidi: 35, maxMidi: 88 } as const;
/** An early (cut-short) pitch window must start at least this long after its onset. */
const EARLY_MIN_SEC = 0.008;
/** Ring buffer length (power of two; holds the tuner window plus the onset delay and retry). */
const RING_SIZE = 16384;
const RING_MASK = RING_SIZE - 1;

/** Options for {@link AnalysisCore}. */
export interface AnalysisCoreOptions {
  sampleRate: number;
  channel: InputChannel;
  tuner: boolean;
}

/** An onset waiting for its pitch measurement. */
interface PendingOnset {
  frame: number;
  /** 0 = first measurement due; 1 = retry after an unclear first estimate. */
  stage: 0 | 1;
}

/** Copy of a pitch estimate (detectors reuse theirs). */
interface Measured {
  midi: number;
  cents: number;
  clarity: number;
  /** Window RMS, dBFS. */
  rmsDb: number;
}

/**
 * Quantum-by-quantum analysis state machine. Feed it every render quantum with
 * {@link AnalysisCore.process}; commands from the main thread go to {@link AnalysisCore.command}.
 */
export class AnalysisCore {
  private readonly sampleRate: number;
  private channel: InputChannel;
  private tuner: boolean;
  private readonly emit: (ev: AnalysisEvent) => void;

  private readonly ring = new Float32Array(RING_SIZE);
  private readonly mono = new Float32Array(QUANTUM);
  /** Frame just past the newest sample in the ring; −1 before the first quantum. */
  private endFrame = -1;
  /** First frame written since the last (re)start. */
  private startFrame = 0;

  private readonly level: LevelMeter;
  private readonly levelEvery: number;
  private quantaSinceLevel = 0;

  private readonly onsets: OnsetDetector;
  private readonly legato: LegatoDetector;
  private readonly detectors: { 1024: PitchDetector; 2048: PitchDetector };
  private readonly windows: { 1024: Float32Array; 2048: Float32Array };
  private size: 1024 | 2048 = 2048;
  private readonly delayFrames: number;
  private readonly earlyMinFrames: number;
  private pending: PendingOnset | null = null;
  private readonly measured: Measured = { midi: 0, cents: 0, clarity: 0, rmsDb: -120 };

  private readonly tunerDetector: PitchDetector;
  private readonly tunerWindow = new Float32Array(TUNER_WINDOW);
  private nextTunerFrame = 0;

  constructor(opts: AnalysisCoreOptions, emit: (ev: AnalysisEvent) => void) {
    const { sampleRate } = opts;
    if (!(sampleRate > 0)) throw new RangeError(`sample rate must be > 0, got ${sampleRate}`);
    this.sampleRate = sampleRate;
    this.channel = opts.channel;
    this.tuner = opts.tuner;
    this.emit = emit;
    this.level = createLevelMeter();
    this.levelEvery = Math.max(1, Math.round((LEVEL_INTERVAL_SEC * sampleRate) / QUANTUM));
    this.onsets = createOnsetDetector({ sampleRate, hop: QUANTUM });
    this.legato = createPitchChangeDetector({ sampleRate });
    this.detectors = {
      1024: createPitchDetector({ sampleRate, size: 1024 }),
      2048: createPitchDetector({ sampleRate, size: 2048 }),
    };
    this.windows = { 1024: new Float32Array(1024), 2048: new Float32Array(2048) };
    this.delayFrames = Math.round(ONSET_PITCH_DELAY_SEC * sampleRate);
    this.earlyMinFrames = Math.round(EARLY_MIN_SEC * sampleRate);
    this.tunerDetector = createPitchDetector({ sampleRate, size: TUNER_WINDOW });
    this.tunerDetector.setRange(TUNER_RANGE);
  }

  /** Current pitch window (1024 or 2048), chosen by the last `expect` hint. */
  get windowSize(): 1024 | 2048 {
    return this.size;
  }

  /** Apply a main-thread command. */
  command(cmd: AnalysisCommand): void {
    switch (cmd.type) {
      case 'expect': {
        const plan = planPitchWindow(cmd.range);
        this.size = plan.size;
        setRangeSafe(this.detectors[plan.size], plan.range);
        break;
      }
      case 'config':
        this.channel = cmd.channel;
        if (cmd.tuner && !this.tuner) this.nextTunerFrame = 0;
        this.tuner = cmd.tuner;
        break;
      case 'reset':
        this.reset();
        break;
    }
  }

  /**
   * Analyse one render quantum. `channels` are the input's channel buffers (empty when nothing is
   * connected: read as silence); `startFrame` is the context frame of their first sample
   * (`currentFrame` in the worklet).
   */
  process(channels: readonly Float32Array[], startFrame: number): void {
    if (this.endFrame !== startFrame) this.restartAt(startFrame);
    const mono = this.mono;
    this.mixDown(channels, mono);
    const ring = this.ring;
    for (let i = 0; i < QUANTUM; i++) ring[(startFrame + i) & RING_MASK] = mono[i];
    const end = startFrame + QUANTUM;
    this.endFrame = end;

    this.level.process(mono);
    if (++this.quantaSinceLevel >= this.levelEvery) {
      this.quantaSinceLevel = 0;
      const { peakDb, rmsDb } = this.level.read();
      this.emit({ type: 'level', frame: end, peakDb, rmsDb });
    }

    const onset = this.onsets.process(mono, startFrame);
    if (onset >= 0) {
      if (this.pending) this.measureEarly(this.pending, onset);
      this.pending = { frame: onset, stage: 0 };
      this.legato.onset(onset);
    }
    if (this.pending) this.measureDue(this.pending, end);

    if ((end - this.startFrame) % PITCH_STEP_FRAMES === 0 && end - this.startFrame >= this.size) {
      this.trackLegato(end);
    }
    if (this.tuner) this.runTuner(end);
  }

  /** Clear all detector state (e.g. after a device change). */
  reset(): void {
    this.onsets.reset();
    this.legato.reset();
    this.level.read();
    this.quantaSinceLevel = 0;
    this.pending = null;
    this.endFrame = -1;
  }

  /** A gap or the first quantum: forget history that is not contiguous with `frame`. */
  private restartAt(frame: number): void {
    if (this.endFrame !== -1) this.reset();
    this.startFrame = frame;
    this.nextTunerFrame = 0;
  }

  private mixDown(channels: readonly Float32Array[], out: Float32Array): void {
    const a = channels[0];
    if (!a) {
      out.fill(0);
      return;
    }
    const b = channels[1];
    if (this.channel === 1 && b) out.set(b);
    else if (this.channel === 'mix' && b) for (let i = 0; i < QUANTUM; i++) out[i] = 0.5 * (a[i] + b[i]);
    else out.set(a);
  }

  /** Measure the pending onset once its window (or its retry window) is complete. */
  private measureDue(p: PendingOnset, end: number): void {
    const n = this.size;
    const start = p.frame + this.delayFrames + (p.stage === 1 ? RETRY_SHIFT_FRAMES : 0);
    if (end < start + n) return;
    const m = this.measure(n, start);
    this.report(p, m, start + n / 2);
  }

  /**
   * The next onset arrived before `p` was measured: use the latest window that ends at `next`, if it
   * starts far enough after `p` (the long window, or 1024 when the hint already chose it).
   */
  private measureEarly(p: PendingOnset, next: number): void {
    const n = this.size;
    const start = next - n;
    const m = start >= p.frame + this.earlyMinFrames && start >= this.endFrame - RING_SIZE ? this.measure(n, start) : null;
    if (p.stage === 0) {
      this.emitOnset(p.frame, m && m.clarity >= ONSET_MIN_CLARITY ? m : null, m);
    } else if (m && m.clarity >= ONSET_MIN_CLARITY) {
      this.emit({ type: 'pitch', frame: start + n / 2, onsetFrame: p.frame, midi: m.midi, cents: m.cents, clarity: m.clarity });
    }
    this.pending = null;
  }

  /** Emit the result of a scheduled measurement and advance or clear the pending onset. */
  private report(p: PendingOnset, m: Measured | null, windowCentre: number): void {
    const clear = m !== null && m.clarity >= ONSET_MIN_CLARITY;
    if (p.stage === 0) {
      this.emitOnset(p.frame, clear ? m : null, m);
      if (clear) this.pending = null;
      else p.stage = 1;
      return;
    }
    if (clear) {
      this.emit({ type: 'pitch', frame: windowCentre, onsetFrame: p.frame, midi: m.midi, cents: m.cents, clarity: m.clarity });
    }
    this.pending = null;
  }

  private emitOnset(frame: number, pitched: Measured | null, any: Measured | null): void {
    this.emit({
      type: 'onset',
      frame,
      midi: pitched ? pitched.midi : null,
      cents: pitched ? pitched.cents : 0,
      clarity: any ? any.clarity : 0,
      rmsDb: any ? any.rmsDb : -120,
    });
  }

  /** Pitch of the `n`-sample window starting at `start` (null for silence / no peak). */
  private measure(n: 1024 | 2048, start: number): Measured | null {
    const win = this.windows[n];
    this.copyWindow(win, start);
    const est = this.detectors[n].detect(win);
    if (!est) return null;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += win[i] * win[i];
    const m = this.measured;
    m.midi = est.midi;
    m.cents = est.cents;
    m.clarity = est.clarity;
    m.rmsDb = sum > 0 ? Math.max(-120, 10 * Math.log10(sum / n)) : -120;
    return m;
  }

  private trackLegato(end: number): void {
    const n = this.size;
    const win = this.windows[n];
    this.copyWindow(win, end - n);
    const est: PitchEstimate | null = this.detectors[n].detect(win);
    const midi = this.legato.push(est, end - n / 2);
    if (midi >= 0 && est) {
      this.emit({ type: 'pitch-change', frame: this.legato.changeFrame, midi, cents: est.cents, clarity: est.clarity });
    }
  }

  private runTuner(end: number): void {
    if (end - this.startFrame < TUNER_WINDOW) return;
    if (this.nextTunerFrame === 0) this.nextTunerFrame = end;
    if (end < this.nextTunerFrame) return;
    this.nextTunerFrame = end + TUNER_HOP_FRAMES;
    this.copyWindow(this.tunerWindow, end - TUNER_WINDOW);
    const est = this.tunerDetector.detect(this.tunerWindow);
    this.emit({ type: 'tuner', frame: end - TUNER_WINDOW / 2, freq: est ? est.freq : 0, clarity: est ? est.clarity : 0 });
  }

  private copyWindow(dst: Float32Array, start: number): void {
    const ring = this.ring;
    for (let i = 0; i < dst.length; i++) dst[i] = ring[(start + i) & RING_MASK];
  }
}

/** `setRange` that falls back to the default range when the window cannot resolve the hint. */
function setRangeSafe(detector: PitchDetector, range: { minMidi: number; maxMidi: number } | null): void {
  try {
    detector.setRange(range);
  } catch {
    detector.setRange(null);
  }
}
