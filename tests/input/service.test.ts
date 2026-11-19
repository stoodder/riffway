/**
 * Input service logic against fake media devices, engine and worklet graph (T-022): label unlock,
 * USB preselect + persistence, constraint read-back, sample-rate matching, event bridge (ctx seconds,
 * calibrated judge events), commands, unplug / re-plug, fallback and context recreation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InputEvent } from '@shared/judge';
import type { TimedAnalysisEvent } from '@shared/services';
import { DEVICE_CHANGE_DEBOUNCE_MS, createInputServiceWith, type DisposableInputService } from '../../src/audio/input/service';
import { FakeEngine, FakeMediaDevices, fakeDeps, memorySettings, type FakeDevice } from './fakes';

const MIC: FakeDevice = { deviceId: 'mic', label: 'MacBook Pro Microphone', kind: 'audioinput' };
const DEFAULT: FakeDevice = { deviceId: 'default', label: 'Default - MacBook Pro Microphone', kind: 'audioinput' };
const CUBI: FakeDevice = {
  deviceId: 'cubi',
  label: 'USB Audio CODEC (08bb:2902)',
  kind: 'audioinput',
  settings: { sampleRate: 44100, channelCount: 2, echoCancellation: false, noiseSuppression: true, autoGainControl: false, latency: 0.0058 } as MediaTrackSettings,
};
const SPEAKERS: FakeDevice = { deviceId: 'spk', label: 'MacBook Pro Speakers', kind: 'audiooutput' };

let media: FakeMediaDevices;
let engine: FakeEngine;
let deps: ReturnType<typeof fakeDeps>;
let settings: ReturnType<typeof memorySettings>;
let svc: DisposableInputService;

function make(devices: FakeDevice[], initial: Parameters<typeof memorySettings>[0] = {}): void {
  media = new FakeMediaDevices(devices);
  engine = new FakeEngine(48000);
  deps = fakeDeps(media);
  settings = memorySettings(initial);
  svc = createInputServiceWith(engine.asEngine(), settings, deps);
}

afterEach(() => {
  svc.dispose();
  vi.useRealTimers();
});

describe('opening the input', () => {
  beforeEach(() => make([DEFAULT, MIC, CUBI, SPEAKERS]));

  it('unlocks labels, preselects the USB cable and opens it with the documented constraints', async () => {
    expect((await svc.listInputs()).every((d) => d.label === '')).toBe(true);
    const res = await svc.open();
    expect(media.requests[0]).toEqual({ audio: true, video: false });
    expect(media.streams[0].track.stopped).toBe(true);
    expect(media.requests[1]).toMatchObject({
      audio: { deviceId: { exact: 'cubi' }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    expect(res).toEqual({
      device: { deviceId: 'cubi', label: CUBI.label, groupId: '', kind: 'audioinput' },
      sampleRate: 44100,
      channelCount: 2,
      latency: 0.0058,
      processingWarnings: ['noiseSuppression'],
      fellBackToDefault: false,
    });
    expect(svc.current).toBe(res);
    expect(settings.get().input).toEqual({ deviceId: 'cubi', label: CUBI.label, channel: 0 });
  });

  it('matches the engine to the track sample rate and builds the graph on the new context', async () => {
    await svc.open();
    expect(engine.ctx.sampleRate).toBe(44100);
    expect(deps.graphs).toHaveLength(1);
    expect(deps.graphs[0].ctx).toBe(engine.ctx);
    expect(deps.graphs[0].opts).toEqual({ channel: 0, tuner: false });
    expect(svc.getInputNode()).toBe(deps.graphs[0].source);
  });

  it('opens a requested device and rejects one that is not connected', async () => {
    await svc.open();
    const res = await svc.open('mic');
    expect(res.device.deviceId).toBe('mic');
    expect(media.streams[1].track.stopped).toBe(true);
    expect(deps.graphs[0].disposed).toBe(true);
    expect(settings.get().input.deviceId).toBe('mic');
    await expect(svc.open('nope')).rejects.toThrow(/not connected/);
  });

  it('falls back to the default input when the auto choice cannot be opened', async () => {
    media.granted = true;
    media.failNext = Object.assign(new Error('gone'), { name: 'OverconstrainedError' });
    const res = await svc.open();
    expect(res.device.deviceId).toBe('default');
    expect(res.fellBackToDefault).toBe(true);
    expect(settings.get().input.deviceId).toBeNull();
  });

  it('passes permission errors through', async () => {
    media.failNext = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    await expect(svc.open()).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(svc.current).toBeNull();
  });

  it('lists outputs', async () => {
    media.granted = true;
    expect((await svc.listOutputs()).map((d) => d.deviceId)).toEqual(['spk']);
  });
});

describe('event bridge and commands', () => {
  beforeEach(async () => {
    make([MIC, CUBI], { calibration: { inputOffsetMs: 20 } });
    await svc.open();
  });

  it('converts frames to context seconds and applies the calibrated offset for the judge', () => {
    const analysis: TimedAnalysisEvent[] = [];
    const inputs: InputEvent[] = [];
    svc.onAnalysis((e) => analysis.push(e));
    svc.onInput((e) => inputs.push(e));
    const port = deps.graphs[0].port;
    port.emit({ type: 'level', frame: 44100, peakDb: -12, rmsDb: -20 });
    port.emit({ type: 'onset', frame: 88200, midi: null, cents: 0, clarity: 0.4, rmsDb: -18 });
    port.emit({ type: 'pitch', frame: 89000, onsetFrame: 88200, midi: 45, cents: -3, clarity: 0.9 });
    port.emit({ type: 'pitch-change', frame: 132300, midi: 47, cents: 2, clarity: 0.95 });
    port.emit({ type: 'tuner', frame: 22050, freq: 110, clarity: 0.99 });
    expect(analysis.map((e) => [e.type, e.ctxTime])).toEqual([
      ['level', 1],
      ['onset', 2],
      ['pitch', 89000 / 44100],
      ['pitch-change', 3],
      ['tuner', 0.5],
    ]);
    expect(inputs).toEqual([
      { ctxTime: 1.98, kind: 'onset', clarity: 0.4, source: 'guitar' },
      { ctxTime: 1.98, kind: 'onset', midi: 45, cents: -3, clarity: 0.9, source: 'guitar', refines: 1.98 },
      { ctxTime: 2.98, kind: 'pitch-change', midi: 47, cents: 2, clarity: 0.95, source: 'guitar' },
    ]);
  });

  it('isolates a throwing listener', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const got: string[] = [];
    svc.onAnalysis(() => {
      throw new Error('boom');
    });
    svc.onAnalysis((e) => got.push(e.type));
    deps.graphs[0].port.emit({ type: 'level', frame: 0, peakDb: -60, rmsDb: -70 });
    expect(got).toEqual(['level']);
    expect(errors).toHaveBeenCalled();
  });

  it('forwards expect hints, tuner mode and channel changes to the worklet', async () => {
    const port = deps.graphs[0].port;
    svc.expect({ minMidi: 40, maxMidi: 52 });
    svc.setTunerMode(true);
    await settings.update({ input: { channel: 1 } });
    await settings.update({ tuner: { a4: 442 } });
    svc.expect(null);
    expect(port.sent).toEqual([
      { type: 'expect', range: { minMidi: 40, maxMidi: 52 } },
      { type: 'config', channel: 0, tuner: true },
      { type: 'config', channel: 1, tuner: true },
      { type: 'expect', range: null },
    ]);
  });

  it('re-sends the expect hint and tuner mode to a rebuilt graph', async () => {
    svc.expect({ minMidi: 60, maxMidi: 70 });
    svc.setTunerMode(true);
    await engine.setSampleRate(48000);
    await vi.waitFor(() => expect(deps.graphs).toHaveLength(2));
    await vi.waitFor(() => expect(svc.getInputNode()).toBe(deps.graphs[1].source));
    expect(deps.graphs[0].disposed).toBe(true);
    expect(deps.graphs[1].ctx.sampleRate).toBe(48000);
    expect(deps.graphs[1].opts).toEqual({ channel: 0, tuner: true });
    expect(deps.graphs[1].port.sent).toEqual([{ type: 'expect', range: { minMidi: 60, maxMidi: 70 } }]);
  });
});

describe('unplug, re-plug and fallback', () => {
  it('closes on unplug and re-opens when the saved device comes back', async () => {
    vi.useFakeTimers();
    make([MIC, CUBI]);
    const changes = vi.fn();
    svc.onDevicesChanged(changes);
    await svc.open();
    expect(changes).toHaveBeenCalledTimes(1);

    media.devices = [MIC];
    media.streams[1].track.end();
    expect(svc.current).toBeNull();
    expect(svc.getInputNode()).toBeNull();
    expect(deps.graphs[0].disposed).toBe(true);
    expect(changes).toHaveBeenCalledTimes(2);
    media.setDevices([MIC]);
    await vi.advanceTimersByTimeAsync(DEVICE_CHANGE_DEBOUNCE_MS + 10);
    expect(svc.current).toBeNull();
    expect(changes).toHaveBeenCalledTimes(3);

    // Re-plugged with a rotated id: matched by label, re-opened automatically.
    const back = { ...CUBI, deviceId: 'cubi-2' };
    media.setDevices([MIC, back]);
    media.setDevices([MIC, back]);
    await vi.advanceTimersByTimeAsync(DEVICE_CHANGE_DEBOUNCE_MS + 10);
    expect(svc.current?.device.deviceId).toBe('cubi-2');
    expect(svc.current?.fellBackToDefault).toBe(false);
    expect(settings.get().input.deviceId).toBe('cubi-2');
  });

  it('opens a flagged fallback when the saved input is missing, then switches back', async () => {
    vi.useFakeTimers();
    make([DEFAULT, MIC], { input: { deviceId: 'cubi', label: CUBI.label, channel: 0 } });
    const res = await svc.open();
    expect(res.fellBackToDefault).toBe(true);
    expect(res.device.deviceId).toBe('default');
    expect(settings.get().input.deviceId).toBe('cubi');
    media.setDevices([DEFAULT, MIC, CUBI]);
    await vi.advanceTimersByTimeAsync(DEVICE_CHANGE_DEBOUNCE_MS + 10);
    expect(svc.current?.device.deviceId).toBe('cubi');
    expect(svc.current?.fellBackToDefault).toBe(false);
  });

  it('drops an input whose device disappeared without ending the track', async () => {
    vi.useFakeTimers();
    make([MIC, CUBI]);
    await svc.open();
    media.setDevices([MIC]);
    await vi.advanceTimersByTimeAsync(DEVICE_CHANGE_DEBOUNCE_MS + 10);
    expect(svc.current).toBeNull();
    expect(media.streams[1].track.stopped).toBe(true);
  });

  it('does not re-open after close()', async () => {
    vi.useFakeTimers();
    make([MIC, CUBI]);
    await svc.open();
    svc.close();
    expect(svc.current).toBeNull();
    media.setDevices([MIC, CUBI]);
    await vi.advanceTimersByTimeAsync(DEVICE_CHANGE_DEBOUNCE_MS + 10);
    expect(svc.current).toBeNull();
    expect(media.requests).toHaveLength(2);
  });
});
