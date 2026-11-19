// @vitest-environment happy-dom
/**
 * Input and tuner panels (T-022) mounted with the real input service over fake devices / engine /
 * worklet port: connect flow, device + channel + output pickers, warnings, unplug, level meter,
 * tuner readout for Drop D, A4 setting, tuner mode on/off.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext, ServiceMap } from '@shared/ui';
import { createInputServiceWith, type DisposableInputService } from '../../src/audio/input/service';
import { mount as mountInput } from '../../src/ui/panels/input';
import { mount as mountTuner } from '../../src/ui/panels/tuner';
import { midiToHz } from '../helpers/signals';
import { FakeEngine, FakeMediaDevices, fakeDeps, memorySettings, type FakeDevice } from './fakes';

const MIC: FakeDevice = { deviceId: 'mic', label: 'MacBook Pro Microphone', kind: 'audioinput' };
const CUBI: FakeDevice = {
  deviceId: 'cubi',
  label: 'USB Audio CODEC (08bb:2902)',
  kind: 'audioinput',
  settings: { sampleRate: 44100, channelCount: 2, noiseSuppression: true, latency: 0.0058 } as MediaTrackSettings,
};
const PHONES: FakeDevice = { deviceId: 'phones', label: 'External Headphones', kind: 'audiooutput' };
const DROP_D = [64, 59, 55, 50, 45, 38];

interface Rig {
  ctx: AppContext;
  media: FakeMediaDevices;
  engine: FakeEngine;
  deps: ReturnType<typeof fakeDeps>;
  settings: ReturnType<typeof memorySettings>;
  input: DisposableInputService;
  toast: ReturnType<typeof vi.fn>;
  host: HTMLElement;
}

const rigs: Rig[] = [];

function rig(devices: FakeDevice[] = [MIC, CUBI, PHONES], initial: Parameters<typeof memorySettings>[0] = {}): Rig {
  const media = new FakeMediaDevices(devices);
  const engine = new FakeEngine();
  const deps = fakeDeps(media);
  const settings = memorySettings(initial);
  const input = createInputServiceWith(engine.asEngine(), settings, deps);
  const toast = vi.fn();
  const services = { engine: engine.asEngine(), input } as Partial<ServiceMap>;
  const ctx = {
    settings,
    services: { get: async (id: keyof ServiceMap) => services[id], peek: (id: keyof ServiceMap) => services[id] ?? null },
    ui: { toast, confirm: async () => true, requireAudioGesture: async () => undefined },
  } as unknown as AppContext;
  const host = document.createElement('div');
  document.body.append(host);
  const r = { ctx, media, engine, deps, settings, input, toast, host };
  rigs.push(r);
  return r;
}

/** Microphone permission state reported by `navigator.permissions.query`. */
function permission(state: PermissionState): void {
  vi.spyOn(navigator.permissions, 'query').mockResolvedValue({ state } as PermissionStatus);
}

const flush = (ms = 40): Promise<void> => new Promise((res) => setTimeout(res, ms));
const $ = <T extends Element = HTMLElement>(root: ParentNode, sel: string): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};
const visibleNotices = (root: ParentNode): string[] => Array.from(root.querySelectorAll<HTMLElement>('[data-notice]')).map((n) => n.dataset.notice!);

afterEach(() => {
  vi.restoreAllMocks();
  for (const r of rigs.splice(0)) {
    r.input.dispose();
    r.host.remove();
  }
});

