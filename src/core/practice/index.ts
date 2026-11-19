/**
 * Practice logic (T-014): speed trainer state machine (D8) and loop math (snap to sections then bars,
 * min 1 bar, pre-roll 1 bar / 2 bars below 60%). Pure. Signatures frozen by T-010.
 * Parameters come from docs/research/learning.md § Concrete parameters.
 * @module
 */
import type { TransportLoop } from '@shared/clock';
import type { BarLoop, TrainerState, TrainerStep } from '@shared/judge';
import type { Bar, Song } from '@shared/song';

/** Speed-trainer parameters (fractions). */
export const TRAINER = {
  start: 0.7,
  /** Start for sections ≥ 2 tiers above comfort. */
  hardStart: 0.6,
  /** A section this many tiers above the comfort tier starts at {@link TRAINER.hardStart}. */
  hardTierGap: 2,
  floor: 0.4,
  cap: 1.0,
  step: 0.05,
  /** Clean-run accuracy %. */
  cleanAccuracy: 90,
  /** Failed-run accuracy % (below). */
  failAccuracy: 70,
  /** Failed runs in a row before stepping down. */
  failsToStepDown: 2,
  /** Restart speed after failing a next-day check. */
  recheckStart: 0.85,
} as const;

/** Loop parameters. */
export const LOOP = {
  /** A loop edge within this many bars of a section boundary snaps to it (else to the nearest bar line). */
  sectionSnapBars: 1,
  /** Pre-roll bars at normal speed… */
  prerollBars: 1,
  /** …and below {@link LOOP.slowSpeed}. */
  slowPrerollBars: 2,
  slowSpeed: 0.6,
} as const;

/** Speeds are kept on a 1% grid so repeated ±5% steps do not drift (0.8 + 0.05 = 0.8500000000000001). */
const roundSpeed = (s: number): number => Math.round(s * 100) / 100;
const pct = (s: number): string => `${Math.round(s * 100)}%`;
const clampSpeed = (s: number): number => Math.min(TRAINER.cap, Math.max(TRAINER.floor, roundSpeed(s)));

/** Initial trainer state for a section given its tier and the player's comfort tier. */
export function initialTrainerState(sectionTier: number, comfortTier: number): TrainerState {
  const hard = sectionTier - comfortTier >= TRAINER.hardTierGap;
  return { speed: hard ? TRAINER.hardStart : TRAINER.start, failStreak: 0 };
}

/**
 * Advance the trainer after a run with `accuracy` % (`clean` per the clean-run rule, which already
 * implies accuracy ≥ 90%): clean → +5% (cap 100%); below 70% twice in a row → −5% (floor 40%) and
 * "Slow down a notch"; anything else holds the speed and resets the fail streak.
 */
export function trainerStep(state: TrainerState, accuracy: number, clean: boolean): TrainerStep {
  const speed = clampSpeed(state.speed);
  if (clean) {
    const next = Math.min(TRAINER.cap, roundSpeed(speed + TRAINER.step));
    const delta = roundSpeed(next - speed);
    return {
      state: { speed: next, failStreak: 0 },
      delta,
      message: delta > 0 ? `Clean run! +${pct(delta)} → ${pct(next)}` : `Clean run at ${pct(next)}!`,
    };
  }
  if (accuracy < TRAINER.failAccuracy) {
    const fails = state.failStreak + 1;
    if (fails < TRAINER.failsToStepDown) return { state: { speed, failStreak: fails }, delta: 0, message: null };
    const next = Math.max(TRAINER.floor, roundSpeed(speed - TRAINER.step));
    const delta = roundSpeed(next - speed);
    return {
      state: { speed: next, failStreak: 0 },
      delta,
      message: delta < 0 ? `Slow down a notch → ${pct(next)}` : `Already at ${pct(next)}: try a shorter loop`,
    };
  }
  return { state: { speed, failStreak: 0 }, delta: 0, message: null };
}

/**
 * Snap a time range to section markers, then bar lines (minimum 1 bar). Each edge snaps to the
 * nearest section boundary within {@link LOOP.sectionSnapBars} bars (exclusive), otherwise to the
 * nearest bar line. Reversed ranges are swapped; the result is clamped to the song.
 *
 * @throws RangeError when the song has no bars.
 */
export function snapLoop(song: Song, startTime: number, endTime: number): BarLoop {
  const bars = song.timing.bars;
  const n = bars.length;
  if (n === 0) throw new RangeError('snapLoop: song has no bars');
  const boundaries = [...new Set(song.sections.flatMap((s) => [s.startBar, s.endBar]))];
  const a = snapEdge(barPosition(bars, Math.min(startTime, endTime)), boundaries);
  const b = snapEdge(barPosition(bars, Math.max(startTime, endTime)), boundaries);
  const startBar = Math.min(Math.max(a, 0), n - 1);
  const endBar = Math.min(Math.max(b, startBar + 1), n);
  return { startBar, endBar };
}

/** Fractional bar position of `time` in `[0, n]` (bar index + fraction through the bar). */
function barPosition(bars: readonly Bar[], time: number): number {
  const first = bars[0] as Bar;
  if (time <= first.time) return 0;
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if ((bars[mid] as Bar).time <= time) lo = mid;
    else hi = mid - 1;
  }
  const bar = bars[lo] as Bar;
  const frac = bar.dur > 0 ? (time - bar.time) / bar.dur : 0;
  return lo + Math.min(1, Math.max(0, frac));
}

function snapEdge(pos: number, sectionBoundaries: readonly number[]): number {
  let best: number | null = null;
  for (const b of sectionBoundaries) {
    const d = Math.abs(b - pos);
    if (d < LOOP.sectionSnapBars - 1e-9 && (best === null || d < Math.abs(best - pos))) best = b;
  }
  return best ?? Math.round(pos);
}

/** Pre-roll bars for a speed (1, or 2 below 60%). */
export function prerollBars(speed: number): number {
  return speed < LOOP.slowSpeed - 1e-9 ? LOOP.slowPrerollBars : LOOP.prerollBars;
}

/**
 * Bar loop → transport loop in song seconds, with pre-roll for `speed`. The pre-roll is the
 * duration of the bars before A; before the first bar it repeats the first bar's duration (the
 * transport plays that stretch as negative song time).
 *
 * @throws RangeError when the song has no bars.
 */
export function toTransportLoop(song: Song, loop: BarLoop, speed: number): TransportLoop {
  const bars = song.timing.bars;
  const n = bars.length;
  if (n === 0) throw new RangeError('toTransportLoop: song has no bars');
  const startBar = Math.min(Math.max(loop.startBar, 0), n - 1);
  const endBar = Math.min(Math.max(loop.endBar, startBar + 1), n);
  const first = bars[startBar] as Bar;
  const last = bars[endBar - 1] as Bar;
  let preroll = 0;
  for (let i = 1; i <= prerollBars(speed); i++) preroll += (bars[Math.max(0, startBar - i)] as Bar).dur;
  return { start: first.time, end: last.time + last.dur, preroll };
}
