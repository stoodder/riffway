/** Device listing, matching and constraint read-back rules (T-022, docs/audio-input.md). */
import { describe, expect, it } from 'vitest';
import type { AudioDeviceInfo } from '@shared/services';
import {
  chooseInput,
  displayLabel,
  findByLabel,
  labelsHidden,
  normalizeLabel,
  savedDevicePresent,
  toDeviceInfos,
} from '../../src/audio/input/devices';
import {
  effectiveChannel,
  inputConstraints,
  processingWarningText,
  readTrackSettings,
} from '../../src/audio/input/constraints';

const dev = (deviceId: string, label: string, kind: AudioDeviceInfo['kind'] = 'audioinput'): AudioDeviceInfo => ({
  deviceId,
  label,
  groupId: `g-${deviceId}`,
  kind,
});

/** What Chrome on a Mac lists with the Cubilux cable plugged in. */
const MAC_INPUTS = [
  dev('default', 'Default - MacBook Pro Microphone (Built-in)'),
  dev('mic', 'MacBook Pro Microphone (Built-in)'),
  dev('cubi', 'USB Audio CODEC (08bb:2902)'),
  dev('zoom', 'ZoomAudioDevice (Virtual)'),
];

describe('toDeviceInfos / labels', () => {
  it('keeps one kind, in order, as plain objects', () => {
    const raw = [
      { deviceId: 'a', label: 'A', groupId: '1', kind: 'audioinput' as const },
      { deviceId: 'v', label: 'Cam', groupId: '2', kind: 'videoinput' as const },
      { deviceId: 'o', label: 'Out', groupId: '3', kind: 'audiooutput' as const },
    ];
    expect(toDeviceInfos(raw, 'audioinput')).toEqual([{ deviceId: 'a', label: 'A', groupId: '1', kind: 'audioinput' }]);
    expect(toDeviceInfos(raw, 'audiooutput').map((d) => d.deviceId)).toEqual(['o']);
  });

  it('detects hidden labels and names devices until permission is granted', () => {
    const hidden = [dev('', ''), dev('', '')];
    expect(labelsHidden(hidden)).toBe(true);
    expect(labelsHidden(MAC_INPUTS)).toBe(false);
    expect(labelsHidden([])).toBe(false);
    expect(hidden.map((d, i) => displayLabel(d, i))).toEqual(['Input 1', 'Input 2']);
    expect(displayLabel(dev('default', ''), 0)).toBe('System default');
    expect(displayLabel(dev('x', '', 'audiooutput'), 2)).toBe('Output 3');
    expect(displayLabel(MAC_INPUTS[2], 2)).toBe('USB Audio CODEC (08bb:2902)');
  });

  it('normalises alias prefixes and USB ids', () => {
    expect(normalizeLabel('Default - USB Audio CODEC (08bb:2902)')).toBe('usb audio codec');
    expect(normalizeLabel('Communications - Cubilux Guitar Cable')).toBe('cubilux guitar cable');
    expect(normalizeLabel('  USB Audio CODEC  ')).toBe('usb audio codec');
  });
});

