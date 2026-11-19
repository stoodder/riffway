// @vitest-environment happy-dom
/**
 * Practice panel (T-032) against a fake session: speed (buttons, presets, shortcuts with debounce,
 * pending/error states, overspeed gating), speed trainer (toggle, ladder, live messages), A/B loop
 * (sections, Set A/B, nudges, strip drag/click, shortcuts), count-in, metronome and persistence.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PanelHandle } from '@shared/ui';
import { mount, SPEED_COMMIT_DELAY_MS } from '../../src/ui/panels/practice';
import { fakeEngine, fakeSession, flush, makeCtx, makeSong, mastered, memorySettings, press, type FakeSession } from './helpers';

const handles: PanelHandle<unknown>[] = [];

afterEach(() => {
  for (const h of handles.splice(0)) h.unmount();
  document.body.replaceChildren();
  vi.useRealTimers();
});

async function setup(opts: Parameters<typeof makeCtx>[0] & { session?: FakeSession } = {}) {
  const session = opts.session ?? fakeSession();
  const eng = fakeEngine();
  const env = makeCtx({ services: { engine: eng.engine }, ...opts });
  const host = document.createElement('div');
  document.body.append(host);
  const handle = await mount(host, env.ctx, { session });
  handles.push(handle as PanelHandle<unknown>);
  await flush();
  const q = <T extends Element = HTMLElement>(sel: string): T => {
    const el = host.querySelector<T>(sel);
    if (!el) throw new Error(`missing ${sel}`);
    return el;
  };
  const btn = (label: string): HTMLButtonElement => {
    const b = Array.from(host.querySelectorAll('button')).find((x) => x.getAttribute('aria-label') === label || x.textContent?.trim() === label);
    if (!b) throw new Error(`no button ${label}`);
    return b;
  };
  return { ...env, session, host, handle, q, btn, eng };
}

describe('speed', () => {
  it('shows the session speed and changes it with presets (no debounce)', async () => {
    const r = await setup({ session: fakeSession(makeSong(), { speed: 0.7 }) });
    expect(r.q('.rw-practice__speed-value').textContent).toBe('70%');
    expect(r.q<HTMLInputElement>('.rw-practice__speed-slider input').max).toBe('100');
    r.q<HTMLButtonElement>('.rw-practice__chip[data-speed="0.85"]').click();
    expect(r.session.calls.setSpeed).toHaveBeenCalledWith(0.85);
    await flush();
    expect(r.q('.rw-practice__speed-value').textContent).toBe('85%');
    expect(r.q('.rw-practice__chip[data-speed="0.85"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('debounces −/+ bursts into one setSpeed and shows the pending target', async () => {
    vi.useFakeTimers();
    const session = fakeSession(makeSong(), { speed: 0.8 });
    session.holdSpeed = true;
    const r = await setupFake(session);
    press('Equal');
    press('Equal', { repeat: true });
    r.btn('Slower (−5%)').click();
    press('Equal');
    expect(r.q('.rw-practice__speed-value').textContent).toBe('90%');
    expect(session.calls.setSpeed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SPEED_COMMIT_DELAY_MS);
    expect(session.calls.setSpeed).toHaveBeenCalledTimes(1);
    expect(session.calls.setSpeed).toHaveBeenCalledWith(0.9);
    expect(r.q('.rw-practice__speed-status').textContent).toBe('→ 90% at the next bar');
    session.resolveSpeed();
    await vi.runOnlyPendingTimersAsync();
    expect(r.q('.rw-practice__speed-status').textContent).toBe('');
  });

  it('reverts and toasts when the speed change fails', async () => {
    const session = fakeSession(makeSong(), { speed: 0.8 });
    session.holdSpeed = true;
    const r = await setup({ session });
    r.q<HTMLButtonElement>('.rw-practice__chip[data-speed="0.5"]').click();
    expect(r.q('.rw-practice__speed-value').textContent).toBe('50%');
    session.rejectSpeed(new Error('render failed'));
    await flush();
    expect(r.q('.rw-practice__speed-value').textContent).toBe('80%');
    expect(r.toast).toHaveBeenCalledWith(expect.stringContaining('render failed'), { kind: 'error' });
  });

  it('caps at 100% unless overspeed is opted in and the sections are mastered', async () => {
    const r = await setup({ session: fakeSession(makeSong(), { speed: 1 }), settings: memorySettings({ practice: { overspeed: true } }), progress: [mastered(0)] });
    expect(r.q<HTMLInputElement>('.rw-practice__speed-slider input').max).toBe('100');
    expect(r.host.textContent).toContain('110% unlocks once the looped sections are mastered.');
    r.q<HTMLButtonElement>('.rw-practice__section[data-section="0"]').click();
    await flush();
    expect(r.q<HTMLInputElement>('.rw-practice__speed-slider input').max).toBe('110');
    expect(r.host.querySelector('.rw-practice__chip[data-speed="1.1"]')).not.toBeNull();
    press('Equal');
    await flush(SPEED_COMMIT_DELAY_MS + 10);
    expect(r.session.calls.setSpeed).toHaveBeenLastCalledWith(1.05);
  });
});

/** Same as setup() but without awaiting real timers (for fake-timer tests). */
async function setupFake(session: FakeSession) {
  const eng = fakeEngine();
  const env = makeCtx({ services: { engine: eng.engine } });
  const host = document.createElement('div');
  document.body.append(host);
  const handle = await mount(host, env.ctx, { session });
  handles.push(handle as PanelHandle<unknown>);
  const q = <T extends Element = HTMLElement>(sel: string): T => host.querySelector<T>(sel) as T;
  const btn = (label: string): HTMLButtonElement => Array.from(host.querySelectorAll('button')).find((x) => x.getAttribute('aria-label') === label) as HTMLButtonElement;
  return { ...env, host, q, btn };
}

