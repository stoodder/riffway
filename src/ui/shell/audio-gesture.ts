/**
 * "Click to enable audio" overlay. Chrome only starts an `AudioContext` after a user gesture, so
 * screens that need sound call `ctx.ui.requireAudioGesture()`; when the engine is not running yet this
 * overlay asks for one click (anywhere on it, or Enter/Space on the button) and calls `resume()`
 * inside that gesture. "Not now" / Esc dismisses it.
 * @module
 */
import { button, h, icon, presentLayer, setBusy } from '../components';

/** The part of the audio engine the overlay needs (`AudioEngine` satisfies it). */
export interface AudioGestureTarget {
  readonly running: boolean;
  resume(): Promise<void>;
}

/** Rejection reason when the user dismisses the overlay ("Not now" / Esc). */
export class AudioGestureDismissedError extends Error {
  override readonly name = 'AudioGestureDismissedError';
  constructor() {
    super('Audio was not enabled (dismissed)');
  }
}

/**
 * Show the overlay on `host` until `target.resume()` succeeds (resolves) or the user dismisses it
 * (rejects with {@link AudioGestureDismissedError}). A failed `resume()` shows the error and lets the
 * user retry.
 */
export function promptAudioGesture(host: HTMLElement, target: AudioGestureTarget): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const error = h('p', { class: 'rw-gesture__error', role: 'alert', hidden: true });
    const enable = button({ label: 'Enable audio', variant: 'primary', size: 'lg', icon: 'power' });
    const later = button({ label: 'Not now', variant: 'ghost', size: 'sm' });
    const titleId = 'rw-gesture-title';
    const panel = h(
      'div',
      { class: 'rw-gesture__card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
      h('div', { class: 'rw-gesture__orb', 'aria-hidden': 'true' }, icon('power', { size: '40px' })),
      h('h2', { class: 'rw-gesture__title', id: titleId }, 'Click to enable audio'),
      h('p', { class: 'rw-gesture__text' }, 'Chrome needs one click before Riffway can play sound and listen to your guitar.'),
      enable,
      h('p', { class: 'rw-gesture__hint' }, icon('headphones', { size: '16px' }), 'Headphones recommended while monitoring.'),
      error,
      later,
    );
    const overlay = h('div', { class: 'rw-gesture' }, panel);

    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      layer.release();
      if (ok) resolve();
      else reject(new AudioGestureDismissedError());
    };
    const activate = (): void => {
      if (settled || enable.disabled) return;
      error.hidden = true;
      setBusy(enable, true);
      // Called synchronously inside the click so Chrome counts it as the user gesture.
      target.resume().then(
        () => finish(true),
        (err: unknown) => {
          setBusy(enable, false);
          error.textContent = `Couldn't start audio: ${err instanceof Error ? err.message : String(err)}. Try again.`;
          error.hidden = false;
          enable.focus();
        },
      );
    };

    later.addEventListener('click', (ev) => {
      ev.stopPropagation();
      finish(false);
    });
    // Any click on the overlay (outside "Not now") counts as the gesture.
    overlay.addEventListener('click', activate);
    const layer = presentLayer({ host, overlay, panel, initialFocus: enable, onEscape: () => finish(false) });
  });
}
