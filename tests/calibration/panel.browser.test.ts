/**
 * Calibration panel in Chromium on a real engine (real clicks on a running AudioContext) with a
 * scripted guitar input: summary states, a full play-to-click run at the documented 90 BPM plan,
 * failure + "estimated" fallback, keyboard taps, loopback (monitoring paused), the visual offset,
 * per-device note and cleanup. Screenshots go to `test-results/calibration/` (gitignored).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/design';
import type { Unsubscribe } from '@shared/clock';
import type { AudioEngine, InputOpenResult, InputService, MonitorService, TimedAnalysisEvent } from '@shared/services';
import type { DeepPartial, Settings } from '@shared/settings';
import type { AppContext, PanelHandle, PanelPropsMap } from '@shared/ui';
import { clickPlan, currentProfile, guitarResultPatch, measuredTimes, type ClickPlanOptions } from '../../src/audio/calibration';
import { createEngine } from '../../src/audio/engine';
import { mount } from '../../src/ui/panels/calibration';
import { createRunStep } from '../../src/ui/panels/calibration/run-step';
import { gauss, memorySettings, rng } from './helpers';

const SHOTS = '../../test-results/calibration';
const USB: DeepPartial<Settings> = { input: { deviceId: 'usb', label: 'Scarlett Solo USB' }, output: { sinkId: 'hp', label: 'External Headphones' } };

/** A scripted guitar: when a run subscribes, it plucks `offsetMs` after each measured click. */
class ScriptedInput implements InputService {
  current: InputOpenResult | null;
  listeners = new Set<(ev: TimedAnalysisEvent) => void>();
  opened = 0;
  timers: ReturnType<typeof setTimeout>[] = [];
  script: { offsetMs: number; jitterMs?: number; missed?: number[]; outliers?: Record<number, number>; plan?: Partial<ClickPlanOptions> } | null = null;

  constructor(
    private readonly engine: AudioEngine,
    open = true,
  ) {
    this.current = open ? this.openResult() : null;
  }
  private openResult(): InputOpenResult {
    return {
      device: { deviceId: 'usb', label: 'Scarlett Solo USB', groupId: 'g', kind: 'audioinput' },
      sampleRate: this.engine.ctx.sampleRate,
      channelCount: 2,
      latency: 0.004,
      processingWarnings: [],
      fellBackToDefault: false,
    };
  }
  listInputs = async () => [];
  listOutputs = async () => [];
  open = async (): Promise<InputOpenResult> => {
    this.opened++;
    this.current = this.openResult();
    return this.current;
  };
  close = (): void => undefined;
  getInputNode = (): AudioNode | null => null;
  onInput = (): Unsubscribe => () => undefined;
  expect = (): void => undefined;
  setTunerMode = (): void => undefined;
  onDevicesChanged = (): Unsubscribe => () => undefined;
  onAnalysis(cb: (ev: TimedAnalysisEvent) => void): Unsubscribe {
    this.listeners.add(cb);
    if (this.script) this.play(this.script);
    return () => this.listeners.delete(cb);
  }
  /** The run computes its plan from `currentTime` in the same task as it subscribes. */
  private play(s: NonNullable<ScriptedInput['script']>): void {
    const ctx = this.engine.ctx;
    const rand = rng(5);
    measuredTimes(clickPlan(ctx.currentTime + 0.3, s.plan)).forEach((click, i) => {
      if (s.missed?.includes(i)) return;
      const t = click + (s.offsetMs + gauss(rand) * (s.jitterMs ?? 0) + (s.outliers?.[i] ?? 0)) / 1000;
      const frame = Math.round(t * ctx.sampleRate);
      this.timers.push(
        setTimeout(
          () => {
            const ev: TimedAnalysisEvent = { type: 'onset', frame, midi: 40, cents: 0, clarity: 0.9, rmsDb: -18, ctxTime: frame / ctx.sampleRate };
            for (const cb of this.listeners) cb(ev);
          },
          Math.max(0, (t - ctx.currentTime) * 1000 + 30),
        ),
      );
    });
  }
  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
  }
}