describe('chooseInput', () => {
  const none = { deviceId: null, label: null };

  it('preselects a USB-looking physical input on first run (not the default alias)', () => {
    expect(chooseInput(MAC_INPUTS, none)).toEqual({ device: MAC_INPUTS[2], by: 'usb', fellBack: false });
    const aliasFirst = [dev('default', 'Default - USB Audio CODEC (08bb:2902)'), ...MAC_INPUTS.slice(1)];
    expect(chooseInput(aliasFirst, none)?.device.deviceId).toBe('cubi');
  });

  it('matches labels like Cubilux / guitar / audio codec', () => {
    for (const label of ['Cubilux Guitar Link', 'Guitar Interface', 'Audio Codec', 'USB PnP Sound Device']) {
      expect(chooseInput([dev('mic', 'Built-in Microphone'), dev('x', label)], none)?.device.deviceId).toBe('x');
    }
  });

  it('uses the default alias, else the first input, when nothing looks like a guitar', () => {
    expect(chooseInput([dev('mic', 'Mic'), dev('default', 'Default - Mic')], none)).toEqual({
      device: dev('default', 'Default - Mic'),
      by: 'default',
      fellBack: false,
    });
    expect(chooseInput([dev('mic', 'Mic')], none)?.by).toBe('default');
    expect(chooseInput([], none)).toBeNull();
  });

  it('re-matches the saved device by id first', () => {
    const saved = { deviceId: 'zoom', label: 'something else' };
    expect(chooseInput(MAC_INPUTS, saved)).toEqual({ device: MAC_INPUTS[3], by: 'id', fellBack: false });
  });

  it('re-matches by label when Chrome rotated the id', () => {
    const rotated = MAC_INPUTS.map((d) => (d.deviceId === 'cubi' ? { ...d, deviceId: 'cubi-new' } : d));
    expect(chooseInput(rotated, { deviceId: 'cubi', label: 'USB Audio CODEC (08bb:2902)' })).toMatchObject({
      by: 'label',
      fellBack: false,
      device: { deviceId: 'cubi-new' },
    });
    // The USB id suffix changed (other port / firmware): normalised match.
    const relabelled = [dev('mic', 'Mic'), dev('c2', 'USB Audio CODEC (08bb:29c0)')];
    expect(chooseInput(relabelled, { deviceId: 'cubi', label: 'USB Audio CODEC (08bb:2902)' })?.device.deviceId).toBe('c2');
  });

  it('prefers the physical device over an alias with the same label', () => {
    const list = [dev('default', 'Default - USB Audio CODEC'), dev('cubi', 'USB Audio CODEC')];
    expect(findByLabel(list, 'USB Audio CODEC')?.deviceId).toBe('cubi');
    expect(findByLabel(list, 'Default - USB Audio CODEC')?.deviceId).toBe('default');
    expect(findByLabel(list, '')).toBeNull();
  });

  it('falls back (flagged) when the saved device is gone', () => {
    const unplugged = MAC_INPUTS.filter((d) => d.deviceId !== 'cubi');
    expect(chooseInput(unplugged, { deviceId: 'cubi', label: 'USB Audio CODEC (08bb:2902)' })).toEqual({
      device: unplugged[0],
      by: 'default',
      fellBack: true,
    });
    const otherUsb = [...unplugged, dev('focus', 'Scarlett Solo USB')];
    expect(chooseInput(otherUsb, { deviceId: 'cubi', label: 'USB Audio CODEC' })).toMatchObject({ by: 'usb', fellBack: true });
  });

  it('savedDevicePresent finds the saved device by id or label', () => {
    expect(savedDevicePresent(MAC_INPUTS, { deviceId: 'cubi', label: null })?.deviceId).toBe('cubi');
    expect(savedDevicePresent(MAC_INPUTS, { deviceId: 'gone', label: 'USB Audio CODEC (08bb:2902)' })?.deviceId).toBe('cubi');
    expect(savedDevicePresent(MAC_INPUTS, { deviceId: 'gone', label: 'Nope' })).toBeNull();
    expect(savedDevicePresent(MAC_INPUTS, { deviceId: null, label: null })).toBeNull();
  });
});

describe('constraints', () => {
  it('requests the device exactly as documented', () => {
    expect(inputConstraints('cubi')).toEqual({
      audio: {
        deviceId: { exact: 'cubi' },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 },
        latency: { ideal: 0 },
      },
      video: false,
    });
  });

  it('trusts only the read-back settings', () => {
    expect(
      readTrackSettings({ sampleRate: 44100, channelCount: 2, echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: 0.01 } as MediaTrackSettings),
    ).toEqual({ sampleRate: 44100, channelCount: 2, latency: 0.01, processingWarnings: [] });
    expect(readTrackSettings({ echoCancellation: true, autoGainControl: true })).toEqual({
      sampleRate: null,
      channelCount: 1,
      latency: null,
      processingWarnings: ['echoCancellation', 'autoGainControl'],
    });
  });

  it('words the processing warning', () => {
    expect(processingWarningText([])).toBeNull();
    expect(processingWarningText(['noiseSuppression'])).toMatch(/kept noise suppression on/);
    expect(processingWarningText(['echoCancellation', 'noiseSuppression', 'autoGainControl'])).toMatch(
      /echo cancellation, noise suppression and auto gain on/,
    );
  });

  it('analyses channel 0 of a mono track whatever the setting', () => {
    expect(effectiveChannel(1, 1)).toBe(0);
    expect(effectiveChannel('mix', 1)).toBe(0);
    expect(effectiveChannel(1, 2)).toBe(1);
    expect(effectiveChannel('mix', 4)).toBe('mix');
  });
});