describe('speed trainer', () => {
  it('toggles the trainer, persists it, and shows now → goal with the ladder', async () => {
    const r = await setup({ session: fakeSession(makeSong(), { speed: 0.75, trainer: false }) });
    expect(r.q('.rw-practice__trainer').hidden).toBe(true);
    press('KeyT');
    expect(r.session.calls.setSpeedTrainer).toHaveBeenCalledWith(true);
    expect(r.settings.update).toHaveBeenCalledWith({ practice: { speedTrainer: true } });
    const box = r.q('.rw-practice__trainer');
    expect(box.hidden).toBe(false);
    expect(box.textContent).toContain('Now75%');
    expect(box.textContent).toContain('Goal100%');
    expect(box.textContent).toContain('5 clean runs to go');
    expect(box.querySelector('.rw-practice__rung--current')?.textContent).toBe('75');
    expect(box.querySelector('[role="meter"]')?.getAttribute('aria-valuetext')).toBe('75% of 100%');
  });

  it('shows live trainer messages and follows the speed the session sets', async () => {
    const session = fakeSession(makeSong(), { speed: 0.75, trainer: true });
    const r = await setup({ session });
    await session.setSpeed(0.8);
    session.emitMessage({ kind: 'trainer', text: 'Clean run! +5% → 80%' });
    const msg = r.q('.rw-practice__message');
    expect(msg.textContent).toBe('Clean run! +5% → 80%');
    expect(msg.dataset.tone).toBe('up');
    expect(msg.getAttribute('aria-live')).toBe('polite');
    expect(r.q('.rw-practice__speed-value').textContent).toBe('80%');
    expect(r.q('.rw-practice__trainer').textContent).toContain('Clean runs this session: 1');
    session.emitMessage({ kind: 'trainer', text: 'Slow down a notch → 75%' });
    expect(msg.dataset.tone).toBe('down');
  });
});

