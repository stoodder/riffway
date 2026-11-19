/**
 * App-wide wiring that runs once after the `AppContext` exists (`src/main.ts`), independent of the
 * screen on view:
 *
 * - **Calibration follows the devices** (`followCalibrationProfiles`, docs/timing.md § Latency
 *   calibration): when the input or output device changes anywhere (audio setup, settings, a
 *   fallback to the default input), the new device pair's saved offsets become active.
 * @module
 */
import type { Unsubscribe } from '@shared/clock';
import type { AppContext } from '@shared/ui';
import { followCalibrationProfiles } from '../audio/calibration/profiles';

/** Start the app-wide wiring; the returned function undoes it (tests). */
export function startAppWiring(ctx: Pick<AppContext, 'settings'>): Unsubscribe {
  const stops = [followCalibrationProfiles(ctx.settings)];
  return () => {
    for (const stop of stops.splice(0)) stop();
  };
}
