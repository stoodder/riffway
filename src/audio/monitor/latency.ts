/**
 * Monitoring latency estimate (docs/monitoring.md § Latency measurement and display). Pure maths on
 * numbers the browser reports, so it is unit-tested in Node. The estimate is honest about what it
 * is: Chrome's `outputLatency` and the track's `latency` are themselves estimates (and sometimes
 * missing, in which case a 10 ms assumption is used and flagged), so the UI labels the total
 * "estimated" until a play-to-click calibration supplies a measured round trip.
 * @module
 */
import type { LatencyEstimate } from '@shared/services';
import type { CalibrationSettings } from '@shared/settings';

/** Fallback when the browser does not report an input or output latency (s). */
export const ASSUMED_LATENCY_SEC = 0.01;

/** Render quantum (samples): one block of buffering on the audio thread. */
export const RENDER_QUANTUM = 128;

/** Band edges (ms): ≤ great, ≤ playable, above = noticeable. */
export const LATENCY_BANDS = { great: 15, playable: 30 } as const;

/** Tips shown when the estimate is "noticeable" (and in the panel's help). */
export const LATENCY_TIPS: readonly string[] = [
  'Use wired headphones (Bluetooth adds 100 ms or more).',
  'Plug the guitar interface straight into the Mac, not through a hub.',
  'Close other audio apps (DAWs, video calls, music players).',
  'Keep the interface at 48 kHz and check Audio MIDI Setup uses the same sample rate for input and output.',
];

/** What the estimate is computed from. */
export interface LatencyInputs {
  /** `track.getSettings().latency` (s), or null when not reported. */
  inputLatencySec: number | null;
  /** `AudioContext.baseLatency` (s). */
  baseLatencySec: number;
  /** `AudioContext.outputLatency` (s); 0 / NaN = not reported. */
  outputLatencySec: number;
  sampleRate: number;
  /** Group delay of the amp DSP in samples (0 for DI). */
  dspSamples: number;
  /** Calibration settings: a play-to-click or loopback calibration supplies the measured round trip. */
  calibration: Pick<CalibrationSettings, 'method' | 'inputOffsetMs'>;
}

/** Grouped for display: input (device + driver), processing (one render quantum + amp DSP), output. */
export interface LatencyBreakdown {
  totalMs: number;
  inputMs: number;
  processingMs: number;
  outputMs: number;
  assumedInput: boolean;
  assumedOutput: boolean;
}

/** Band for a monitoring latency in ms. */
export function latencyBand(ms: number): LatencyEstimate['band'] {
  if (ms <= LATENCY_BANDS.great) return 'great';
  if (ms <= LATENCY_BANDS.playable) return 'playable';
  return 'noticeable';
}

const usable = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Estimate the monitoring delay: `input + baseLatency + output + 128 / sr + amp DSP`, in ms.
 * `calibratedOffsetMs` is the measured `inputOffsetMs` (play-to-click, which also contains the
 * player's own timing habit, or loopback), so the UI calls it "calibrated offset", not latency.
 */
export function estimateMonitorLatency(i: LatencyInputs): LatencyEstimate {
  const inputSec = usable(i.inputLatencySec) ? i.inputLatencySec : ASSUMED_LATENCY_SEC;
  const outputSec = usable(i.outputLatencySec) ? i.outputLatencySec : ASSUMED_LATENCY_SEC;
  const baseSec = usable(i.baseLatencySec) ? i.baseLatencySec : 0;
  const parts = {
    inputMs: inputSec * 1000,
    baseMs: baseSec * 1000,
    outputMs: outputSec * 1000,
    quantumMs: (RENDER_QUANTUM / i.sampleRate) * 1000,
    dspMs: (Math.max(0, i.dspSamples) / i.sampleRate) * 1000,
  };
  const monitorMs = parts.inputMs + parts.baseMs + parts.outputMs + parts.quantumMs + parts.dspMs;
  return {
    monitorMs,
    band: latencyBand(monitorMs),
    calibratedOffsetMs: i.calibration.method === 'play-to-click' || i.calibration.method === 'loopback' ? i.calibration.inputOffsetMs : null,
    parts,
    assumed: { input: !usable(i.inputLatencySec), output: !usable(i.outputLatencySec) },
  };
}

/**
 * Group an estimate for display. An absent `parts.dspMs` reads as 0 and absent `assumed` flags as
 * "reported" (estimates not made by {@link estimateMonitorLatency}, e.g. test fakes).
 */
export function latencyBreakdown(est: LatencyEstimate): LatencyBreakdown {
  return {
    totalMs: est.monitorMs,
    inputMs: est.parts.inputMs,
    processingMs: est.parts.quantumMs + (est.parts.dspMs ?? 0),
    outputMs: est.parts.baseMs + est.parts.outputMs,
    assumedInput: est.assumed?.input ?? false,
    assumedOutput: est.assumed?.output ?? false,
  };
}
