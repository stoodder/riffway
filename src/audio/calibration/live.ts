/**
 * Live wiring of a calibration run on the app's engine and input (browser only):
 * - **clicks** use the engine's click voice on its context, straight into the master bus, so they
 *   take the normal output path (master → safety limiter → device) whatever the metronome level is;
 * - **guitar / loopback** events are analysis-worklet onsets converted with the judge's own
 *   `frameToEventCtx(frame, sampleRate, 0)` (uncalibrated);
 * - **keyboard** taps are mapped with `engine.perfToCtxTime(event.timeStamp)`, the heard-domain
 *   mapping keyboard play uses (docs/timing.md § How offsets apply to scoring).
 * A context change (sample-rate switch) aborts the run.
 * @module
 */
import type { Unsubscribe } from '@shared/clock';
import type { AudioEngine, InputService } from '@shared/services';
import { frameToEventCtx } from '@core/judge';
import { createClickPlayer } from '../engine/metronome';
import { CalibrationRun, type CalibrationRunOptions } from './run';

/** What is being calibrated. Loopback = output cabled to input; the clicks themselves come back. */
export type CalibrationKind = 'guitar' | 'keyboard' | 'loopback';

/** Keys that count as a tap: Space plus the keyboard-mode lane keys. */
export function tapKeys(lanes: readonly string[]): Set<string> {
  return new Set(['Space', ...lanes]);
}

/** Event source for analysis-worklet onsets (guitar and loopback). */
export function onsetSource(engine: AudioEngine, input: InputService): (cb: (ctxTime: number) => void) => Unsubscribe {
  return (cb) =>
    input.onAnalysis((ev) => {
      if (ev.type === 'onset') cb(frameToEventCtx(ev.frame, engine.ctx.sampleRate, 0));
    });
}

/** A keyboard tap source; {@link TapSource.tap} also accepts taps from an on-screen pad. */
export interface TapSource {
  listen(cb: (ctxTime: number) => void): Unsubscribe;
  /** Feed a tap with its DOM event `timeStamp` (ms, `performance.now()` clock). */
  tap(timeStampMs: number): void;
}

/** Keyboard taps (keydown of `keys`, no auto-repeat) on `target`, mapped to heard context time. */
export function tapSource(engine: AudioEngine, keys: ReadonlySet<string>, target: EventTarget = window): TapSource {
  const listeners = new Set<(t: number) => void>();
  const emit = (ts: number): void => {
    const t = engine.perfToCtxTime(ts);
    for (const cb of listeners) cb(t);
  };
  const onKey = (e: Event): void => {
    const ev = e as KeyboardEvent;
    if (!keys.has(ev.code) || ev.repeat || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    ev.preventDefault();
    emit(ev.timeStamp);
  };
  return {
    listen(cb) {
      if (listeners.size === 0) target.addEventListener('keydown', onKey);
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0) target.removeEventListener('keydown', onKey);
      };
    },
    tap: emit,
  };
}

/** A run bound to the engine; dispose it when done. */
export interface LiveCalibration {
  run: CalibrationRun;
  dispose(): void;
}

/**
 * Create a run on the engine's current context with `listen` as the event source. The caller
 * resumes the engine (user gesture) first.
 */
export function createLiveCalibration(
  engine: AudioEngine,
  listen: (cb: (ctxTime: number) => void) => Unsubscribe,
  opts: CalibrationRunOptions = {},
): LiveCalibration {
  const ctx = engine.ctx;
  const clicks = createClickPlayer(ctx, engine.buses.master);
  const run = new CalibrationRun({ now: () => ctx.currentTime, clicks, listen }, opts);
  const offContext = engine.onContextChange(() => run.abort('The audio device changed. Start again.'));
  return {
    run,
    dispose() {
      offContext();
      run.abort();
      clicks.dispose();
    },
  };
}
