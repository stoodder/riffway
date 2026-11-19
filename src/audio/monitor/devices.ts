/**
 * Device-label heuristics for the speaker guard (docs/monitoring.md § Headphones and feedback guard).
 * Pure functions over `MediaDeviceInfo`-like records.
 * @module
 */
import type { AudioDeviceInfo } from '@shared/services';

/** Output labels that mean laptop / built-in speakers. */
export const SPEAKER_LABEL = /built-in|macbook.*speakers|internal speakers/i;

/** Input labels that mean the built-in microphone (not a guitar interface). */
export const BUILT_IN_MIC_LABEL = /built-in|macbook.*microphone|internal microphone/i;

/** True when an output label looks like built-in laptop speakers. */
export function isLaptopSpeaker(label: string | null | undefined): boolean {
  return Boolean(label) && SPEAKER_LABEL.test(label!);
}

/** True when an input label looks like the built-in microphone. */
export function isBuiltInMic(label: string | null | undefined): boolean {
  return Boolean(label) && BUILT_IN_MIC_LABEL.test(label!);
}

/**
 * Label of the output a `sinkId` plays to. `''` is the system default: Chrome lists it as
 * `deviceId: 'default'` ("Default - MacBook Pro Speakers (Built-in)"). Falls back to `fallback`
 * (the label saved in settings) when the device isn't listed or labels are hidden.
 */
export function outputLabel(outputs: readonly AudioDeviceInfo[], sinkId: string, fallback: string | null): string | null {
  const id = sinkId === '' ? 'default' : sinkId;
  const match = outputs.find((d) => d.deviceId === id) ?? (sinkId === '' ? outputs[0] : undefined);
  return match?.label || fallback || null;
}
