/**
 * Player settings, stored in IndexedDB store `settings` under key `'settings'` (docs/progress.md).
 * Read/written through {@link SettingsStore} (implemented by `src/storage/`, T-020). Stored values are
 * deep-merged over {@link DEFAULT_SETTINGS}, so new fields need only a default here.
 *
 * Units: levels 0–1 (linear gain, UI shows dB), offsets in ms, speeds as fractions (0.7 = 70%).
 * DOM-free.
 * @module
 */
import type { Unsubscribe } from './clock';

/** Which input channel the analysis worklet listens to. */
export type InputChannel = 0 | 1 | 'mix';

/** Amp presets (docs/monitoring.md). */
export type AmpPresetId = 'clean' | 'crunch' | 'overdrive' | 'di';

/** How calibration offsets were obtained. */
export type CalibrationMethod = 'none' | 'play-to-click' | 'tap-to-click' | 'estimated';

/** HUD feedback detail (learning research row 8). */
export type FeedbackDetail = 'minimal' | 'standard' | 'detailed';

/** Mixer bus levels (0–1). Mute = 0; buses are never disconnected. */
export interface MixerLevels {
  master: number;
  monitor: number;
  backing: number;
  guide: number;
  metronome: number;
}

/** Latency calibration (docs/timing.md § Latency calibration). */
export interface CalibrationSettings {
  /** Guitar: subtracted from worklet onset times. Includes output + input latency + habitual bias. */
  inputOffsetMs: number;
  /** Keyboard / tap: subtracted from keyboard event times. */
  keyboardOffsetMs: number;
  /** Render-only offset (flash vs click). */
  visualOffsetMs: number;
  method: CalibrationMethod;
  /** Epoch ms of the last calibration, or null. */
  measuredAt: number | null;
  /** MAD spread of the accepted pairs, ms. */
  spreadMs: number | null;
}

/** Monitoring + amp sim (docs/monitoring.md § Settings). */
export interface MonitorSettings {
  enabled: boolean;
  preset: AmpPresetId;
  /** Drive (linear gain into the clipper). */
  drive: number;
  /** Tone stack in dB. */
  tone: { low: number; mid: number; high: number };
  /** Output level in dB. */
  level: number;
  /** Per output `sinkId`: user chose "Turn on anyway" on laptop speakers. */
  allowSpeakers: Record<string, boolean>;
  /** The "use headphones" card has been shown. */
  headphonesCardSeen: boolean;
}

/** Keyboard input mode (D6). Values are `KeyboardEvent.code`s. */
export interface KeyboardSettings {
  /** `lanes[0]` = string 1 (high e) … `lanes[5]` = string 6 (low E). Default `Digit1`…`Digit6`. */
  lanes: [string, string, string, string, string, string];
  /** Held modifier that adds +1 semitone (deliberate WrongNote). */
  wrongPitchModifier: 'Shift';
}

/** All player settings. */
export interface Settings {
  schema: 1;
  input: {
    /** Chosen input `deviceId` (Chrome may rotate ids; re-match by label). */
    deviceId: string | null;
    label: string | null;
    channel: InputChannel;
  };
  output: {
    /** `AudioContext.setSinkId` value; `''` = system default. */
    sinkId: string;
    label: string | null;
  };
  calibration: CalibrationSettings;
  monitor: MonitorSettings;
  mixer: MixerLevels;
  tuner: {
    /** A4 reference in Hz. */
    a4: number;
  };
  game: {
    feedbackDetail: FeedbackDetail;
    /** Hand-position cue brackets on the highway. */
    handCues: boolean;
    /** Octave errors are WrongNotes (DEC-18). */
    strictOctave: boolean;
    /** Highway scroll speed multiplier (0.5–2). */
    noteSpeed: number;
    /** Guide synth audible (assist toggle). */
    guide: boolean;
    /** Auto-mute the guide while backing audio plays. */
    muteGuideWithBacking: boolean;
  };
  keyboard: KeyboardSettings;
  practice: {
    /** Count-in bars before play (0–2). */
    countInBars: number;
    metronome: boolean;
    speedTrainer: boolean;
    /** Allow 110% after mastery (opt-in). */
    overspeed: boolean;
  };
  goals: {
    /** Daily goal minutes: 5 / 10 / 15 / 30 / 45. */
    dailyMinutes: number;
    /** Weekly target practice days (2–7). */
    weeklyDays: number;
  };
  preferences: {
    /** Preferred right-hand style for recommendations. */
    style: 'pick' | 'fingerstyle';
    /** Include fingerstyle items in session goals. */
    fingerstyle: boolean;
    /** Preferred genres (recommendation bonus). */
    genres: string[];
  };
}

/** Recursive partial, for patches. Arrays and tuples are replaced whole. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * Defaults (docs/*.md, user profile: pick player, rock/metal, headphones recommended).
 * Deep-frozen; use {@link defaultSettings} for a mutable copy.
 */
export const DEFAULT_SETTINGS: Readonly<Settings> = deepFreeze<Settings>({
  schema: 1,
  input: { deviceId: null, label: null, channel: 0 },
  output: { sinkId: '', label: null },
  calibration: {
    inputOffsetMs: 0,
    keyboardOffsetMs: 0,
    visualOffsetMs: 0,
    method: 'none',
    measuredAt: null,
    spreadMs: null,
  },
  monitor: {
    enabled: true,
    preset: 'clean',
    drive: 1.5,
    tone: { low: 1, mid: 0, high: 2 },
    level: -6,
    allowSpeakers: {},
    headphonesCardSeen: false,
  },
  mixer: { master: 0.8, monitor: 0.8, backing: 0.8, guide: 0.6, metronome: 0.6 },
  tuner: { a4: 440 },
  game: {
    feedbackDetail: 'standard',
    handCues: true,
    strictOctave: false,
    noteSpeed: 1,
    guide: true,
    muteGuideWithBacking: true,
  },
  keyboard: {
    lanes: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'],
    wrongPitchModifier: 'Shift',
  },
  practice: { countInBars: 1, metronome: true, speedTrainer: true, overspeed: false },
  goals: { dailyMinutes: 15, weeklyDays: 4 },
  preferences: { style: 'pick', fingerstyle: false, genres: ['rock', 'metal', 'recognizable'] },
});

/** A fresh, mutable copy of {@link DEFAULT_SETTINGS}. */
export function defaultSettings(): Settings {
  return structuredClone(DEFAULT_SETTINGS) as Settings;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Reactive settings access (T-020). `get()` is synchronous after the store has opened. */
export interface SettingsStore {
  /** Current settings (defaults merged). */
  get(): Settings;
  /** Deep-merge a patch, persist, notify subscribers. */
  update(patch: DeepPartial<Settings>): Promise<Settings>;
  /** Replace everything (import / reset). */
  replace(next: Settings): Promise<void>;
  /** Called after every change with the new settings. */
  subscribe(cb: (s: Settings) => void): Unsubscribe;
}
