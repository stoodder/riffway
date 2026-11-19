/**
 * Timing leniency (settings `game.timingLeniency`, docs/game-mechanics.md § Windows): one factor
 * scales all three timing windows. `standard` is the D5 default (Perfect ±35 / Great ±70 /
 * Good ±120 ms); `relaxed` widens them for a first pass at a hard song or a laggy setup, `tight`
 * narrows them for precision practice. Windows stay in real seconds at every practice speed.
 * @module
 */
import type { TimingWindows } from '@shared/judge';
import type { TimingLeniency } from '@shared/settings';
import { WINDOWS } from '@core/judge/constants';

/** Window scale per leniency. */
export const LENIENCY_SCALE: Readonly<Record<TimingLeniency, number>> = { tight: 0.75, standard: 1, relaxed: 1.5 };

/** Timing windows for a leniency (unknown values, e.g. from an old export, read as `standard`). */
export function windowsFor(leniency: TimingLeniency): TimingWindows {
  const k = LENIENCY_SCALE[leniency] ?? 1;
  return { perfect: WINDOWS.perfect * k, great: WINDOWS.great * k, good: WINDOWS.good * k };
}