describe('input panel', () => {
  it('connects, lists devices and shows the read-back and warnings', async () => {
    permission('prompt');
    const r = rig();
    const handle = await mountInput(r.host, r.ctx, {});
    const connect = $<HTMLButtonElement>(r.host, '.rw-input__connect button');
    expect($(r.host, '.rw-input__live').hidden).toBe(true);
    expect($(r.host, '.rw-input__status').textContent).toBe('Not connected');
    connect.click();
    await vi.waitFor(() => expect($(r.host, '.rw-input__status').textContent).toBe('Listening'));
    expect($(r.host, '.rw-input__connect').hidden).toBe(true);
    const selects = r.host.querySelectorAll<HTMLSelectElement>('select');
    const [device, channel, output] = Array.from(selects);
    expect(Array.from(device.options).map((o) => o.textContent)).toEqual(['MacBook Pro Microphone', 'USB Audio CODEC (08bb:2902)']);
    expect(device.value).toBe('cubi');
    expect((channel.closest('.rw-field') as HTMLElement).hidden).toBe(false);
    expect(Array.from(output.options).map((o) => o.value)).toEqual(['', 'phones']);
    expect($(r.host, '.rw-input__details').textContent).toBe('44.1 kHz · 2 channels · input latency 6 ms');
    expect(visibleNotices(r.host)).toEqual(['processing']);
    expect($(r.host, '[data-notice="processing"]').textContent).toMatch(/noise suppression/);
    handle.unmount();
    expect(r.host.children).toHaveLength(0);
  });

  it('moves the meter from level events and lights the clip lamp', async () => {
    const r = rig();
    await r.input.open();
    const handle = await mountInput(r.host, r.ctx, {});
    r.deps.graphs[0].port.emit({ type: 'level', frame: 0, peakDb: -0.2, rmsDb: -8 });
    await flush();
    const track = $(r.host, '[role="meter"]');
    expect(Number(track.getAttribute('aria-valuenow'))).toBeGreaterThan(-2);
    expect($(r.host, '.rw-input__clip').classList.contains('is-on')).toBe(true);
    handle.unmount();
  });

  it('saves channel and output choices', async () => {
    const r = rig();
    await r.input.open();
    const handle = await mountInput(r.host, r.ctx, {});
    await flush();
    const [, channel, output] = Array.from(r.host.querySelectorAll<HTMLSelectElement>('select'));
    channel.value = 'mix';
    channel.dispatchEvent(new Event('change'));
    output.value = 'phones';
    output.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(r.settings.get().output).toEqual({ sinkId: 'phones', label: 'External Headphones' }));
    expect(r.settings.get().input.channel).toBe('mix');
    expect(r.engine.sinkId).toBe('phones');
    expect(r.deps.graphs[0].port.sent).toContainEqual({ type: 'config', channel: 'mix', tuner: false });
    handle.unmount();
  });

  it('switches input from the picker', async () => {
    const r = rig();
    await r.input.open();
    const handle = await mountInput(r.host, r.ctx, {});
    await flush();
    const device = r.host.querySelector('select')!;
    device.value = 'mic';
    device.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(r.input.current?.device.deviceId).toBe('mic'));
    await vi.waitFor(() => expect((r.host.querySelectorAll('select')[1].closest('.rw-field') as HTMLElement).hidden).toBe(true));
    handle.unmount();
  });

  it('warns when the saved input is missing, and when the input is unplugged', async () => {
    const r = rig([MIC, PHONES], { input: { deviceId: 'cubi', label: CUBI.label, channel: 0 } });
    await r.input.open();
    const handle = await mountInput(r.host, r.ctx, {});
    await flush();
    expect(visibleNotices(r.host)).toEqual(['fallback']);
    expect($(r.host, '[data-notice="fallback"]').textContent).toMatch(/wasn’t found \(USB Audio CODEC/);
    r.media.streams[r.media.streams.length - 1].track.end();
    await vi.waitFor(() => expect($(r.host, '.rw-input__status').textContent).toBe('Disconnected'));
    expect(visibleNotices(r.host)).toEqual(['disconnected']);
    handle.unmount();
  });

  it('re-opens the saved input on mount when permission was granted before', async () => {
    permission('granted');
    const r = rig([MIC, CUBI], { input: { deviceId: 'cubi', label: CUBI.label, channel: 0 } });
    const handle = await mountInput(r.host, r.ctx, {});
    expect(r.input.current?.device.deviceId).toBe('cubi');
    expect($(r.host, '.rw-input__status').textContent).toBe('Listening');
    handle.unmount();
  });

  it('shows a readable error when microphone access is blocked', async () => {
    permission('prompt');
    const r = rig();
    r.media.failNext = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const handle = await mountInput(r.host, r.ctx, {});
    $<HTMLButtonElement>(r.host, '.rw-input__connect button').click();
    await vi.waitFor(() => expect(visibleNotices(r.host)).toEqual(['error']));
    expect($(r.host, '[data-notice="error"]').textContent).toMatch(/Microphone access is blocked/);
    handle.unmount();
  });
});

