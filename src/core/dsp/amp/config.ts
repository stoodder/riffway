/**
 * Amp configuration types and fixed tone-stack/knob constants. Free of app contracts beyond
 * `@shared/audio-events`, so the amp worklet can import it.
 * @module
 */
import type { AmpParams } from '@shared/audio-events';

/** Everything the amp DSP needs: the shared {@link AmpParams} plus the preset's noise-gate threshold. */
export interface AmpConfig extends AmpParams {
  /** Gate open threshold, dBFS of the input peak envelope; `null` = no gate. */
  gateDb: number | null;
}

/** Pass-through config (DI): no gate, no amp. */
export const BYPASS_CONFIG: Readonly<AmpConfig> = Object.freeze({
  drive: 1,
  bias: 0,
  low: 0,
  mid: 0,
  high: 0,
  level: 0,
  bypass: true,
  gateDb: null,
});

/** Tone-stack bands (Hz). */
export const TONE_BANDS = { low: 120, mid: 700, high: 3000 } as const;

/** Peak-band Q of the tone stack's mid control. */
export const TONE_MID_Q = 0.7;

/** Tone and level knob ranges (dB) and drive range (linear) for the panel and clamping. */
export const AMP_RANGES = {
  drive: { min: 1, max: 40 },
  tone: { min: -12, max: 12 },
  level: { min: -40, max: 6 },
} as const;