class FakeMonitor implements Pick<MonitorService, 'enabled' | 'setEnabled'> {
  calls: boolean[] = [];
  enabled = true;
  async setEnabled(on: boolean): Promise<void> {
    this.calls.push(on);
    this.enabled = on;
  }
}

interface Harness {
  host: HTMLElement;
  ctx: AppContext;
  settings: ReturnType<typeof memorySettings>;
  engine: AudioEngine;
  input: ScriptedInput;
  monitor: FakeMonitor;
  toasts: string[];
  handle?: PanelHandle<PanelPropsMap['calibration']>;
  dispose: (() => void)[];
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    h.handle?.unmount();
    for (const d of h.dispose) d();
    h.input.dispose();
    h.host.remove();
    await h.engine.dispose();
  }
});

async function setup(initial: DeepPartial<Settings> = USB, opts: { inputOpen?: boolean; width?: number } = {}): Promise<Harness> {
  const settings = memorySettings(initial);
  const engine = await createEngine();
  const input = new ScriptedInput(engine, opts.inputOpen ?? true);
  const monitor = new FakeMonitor();
  const toasts: string[] = [];
  const ctx = {
    settings,
    services: {
      get: async (id: string) => (id === 'engine' ? engine : id === 'input' ? input : monitor),
      peek: () => null,
    },
    ui: {
      toast: (m: string) => void toasts.push(m),
      confirm: async () => true,
      requireAudioGesture: async () => engine.resume(),
    },
  } as unknown as AppContext;
  const host = document.createElement('div');
  host.style.cssText = `width: ${opts.width ?? 640}px; padding: 24px; background: var(--color-bg); font-family: var(--font-sans);`;
  document.body.append(host);
  const h: Harness = { host, ctx, settings, engine, input, monitor, toasts, dispose: [] };
  harnesses.push(h);
  return h;
}

async function mountPanel(h: Harness, props: PanelPropsMap['calibration'] = {}): Promise<void> {
  h.handle = await mount(h.host, h.ctx, props);
}

