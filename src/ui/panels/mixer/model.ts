/**
 * Mixer panel model (T-032): fader taper and dB readouts. DOM-free, unit-tested in Node.
 *
 * Levels are linear gains 0–1 as stored in `settings.mixer` (docs/monitoring.md); mute is the
 * per-bus `settings.mixerMute` flag (the engine plays a muted bus at 0 and the level is kept),
 * except the guide whose mute is the `game.guide` assist toggle.
 * @module
 */
import type { MixerBus } from '@shared/services';

/** Fader rows in display order with labels. */
export const MIXER_CHANNELS: readonly { bus: MixerBus; label: string }[] = [
  { bus: 'monitor', label: 'Guitar (monitor)' },
  { bus: 'backing', label: 'Backing track' },
  { bus: 'guide', label: 'Guide synth' },
  { bus: 'metronome', label: 'Metronome' },
  { bus: 'master', label: 'Master' },
];

/** Fader positions run 0–{@link FADER_MAX}. */
export const FADER_MAX = 100;

/**
 * Fader position → linear gain with a square-law taper (`(p/100)²`): the top half of the travel
 * covers the last ~12 dB, where mixing happens, instead of a linear fader's −6 dB.
 */
export function faderToLevel(pos: number): number {
  const p = Math.min(FADER_MAX, Math.max(0, pos)) / FADER_MAX;
  return Math.round(p * p * 10000) / 10000;
}

/** Linear gain → fader position (inverse of {@link faderToLevel}, rounded to whole steps). */
export function levelToFader(level: number): number {
  return Math.round(Math.sqrt(Math.min(1, Math.max(0, level))) * FADER_MAX);
}

/** `0.5` → `"−6.0 dB"`, `1` → `"0.0 dB"`, `0` → `"Off"`. */
export function formatLevelDb(level: number): string {
  if (!(level > 0)) return 'Off';
  const db = 20 * Math.log10(level);
  const abs = Math.abs(db) < 0.05 ? 0 : db;
  return `${abs < 0 ? '−' : ''}${Math.abs(abs).toFixed(1)} dB`;
}
