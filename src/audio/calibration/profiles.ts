/**
 * Calibration results in settings, kept **per device pair** (input label → output label):
 * docs/timing.md § Latency calibration › Storage.
 *
 * The judge, the input service and the engine read the *active* fields of
 * `settings.calibration` (`CalibrationSettings`). Every save also stores a copy of them under
 * `calibration.profiles[deviceKey]`, and switching the input or output device restores that device
 * pair's copy ({@link followCalibrationProfiles}). The profile map, the active pair's key and the
 * keyboard / loopback details are an extension of the frozen `CalibrationSettings` contract
 * ({@link CalibrationExtension}); the settings store deep-merges and persists unknown fields, and
 * its validator ignores them, so they ride along in IndexedDB and in exports.
 * @module
 */
import type { Unsubscribe } from '@shared/clock';
import type { CalibrationMethod, CalibrationSettings, DeepPartial, Settings, SettingsStore } from '@shared/settings';
import { ASSUMED_LATENCY_SEC } from '../monitor/latency';

/** One device pair's calibration. */
export interface CalibrationProfile {
  /** Display labels of the pair (null = system default). */
  inputLabel: string | null;
  outputLabel: string | null;
  inputOffsetMs: number;
  method: CalibrationMethod;
  measuredAt: number | null;
  spreadMs: number | null;
  keyboardOffsetMs: number;
  keyboardMeasuredAt: number | null;
  keyboardSpreadMs: number | null;
  visualOffsetMs: number;
  /** Hardware round trip from a loopback measurement (ms), or null. */
  loopbackMs: number | null;
  loopbackAt: number | null;
}

/** Fields stored next to `CalibrationSettings` (not in the frozen contract). */
export interface CalibrationExtension {
  /** Device pair the active fields belong to. */
  deviceKey?: string;
  profiles?: Record<string, CalibrationProfile>;
}

/** `settings.calibration` with the extension fields. */
export type StoredCalibration = CalibrationSettings & CalibrationExtension;

/** A settings patch that may carry the extension fields. */
export type CalibrationPatch = DeepPartial<Settings> & { calibration?: DeepPartial<StoredCalibration> };

/** Active fields copied between `settings.calibration` and a profile. */
const ACTIVE_FIELDS = ['inputOffsetMs', 'keyboardOffsetMs', 'visualOffsetMs', 'method', 'measuredAt', 'spreadMs'] as const;

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Key of the current device pair: input label (else device id, else "default") → output label
 * (else sink id, else "default"). Labels, not ids: Chrome rotates device ids.
 */
export function deviceKey(s: Pick<Settings, 'input' | 'output'>): string {
  const input = s.input.label || s.input.deviceId || 'default';
  const output = s.output.label || s.output.sinkId || 'default';
  return `${norm(input)} → ${norm(output)}`;
}

/** The stored calibration with its extension fields. */
export function storedCalibration(s: Settings): StoredCalibration {
  return s.calibration as StoredCalibration;
}

/** The profile of the current device pair, or null. */
export function currentProfile(s: Settings): CalibrationProfile | null {
  return storedCalibration(s).profiles?.[deviceKey(s)] ?? null;
}

/**
 * True when the active offsets were measured on another device pair (the player switched devices
 * and has not calibrated this pair yet).
 */
export function calibratedForOtherDevice(s: Settings): boolean {
  const c = storedCalibration(s);
  return c.method !== 'none' && c.deviceKey !== undefined && c.deviceKey !== deviceKey(s);
}

function profileOf(s: Settings, active: CalibrationSettings, prev: CalibrationProfile | null, extra: Partial<CalibrationProfile>): CalibrationProfile {
  return {
    inputLabel: s.input.label,
    outputLabel: s.output.label,
    inputOffsetMs: active.inputOffsetMs,
    method: active.method,
    measuredAt: active.measuredAt,
    spreadMs: active.spreadMs,
    keyboardOffsetMs: active.keyboardOffsetMs,
    keyboardMeasuredAt: prev?.keyboardMeasuredAt ?? null,
    keyboardSpreadMs: prev?.keyboardSpreadMs ?? null,
    visualOffsetMs: active.visualOffsetMs,
    loopbackMs: prev?.loopbackMs ?? null,
    loopbackAt: prev?.loopbackAt ?? null,
    ...extra,
  };
}

/** Patch that sets active fields and stores the resulting profile for the current device pair. */
function savePatch(s: Settings, active: Partial<CalibrationSettings>, extra: Partial<CalibrationProfile> = {}): CalibrationPatch {
  const key = deviceKey(s);
  // Offsets measured on another device pair are only an estimate for this one: the new pair's
  // profile starts from them marked "estimated", without the other pair's keyboard / loopback details.
  const other = calibratedForOtherDevice(s);
  const carried: Partial<CalibrationSettings> = other && active.method === undefined ? { method: 'estimated', spreadMs: null } : {};
  const next: CalibrationSettings = { ...s.calibration, ...carried, ...active };
  const prev = other ? null : currentProfile(s);
  return { calibration: { ...carried, ...active, deviceKey: key, profiles: { [key]: profileOf(s, next, prev, extra) } } };
}

/** Result of a guitar play-to-click run. */
export function guitarResultPatch(s: Settings, r: { offsetMs: number; spreadMs: number }, now: number): CalibrationPatch {
  return savePatch(s, { inputOffsetMs: r.offsetMs, method: 'play-to-click', measuredAt: now, spreadMs: r.spreadMs });
}