const q = <T extends Element = HTMLElement>(root: ParentNode, sel: string): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};
const visible = (el: Element): boolean => !(el as HTMLElement).hidden && el.getClientRects().length > 0;
const buttonByText = (root: ParentNode, text: string): HTMLButtonElement => {
  const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim().startsWith(text) && visible(x));
  if (!b) throw new Error(`no visible button "${text}"`);
  return b;
};
async function until(cond: () => boolean, timeoutMs: number): Promise<void> {
  const end = performance.now() + timeoutMs;
  while (!cond()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const FAST: Partial<ClickPlanOptions> = { bpm: 300, countInBeats: 2, clicks: 12 };

describe('calibration panel', () => {
  it('shows an uncalibrated summary and the guitar instructions', async () => {
    await page.viewport(720, 1000);
    const h = await setup();
    await mountPanel(h);
    const summary = q(h.host, '.rw-calib__summary');
    expect(q(summary, '.rw-calib__device').textContent).toBe('Scarlett Solo USB → External Headphones');
    expect(q(summary, '[data-row="guitar"] .rw-calib__row-value').textContent).toBe('—');
    expect(q(summary, '[data-row="guitar"] .rw-badge').textContent).toBe('Not calibrated');
    expect(visible(q(summary, '.rw-calib__note'))).toBe(false);
    expect(q(h.host, '.rw-tabs__tab[aria-selected="true"]').textContent).toBe('Guitar');
    expect(q(h.host, '.rw-calib__input-line').textContent).toContain('Scarlett Solo USB');
    await page.screenshot({ element: h.host, path: `${SHOTS}/panel-default.png` });
  });

  it('runs play-to-click at 90 BPM, saves the median and applies it', async () => {
    await page.viewport(720, 1100);
    const h = await setup();
    h.input.script = { offsetMs: 42, jitterMs: 1.5, missed: [6], outliers: { 10: 160 } };
    await mountPanel(h);
    buttonByText(h.host, 'Start').click();
    const step = q(h.host, '.rw-calib__step--guitar');
    await until(() => step.dataset.phase === 'live', 3000);
    expect(h.host.querySelectorAll('.rw-calib__beat')).toHaveLength(20);
    // Tabs are locked while running.
    expect(q<HTMLButtonElement>(h.host, '.rw-tabs__tab[data-tab="visual"]').disabled).toBe(true);
    await until(() => h.host.querySelectorAll('.rw-calib__beat[data-status]').length >= 7, 12_000);
    await page.screenshot({ element: h.host, path: `${SHOTS}/panel-guitar-running.png` });
    await until(() => step.dataset.phase === 'result', 15_000);
    expect(step.dataset.outcome).toBe('ok');
    const value = q(step, '[data-testid="calib-offset"]').textContent!;
    expect(Math.abs(Number.parseInt(value, 10) - 42)).toBeLessThanOrEqual(3);
    await until(() => h.settings.get().calibration.method === 'play-to-click', 1000);
    const c = h.settings.get().calibration;
    expect(Math.abs(c.inputOffsetMs - 42)).toBeLessThanOrEqual(3);
    expect(c.spreadMs).not.toBeNull();
    expect(currentProfile(h.settings.get())?.inputOffsetMs).toBe(c.inputOffsetMs);
    expect(q(step, '.rw-calib__stats').textContent).toContain('1 missed');
    expect(step.querySelectorAll('.rw-calib__strip-dot--rejected').length).toBeGreaterThanOrEqual(1);
    expect(q(step, '.rw-calib__applied').textContent).toMatch(/subtracts \d+ ms from every pluck/);
    expect(q(h.host, '[data-row="guitar"] .rw-badge').textContent).toBe('Play-to-click');
    expect(q<HTMLButtonElement>(h.host, '.rw-tabs__tab[data-tab="visual"]').disabled).toBe(false);
    await page.screenshot({ element: h.host, path: `${SHOTS}/panel-guitar-result.png` });

    buttonByText(step, 'Undo').click();
    await until(() => h.settings.get().calibration.method === 'none', 1000);
    expect(h.settings.get().calibration.inputOffsetMs).toBe(0);
  }, 40_000);

  it('opens the guitar input when none is open', async () => {
    const h = await setup(USB, { inputOpen: false });
    h.input.script = { offsetMs: 30, plan: FAST };
    const step = createRunStep('guitar', { ctx: h.ctx, engine: h.engine, input: h.input, runOptions: { plan: FAST } });
    h.dispose.push(() => step.destroy());
    h.host.append(step.el);
    expect(q(step.el, '.rw-calib__input-line').dataset.state).toBe('missing');
    buttonByText(step.el, 'Start').click();
    await until(() => step.el.dataset.phase === 'result', 8000);
    expect(h.input.opened).toBe(1);
    expect(step.el.dataset.outcome).toBe('ok');
  }, 15_000);

  it('explains a run with no plucks and offers the estimated fallback', async () => {
    await page.viewport(720, 900);
    const h = await setup({ ...USB, calibration: { keyboardOffsetMs: 12 } });
    const step = createRunStep('guitar', { ctx: h.ctx, engine: h.engine, input: h.input, runOptions: { plan: FAST } });
    h.dispose.push(() => step.destroy());
    h.host.append(step.el);
    buttonByText(step.el, 'Start').click();
    await until(() => step.el.dataset.phase === 'result', 8000);
    expect(step.el.dataset.outcome).toBe('no-events');
    expect(q(step.el, '.rw-calib__outcome--fail strong').textContent).toBe('No plucks were detected');
    await page.screenshot({ element: h.host, path: `${SHOTS}/panel-guitar-failed.png` });
    const fallback = buttonByText(step.el, 'Use an estimate');
    // 12 ms keyboard + 4 ms input + base + output latency of this context.
    const expected = 12 + 4 + (h.engine.ctx.baseLatency + (h.engine.ctx.outputLatency || 0.01)) * 1000;
    expect(Math.abs(Number.parseInt(/\((−?\d+) ms\)/.exec(fallback.textContent!)![1]!, 10) - expected)).toBeLessThanOrEqual(1);
    fallback.click();
    await until(() => h.settings.get().calibration.method === 'estimated', 1000);
    expect(Math.abs(h.settings.get().calibration.inputOffsetMs - expected)).toBeLessThan(0.01);
    expect(fallback.disabled).toBe(true);
  }, 15_000);

  it('rejects an inconsistent run without saving', async () => {
    const h = await setup();
    h.input.script = { offsetMs: 40, jitterMs: 40, plan: FAST };
    const step = createRunStep('guitar', { ctx: h.ctx, engine: h.engine, input: h.input, runOptions: { plan: FAST, estimator: { pairWindowMs: 150 } } });
    h.dispose.push(() => step.destroy());
    h.host.append(step.el);
    buttonByText(step.el, 'Start').click();
    await until(() => step.el.dataset.phase === 'result', 8000);
    expect(['inconsistent', 'too-few']).toContain(step.el.dataset.outcome);
    expect(q(step.el, '.rw-calib__stats').textContent).toContain('not saved');
    expect(h.settings.get().calibration.method).toBe('none');
  }, 15_000);

  it('calibrates keyboard taps (Space) in the heard domain', async () => {
    const h = await setup();
    const step = createRunStep('keyboard', { ctx: h.ctx, engine: h.engine, input: h.input, runOptions: { plan: FAST } });
    h.dispose.push(() => step.destroy());
    h.host.append(step.el);
    buttonByText(step.el, 'Start').click();
    await until(() => step.el.dataset.phase === 'live', 3000);
    expect(step.el.querySelectorAll('.rw-calib__beat')).toHaveLength(14);
    // Taps at the click period: not phase-locked to the clicks, but periodic, so the spread is tiny.
    const beat = 60 / FAST.bpm!;
    const taps = setInterval(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' })), beat * 1000);
    h.dispose.push(() => clearInterval(taps));
    await until(() => step.el.dataset.phase === 'result', 8000);
    clearInterval(taps);
    expect(step.el.dataset.outcome).toBe('ok');
    await until(() => currentProfile(h.settings.get())?.keyboardMeasuredAt != null, 1000);
    const s = h.settings.get().calibration;
    expect(s.method).toBe('tap-to-click');
    expect(Math.abs(s.keyboardOffsetMs)).toBeLessThanOrEqual(250);
  }, 15_000);

  it('loopback pauses monitoring, stores the round trip and can become the guitar offset', async () => {
    const h = await setup();
    h.input.script = { offsetMs: 23.5, plan: FAST };
    const step = createRunStep('loopback', { ctx: h.ctx, engine: h.engine, input: h.input, runOptions: { plan: FAST } });
    h.dispose.push(() => step.destroy());
    h.host.append(step.el);
    buttonByText(step.el, 'Measure loopback').click();
    await until(() => step.el.dataset.phase === 'live', 3000);
    expect(h.monitor.calls).toEqual([false]);
    await until(() => step.el.dataset.phase === 'result', 8000);
    expect(h.monitor.calls).toEqual([false, true]);
    await until(() => currentProfile(h.settings.get())?.loopbackMs != null, 1000);
    expect(currentProfile(h.settings.get())!.loopbackMs).toBeCloseTo(23.5, 0);
    expect(h.settings.get().calibration.method).toBe('none');
    buttonByText(step.el, 'Use as guitar offset').click();
    await until(() => h.settings.get().calibration.method === 'loopback', 1000);
    expect(h.settings.get().calibration.inputOffsetMs).toBeCloseTo(23.5, 0);
  }, 15_000);

  it('nudges the visual offset while clicks play and saves it', async () => {
    await page.viewport(720, 1000);
    const h = await setup();
    await mountPanel(h, { mode: 'visual' });
    expect(q(h.host, '.rw-tabs__tab[aria-selected="true"]').textContent).toBe('Visual');
    buttonByText(h.host, 'Start clicks').click();
    const step = q(h.host, '.rw-calib__step--visual');
    await until(() => step.dataset.phase === 'running', 3000);
    buttonByText(step, '+5 ms').click();
    buttonByText(step, '+5 ms').click();
    q(step, '.rw-calib__lane').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await until(() => h.settings.get().calibration.visualOffsetMs === 15, 1000);
    expect(q(step, '.rw-calib__visual-value').textContent).toBe('+15 ms');
    expect(q(h.host, '[data-row="visual"] .rw-calib__row-value').textContent).toBe('+15 ms');
    await until(() => [...step.querySelectorAll<HTMLElement>('.rw-calib__gem')].some((g) => g.style.opacity === '1'), 2000);
    await page.screenshot({ element: h.host, path: `${SHOTS}/panel-visual.png` });
    buttonByText(step, 'Stop clicks').click();
    expect(step.dataset.phase).toBe('idle');
    buttonByText(step, 'Reset').click();
    await until(() => h.settings.get().calibration.visualOffsetMs === 0, 1000);
  }, 15_000);

  it('notes offsets from another device and restores a known pair on switch', async () => {
    await page.viewport(720, 1000);
    const h = await setup();
    await h.settings.update(guitarResultPatch(h.settings.get(), { offsetMs: 48, spreadMs: 2.4 }, Date.now()));
    await mountPanel(h, { mode: 'keyboard' });
    await h.settings.update({ output: { sinkId: '', label: 'MacBook Pro Speakers' } });
    const note = q(h.host, '.rw-calib__note');
    expect(visible(note)).toBe(true);
    expect(q(h.host, '.rw-calib__device').textContent).toBe('Scarlett Solo USB → MacBook Pro Speakers');
    await page.screenshot({ element: h.host, path: `${SHOTS}/panel-other-device.png` });
    await h.settings.update({ output: { sinkId: 'hp', label: 'External Headphones' } });
    expect(visible(note)).toBe(false);
    expect(q(h.host, '[data-row="guitar"] .rw-calib__row-value').textContent).toBe('48 ms');
    h.handle!.update!({ mode: 'guitar' });
    expect(q(h.host, '.rw-tabs__tab[aria-selected="true"]').textContent).toBe('Guitar');
  });

  it('fits a narrow layout', async () => {
    await page.viewport(420, 1100);
    const h = await setup(USB, { width: 360 });
    await h.settings.update(guitarResultPatch(h.settings.get(), { offsetMs: 48, spreadMs: 2.4 }, Date.now()));
    await mountPanel(h);
    expect(h.host.scrollWidth).toBeLessThanOrEqual(h.host.clientWidth + 1);
    await page.screenshot({ element: h.host, path: `${SHOTS}/panel-narrow.png` });
  });

  it('cancel stops a run; unmount removes listeners', async () => {
    const h = await setup();
    await mountPanel(h);
    buttonByText(h.host, 'Start').click();
    const step = q(h.host, '.rw-calib__step--guitar');
    await until(() => step.dataset.phase === 'live', 3000);
    expect(h.input.listeners.size).toBe(1);
    buttonByText(step, 'Cancel').click();
    await until(() => step.dataset.phase === 'intro', 1000);
    expect(h.input.listeners.size).toBe(0);
    buttonByText(h.host, 'Start').click();
    await until(() => step.dataset.phase === 'live', 3000);
    h.handle!.unmount();
    h.handle = undefined;
    expect(h.input.listeners.size).toBe(0);
    expect(h.host.querySelector('.rw-calib')).toBeNull();
  });
});