describe('tuner panel', () => {
  const tunerFrames = (r: Rig, freq: number, fromSec: number, sec: number): void => {
    const port = r.deps.graphs[r.deps.graphs.length - 1].port;
    const sr = r.engine.ctx.sampleRate;
    for (let t = fromSec; t < fromSec + sec; t += 2048 / sr) port.emit({ type: 'tuner', frame: Math.round(t * sr), freq, clarity: 0.99 });
  };

  it('shows the song tuning and turns tuner mode on and off', async () => {
    const r = rig();
    await r.input.open();
    const handle = await mountTuner(r.host, r.ctx, { tuning: DROP_D });
    expect($(r.host, '.rw-card__aside').textContent).toBe('Drop D');
    expect(Array.from(r.host.querySelectorAll('.rw-tuner__string')).map((li) => li.textContent)).toEqual(['6D2', '5A2', '4D3', '3G3', '2B3', '1E4']);
    expect(r.deps.graphs[0].port.sent).toContainEqual({ type: 'config', channel: 0, tuner: true });
    expect($(r.host, '.rw-tuner__connect').hidden).toBe(true);
    handle.unmount();
    expect(r.deps.graphs[0].port.sent.at(-1)).toEqual({ type: 'config', channel: 0, tuner: false });
  });

  it('guides the low E down to D and celebrates when in tune', async () => {
    const r = rig();
    await r.input.open();
    const handle = await mountTuner(r.host, r.ctx, { tuning: DROP_D });
    tunerFrames(r, midiToHz(40), 0, 0.3);
    expect($(r.host, '.rw-tuner__name').textContent).toBe('E');
    expect($(r.host, '.rw-tuner__oct').textContent).toBe('2');
    expect($(r.host, '.rw-tuner__hint').textContent).toBe('Tune down to D2 (2 semitones)');
    const low = $(r.host, '.rw-tuner__string[data-string="6"]');
    expect(low.classList.contains('is-target')).toBe(true);
    expect(low.dataset.direction).toBe('down');
    tunerFrames(r, midiToHz(38) * 2 ** (1 / 1200), 1, 0.8);
    expect($(r.host, '.rw-tuner__stage').dataset.state).toBe('in-tune');
    expect($(r.host, '.rw-tuner__hint').textContent).toBe('String 6 in tune');
    expect($(r.host, '.rw-tuner__cents').textContent).toBe('+1 ¢');
    expect(low.classList.contains('is-done')).toBe(true);
    handle.unmount();
  });

  it('adjusts and persists A4, and follows tuning updates', async () => {
    const r = rig();
    await r.input.open();
    const handle = await mountTuner(r.host, r.ctx, {});
    expect($(r.host, '.rw-card__aside').textContent).toBe('Standard');
    const [down, up] = Array.from(r.host.querySelectorAll<HTMLButtonElement>('.rw-tuner__step'));
    up.click();
    up.click();
    down.click();
    await flush();
    expect(r.settings.get().tuner.a4).toBe(441);
    expect($(r.host, '.rw-tuner__a4-value').textContent).toBe('441 Hz');
    tunerFrames(r, 441, 0, 0.8);
    expect($(r.host, '.rw-tuner__name').textContent).toBe('A');
    expect($(r.host, '.rw-tuner__cents').textContent).toBe('0 ¢');
    handle.update?.({ tuning: DROP_D });
    expect($(r.host, '.rw-card__aside').textContent).toBe('Drop D');
    handle.unmount();
  });

  it('offers to connect when there is no input', async () => {
    const r = rig();
    const handle = await mountTuner(r.host, r.ctx, {});
    expect($(r.host, '.rw-tuner__connect').hidden).toBe(false);
    $<HTMLButtonElement>(r.host, '.rw-tuner__connect button').click();
    await vi.waitFor(() => expect($(r.host, '.rw-tuner__connect').hidden).toBe(true));
    expect(r.deps.graphs[0].opts.tuner).toBe(true);
    handle.unmount();
  });
});
