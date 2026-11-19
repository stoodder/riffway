/**
 * Amp sim DSP (T-023): oversampled ADAA soft clipper, noise gate, tone stack, presets/cab data and
 * the feedback guard detector. Pure TS: wrapped by `src/audio/worklets/amp.worklet.ts` and tested in
 * Node. See docs/monitoring.md. (The worklet imports the submodules directly: this index pulls in
 * `@shared/settings` through the presets, which the worklet scope doesn't need.)
 * @module
 */
export { AMP_LATENCY_SAMPLES, AmpEngine, DUCK } from './amp';
export { AdaaClipper, clip, clipAntiderivative } from './clipper';
export {
  Biquad,
  DcBlocker,
  DENORMAL_FLOOR,
  biquadCoefficients,
  cascadeMagnitudeDb,
  type BiquadCoefficients,
  type BiquadShape,
  type BiquadSpec,
} from './filters';
export { GATE_TIMING, NoiseGate } from './gate';
export { GUARD, RunawayGuard, type GuardTrip } from './guard';
export { HalfbandStage, OVERSAMPLER_DESIGN, Oversampler4x, designHalfband, oversamplerLatency } from './halfband';
export { AMP_RANGES, BYPASS_CONFIG, TONE_BANDS, TONE_MID_Q, type AmpConfig } from './config';
export type { AmpProcessorOptions, AmpWorkletCommand, AmpWorkletEvent } from './messages';
export {
  AMP_PRESETS,
  AMP_PRESET_ORDER,
  CAB_LOWPASS_HZ,
  ampConfigFor,
  cabStages,
  driveCharacter,
  type AmpPreset,
} from './presets';

