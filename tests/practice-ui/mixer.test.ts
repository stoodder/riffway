// @vitest-environment happy-dom
/**
 * Mixer (T-032): fader taper and dB readout, and the panel — live engine levels while dragging,
 * debounced persistence, mute/unmute per bus (`settings.mixerMute`, level kept), guide mute via
 * `game.guide` and the session, the `G` shortcut, hints, and lifecycle.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackingService, MonitorService } from '@shared/services';
import type { PanelHandle } from '@shared/ui';
import { mount, PERSIST_DELAY_MS } from '../../src/ui/panels/mixer';
import { MIXER_CHANNELS, faderToLevel, formatLevelDb, levelToFader } from '../../src/ui/panels/mixer/model';
import { fakeEngine, fakeSession, flush, makeCtx, memorySettings, press } from './helpers';

const handles: PanelHandle<unknown>[] = [];

afterEach(() => {
  for (const h of handles.splice(0)) h.unmount();
  document.body.replaceChildren();
});

describe('mixer model', () => {
  it('tapers faders (square law) and inverts', () => {
    expect(faderToLevel(0)).toBe(0);
    expect(faderToLevel(100)).toBe(1);
    expect(faderToLevel(50)).toBe(0.25);
    expect(faderToLevel(150)).toBe(1);
    for (const p of [0, 1, 37, 50, 89, 100]) expect(levelToFader(faderToLevel(p))).toBe(p);
    expect(levelToFader(0.8)).toBe(89);
  });

  it('formats dB', () => {
    expect(formatLevelDb(1)).toBe('0.0 dB');
    expect(formatLevelDb(0.5)).toBe('−6.0 dB');
    expect(formatLevelDb(0)).toBe('Off');
    expect(formatLevelDb(Number.NaN)).toBe('Off');
  });

  it('lists all five buses', () => {
    expect(MIXER_CHANNELS.map((c) => c.bus)).toEqual(['monitor', 'backing', 'guide', 'metronome', 'master']);
  });
});

async function setup(opts: Parameters<typeof makeCtx>[0] & { withSession?: boolean } = {}) {
  const eng = fakeEngine();
  const env = makeCtx({ ...opts, services: { engine: eng.engine, ...opts.services } });
  const session = opts.withSession ? fakeSession() : undefined;
  const host = document.createElement('div');
  document.body.append(host);
  const handle = await mount(host, env.ctx, { session });
  handles.push(handle as PanelHandle<unknown>);
  const row = (bus: string): HTMLElement => host.querySelector(`.rw-mixer__row[data-bus="${bus}"]`) as HTMLElement;
  const fader = (bus: string): HTMLInputElement => row(bus).querySelector('input[type="range"]') as HTMLInputElement;
  const mute = (bus: string): HTMLButtonElement => row(bus).querySelector('.rw-mixer__mute') as HTMLButtonElement;
  return { ...env, eng, session, host, handle, row, fader, mute };
}

describe('mixer panel', () => {
  it('renders a labelled fader and mute per bus from settings', async () => {
    const r = await setup({ settings: memorySettings({ mixer: { backing: 0.25 } }) });
    for (const c of MIXER_CHANNELS) {
      expect(r.fader(c.bus).labels?.[0]?.textContent).toBe(c.label);
      expect(r.mute(c.bus).getAttribute('aria-label')).toBe(`Mute ${c.label}`);
    }
    expect(r.fader('backing').value).toBe('50');
    expect(r.row('backing').querySelector('.rw-slider__value')?.textContent).toBe('−12.0 dB');
  });

  it('applies levels live while dragging and persists once after a pause', async () => {
    vi.useFakeTimers();
    try {
      const r = await setup();
      const f = r.fader('guide');
      for (const v of ['40', '45', '50']) {
        f.value = v;
        f.dispatchEvent(new Event('input'));
      }
      expect(r.eng.setLevel).toHaveBeenLastCalledWith('guide', 0.25);
      expect(r.settings.update).not.toHaveBeenCalled();
      vi.advanceTimersByTime(PERSIST_DELAY_MS);
      expect(r.settings.update).toHaveBeenCalledTimes(1);
      expect(r.settings.update).toHaveBeenCalledWith({ mixer: { guide: 0.25 } });
      f.value = '100';
      f.dispatchEvent(new Event('input'));
      f.dispatchEvent(new Event('change'));
      expect(r.settings.update).toHaveBeenLastCalledWith({ mixer: { guide: 1 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('mutes with the per-bus flag, keeps the level, and unmutes to it (also after a reload)', async () => {
    const r = await setup({ settings: memorySettings({ mixer: { monitor: 0.49 } }) });
    r.mute('monitor').click();
    expect(r.eng.setLevel).toHaveBeenLastCalledWith('monitor', 0);
    expect(r.settings.update).toHaveBeenLastCalledWith({ mixerMute: { monitor: true } });
    await flush();
    expect(r.settings.get().mixer.monitor).toBe(0.49);
    expect(r.mute('monitor').getAttribute('aria-pressed')).toBe('true');
    expect(r.row('monitor').classList.contains('rw-mixer__row--muted')).toBe(true);
    expect(r.fader('monitor').value).toBe('70');
    // Moving a muted fader sets the level without un-silencing the bus.
    const calls = r.eng.setLevel.mock.calls.length;
    r.fader('monitor').value = '80';
    r.fader('monitor').dispatchEvent(new Event('change'));
    expect(r.eng.setLevel.mock.calls.length).toBe(calls);
    expect(r.settings.update).toHaveBeenLastCalledWith({ mixer: { monitor: 0.64 } });
    await flush();
    r.handle.unmount();
    handles.splice(0);
    const again = await setup({ settings: r.settings });
    expect(again.mute('monitor').getAttribute('aria-pressed')).toBe('true');
    again.mute('monitor').click();
    expect(again.eng.setLevel).toHaveBeenLastCalledWith('monitor', 0.64);
    expect(again.settings.update).toHaveBeenLastCalledWith({ mixerMute: { monitor: false } });
    await flush();
    expect(again.mute('monitor').getAttribute('aria-pressed')).toBe('false');
    expect(again.fader('monitor').value).toBe('80');
  });

  it('mutes the guide through game.guide and the session; G toggles it', async () => {
    const r = await setup({ withSession: true });
    r.mute('guide').click();
    expect(r.session?.calls.setGuideMuted).toHaveBeenLastCalledWith(true);
    expect(r.settings.update).toHaveBeenLastCalledWith({ game: { guide: false } });
    await flush();
    expect(r.mute('guide').getAttribute('aria-pressed')).toBe('true');
    expect(r.row('guide').textContent).toContain('Guide off');
    const ev = press('KeyG');
    expect(ev.defaultPrevented).toBe(true);
    expect(r.session?.calls.setGuideMuted).toHaveBeenLastCalledWith(false);
    expect(r.settings.update).toHaveBeenLastCalledWith({ game: { guide: true } });
    expect(press('Digit5').defaultPrevented).toBe(false);
  });

  it('follows settings changed elsewhere (e.g. the practice panel metronome volume)', async () => {
    const r = await setup();
    await r.settings.update({ mixer: { metronome: 0.09 } });
    expect(r.fader('metronome').value).toBe('30');
  });

  it('shows hints for monitoring off, no backing and guide auto-mute', async () => {
    const monitor = { enabled: false } as unknown as MonitorService;
    const backing = { link: null } as unknown as BackingService;
    const r = await setup({ withSession: true, services: { monitor, backing } });
    expect(r.row('monitor').textContent).toContain('Monitoring is off');
    expect(r.row('backing').textContent).toContain('No backing track attached');
    (backing as { link: unknown }).link = { enabled: true };
    await r.settings.update({ game: { muteGuideWithBacking: true } });
    expect(r.row('guide').textContent).toContain('Auto-muted while the backing track plays.');
    expect(r.row('backing').querySelector('.rw-mixer__hint')?.hasAttribute('hidden')).toBe(true);
  });

  it('reverts and toasts when saving fails', async () => {
    const settings = memorySettings();
    settings.fail = new Error('quota');
    const r = await setup({ settings });
    r.mute('master').click();
    await flush();
    expect(r.toast).toHaveBeenCalledWith(expect.stringContaining('quota'), { kind: 'error' });
    expect(r.mute('master').getAttribute('aria-pressed')).toBe('false');
  });

  it('flushes a pending level on unmount and stops listening', async () => {
    const r = await setup({ withSession: true });
    const f = r.fader('backing');
    f.value = '30';
    f.dispatchEvent(new Event('input'));
    r.handle.unmount();
    handles.splice(0);
    expect(r.settings.update).toHaveBeenCalledWith({ mixer: { backing: 0.09 } });
    expect(r.host.querySelector('.rw-mixer')).toBeNull();
    press('KeyG');
    expect(r.session?.calls.setGuideMuted).not.toHaveBeenCalled();
  });

  it('update() swaps the session', async () => {
    const r = await setup();
    const s = fakeSession();
    r.handle.update?.({ session: s });
    r.mute('guide').click();
    expect(s.calls.setGuideMuted).toHaveBeenCalledWith(true);
  });
});
