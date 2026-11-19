/**
 * Calibration results in settings, kept **per device pair** (input label → output label):
 * docs/timing.md § Latency calibration › Storage.
 *
 * The judge, the input service and the engine read the *active* fields of
 * `settings.calibration` (`CalibrationSettings`). Every save also stores a copy of them under
 * `calibration.profiles[deviceKey]`, and switching the input or output device restores that device
 * pair's copy ({@link followCalibrationProfiles}, run once for the app's lifetime by `src/main.ts`).
 * @module
 */
import type { Unsubscribe } from '@shared/clock';
import type { CalibrationProfile, CalibrationSettings, DeepPartial, Settings, SettingsStore } from '@shared/settings';
import { ASSUMED_LATENCY_SEC } from '../monitor/latency';

/** A settings patch with a calibration part. */
export type CalibrationPatch = DeepPartial<Settings>;

/** The active fields of `settings.calibration` (what the judge, input service and engine read), copied to and from a profile. */
export type ActiveCalibration = Pick<CalibrationSettings, 'inputOffsetMs' | 'keyboardOffsetMs' | 'visualOffsetMs' | 'method' | 'measuredAt' | 'spreadMs'>;

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

/** The profile of the current device pair, or null. */
export function currentProfile(s: Settings): CalibrationProfile | null {
  return s.calibration.profiles[deviceKey(s)] ?? null;
}

/**
 * True when the active offsets were measured on another device pair (the player switched devices
 * and has not calibrated this pair yet).
 */
export function calibratedForOtherDevice(s: Settings): boolean {
  const c = s.calibration;
  return c.method !== 'none' && c.deviceKey !== null && c.deviceKey !== deviceKey(s);
}

function profileOf(s: Settings, active: ActiveCalibration, prev: CalibrationProfile | null, extra: Partial<CalibrationProfile>): CalibrationProfile {
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
function savePatch(s: Settings, active: Partial<ActiveCalibration>, extra: Partial<CalibrationProfile> = {}): CalibrationPatch {
  const key = deviceKey(s);
  // Offsets measured on another device pair are only an estimate for this one: the new pair's
  // profile starts from them marked "estimated", without the other pair's keyboard / loopback details.
  const other = calibratedForOtherDevice(s);
  const carried: Partial<ActiveCalibration> = other && active.method === undefined ? { method: 'estimated', spreadMs: null } : {};
  const next: ActiveCalibration = { ...s.calibration, ...carried, ...active };
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
  const active: Partial<ActiveCalibration> = { keyboardOffsetMs: r.offsetMs };
  if (s.calibration.method === 'none') Object.assign(active, { method: 'tap-to-click' as const, measuredAt: now, spreadMs: r.spreadMs });
  return savePatch(s, active, { keyboardMeasuredAt: now, keyboardSpreadMs: r.spreadMs });
}

/** Guitar offset that was not measured with the guitar ("estimated"). */
export function estimatedGuitarPatch(s: Settings, offsetMs: number, now: number): CalibrationPatch {
  return savePatch(s, { inputOffsetMs: offsetMs, method: 'estimated', measuredAt: now, spreadMs: null });
}

/** Guitar offset set from a loopback measurement ("Use as guitar offset"): `method: 'loopback'`. */
export function loopbackGuitarPatch(s: Settings, offsetMs: number, now: number): CalibrationPatch {
  return savePatch(s, { inputOffsetMs: offsetMs, method: 'loopback', measuredAt: now, spreadMs: null });
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
export function restorePatch(s: Settings, snapshot: { active: ActiveCalibration; profile: CalibrationProfile | null }): CalibrationPatch {
  const active = pickActive(snapshot.active);
  if (!snapshot.profile) return { calibration: { ...active } };
  const key = deviceKey(s);
  return { calibration: { ...active, deviceKey: key, profiles: { [key]: { ...snapshot.profile } } } };
}

/** Snapshot of what {@link restorePatch} restores. */
export function snapshot(s: Settings): { active: ActiveCalibration; profile: CalibrationProfile | null } {
  const p = currentProfile(s);
  return { active: pickActive(s.calibration), profile: p ? { ...p } : null };
}

function pickActive(c: ActiveCalibration): ActiveCalibration {
  const { inputOffsetMs, keyboardOffsetMs, visualOffsetMs, method, measuredAt, spreadMs } = c;
  return { inputOffsetMs, keyboardOffsetMs, visualOffsetMs, method, measuredAt, spreadMs };
}

/**
 * Patch to apply when the device pair changed: the new pair's profile becomes active. Null when
 * nothing changes (same pair, or no profile for it: the old values stay and the panel says they
 * were measured on another device).
 */
export function profileSwitchPatch(s: Settings): CalibrationPatch | null {
  const c = s.calibration;
  const key = deviceKey(s);
  if (c.deviceKey === key) return null;
  const p = c.profiles[key];
  if (!p) return null;
  return { calibration: { ...pickActive(p), deviceKey: key } };
}

/**
 * Keep the active calibration on the current device pair's profile: applies
 * {@link profileSwitchPatch} now and after every settings change. `src/main.ts` calls it once for
 * the app's lifetime; running it twice is harmless.
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
