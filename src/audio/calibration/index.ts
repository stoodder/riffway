/**
 * Latency calibration (T-033, docs/timing.md § Latency calibration): play-to-click (guitar),
 * tap-to-click (keyboard), loopback (output cabled to input) and the visual offset.
 *
 * - `./estimate` — pairing, settling, MAD rejection, acceptance (pure).
 * - `./plan` — the click plan (count-in + 16 clicks at 90 BPM).
 * - `./run` — one run on an injected clock / click sink / event source.
 * - `./live` — the run on the app's engine, input worklet and keyboard.
 * - `./profiles` — results in settings, per device pair; estimated fallback.
 * - `./visual` — visual offset maths and an endless click loop.
 * The UI lives in `src/ui/panels/calibration/`.
 * @module
 */
export {
  CALIBRATION,
  dedupeEvents,
  estimateOffset,
  mad,
  median,
  pairClicks,
  qualityFor,
  type CalibrationFailure,
  type CalibrationPair,
  type CalibrationQuality,
  type EstimatorOptions,
  type OffsetEstimate,
  type PairStatus,
} from './estimate';
export { DEFAULT_PLAN, clickPlan, measuredTimes, type ClickPlanOptions, type PlannedClick } from './plan';
export {
  CalibrationAbortedError,
  CalibrationRun,
  type CalibrationClickSink,
  type CalibrationProgress,
  type CalibrationRunHost,
  type CalibrationRunOptions,
} from './run';
export { createLiveCalibration, onsetSource, tapKeys, tapSource, type CalibrationKind, type LiveCalibration, type TapSource } from './live';
export {
  calibratedForOtherDevice,
  currentProfile,
  deviceKey,
  estimateGuitarOffsetMs,
  estimatedGuitarPatch,
  followCalibrationProfiles,
  guitarResultPatch,
  keyboardResultPatch,
  loopbackGuitarPatch,
  loopbackResultPatch,
  profileSwitchPatch,
  restorePatch,
  snapshot,
  visualOffsetPatch,
  type ActiveCalibration,
  type CalibrationPatch,
  type EstimateInputs,
} from './profiles';
export { ClickLoop, FLASH_DECAY_SEC, VISUAL_OFFSET, clampVisualOffset, nudgeVisualOffset, visualFrame, type ClickLoopHost, type VisualFrame } from './visual';
