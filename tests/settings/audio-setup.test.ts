// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelHandle, PanelId, ScreenHandle } from '@shared/ui';
import { createFakeServer, fakeContext, type FakeCtx } from './fake';

/** Panels are replaced by recording stand-ins (the real ones need Web Audio and devices). */
interface MountedPanel {
  id: PanelId;
  props: unknown;
  el: HTMLElement;
  unmounted: boolean;
  update?: (props: unknown) => void;
}
const panels = vi.hoisted(() => ({
  mounted: [] as MountedPanel[],
  /** Per panel id: make the next mount fail or wait. */
  fail: new Set<string>(),
  gate: null as Promise<void> | null,
}));

vi.mock('../../src/ui/panels', () => ({
  mountPanel: async (id: PanelId, el: HTMLElement, _ctx: unknown, props: unknown): Promise<PanelHandle<unknown>> => {
    if (panels.gate) await panels.gate;
    if (panels.fail.has(id)) throw new Error(`${id} exploded`);
    const node = document.createElement('div');
    node.className = 'mock-panel';
    node.dataset.mock = id;
    el.append(node);
    const rec: MountedPanel = { id, props, el: node, unmounted: false };
    panels.mounted.push(rec);
    return {
      unmount() {
        rec.unmounted = true;
        node.remove();
      },
      update: (p: unknown) => rec.update?.(p),
    };
  },
}));

const { mount } = await import('../../src/ui/screens/audio-setup');

