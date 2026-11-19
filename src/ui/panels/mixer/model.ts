/**
 * Mixer panel model (T-032): fader taper, dB readouts and the "level before mute" memory.
 * DOM-free (the memory takes a `Storage`-like object) so it is unit-tested in Node.
 *
 * Levels are linear gains 0–1 as stored in `settings.mixer` (docs/monitoring.md); mute = level 0
 * (buses are never disconnected), except the guide whose mute is the `game.guide` assist toggle.
 * @module
 */
import type { MixerBus } from '@shared/services';
import { DEFAULT_SETTINGS } from '@shared/settings';

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

/** Storage key of the per-bus level to restore on unmute. */
export const UNMUTE_STORAGE_KEY = 'riffway:mixer:unmute';

/** Minimal `Storage` surface used by {@link unmuteMemory}. */
export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Remembers the level each bus had before it was muted (survives reloads via `storage`). */
export interface UnmuteMemory {
  /** Level to restore for `bus` (the remembered one, else the default level). */
  restoreLevel(bus: MixerBus): number;
  remember(bus: MixerBus, level: number): void;
}

/**
 * Create the unmute memory. `storage` is usually `localStorage`; null or a throwing storage
 * (private mode) degrades to memory only.
 */
export function unmuteMemory(storage: KeyValueStorage | null): UnmuteMemory {
  let saved: Partial<Record<MixerBus, number>> = {};
  try {
    const raw = storage?.getItem(UNMUTE_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (k in DEFAULT_SETTINGS.mixer && typeof v === 'number' && v > 0 && v <= 1) saved[k as MixerBus] = v;
      }
    }
  } catch {
    saved = {};
  }
  return {
    restoreLevel(bus) {
      return saved[bus] ?? DEFAULT_SETTINGS.mixer[bus];
    },
    remember(bus, level) {
      if (!(level > 0)) return;
      saved = { ...saved, [bus]: Math.min(1, level) };
      try {
        storage?.setItem(UNMUTE_STORAGE_KEY, JSON.stringify(saved));
      } catch {
        // Storage full / blocked: the in-memory value still works for this page.
      }
    },
  };
}
