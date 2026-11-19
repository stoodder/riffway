/**
 * Level-meter state (docs/audio-input.md § Level meter): bar with a smooth fall-off, 1 s peak hold,
 * clip lamp at ≥ −0.5 dBFS and "No signal" after 5 s below −60 dBFS. Pure; times in ms.
 * @module
 */

/** Meter floor, dBFS (the bar is empty below it). */
export const METER_MIN_DB = -60;
/** Green below this… */
export const METER_WARN_DB = -18;
/** …amber up to this, red above. */
export const METER_HOT_DB = -6;
/** Peak-hold time, ms. */
export const PEAK_HOLD_MS = 1000;
/** A peak at or above this is a clip. */
export const CLIP_DB = -0.5;
/** The clip lamp stays lit this long, ms. */
export const CLIP_HOLD_MS = 2000;
/** Below this is silence for the "No signal" hint… */
export const SILENCE_DB = -60;
/** …once it lasts this long, ms. */
export const NO_SIGNAL_MS = 5000;
/** Bar fall-off, dB per second. */
export const FALL_DB_PER_SEC = 24;

/** What the meter shows at one instant. */
export interface LevelView {
  /** Bar level, dBFS. */
  barDb: number;
  /** Peak-hold marker, dBFS. */
  holdDb: number;
  /** Clip lamp lit. */
  clip: boolean;
  /** Silent for ≥ 5 s. */
  noSignal: boolean;
}

/** Accumulates `level` events and answers {@link LevelView}s. */
export class LevelModel {
  private barDb = METER_MIN_DB;
  private barAt = 0;
  private holdDb = METER_MIN_DB;
  private holdAt = -Infinity;
  private clipAt = -Infinity;
  private lastSoundAt: number;

  /** `startMs`: when listening started (the "No signal" timer runs from here). */
  constructor(startMs: number) {
    this.lastSoundAt = startMs;
    this.barAt = startMs;
  }

  /** Feed one `level` event received at `nowMs`. */
  push(peakDb: number, nowMs: number): void {
    const current = this.decayed(nowMs);
    if (peakDb >= current) this.barDb = peakDb;
    else this.barDb = current;
    this.barAt = nowMs;
    if (peakDb >= this.holdDb || nowMs - this.holdAt > PEAK_HOLD_MS) {
      this.holdDb = peakDb;
      this.holdAt = nowMs;
    }
    if (peakDb >= CLIP_DB) this.clipAt = nowMs;
    if (peakDb >= SILENCE_DB) this.lastSoundAt = nowMs;
  }

  /** Restart the "No signal" timer (input re-opened). */
  restart(nowMs: number): void {
    this.lastSoundAt = nowMs;
    this.barDb = METER_MIN_DB;
    this.barAt = nowMs;
    this.holdDb = METER_MIN_DB;
    this.holdAt = -Infinity;
    this.clipAt = -Infinity;
  }

  view(nowMs: number): LevelView {
    const barDb = this.decayed(nowMs);
    const holdDb = nowMs - this.holdAt <= PEAK_HOLD_MS ? Math.max(this.holdDb, barDb) : barDb;
    return {
      barDb,
      holdDb,
      clip: nowMs - this.clipAt <= CLIP_HOLD_MS,
      noSignal: nowMs - this.lastSoundAt >= NO_SIGNAL_MS,
    };
  }

  private decayed(nowMs: number): number {
    const dt = Math.max(0, nowMs - this.barAt) / 1000;
    return Math.max(METER_MIN_DB, this.barDb - FALL_DB_PER_SEC * dt);
  }
}

/** `-12.3 → '−12 dB'`; at or below the floor `'−∞ dB'`. */
export function formatDb(db: number): string {
  if (db <= METER_MIN_DB) return '−∞ dB';
  const r = Math.round(db);
  return r < 0 ? `−${-r} dB` : `${r} dB`;
}
