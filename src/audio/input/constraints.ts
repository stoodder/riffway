/**
 * `getUserMedia` constraints and their read-back (docs/audio-input.md § Constraints). The browser may
 * ignore any constraint, so only `track.getSettings()` is trusted: processing flags that read back
 * `true` become warnings, and the real sample rate / channel count drive the engine and the worklet.
 * @module
 */
import type { InputChannel } from '@shared/settings';
import type { InputOpenResult } from '@shared/services';

/** The three voice-processing flags that must be off for a guitar. */
export const PROCESSING_FLAGS = ['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const;

/** One of {@link PROCESSING_FLAGS}. */
export type ProcessingFlag = (typeof PROCESSING_FLAGS)[number];

/** Audio constraints for the chosen input, exactly as in docs/audio-input.md. */
export function inputConstraints(deviceId: string): MediaStreamConstraints {
  return {
    audio: {
      deviceId: { exact: deviceId },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 },
      // `latency` is supported by Chrome but missing from TypeScript's MediaTrackConstraintSet.
      ...({ latency: { ideal: 0 } } as MediaTrackConstraintSet),
    },
    video: false,
  };
}

/** What we read back from `track.getSettings()`. */
export interface TrackReadback {
  /** Hz; null when the browser does not report it. */
  sampleRate: number | null;
  /** Channels delivered (≥ 1). */
  channelCount: number;
  /** Seconds, if reported. */
  latency: number | null;
  /** Flags that are still on despite the constraints. */
  processingWarnings: ProcessingFlag[];
}

/** Interpret `track.getSettings()` (unknown fields read as "not reported"). */
export function readTrackSettings(settings: MediaTrackSettings): TrackReadback {
  const s = settings as MediaTrackSettings & { latency?: number };
  return {
    sampleRate: positive(s.sampleRate),
    channelCount: Math.max(1, Math.round(positive(s.channelCount) ?? 1)),
    latency: typeof s.latency === 'number' && Number.isFinite(s.latency) && s.latency >= 0 ? s.latency : null,
    processingWarnings: PROCESSING_FLAGS.filter((flag) => s[flag] === true),
  };
}

/**
 * The channel the worklet should analyse: the setting when the track has at least two channels,
 * else channel 0 (`1` or `mix` on a mono track would read silence or halve the level).
 */
export function effectiveChannel(setting: InputChannel, channelCount: number): InputChannel {
  return channelCount >= 2 ? setting : 0;
}

/** Player-facing text for a processing warning. */
export function processingWarningText(flags: InputOpenResult['processingWarnings']): string | null {
  if (flags.length === 0) return null;
  const names: Record<ProcessingFlag, string> = {
    echoCancellation: 'echo cancellation',
    noiseSuppression: 'noise suppression',
    autoGainControl: 'auto gain',
  };
  const list = flags.map((f) => names[f]);
  const joined = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0];
  return `The browser kept ${joined} on for this input. Pitch and timing detection may be less reliable; try another input or check the device in macOS Audio MIDI Setup.`;
}

function positive(v: number | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}