describe('A/B loop', () => {
  it('loops a section from the list with its pre-roll summary', async () => {
    const r = await setup();
    r.q<HTMLButtonElement>('.rw-practice__section[data-section="1"]').click();
    expect(r.session.calls.setLoopBars).toHaveBeenCalledWith(4, 8);
    expect(r.q('.rw-practice__section[data-section="1"]').getAttribute('aria-pressed')).toBe('true');
    expect(r.q('.rw-practice__loop-summary').textContent).toBe('Looping Verse · bars 5–8 · 4 bars · 1-bar pre-roll');
    expect(r.q('.rw-loopstrip__loop').hidden).toBe(false);
    expect(r.q('.rw-loopstrip__preroll').hidden).toBe(false);
    r.btn('Clear loop').click();
    expect(r.session.calls.clearLoop).toHaveBeenCalled();
    expect(r.q('.rw-practice__loop-summary').textContent).toContain('No loop');
  });

  it('says 2-bar pre-roll below 60%', async () => {
    const r = await setup({ session: fakeSession(makeSong(), { speed: 0.5 }) });
    r.q<HTMLButtonElement>('.rw-practice__section[data-section="2"]').click();
    expect(r.q('.rw-practice__loop-summary').textContent).toContain('2-bar pre-roll (below 60%)');
  });

  it('updates the pre-roll when the speed drops below 60%', async () => {
    const r = await setup();
    r.q<HTMLButtonElement>('.rw-practice__section[data-section="2"]').click();
    expect(r.q('.rw-practice__loop-summary').textContent).toContain('1-bar pre-roll');
    r.q<HTMLButtonElement>('.rw-practice__chip[data-speed="0.5"]').click();
    expect(r.q('.rw-practice__loop-summary').textContent).toContain('2-bar pre-roll (below 60%)');
    expect(r.q('.rw-loopstrip__preroll').getAttribute('style')).toContain('left:37.500%');
  });

  it('sets A then B from the heard position (buttons and keys), snapped', async () => {
    const r = await setup();
    r.session.heard = 10.2; // in bar 6 (index 5)
    r.btn('Set A').click();
    expect(r.session.calls.setLoopBars).not.toHaveBeenCalled();
    expect(r.q('.rw-practice__loop-summary').textContent).toContain('A at bar 6');
    expect(r.q('.rw-loopstrip__pending').hidden).toBe(false);
    r.session.heard = 15.3;
    press('KeyB');
    expect(r.session.calls.setLoopBars).toHaveBeenLastCalledWith(5, 8);
    expect(r.q('.rw-loopstrip__pending').hidden).toBe(true);
    press('KeyA'); // heard 15.3 → bar 8 boundary (Chorus) → would be ≥ B, so pending
    r.session.heard = 8.1;
    press('KeyA'); // moves A of the existing loop to the Verse boundary
    expect(r.session.calls.setLoopBars).toHaveBeenLastCalledWith(4, 8);
  });

  it('nudges the edges by one bar and disables impossible nudges', async () => {
    const r = await setup();
    r.q<HTMLButtonElement>('.rw-practice__section[data-section="0"]').click();
    expect(r.btn('Loop start one bar earlier').disabled).toBe(true);
    r.btn('Loop end one bar later').click();
    expect(r.session.calls.setLoopBars).toHaveBeenLastCalledWith(0, 5);
    r.btn('Loop start one bar later').click();
    expect(r.session.calls.setLoopBars).toHaveBeenLastCalledWith(1, 5);
  });

  it('L toggles a loop on the current section; [ and ] step sections', async () => {
    const r = await setup();
    r.session.heard = 17; // bar 9 → Chorus
    press('KeyL');
    expect(r.session.calls.setLoopBars).toHaveBeenLastCalledWith(8, 12);
    press('BracketRight');
    expect(r.session.calls.setLoopBars).toHaveBeenLastCalledWith(12, 16);
    press('BracketLeft');
    press('BracketLeft');
    expect(r.session.calls.setLoopBars).toHaveBeenLastCalledWith(4, 8);
    press('KeyL');
    expect(r.session.calls.clearLoop).toHaveBeenCalled();
    expect(r.session.loop).toBeNull();
  });

  it('drag on the strip selects a snapped range; a click loops the section under it', async () => {
    const r = await setup();
    const strip = r.q('.rw-loopstrip');
    strip.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 64, right: 320, bottom: 64, x: 0, y: 0, toJSON: () => ({}) });
    const fire = (type: string, x: number): void => {
      strip.dispatchEvent(new PointerEvent(type, { clientX: x, button: 0, pointerId: 1, bubbles: true, cancelable: true }));
    };
    // 320 px = 32 s → 10 px per second, 20 px per bar
    fire('pointerdown', 101); // 10.1 s (bar 5.05)
    fire('pointermove', 150);
    expect(r.q('.rw-loopstrip__preview').hidden).toBe(false);
    fire('pointermove', 219); // 21.9 s (bar 10.95 → 11)
    fire('pointerup', 219);
    expect(r.session.calls.setLoopBars).toHaveBeenLastCalledWith(5, 11);
    expect(r.q('.rw-loopstrip__preview').hidden).toBe(true);
    // Drag the B edge (at 220 px) to 302 px → bar 15.1 → snaps to the song end section boundary 16? (Outro ends at 16, within 1 bar)
    fire('pointerdown', 221);
    fire('pointermove', 260);
    fire('pointerup', 302);
    expect(r.session.calls.setLoopBars).toHaveBeenLastCalledWith(5, 16);
    // A click inside Outro loops Outro.
    fire('pointerdown', 290);
    fire('pointerup', 290);
    expect(r.session.calls.setLoopBars).toHaveBeenLastCalledWith(12, 16);
  });

  it('reflects a loop the session sets itself ("Loop this")', async () => {
    const r = await setup();
    r.session.setLoopBars(8, 12);
    await new Promise((res) => requestAnimationFrame(() => res(null)));
    await flush(20);
    expect(r.q('.rw-practice__loop-summary').textContent).toContain('Looping Chorus');
  });
});

