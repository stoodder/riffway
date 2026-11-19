/**
 * Text and display model of the calibration panel (pure, unit-tested): number formatting, method and
 * quality labels, failure explanations, the "how it is applied" sentence and the residual strip.
 * @module
 */
import type { CalibrationMethod, Settings } from '@shared/settings';
import { WINDOWS } from '@core/judge/constants';
import type { CalibrationFailure, CalibrationKind, CalibrationQuality, OffsetEstimate } from '../../../audio/calibration';

/** Signed whole-ms label: `+42 ms`, `−8 ms`, `0 ms`. */
export function fmtSignedMs(ms: number): string {
  const r = Math.round(ms);
  if (r === 0) return '0 ms';
  return `${r > 0 ? '+' : '−'}${Math.abs(r)} ms`;
}

/** Offset label: whole ms (`42 ms`, `−8 ms`). */
export function fmtMs(ms: number): string {
  const r = Math.round(ms);
  return `${r < 0 ? '−' : ''}${Math.abs(r)} ms`;
}

/** Spread label with one decimal: `±2.4 ms`. */
export function fmtSpread(ms: number): string {
  return `±${ms.toFixed(1)} ms`;
}

/** Short date for "measured" lines (local time). */
export function fmtWhen(epochMs: number, now = Date.now()): string {
  const d = new Date(epochMs);
  const today = new Date(now);
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? `today ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

/** Badge text and tone for a calibration method. */
export const METHOD_LABEL: Readonly<Record<CalibrationMethod, { text: string; tone: 'success' | 'info' | 'warning' | 'neutral' }>> = {
  'play-to-click': { text: 'Play-to-click', tone: 'success' },
  'tap-to-click': { text: 'Keyboard only', tone: 'info' },
  estimated: { text: 'Estimated', tone: 'warning' },
  none: { text: 'Not calibrated', tone: 'neutral' },
};

/** Badge text and tone for a quality band. */
export const QUALITY_LABEL: Readonly<Record<CalibrationQuality, { text: string; tone: 'success' | 'info' | 'warning' }>> = {
  excellent: { text: 'Very consistent', tone: 'success' },
  good: { text: 'Consistent', tone: 'success' },
  fair: { text: 'A bit uneven', tone: 'info' },
};

/** What the player does in each kind of run. */
export const ACTION: Readonly<Record<CalibrationKind, { verb: string; noun: string }>> = {
  guitar: { verb: 'Pick', noun: 'plucks' },
  keyboard: { verb: 'Tap', noun: 'taps' },
  loopback: { verb: 'Listen', noun: 'clicks heard back' },
};

/** Title and advice for a failed run. */
export function failureMessage(failure: CalibrationFailure, kind: CalibrationKind, e: Pick<OffsetEstimate, 'kept' | 'spreadMs'>): { title: string; advice: string } {
  const noun = ACTION[kind].noun;
  switch (failure) {
    case 'no-events':
      return kind === 'keyboard'
        ? { title: 'No taps were heard', advice: 'Tap Space on each click. Click inside this page first so it has the keyboard.' }
        : kind === 'loopback'
          ? { title: 'The clicks did not come back', advice: 'Connect the output to the guitar input with a cable, turn the output volume up, and try again.' }
          : { title: 'No plucks were detected', advice: 'Check the input level meter moves when you play, then pick a muted or open string on each click.' };
    case 'too-few':
      return {
        title: `Only ${e.kept} usable ${noun}`,
        advice: `At least 8 are needed. ${kind === 'loopback' ? 'Raise the output volume.' : `${ACTION[kind].verb} once on every click, not between them.`}`,
      };
    case 'inconsistent':
      return {
        title: `Timing too uneven (${fmtSpread(e.spreadMs ?? 0)})`,
        advice:
          kind === 'loopback'
            ? 'Something else is reaching the input. Turn monitoring and other audio off and try again.'
            : `Relax and ${ACTION[kind].verb.toLowerCase()} right on each click; the spread must be within ±15 ms.`,
      };
  }
}

/** The device pair as shown to the player. */
export function deviceLine(s: Pick<Settings, 'input' | 'output'>): string {
  return `${s.input.label || 'Default input'} → ${s.output.label || 'Default output'}`;
}

/** Sentence explaining how a guitar or keyboard offset changes judging. */
export function appliedSentence(kind: 'guitar' | 'keyboard', offsetMs: number): string {
  const what = kind === 'guitar' ? 'pluck' : 'key press';
  const perfect = Math.round(WINDOWS.perfect * 1000);
  if (Math.round(offsetMs) === 0) return `Every ${what} is judged as it arrives. Perfect is ±${perfect} ms.`;
  const dir = offsetMs > 0 ? 'subtracts' : 'adds';
  return `Riffway ${dir} ${fmtMs(Math.abs(offsetMs))} ${offsetMs > 0 ? 'from' : 'to'} every ${what} before judging it, so a note you play right on the beat scores Perfect (±${perfect} ms).`;
}

/** Sentence for the visual offset. */
export function visualSentence(visualOffsetMs: number): string {
  const r = Math.round(visualOffsetMs);
  if (r === 0) return 'The highway is drawn in sync with what you hear.';
  return `The highway is drawn ${Math.abs(r)} ms ${r > 0 ? 'later' : 'earlier'}. It only moves the picture; scoring is unchanged.`;
}

/** One dot of the residual strip: a pair's error after the offset is applied. */
export interface ResidualDot {
  /** `deltaMs − offsetMs`, clamped to the strip. */
  ms: number;
  /** 0–1 across the strip. */
  x: number;
  status: 'settling' | 'kept' | 'rejected';
  /** Outside the strip (clamped at the edge). */
  clipped: boolean;
}

/** Half-width of the residual strip (ms). */
export const STRIP_HALF_MS = 80;

/** Residuals of every pair after the offset, for the strip (Perfect band = ± `WINDOWS.perfect`). */
export function residualDots(e: Pick<OffsetEstimate, 'pairs' | 'offsetMs'>, halfMs = STRIP_HALF_MS): ResidualDot[] {
  if (e.offsetMs === null) return [];
  return e.pairs.map((p) => {
    const raw = p.deltaMs - e.offsetMs!;
    const ms = Math.max(-halfMs, Math.min(halfMs, raw));
    return { ms: raw, x: (ms + halfMs) / (2 * halfMs), status: p.status, clipped: Math.abs(raw) > halfMs };
  });
}

/** Share of kept pairs inside the Perfect window once the offset is applied (0–1). */
export function perfectShare(e: Pick<OffsetEstimate, 'pairs' | 'offsetMs'>): number {
  if (e.offsetMs === null) return 0;
  const kept = e.pairs.filter((p) => p.status === 'kept');
  if (kept.length === 0) return 0;
  return kept.filter((p) => Math.abs(p.deltaMs - e.offsetMs!) <= WINDOWS.perfect * 1000).length / kept.length;
}
