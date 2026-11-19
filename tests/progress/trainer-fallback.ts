/**
 * Test helper: use the real speed trainer (`src/core/practice`, T-014) when it is implemented, else a
 * minimal stand-in that follows D8 (start 70% / 60%, +5% per clean run, −5% after 2 failed runs,
 * floor 40%, cap 100%). Mastery tests assert only D8 numbers, so they hold for both.
 */
import type * as Practice from '@core/practice';
import type { TrainerState, TrainerStep } from '@shared/judge';
import { isNotImplemented } from '@shared/errors';

type PracticeModule = typeof Practice;

export function withTrainerFallback(real: PracticeModule): PracticeModule {
  try {
    real.initialTrainerState(3, 2);
    real.trainerStep({ speed: 0.7, failStreak: 0 }, 95, true);
    return real;
  } catch (err) {
    if (!isNotImplemented(err)) throw err;
  }
  const T = real.TRAINER;
  const round = (s: number): number => Math.round(s * 100) / 100;
  return {
    ...real,
    initialTrainerState: (sectionTier: number, comfortTier: number): TrainerState => ({
      speed: sectionTier - comfortTier >= 2 ? T.hardStart : T.start,
      failStreak: 0,
    }),
    trainerStep: (state: TrainerState, accuracy: number, clean: boolean): TrainerStep => {
      if (clean) {
        const speed = round(Math.min(T.cap, state.speed + T.step));
        return { state: { speed, failStreak: 0 }, delta: speed - state.speed, message: null };
      }
      if (accuracy < T.failAccuracy) {
        const fails = state.failStreak + 1;
        if (fails >= T.failsToStepDown) {
          const speed = round(Math.max(T.floor, state.speed - T.step));
          return { state: { speed, failStreak: 0 }, delta: speed - state.speed, message: 'Slow down a notch' };
        }
        return { state: { speed: state.speed, failStreak: fails }, delta: 0, message: null };
      }
      return { state: { speed: state.speed, failStreak: 0 }, delta: 0, message: null };
    },
  };
}