describe('count-in and metronome', () => {
  it('sets count-in bars (click, C cycles, arrows) and persists', async () => {
    const r = await setup();
    const radio = (n: number): HTMLButtonElement => r.q<HTMLButtonElement>(`.rw-practice__seg-btn[data-bars="${n}"]`);
    expect(radio(1).getAttribute('aria-checked')).toBe('true');
    radio(2).click();
    expect(r.session.calls.setCountInBars).toHaveBeenLastCalledWith(2);
    expect(r.settings.update).toHaveBeenCalledWith({ practice: { countInBars: 2 } });
    press('KeyC');
    expect(r.session.calls.setCountInBars).toHaveBeenLastCalledWith(0);
    expect(radio(0).getAttribute('aria-checked')).toBe('true');
    radio(0).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(r.session.calls.setCountInBars).toHaveBeenLastCalledWith(1);
  });

  it('toggles the metronome and sets its volume live + persisted', async () => {
    const r = await setup();
    press('KeyM');
    expect(r.session.calls.setMetronome).toHaveBeenCalledWith(false);
    expect(r.settings.update).toHaveBeenCalledWith({ practice: { metronome: false } });
    const vol = Array.from(r.host.querySelectorAll<HTMLInputElement>('input[type="range"]')).find((i) => i.labels?.[0]?.textContent === 'Metronome volume');
    expect(vol).toBeDefined();
    if (!vol) return;
    vol.value = '40';
    vol.dispatchEvent(new Event('input'));
    expect(r.eng.setLevel).toHaveBeenCalledWith('metronome', 0.4);
    vol.dispatchEvent(new Event('change'));
    expect(r.settings.update).toHaveBeenCalledWith({ mixer: { metronome: 0.4 } });
  });

  it('toasts when a setting cannot be saved', async () => {
    const settings = memorySettings();
    settings.fail = new Error('disk full');
    const r = await setup({ settings });
    press('KeyM');
    await flush();
    expect(r.toast).toHaveBeenCalledWith(expect.stringContaining('disk full'), { kind: 'error' });
  });
});

describe('focus and lifecycle', () => {
  it('lane keys reach the game untouched and the shortcut help lists the map', async () => {
    const r = await setup();
    const ev = press('Digit2');
    expect(ev.defaultPrevented).toBe(false);
    r.btn('Shortcuts').click();
    const help = r.q('.rw-practice__shortcuts');
    expect(help.hidden).toBe(false);
    expect(help.textContent).toContain('Set loop start here');
    expect(help.textContent).toContain('Always go to the game');
  });

  it('unmount removes the DOM and the key listeners; update rebinds a new session', async () => {
    const r = await setup();
    const next = fakeSession(makeSong(), { speed: 0.6 });
    r.handle.update?.({ session: next });
    expect(r.q('.rw-practice__speed-value').textContent).toBe('60%');
    press('KeyT');
    expect(next.calls.setSpeedTrainer).toHaveBeenCalled();
    expect(r.session.calls.setSpeedTrainer).not.toHaveBeenCalled();
    r.handle.unmount();
    handles.splice(0);
    expect(r.host.querySelector('.rw-practice')).toBeNull();
    press('KeyT');
    expect(next.calls.setSpeedTrainer).toHaveBeenCalledTimes(1);
  });
});
