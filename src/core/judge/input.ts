/**
 * Input timing helpers (docs/timing.md § How offsets apply to scoring): convert raw input to
 * calibrated {@link InputEvent}s and compute the judge's input horizon. Pure; the session (T-031)
 * and the input layer (T-022) call these so every source reaches the judge in one time domain.
 * @module
 */
import type { AnalysisEvent } from '@shared/audio-events';
import type { InputEvent, InputSource } from '@shared/judge';
import { INPUT_LAG_SEC } from './constants';

/**
 * Calibrated context time of a worklet frame: `frame / sampleRate − inputOffsetMs / 1000`.
 * The same formula is used for an onset and for the follow-up pitch that refines it, so the two
 * agree bit-for-bit.
 */
export function frameToEventCtx(frame: number, sampleRate: number, inputOffsetMs: number): number {
  return frame / sampleRate - inputOffsetMs / 1000;
}

/**
 * Calibrated context time of a keyboard event, in the *heard* domain:
 * `contextTime + (timeStamp − performanceTime) / 1000 − keyboardOffsetMs / 1000`, where
 * `{contextTime, performanceTime}` is a fresh `AudioContext.getOutputTimestamp()` pair and
 * `timeStampMs` the DOM event's `timeStamp` (same clock as `performance.now()`).
 */
export function keyboardEventCtx(
  timeStampMs: number,
  outputTimestamp: { contextTime: number; performanceTime: number },
  keyboardOffsetMs: number,
): number {
  return outputTimestamp.contextTime + (timeStampMs - outputTimestamp.performanceTime) / 1000 - keyboardOffsetMs / 1000;
}

/**
 * Convert an analysis-worklet message to a judge {@link InputEvent} with the calibrated guitar
 * offset applied. `onset` → onset (unpitched when `midi` is null); `pitch` → onset at the original
 * onset time with `refines` set; `pitch-change` → legato event. Other messages → `null`.
 */
export function analysisToInputEvent(ev: AnalysisEvent, sampleRate: number, inputOffsetMs: number): InputEvent | null {
  switch (ev.type) {
    case 'onset': {
      const ctxTime = frameToEventCtx(ev.frame, sampleRate, inputOffsetMs);
      if (ev.midi === null) return { ctxTime, kind: 'onset', clarity: ev.clarity, source: 'guitar' };
      return { ctxTime, kind: 'onset', midi: ev.midi, cents: ev.cents, clarity: ev.clarity, source: 'guitar' };
    }
    case 'pitch': {
      const ctxTime = frameToEventCtx(ev.onsetFrame, sampleRate, inputOffsetMs);
      return { ctxTime, kind: 'onset', midi: ev.midi, cents: ev.cents, clarity: ev.clarity, source: 'guitar', refines: ctxTime };
    }
    case 'pitch-change':
      return {
        ctxTime: frameToEventCtx(ev.frame, sampleRate, inputOffsetMs),
        kind: 'pitch-change',
        midi: ev.midi,
        cents: ev.cents,
        clarity: ev.clarity,
        source: 'guitar',
      };
    default:
      return null;
  }
}

/**
 * The judge's input horizon: the latest calibrated context time up to which every event of
 * `source` has already been delivered. Pass it to `Judge.advance()` (not `ctx.currentTime`), so a
 * window never closes before a late-arriving onset inside it could be judged:
 * `ctxNow − max(0, offsetMs)/1000 − INPUT_LAG_SEC[source]` (keyboard additionally minus the output
 * latency, because its events are stamped in the heard domain).
 *
 * @param ctxNow `AudioContext.currentTime`.
 * @param offsetMs The calibrated offset for the source (`inputOffsetMs` / `keyboardOffsetMs`; 0 for test).
 * @param outputLatencySec `ctx.outputLatency` (keyboard only).
 */
export function inputHorizon(ctxNow: number, source: InputSource, offsetMs: number, outputLatencySec = 0): number {
  const horizon = ctxNow - Math.max(0, offsetMs) / 1000 - INPUT_LAG_SEC[source];
  return source === 'keyboard' ? horizon - outputLatencySec : horizon;
}