/**
 * Result of a tap-to-click run: sets `keyboardOffsetMs`. `method` / `measuredAt` / `spreadMs`
 * describe the guitar offset, so they only change when nothing better is stored (`method: 'none'`).
 */
export function keyboardResultPatch(s: Settings, r: { offsetMs: number; spreadMs: number }, now: number): CalibrationPatch {
  const active: Partial<CalibrationSettings> = { keyboardOffsetMs: r.offsetMs };
  if (s.calibration.method === 'none') Object.assign(active, { method: 'tap-to-click' as const, measuredAt: now, spreadMs: r.spreadMs });
  return savePatch(s, active, { keyboardMeasuredAt: now, keyboardSpreadMs: r.spreadMs });
}

/** Guitar offset that was not measured with the guitar ("estimated"). */
export function estimatedGuitarPatch(s: Settings, offsetMs: number, now: number): CalibrationPatch {
  return savePatch(s, { inputOffsetMs: offsetMs, method: 'estimated', measuredAt: now, spreadMs: null });
}

/** Store a loopback measurement (hardware round trip) for the current device pair. */
export function loopbackResultPatch(s: Settings, loopbackMs: number, now: number): CalibrationPatch {
  return savePatch(s, {}, { loopbackMs, loopbackAt: now });
}

/** Set the render-only visual offset. */
export function visualOffsetPatch(s: Settings, visualOffsetMs: number): CalibrationPatch {
  return savePatch(s, { visualOffsetMs });
}

/** Restore the active fields (and the current pair's profile) to an earlier snapshot (undo). */
export function restorePatch(s: Settings, snapshot: { active: CalibrationSettings; profile: CalibrationProfile | null }): CalibrationPatch {
  const active = pickActive(snapshot.active);
  if (!snapshot.profile) return { calibration: { ...active } };
  const key = deviceKey(s);
  return { calibration: { ...active, deviceKey: key, profiles: { [key]: { ...snapshot.profile } } } };
}

/** Snapshot of what {@link restorePatch} restores. */
export function snapshot(s: Settings): { active: CalibrationSettings; profile: CalibrationProfile | null } {
  const p = currentProfile(s);
  return { active: pickActive(s.calibration), profile: p ? { ...p } : null };
}

function pickActive(c: CalibrationSettings): CalibrationSettings {
  const out = {} as Record<(typeof ACTIVE_FIELDS)[number], unknown>;
  for (const f of ACTIVE_FIELDS) out[f] = c[f];
  return out as unknown as CalibrationSettings;
}

/**
 * Patch to apply when the device pair changed: the new pair's profile becomes active. Null when
 * nothing changes (same pair, or no profile for it: the old values stay and the panel says they
 * were measured on another device).
 */
export function profileSwitchPatch(s: Settings): CalibrationPatch | null {
  const c = storedCalibration(s);
  const key = deviceKey(s);
  if (c.deviceKey === key) return null;
  const p = c.profiles?.[key];
  if (!p) return null;
  const active: CalibrationSettings = {
    inputOffsetMs: p.inputOffsetMs,
    keyboardOffsetMs: p.keyboardOffsetMs,
    visualOffsetMs: p.visualOffsetMs,
    method: p.method,
    measuredAt: p.measuredAt,
    spreadMs: p.spreadMs,
  };
  return { calibration: { ...active, deviceKey: key } };
}

/**
 * Keep the active calibration on the current device pair's profile: applies
 * {@link profileSwitchPatch} now and after every settings change. Call once for the app's lifetime
 * (the calibration panel also runs it while mounted; running it twice is harmless).
 */
export function followCalibrationProfiles(settings: Pick<SettingsStore, 'get' | 'update' | 'subscribe'>): Unsubscribe {
  let applying = false;
  const check = (s: Settings): void => {
    if (applying) return;
    const patch = profileSwitchPatch(s);
    if (!patch) return;
    applying = true;
    settings
      .update(patch)
      .catch((err: unknown) => console.error('Riffway: could not restore the calibration for this device', err))
      .finally(() => {
        applying = false;
      });
  };
  check(settings.get());
  return settings.subscribe(check);
}

/** What the "estimated" guitar offset is computed from (seconds, as the browser reports them). */
export interface EstimateInputs {
  keyboardOffsetMs: number;
  /** `track.getSettings().latency`, or null when not reported. */
  inputLatencySec: number | null;
  baseLatencySec: number;
  /** `ctx.outputLatency` (0 / NaN = not reported). */
  outputLatencySec: number;
}

/**
 * Fallback guitar offset when play-to-click finds no onsets (docs/timing.md): the keyboard offset
 * (the player's timing habit in the heard domain) plus the input, base and output latency the
 * browser reports; unreported input / output latency counts as 10 ms (as in the monitoring estimate).
 */
export function estimateGuitarOffsetMs(i: EstimateInputs): number {
  const usable = (v: number | null): v is number => v !== null && Number.isFinite(v) && v > 0;
  const input = usable(i.inputLatencySec) ? i.inputLatencySec : ASSUMED_LATENCY_SEC;
  const output = usable(i.outputLatencySec) ? i.outputLatencySec : ASSUMED_LATENCY_SEC;
  const base = usable(i.baseLatencySec) ? i.baseLatencySec : 0;
  return i.keyboardOffsetMs + (input + base + output) * 1000;
}
