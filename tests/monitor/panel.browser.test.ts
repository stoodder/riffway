/**
 * Monitoring panel in Chromium with fake services: status, headphone card, guard banners, presets,
 * knobs, latency display; screenshots of the default and warning states go to
 * `test-results/monitor/` (gitignored) for visual review.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/design';
import type { AmpParams } from '@shared/audio-events';
import type { Unsubscribe } from '@shared/clock';
import type { InputOpenResult, InputService, LatencyEstimate, MonitorGuardEvent, MonitorService } from '@shared/services';
import type { AmpPresetId, DeepPartial, Settings } from '@shared/settings';
import type { AppContext, PanelHandle } from '@shared/ui';
import { AMP_LATENCY_SAMPLES, AMP_PRESETS } from '@core/dsp/amp';
import { estimateMonitorLatency } from '../../src/audio/monitor/latency';
import { AudioGestureDismissedError } from '../../src/ui/shell/audio-gesture';
import { mount, monitorStatus } from '../../src/ui/panels/monitor';
import { memorySettings } from './helpers';

class FakeMonitor implements MonitorService {
  guardCbs = new Set<(ev: MonitorGuardEvent) => void>();
  params: Partial<AmpParams>[] = [];
  enabledCalls: boolean[] = [];
  allowed: [string, boolean][] = [];
  outputLatency = 0.012;
  constructor(private readonly settings: ReturnType<typeof memorySettings>) {}
  get enabled(): boolean {
    return this.settings.get().monitor.enabled;
  }
  async setEnabled(on: boolean): Promise<void> {
    this.enabledCalls.push(on);
    await this.settings.update({ monitor: { enabled: on } });
  }
  setPreset(preset: AmpPresetId): void {
    const p = AMP_PRESETS[preset].amp;
    void this.settings.update({ monitor: { preset, drive: p.drive, tone: { low: p.low, mid: p.mid, high: p.high }, level: p.level } });
  }
  setParams(params: Partial<AmpParams>): void {
    this.params.push(params);
  }
  latency(): LatencyEstimate {
    const s = this.settings.get();
    return estimateMonitorLatency({
      inputLatencySec: null,
      baseLatencySec: 0.0027,
      outputLatencySec: this.outputLatency,
      sampleRate: 48000,
      dspSamples: AMP_PRESETS[s.monitor.preset].amp.bypass ? 0 : AMP_LATENCY_SAMPLES,
      calibration: s.calibration,
    });
  }
  async allowSpeakers(sinkId: string, allow: boolean): Promise<void> {
    this.allowed.push([sinkId, allow]);
    this.emit({ type: 'restored' });
  }
  onGuard(cb: (ev: MonitorGuardEvent) => void): Unsubscribe {
    this.guardCbs.add(cb);
    return () => this.guardCbs.delete(cb);
  }
  emit(ev: MonitorGuardEvent): void {
    for (const cb of this.guardCbs) cb(ev);
  }
}

function fakeInput(label = 'Scarlett Solo USB'): InputService {
  const current: InputOpenResult = {
    device: { deviceId: 'usb', label, groupId: 'g', kind: 'audioinput' },
    sampleRate: 48000,
    channelCount: 2,
    latency: null,
    processingWarnings: [],
    fellBackToDefault: false,
  };
  const node = {} as AudioNode;
  const none = (): Unsubscribe => () => undefined;
  return {
    listInputs: async () => [],
    listOutputs: async () => [],
    open: async () => current,
    close: () => undefined,
    current,
    getInputNode: () => node,
    onInput: none,
    onAnalysis: none,
    expect: () => undefined,
    setTunerMode: () => undefined,
    onDevicesChanged: none,
  };
}

interface Harness {
  host: HTMLElement;
  handle: PanelHandle<Record<string, never>>;
  monitor: FakeMonitor;
  settings: ReturnType<typeof memorySettings>;
  toasts: string[];
  gesture: { reject: boolean };
}

const mounted: Harness[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    m.handle.unmount();
    m.host.remove();
  }
});

async function setup(initial: DeepPartial<Settings> = {}, inputLabel?: string): Promise<Harness> {
  const settings = memorySettings(initial);
  const monitor = new FakeMonitor(settings);
  const input = fakeInput(inputLabel);
  const toasts: string[] = [];
  const gesture = { reject: false };
  const ctx = {
    settings,
    services: {
      get: async (id: string) => (id === 'monitor' ? monitor : input),
      peek: () => null,
    },
    ui: {
      toast: (m: string) => void toasts.push(m),
      confirm: async () => true,
      requireAudioGesture: async () => {
        if (gesture.reject) throw new AudioGestureDismissedError();
      },
    },
  } as unknown as AppContext;
  const host = document.createElement('div');
  host.style.cssText = 'width: 640px; padding: 24px; background: var(--color-bg); font-family: var(--font-sans);';
  document.body.append(host);
  const handle = await mount(host, ctx, {});
  const h: Harness = { host, handle, monitor, settings, toasts, gesture };
  mounted.push(h);
  return h;
}

const q = <T extends Element = HTMLElement>(root: ParentNode, sel: string): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};
const visible = (el: HTMLElement): boolean => !el.hidden && el.getClientRects().length > 0;

describe('monitorStatus', () => {
  it('explains why the monitor is silent', () => {
    const base = { enabled: true, hasInput: true, speakerMuted: false, feedback: false };
    expect(monitorStatus(base)).toBe('live');
    expect(monitorStatus({ ...base, enabled: false, feedback: true })).toBe('off');
    expect(monitorStatus({ ...base, feedback: true, speakerMuted: true })).toBe('feedback');
    expect(monitorStatus({ ...base, speakerMuted: true })).toBe('speaker-muted');
    expect(monitorStatus({ ...base, hasInput: false })).toBe('no-input');
  });
});

describe('monitoring panel', () => {
  it('renders the default state: live, headphone card, Clean preset, estimated latency with parts', async () => {
    await page.viewport(720, 1100);
    const { host } = await setup();
    const root = q(host, '.rw-monitor');
    expect(root.dataset.status).toBe('live');
    expect(visible(q(root, '.rw-monitor__phones'))).toBe(true);
    expect(root.textContent).toContain('Are you wearing headphones?');
    // One headphone message only (R2-U-10): no "Headphones recommended" toggle subtitle.
    expect(root.textContent).not.toContain('Headphones recommended');
    expect(q(root, '[data-preset="clean"]').getAttribute('aria-checked')).toBe('true');
    expect(q(root, '.rw-monitor__lat-total').textContent).toMatch(/^\d+(\.\d)? ms$/);
    const lat = q(root, '.rw-monitor__latency');
    expect(lat.textContent).toContain('estimated');
    expect(lat.textContent).toContain('Input');
    expect(lat.textContent).toContain('Processing');
    expect(lat.textContent).toContain('Output');
    expect(lat.textContent).toContain('(assumed)'); // input latency not reported by the fake input
    expect(lat.textContent).toContain('A loopback calibration');
    expect(lat.dataset.kind).toBe('estimated');
    expect(lat.dataset.band).toBe('playable');
    expect(visible(q(root, '.rw-monitor__banner--warning'))).toBe(false);
    expect(visible(q(root, '.rw-monitor__banner--danger'))).toBe(false);
    await page.screenshot({ element: host, path: '../../test-results/monitor/panel-default.png' });
  });

  it('shows the speaker banner and "Turn on anyway" allows the current sink', async () => {
    await page.viewport(720, 1100);
    const { host, monitor } = await setup({ monitor: { headphonesCardSeen: true }, output: { sinkId: 'spk' } });
    monitor.emit({ type: 'speaker-muted', sinkLabel: 'MacBook Pro Speakers' });
    const root = q(host, '.rw-monitor');
    const banner = q(root, '.rw-monitor__banner--warning');
    expect(visible(banner)).toBe(true);
    expect(banner.textContent).toContain('Monitoring is off on laptop speakers');
    expect(banner.textContent).toContain('MacBook Pro Speakers');
    expect(root.dataset.status).toBe('speaker-muted');
    expect(visible(q(root, '.rw-monitor__phones'))).toBe(false);
    await page.screenshot({ element: host, path: '../../test-results/monitor/panel-speakers.png' });
    q<HTMLButtonElement>(banner, 'button').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(monitor.allowed).toEqual([['spk', true]]);
    expect(visible(banner)).toBe(false);
    expect(root.dataset.status).toBe('live');
  });

  it('shows the feedback banner and re-enables monitoring from it', async () => {
    const { host, monitor } = await setup();
    monitor.emit({ type: 'feedback-ducked' });
    const root = q(host, '.rw-monitor');
    const banner = q(root, '.rw-monitor__banner--danger');
    expect(visible(banner)).toBe(true);
    expect(banner.textContent).toContain('Feedback detected — monitoring lowered');
    q<HTMLButtonElement>(banner, 'button').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(monitor.enabledCalls).toEqual([true]);
    expect(visible(banner)).toBe(false);
  });

  it('the switch asks for the audio gesture and survives a dismissal', async () => {
    const { host, monitor, settings, gesture, toasts } = await setup({ monitor: { enabled: false } });
    const root = q(host, '.rw-monitor');
    expect(root.dataset.status).toBe('off');
    const sw = q<HTMLButtonElement>(root, '.rw-switch');
    gesture.reject = true;
    sw.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(monitor.enabledCalls).toEqual([]);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(toasts).toEqual([]);
    gesture.reject = false;
    sw.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(monitor.enabledCalls).toEqual([true]);
    expect(settings.get().monitor.enabled).toBe(true);
    expect(root.dataset.status).toBe('live');
  });

  it('presets and knobs drive the service; DI disables the knobs', async () => {
    const { host, monitor, settings } = await setup();
    const root = q(host, '.rw-monitor');
    q<HTMLButtonElement>(root, '[data-preset="overdrive"]').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(settings.get().monitor.preset).toBe('overdrive');
    expect(q(root, '[data-preset="overdrive"]').getAttribute('aria-checked')).toBe('true');
    expect(root.textContent).toContain('overdrive'); // drive character readout
    const sliders = root.querySelectorAll<HTMLInputElement>('.rw-monitor__knobs input[type="range"]');
    expect(sliders).toHaveLength(5);
    const drive = sliders[0]!;
    drive.value = '14';
    drive.dispatchEvent(new Event('change'));
    expect(monitor.params.at(-1)!.drive).toBeCloseTo(10 ** (14 / 20), 6);
    const mid = sliders[2]!;
    mid.value = '-3';
    mid.dispatchEvent(new Event('change'));
    expect(monitor.params.at(-1)).toEqual({ mid: -3 });
    // Arrow keys move through the presets (radio group).
    const od = q<HTMLButtonElement>(root, '[data-preset="overdrive"]');
    expect(od.tabIndex).toBe(0); // the checked radio is the tab stop
    od.focus();
    od.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(settings.get().monitor.preset).toBe('di');
    for (const s of sliders) expect(s.disabled).toBe(true);
  });

  it('shows the calibrated offset, flags a noticeable delay with tips, and notes a built-in mic', async () => {
    await page.viewport(720, 1300);
    const { host, monitor, settings } = await setup(
      { monitor: { headphonesCardSeen: true }, calibration: { method: 'play-to-click', inputOffsetMs: 52 } },
      'MacBook Pro Microphone',
    );
    monitor.outputLatency = 0.04;
    await settings.update({}); // re-render
    const root = q(host, '.rw-monitor');
    const lat = q(root, '.rw-monitor__latency');
    expect(lat.dataset.band).toBe('noticeable');
    expect(lat.textContent).toContain('Calibrated offset ≈ 52 ms');
    expect(q<HTMLDetailsElement>(lat, 'details').open).toBe(true);
    expect(lat.textContent).toContain('headphones');
    expect(visible(q(root, '.rw-monitor__note'))).toBe(true);
    await page.screenshot({ element: host, path: '../../test-results/monitor/panel-noticeable.png' });
  });

  it('turns monitoring on from the headphone check, and warns about built-in speakers there', async () => {
    const { host, monitor, settings } = await setup({ monitor: { enabled: false }, output: { sinkId: 'spk', label: 'MacBook Pro Speakers' } });
    const card = q(host, '.rw-monitor__phones');
    expect(visible(card)).toBe(true);
    expect(visible(q(card, '.rw-monitor__phones-speakers'))).toBe(true);
    const on = Array.from(card.querySelectorAll('button')).find((b) => b.textContent?.includes('wearing headphones')) as HTMLButtonElement;
    on.click();
    await expect.poll(() => monitor.enabledCalls).toEqual([true]);
    expect(settings.get().monitor.headphonesCardSeen).toBe(true);
    await expect.poll(() => visible(card)).toBe(false);
  });

  it('"Not now" dismisses the headphone check and leaves monitoring off', async () => {
    const { host, monitor, settings } = await setup({ monitor: { enabled: false } });
    const card = q(host, '.rw-monitor__phones');
    expect(visible(q(card, '.rw-monitor__phones-speakers'))).toBe(false);
    (Array.from(card.querySelectorAll('button')).find((b) => b.textContent === 'Not now') as HTMLButtonElement).click();
    await expect.poll(() => settings.get().monitor.headphonesCardSeen).toBe(true);
    expect(monitor.enabledCalls).toEqual([]);
    expect(settings.get().monitor.enabled).toBe(false);
  });

  it('shows the measured monitoring delay when a loopback calibration exists (R2-S-10)', async () => {
    const key = 'Scarlett Solo USB → Headphones';
    const { host } = await setup({
      monitor: { headphonesCardSeen: true },
      calibration: {
        method: 'loopback',
        inputOffsetMs: 14,
        deviceKey: key,
        profiles: {
          [key]: {
            inputLabel: 'Scarlett Solo USB',
            outputLabel: 'Headphones',
            inputOffsetMs: 14,
            method: 'loopback',
            measuredAt: 1,
            spreadMs: 1,
            keyboardOffsetMs: 0,
            keyboardMeasuredAt: null,
            keyboardSpreadMs: null,
            visualOffsetMs: 0,
            loopbackMs: 9.5,
            loopbackAt: 1,
          },
        },
      },
    });
    const lat = q(host, '.rw-monitor__latency');
    expect(lat.dataset.kind).toBe('measured');
    expect(lat.textContent).toContain('measured');
    expect(lat.textContent).toContain('Measured: the loopback round trip');
    const dspMs = (AMP_LATENCY_SAMPLES / 48000) * 1000;
    const total = 9.5 + dspMs;
    expect(q(lat, '.rw-monitor__lat-total').textContent).toBe(`${total < 10 ? total.toFixed(1) : Math.round(total)} ms`);
    expect(lat.dataset.band).toBe('great');
  });

  it('unmount removes the panel and its subscriptions', async () => {
    const h = await setup();
    h.handle.unmount();
    expect(h.host.querySelector('.rw-monitor')).toBeNull();
    expect(h.monitor.guardCbs.size).toBe(0);
    mounted.splice(mounted.indexOf(h), 1);
    h.host.remove();
  });
});
