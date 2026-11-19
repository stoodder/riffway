/**
 * Amp presets and the cab simulation as data (docs/monitoring.md). Presets are starting points: the
 * monitoring panel exposes drive, tone and level per preset; bias, the gate threshold, bypass and the
 * cab come from the preset.
 * @module
 */
import type { AmpPresetId } from '@shared/settings';
import { AMP_RANGES, BYPASS_CONFIG, type AmpConfig } from './config';
import type { BiquadSpec } from './filters';

/** A preset: amp config, cab on/off and the cab's low-pass corner. */
export interface AmpPreset {
  id: AmpPresetId;
  label: string;
  /** One-line description for the panel. */
  description: string;
  amp: AmpConfig;
  /** Cab low-pass corner (Hz); `null` = cab off. */
  cabLowpassHz: number | null;
}

/** Butterworth Q (maximally flat 12 dB/oct section). */
const BUTTERWORTH_Q = Math.SQRT1_2;

/**
 * Cab simulation (native biquads in the browser): high-pass 80 Hz, low resonance +3 dB @ 120 Hz,
 * dip −4 dB @ 400 Hz, presence +3 dB @ 2.5 kHz, then two 12 dB/oct low-pass sections at the preset's
 * corner (5.5 kHz by default). No impulse-response files (licence-free, zero latency).
 */
export function cabStages(lowpassHz: number): BiquadSpec[] {
  return [
    { type: 'highpass', frequency: 80, q: BUTTERWORTH_Q, gain: 0 },
    { type: 'peaking', frequency: 120, q: 1, gain: 3 },
    { type: 'peaking', frequency: 400, q: 0.8, gain: -4 },
    { type: 'peaking', frequency: 2500, q: 1, gain: 3 },
    { type: 'lowpass', frequency: lowpassHz, q: BUTTERWORTH_Q, gain: 0 },
    { type: 'lowpass', frequency: lowpassHz, q: BUTTERWORTH_Q, gain: 0 },
  ];
}

/** Default cab low-pass corner (Hz). */
export const CAB_LOWPASS_HZ = 5500;

/** The presets, in panel order. */
export const AMP_PRESETS: Readonly<Record<AmpPresetId, AmpPreset>> = {
  clean: {
    id: 'clean',
    label: 'Clean',
    description: 'Warm, mostly clean amp with a little edge when you dig in.',
    amp: { drive: 1.5, bias: 0, low: 1, mid: 0, high: 2, level: -6, bypass: false, gateDb: -72 },
    cabLowpassHz: 7000,
  },
  crunch: {
    id: 'crunch',
    label: 'Crunch',
    description: 'Classic rock rhythm crunch: breaks up when you dig in, cleans up when you pick lightly.',
    amp: { drive: 5, bias: 0.1, low: 1, mid: 2, high: 1, level: -14, bypass: false, gateDb: -66 },
    cabLowpassHz: 6000,
  },
  overdrive: {
    id: 'overdrive',
    label: 'Overdrive',
    description: 'Driven rock and metal tone with mid push and tight sustain.',
    amp: { drive: 12, bias: 0.15, low: 2, mid: 3, high: -1, level: -20, bypass: false, gateDb: -60 },
    cabLowpassHz: CAB_LOWPASS_HZ,
  },
  di: {
    id: 'di',
    label: 'DI',
    description: 'Dry input, no amp or cab (use with your own amp sim or for checks).',
    amp: { ...BYPASS_CONFIG },
    cabLowpassHz: null,
  },
};

/** Preset ids in panel order. */
export const AMP_PRESET_ORDER: readonly AmpPresetId[] = ['clean', 'crunch', 'overdrive', 'di'];

/**
 * Drive character for the panel (by drive in dB): purely descriptive, so the player knows where a
 * drive setting sits (the Crunch preset starts in "crunch", Overdrive in "overdrive").
 */
export function driveCharacter(drive: number): string {
  const db = 20 * Math.log10(Math.max(drive, 1e-6));
  if (db < 6) return 'clean';
  if (db < 12) return 'edge of breakup';
  if (db < 18) return 'crunch';
  if (db < 26) return 'overdrive';
  return 'saturated';
}

/** Clamp a value into a range. */
function clampTo(v: number, r: { min: number; max: number }): number {
  return Math.min(r.max, Math.max(r.min, v));
}

/**
 * The amp config for a preset with the player's knob settings (drive, tone, level) applied and
 * clamped to {@link AMP_RANGES}. Bias, gate and bypass always come from the preset.
 */
export function ampConfigFor(
  preset: AmpPresetId,
  knobs: { drive: number; tone: { low: number; mid: number; high: number }; level: number },
): AmpConfig {
  const base = AMP_PRESETS[preset].amp;
  if (base.bypass) return { ...base };
  return {
    ...base,
    drive: clampTo(knobs.drive, AMP_RANGES.drive),
    low: clampTo(knobs.tone.low, AMP_RANGES.tone),
    mid: clampTo(knobs.tone.mid, AMP_RANGES.tone),
    high: clampTo(knobs.tone.high, AMP_RANGES.tone),
    level: clampTo(knobs.level, AMP_RANGES.level),
  };
}