describe('audio setup screen', () => {
  let fake: FakeCtx;
  let el: HTMLElement;
  let handle: ScreenHandle | null;

  const q = <T extends Element = HTMLElement>(sel: string): T => {
    const found = el.querySelector<T>(sel);
    if (!found) throw new Error(`no ${sel}`);
    return found;
  };
  const live = (): string[] => panels.mounted.filter((p) => !p.unmounted).map((p) => p.id);
  const shown = (): string[] => Array.from(el.querySelectorAll<HTMLElement>('.mock-panel')).map((p) => p.dataset.mock ?? '');
  const btn = (label: string): HTMLButtonElement => {
    const b = Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((x) => x.textContent?.trim() === label && !x.hidden);
    if (!b) throw new Error(`no button ${label}`);
    return b;
  };
  const railStatus = (step: string): string => q(`.as-rail__step[data-step="${step}"] .as-rail__status`).textContent ?? '';

  async function start(params: Record<string, string> = {}): Promise<ScreenHandle> {
    handle = await mount(el, fake.ctx, params);
    await vi.waitFor(() => expect(q('.as-step__body').getAttribute('aria-busy')).toBe('false'));
    return handle;
  }

  beforeEach(async () => {
    panels.mounted.length = 0;
    panels.fail.clear();
    panels.gate = null;
    fake = await fakeContext(createFakeServer());
    el = document.createElement('div');
    document.body.replaceChildren(el);
    handle = null;
  });

  afterEach(() => {
    handle?.unmount();
    fake.storage.close();
  });

  it('starts with the input step and lists the guided order with live statuses', async () => {
    await start();
    expect(q('h1').textContent).toBe('Audio setup');
    expect(Array.from(el.querySelectorAll('.as-rail__label')).map((l) => l.textContent)).toEqual(['Input & level', 'Tune', 'Monitoring', 'Latency', 'Summary']);
    expect(q('.as-rail__step[aria-current="step"]').dataset.step).toBe('input');
    expect(q('.as-step .rw-eyebrow').textContent).toBe('Step 1 of 4');
    expect(q('.as-step__title').textContent).toBe('Connect your guitar');
    expect(shown()).toEqual(['input']);
    expect(() => btn('Back')).toThrow();
    expect(railStatus('input')).toBe('Not connected yet');
    expect(railStatus('calibration')).toBe('Not calibrated');

    await fake.ctx.settings.update({ input: { deviceId: 'usb', label: 'USB Audio CODEC' }, calibration: { method: 'play-to-click', inputOffsetMs: 37 } });
    await vi.waitFor(() => expect(railStatus('input')).toBe('USB Audio CODEC'));
    expect(railStatus('calibration')).toBe('+37 ms offset');
    expect(q('.as-rail__step[data-step="calibration"]').dataset.tone).toBe('done');
  });

  it('walks through the steps, mounting only the current step’s panel', async () => {
    await start();
    btn('Next: Tune').click();
    await vi.waitFor(() => expect(shown()).toEqual(['tuner']));
    expect(live()).toEqual(['tuner']);
    expect(fake.navigations.at(-1)).toBe('/audio-setup?step=tuner');
    expect(document.activeElement).toBe(q('.as-step__title'));

    btn('Next: Monitoring').click();
    await vi.waitFor(() => expect(shown()).toEqual(['monitor']));
    expect(q('.as-tip').textContent).toMatch(/Headphones recommended/);

    btn('Next: Latency').click();
    await vi.waitFor(() => expect(shown()).toEqual(['calibration']));
    expect(panels.mounted.at(-1)?.props).toEqual({ mode: 'guitar' });
    expect(fake.navigations.at(-1)).toBe('/audio-setup?step=calibration');

    btn('Finish').click();
    await vi.waitFor(() => expect(el.querySelector('.as-summary')).not.toBeNull());
    expect(live()).toEqual([]);
    expect(q('.as-step .rw-eyebrow').textContent).toBe('Summary');
    expect(() => btn('Next')).toThrow();

    btn('Back').click();
    await vi.waitFor(() => expect(shown()).toEqual(['calibration']));
    expect(panels.mounted.filter((p) => p.id === 'input').every((p) => p.unmounted)).toBe(true);
  });

  it('opens calibration on the mode from the route and forwards mode changes to the panel', async () => {
    const updates: unknown[] = [];
    await start({ step: 'calibration', mode: 'keyboard' });
    expect(panels.mounted.at(-1)?.props).toEqual({ mode: 'keyboard' });
    const rec = panels.mounted.at(-1) as MountedPanel;
    rec.update = (p) => updates.push(p);
    handle?.update?.({ step: 'calibration', mode: 'visual' });
    expect(updates).toEqual([{ mode: 'visual' }]);
    handle?.update?.({ step: 'calibration' });
    expect(updates).toHaveLength(1);
    expect(live()).toEqual(['calibration']);
  });

  it('summarises the setup with links back to each step', async () => {
    await fake.ctx.settings.update({
      input: { deviceId: 'usb', label: 'USB Audio CODEC', channel: 0 },
      output: { sinkId: 'hp', label: 'External Headphones' },
      monitor: { preset: 'crunch' },
      calibration: { method: 'play-to-click', inputOffsetMs: 41, spreadMs: 3 },
    });
    await start({ step: 'done' });
    const rows = Array.from(el.querySelectorAll('.as-summary__row')).map((r) => [r.querySelector('dt')?.textContent, r.querySelector('.as-summary__value')?.textContent]);
    expect(rows).toEqual([
      ['Guitar input', 'USB Audio CODEC (channel 1)'],
      ['Output', 'External Headphones'],
      ['Monitoring', 'On · Crunch amp'],
      ['Latency calibration', 'Guitar +41 ms · keyboard 0 ms · spread ±3 ms'],
    ]);
    expect(railStatus('done')).toBe('Ready to play');
    expect(q<HTMLAnchorElement>('.as-summary__actions a').getAttribute('href')).toBe('#/library');
    (el.querySelectorAll<HTMLButtonElement>('.as-summary__row button')[1] as HTMLButtonElement).click();
    await vi.waitFor(() => expect(shown()).toEqual(['input']));

    // Changing settings while on the summary refreshes it.
    handle?.update?.({ step: 'done' });
    await vi.waitFor(() => expect(el.querySelector('.as-summary')).not.toBeNull());
    await fake.ctx.settings.update({ monitor: { enabled: false } });
    await vi.waitFor(() => expect(el.querySelectorAll('.as-summary__value')[2]?.textContent).toBe('Off (you hear your own amp)'));
  });

  it('follows route updates and ignores its own echo', async () => {
    await start();
    handle?.update?.({ step: 'monitor' });
    await vi.waitFor(() => expect(shown()).toEqual(['monitor']));
    const count = panels.mounted.length;
    handle?.update?.({ step: 'monitor' });
    expect(panels.mounted.length).toBe(count);
    handle?.update?.({ step: 'nonsense' });
    await vi.waitFor(() => expect(shown()).toEqual(['input']));
  });

  it('shows a load failure with a retry', async () => {
    panels.fail.add('tuner');
    await start({ step: 'tuner' });
    expect(q('.as-step__error').textContent).toMatch(/This step couldn’t load: tuner exploded/);
    panels.fail.clear();
    btn('Try again').click();
    await vi.waitFor(() => expect(shown()).toEqual(['tuner']));
  });

  it('drops a panel that finishes loading after the step changed, and unmounts on leave', async () => {
    let open!: () => void;
    panels.gate = new Promise((r) => (open = r));
    handle = await mount(el, fake.ctx, {});
    q<HTMLButtonElement>('.as-rail__step[data-step="monitor"]').click();
    panels.gate = null;
    open();
    await vi.waitFor(() => expect(shown()).toEqual(['monitor']));
    expect(panels.mounted.find((p) => p.id === 'input')?.unmounted).toBe(true);
    handle.unmount();
    handle = null;
    expect(live()).toEqual([]);
    expect(el.childElementCount).toBe(0);
  });

  it('shows an unavailable view instead of throwing when the context is incomplete', async () => {
    const h2 = await mount(el, {} as never, {});
    expect(q('h1').textContent).toBe('Audio setup');
    expect(el.textContent).toContain('missing: settings, services, router, ui');
    expect(panels.mounted).toHaveLength(0);
    h2.unmount();
    expect(el.childElementCount).toBe(0);
  });
});
