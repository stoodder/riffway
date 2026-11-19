/**
 * Visual offset step: endless clicks, a gem scrolling right → left into a hit line that flashes on
 * each click (drawn exactly like the highway: heard time − visual offset), and ±5 ms nudges until
 * flash and click coincide. Every nudge is saved; the engine applies it to `heardSongTime`.
 * @module
 */
import type { AudioEngine } from '@shared/services';
import type { AppContext } from '@shared/ui';
import {
  CALIBRATION,
  ClickLoop,
  VISUAL_OFFSET,
  clampVisualOffset,
  nudgeVisualOffset,
  visualFrame,
  visualOffsetPatch,
} from '../../../audio/calibration';
import { createClickPlayer } from '../../../audio/engine/metronome';
import { AudioGestureDismissedError } from '../../shell/audio-gesture';
import { button, h, icon, setBusy } from '../../components';
import { fmtSignedMs, visualSentence } from './model';

/** Seconds of lane shown to the right of the hit line. */
const LANE_SEC = 1.6;
/** Gems drawn ahead of the line. */
const GEMS = 3;

/** A mounted visual step. */
export interface VisualStep {
  el: HTMLElement;
  /** Stop the clicks (tab switch). */
  stop(): void;
  destroy(): void;
}

/** Create the visual-offset step. */
export function createVisualStep(ctx: AppContext, engine: AudioEngine): VisualStep {
  let value = ctx.settings.get().calibration.visualOffsetMs;
  let loop: ClickLoop | null = null;
  let disposeClicks: (() => void) | null = null;
  let offContext: (() => void) | null = null;
  let raf = 0;

  const gems = Array.from({ length: GEMS }, () => h('span', { class: 'rw-calib__gem' }));
  const flash = h('span', { class: 'rw-calib__flash' });
  const lane = h(
    'div',
    {
      class: 'rw-calib__lane',
      tabindex: '0',
      role: 'group',
      'aria-label': 'Visual offset preview. Left and right arrows nudge by 5 ms.',
      on: {
        keydown: (ev: KeyboardEvent) => {
          if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
            ev.preventDefault();
            setValue(nudgeVisualOffset(value, ev.key === 'ArrowRight' ? 1 : -1));
          }
        },
      },
    },
    h('span', { class: 'rw-calib__hitline' }),
    flash,
    ...gems,
  );
  const valueEl = h('output', { class: 'rw-calib__visual-value rw-num', 'aria-live': 'polite' });
  const sentence = h('p', { class: 'rw-calib__applied' });
  const earlier = button({ label: '−5 ms', variant: 'secondary', size: 'sm', title: 'Draw earlier', onClick: () => setValue(nudgeVisualOffset(value, -1)) });
  const later = button({ label: '+5 ms', variant: 'secondary', size: 'sm', title: 'Draw later', onClick: () => setValue(nudgeVisualOffset(value, 1)) });
  const reset = button({ label: 'Reset', variant: 'ghost', size: 'sm', onClick: () => setValue(0) });
  const toggleBtn = button({ label: 'Start clicks', icon: 'play', variant: 'primary', onClick: () => void (loop ? stop() : start()) });

  const el = h(
    'div',
    { class: 'rw-calib__step rw-calib__step--visual', dataset: { phase: 'idle' } },
    h(
      'ol',
      { class: 'rw-calib__steps' },
      h('li', null, 'Start the clicks and watch each gem hit the line.'),
      h('li', null, 'If the gem hits the line before you hear the click, press +5 ms (+ draws the gems later); if after, −5 ms.'),
      h('li', null, 'Stop when they feel simultaneous. This changes only the picture, not scoring.'),
    ),
    lane,
    h('div', { class: 'rw-calib__nudge' }, earlier, valueEl, later, reset),
    sentence,
    h('div', { class: 'rw-calib__actions' }, toggleBtn),
  );

  function setToggle(label: string, name: 'play' | 'pause'): void {
    toggleBtn.querySelector('.rw-btn__label')?.replaceChildren(label);
    toggleBtn.querySelector('svg')?.replaceWith(icon(name));
  }

  function render(): void {
    valueEl.textContent = fmtSignedMs(value);
    sentence.textContent = visualSentence(value);
    earlier.disabled = value <= VISUAL_OFFSET.min;
    later.disabled = value >= VISUAL_OFFSET.max;
  }

  function setValue(next: number): void {
    const v = clampVisualOffset(next);
    if (v === value) return;
    value = v;
    render();
    ctx.settings.update(visualOffsetPatch(ctx.settings.get(), v)).catch((err: unknown) => {
      ctx.ui.toast(`Could not save the visual offset: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
    });
  }

  function draw(): void {
    if (!loop) return;
    const width = lane.clientWidth;
    const hitX = width * 0.2;
    const pxPerSec = (width - hitX) / LANE_SEC;
    const f = visualFrame(engine.perfToCtxTime(performance.now()), value, loop.firstClick, loop.period);
    gems.forEach((g, j) => {
      const x = hitX + (f.untilNext + j * loop!.period) * pxPerSec;
      g.style.transform = `translateX(${x.toFixed(1)}px)`;
      g.style.opacity = x > width ? '0' : '1';
    });
    flash.style.opacity = f.flash.toFixed(3);
    raf = requestAnimationFrame(draw);
  }

  async function start(): Promise<void> {
    setBusy(toggleBtn, true);
    try {
      await ctx.ui.requireAudioGesture();
      await engine.resume();
    } catch (err) {
      if (!(err instanceof AudioGestureDismissedError)) ctx.ui.toast(`Could not start the clicks: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
      return;
    } finally {
      setBusy(toggleBtn, false);
    }
    const audio = engine.ctx;
    const clicks = createClickPlayer(audio, engine.buses.master);
    disposeClicks = () => clicks.dispose();
    loop = new ClickLoop({ now: () => audio.currentTime, clicks }, 60 / CALIBRATION.bpm);
    offContext = engine.onContextChange(() => stop());
    el.dataset.phase = 'running';
    setToggle('Stop clicks', 'pause');
    lane.focus({ preventScroll: true });
    raf = requestAnimationFrame(draw);
  }

  function stop(): void {
    cancelAnimationFrame(raf);
    loop?.stop();
    loop = null;
    disposeClicks?.();
    disposeClicks = null;
    offContext?.();
    offContext = null;
    el.dataset.phase = 'idle';
    setToggle('Start clicks', 'play');
    flash.style.opacity = '0';
    for (const g of gems) g.style.opacity = '0';
  }

  const offSettings = ctx.settings.subscribe((s) => {
    if (s.calibration.visualOffsetMs !== value) {
      value = s.calibration.visualOffsetMs;
      render();
    }
  });
  render();
  for (const g of gems) g.style.opacity = '0';

  return {
    el,
    stop,
    destroy() {
      stop();
      offSettings();
    },
  };
}
