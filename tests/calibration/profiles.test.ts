/**
 * Calibration results in settings, per device pair: saves, keyboard vs guitar method rules, the
 * estimated fallback, loopback, visual offset, undo, device switching and IndexedDB persistence.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  calibratedForOtherDevice,
  currentProfile,
  deviceKey,
  estimateGuitarOffsetMs,
  estimatedGuitarPatch,
  followCalibrationProfiles,
  guitarResultPatch,
  keyboardResultPatch,
  loopbackGuitarPatch,
  loopbackResultPatch,
  profileSwitchPatch,
  restorePatch,
  snapshot,
  visualOffsetPatch,
} from '../../src/audio/calibration';
import { openStorage } from '../../src/storage';
import { memorySettings } from './helpers';

const USB = { input: { deviceId: 'a', label: 'Scarlett Solo USB', channel: 0 as const }, output: { sinkId: 'h', label: 'External Headphones' } };
const NOW = 1_700_000_000_000;

describe('deviceKey', () => {
  it('uses labels (normalised), falling back to ids, then "default"', () => {
    expect(deviceKey(USB)).toBe('scarlett solo usb → external headphones');
    expect(deviceKey({ input: { deviceId: 'x1', label: null, channel: 0 }, output: { sinkId: '', label: null } })).toBe('x1 → default');
    expect(deviceKey({ input: { deviceId: null, label: '  Scarlett   Solo ', channel: 0 }, output: { sinkId: 's9', label: null } })).toBe('scarlett solo → s9');
  });
});

describe('result patches', () => {
  it('a guitar result sets the active fields and the device pair profile', async () => {
    const st = memorySettings(USB);
    await st.update(guitarResultPatch(st.get(), { offsetMs: 41.5, spreadMs: 3.2 }, NOW));
    const c = st.get().calibration;
    expect(c).toMatchObject({ inputOffsetMs: 41.5, method: 'play-to-click', measuredAt: NOW, spreadMs: 3.2, keyboardOffsetMs: 0, visualOffsetMs: 0 });
    expect(st.get().calibration.deviceKey).toBe(deviceKey(USB));
    expect(currentProfile(st.get())).toMatchObject({
      inputLabel: 'Scarlett Solo USB',
      outputLabel: 'External Headphones',
      inputOffsetMs: 41.5,
      method: 'play-to-click',
      loopbackMs: null,
    });
  });

  it('a keyboard result keeps the guitar method unless nothing was calibrated', async () => {
    const st = memorySettings(USB);
    await st.update(keyboardResultPatch(st.get(), { offsetMs: 18, spreadMs: 6 }, NOW));
    expect(st.get().calibration).toMatchObject({ keyboardOffsetMs: 18, method: 'tap-to-click', spreadMs: 6, inputOffsetMs: 0 });
    await st.update(guitarResultPatch(st.get(), { offsetMs: 40, spreadMs: 2 }, NOW + 1));
    await st.update(keyboardResultPatch(st.get(), { offsetMs: 22, spreadMs: 7 }, NOW + 2));
    expect(st.get().calibration).toMatchObject({ keyboardOffsetMs: 22, method: 'play-to-click', spreadMs: 2, measuredAt: NOW + 1, inputOffsetMs: 40 });
    expect(currentProfile(st.get())).toMatchObject({ keyboardOffsetMs: 22, keyboardSpreadMs: 7, keyboardMeasuredAt: NOW + 2 });
  });

  it('estimated, loopback and visual patches', async () => {
    const st = memorySettings(USB);
    await st.update(loopbackResultPatch(st.get(), 33.4, NOW));
    expect(st.get().calibration.method).toBe('none');
    expect(currentProfile(st.get())).toMatchObject({ loopbackMs: 33.4, loopbackAt: NOW });
    await st.update(estimatedGuitarPatch(st.get(), 33.4, NOW + 5));
    expect(st.get().calibration).toMatchObject({ inputOffsetMs: 33.4, method: 'estimated', spreadMs: null });
    await st.update(visualOffsetPatch(st.get(), -10));
    expect(st.get().calibration.visualOffsetMs).toBe(-10);
    // Later saves keep the loopback detail.
    expect(currentProfile(st.get())).toMatchObject({ loopbackMs: 33.4, visualOffsetMs: -10, method: 'estimated' });
  });

  it('"Use as guitar offset" saves the loopback round trip with method loopback', async () => {
    const st = memorySettings(USB);
    await st.update(loopbackResultPatch(st.get(), 31.2, NOW));
    await st.update(loopbackGuitarPatch(st.get(), 31.2, NOW + 1));
    expect(st.get().calibration).toMatchObject({ inputOffsetMs: 31.2, method: 'loopback', measuredAt: NOW + 1, spreadMs: null, deviceKey: deviceKey(USB) });
    expect(currentProfile(st.get())).toMatchObject({ inputOffsetMs: 31.2, method: 'loopback', loopbackMs: 31.2 });
  });

  it('undo restores the previous active fields and profile', async () => {
    const st = memorySettings(USB);
    await st.update(guitarResultPatch(st.get(), { offsetMs: 30, spreadMs: 2 }, NOW));
    const before = snapshot(st.get());
    await st.update(guitarResultPatch(st.get(), { offsetMs: 80, spreadMs: 9 }, NOW + 1));
    await st.update(restorePatch(st.get(), before));
    expect(st.get().calibration).toMatchObject({ inputOffsetMs: 30, spreadMs: 2, measuredAt: NOW });
    expect(currentProfile(st.get())).toMatchObject({ inputOffsetMs: 30 });

    const fresh = memorySettings(USB);
    const empty = snapshot(fresh.get());
    await fresh.update(guitarResultPatch(fresh.get(), { offsetMs: 50, spreadMs: 1 }, NOW));
    await fresh.update(restorePatch(fresh.get(), empty));
    expect(fresh.get().calibration).toMatchObject({ inputOffsetMs: 0, method: 'none', measuredAt: null });
  });
});

describe('estimated guitar offset', () => {
  it('is keyboard offset + input + base + output latency, with 10 ms for unreported parts', () => {
    expect(estimateGuitarOffsetMs({ keyboardOffsetMs: 15, inputLatencySec: 0.005, baseLatencySec: 0.003, outputLatencySec: 0.012 })).toBeCloseTo(35, 9);
    expect(estimateGuitarOffsetMs({ keyboardOffsetMs: 0, inputLatencySec: null, baseLatencySec: 0, outputLatencySec: Number.NaN })).toBeCloseTo(20, 9);
  });
});

describe('per-device profiles', () => {
  it('switching devices restores that pair\'s calibration; an unknown pair keeps the values, flagged', async () => {
    const st = memorySettings(USB);
    const stop = followCalibrationProfiles(st);
    await st.update(guitarResultPatch(st.get(), { offsetMs: 40, spreadMs: 2 }, NOW));
    await st.update(visualOffsetPatch(st.get(), 10));

    // Switch output to laptop speakers: no profile yet.
    await st.update({ output: { sinkId: '', label: 'MacBook Pro Speakers' } });
    expect(st.get().calibration.inputOffsetMs).toBe(40);
    expect(calibratedForOtherDevice(st.get())).toBe(true);
    // Calibrate the new pair (keyboard only): the carried guitar value is now "estimated".
    await st.update(keyboardResultPatch(st.get(), { offsetMs: 25, spreadMs: 5 }, NOW + 1));
    expect(calibratedForOtherDevice(st.get())).toBe(false);
    expect(st.get().calibration).toMatchObject({ method: 'estimated', inputOffsetMs: 40, keyboardOffsetMs: 25 });
    await st.update(guitarResultPatch(st.get(), { offsetMs: 120, spreadMs: 4 }, NOW + 2));

    // Back to headphones: the first pair comes back.
    await st.update({ output: { sinkId: 'h', label: 'External Headphones' } });
    await Promise.resolve();
    expect(st.get().calibration).toMatchObject({ inputOffsetMs: 40, method: 'play-to-click', visualOffsetMs: 10, keyboardOffsetMs: 0 });
    // And to the speakers again.
    await st.update({ output: { sinkId: '', label: 'MacBook Pro Speakers' } });
    await Promise.resolve();
    expect(st.get().calibration).toMatchObject({ inputOffsetMs: 120, method: 'play-to-click', keyboardOffsetMs: 25, visualOffsetMs: 10 });
    stop();
    await st.update({ output: { sinkId: 'h', label: 'External Headphones' } });
    expect(st.get().calibration.inputOffsetMs).toBe(120);
  });

  it('profileSwitchPatch is null for the same pair or a pair without a profile', async () => {
    const st = memorySettings(USB);
    expect(profileSwitchPatch(st.get())).toBeNull();
    await st.update(guitarResultPatch(st.get(), { offsetMs: 40, spreadMs: 2 }, NOW));
    expect(profileSwitchPatch(st.get())).toBeNull();
  });

  it('profiles persist in IndexedDB settings and survive a reopen', async () => {
    const dbName = `calib-${Math.random()}`;
    const a = await openStorage({ dbName });
    await a.settings.update(USB);
    await a.settings.update(guitarResultPatch(a.settings.get(), { offsetMs: 44, spreadMs: 3 }, NOW));
    a.close();
    const b = await openStorage({ dbName });
    expect(b.settings.get().calibration.inputOffsetMs).toBe(44);
    expect(currentProfile(b.settings.get())).toMatchObject({ inputOffsetMs: 44, method: 'play-to-click' });
    b.close();
  });
});
