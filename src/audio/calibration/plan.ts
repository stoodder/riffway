/**
 * Click plan for a calibration run: one bar of count-in, then the measured clicks, at a fixed tempo
 * (docs/timing.md § Latency calibration). Pure.
 * @module
 */
import { CALIBRATION } from './estimate';

/** One click of the plan. */
export interface PlannedClick {
  /** Context time the click is scheduled at (s). */
  ctxTime: number;
  /** Accented (bar downbeat). */
  accent: boolean;
  /** Part of the measurement (false for count-in clicks). */
  measured: boolean;
}

/** Plan parameters (defaults from {@link CALIBRATION}). */
export interface ClickPlanOptions {
  bpm: number;
  countInBeats: number;
  clicks: number;
  /** Beats per bar, for accents (4). */
  beatsPerBar: number;
}

/** Default plan options. */
export const DEFAULT_PLAN: Readonly<ClickPlanOptions> = {
  bpm: CALIBRATION.bpm,
  countInBeats: CALIBRATION.countInBeats,
  clicks: CALIBRATION.clicks,
  beatsPerBar: 4,
};

/** Build the plan starting at context time `startCtx` (the first count-in click). */
export function clickPlan(startCtx: number, options: Partial<ClickPlanOptions> = {}): PlannedClick[] {
  const o = { ...DEFAULT_PLAN, ...options };
  const beat = 60 / o.bpm;
  const total = o.countInBeats + o.clicks;
  return Array.from({ length: total }, (_, i) => ({
    ctxTime: startCtx + i * beat,
    accent: i % o.beatsPerBar === 0,
    measured: i >= o.countInBeats,
  }));
}

/** Context times of the measured clicks. */
export function measuredTimes(plan: readonly PlannedClick[]): number[] {
  return plan.filter((c) => c.measured).map((c) => c.ctxTime);
}
