/**
 * Toasts: short, non-blocking notifications stacked bottom-right. Info/success are `role="status"`
 * (polite), warnings/errors `role="alert"` (assertive). Auto-dismiss (pauses while hovered or focused), close
 * button, at most `max` visible (oldest dropped).
 * @module
 */
import type { ToastKind } from '@shared/ui';
import { h } from './dom';
import { icon, type IconName } from './icons';

/** Default auto-dismiss per kind (ms). Errors stay longer. */
export const TOAST_TIMEOUT_MS: Readonly<Record<ToastKind, number>> = {
  info: 4000,
  success: 4000,
  warning: 6000,
  error: 8000,
};

const KIND_ICON: Record<ToastKind, IconName> = { info: 'info', success: 'check', warning: 'warning', error: 'error' };

/** Options for one toast. */
export interface ToastOptions {
  kind?: ToastKind;
  /** Auto-dismiss after this many ms; `0` keeps it until closed. */
  timeoutMs?: number;
}

/** A toast stack bound to a host element. */
export interface Toaster {
  /** The stack element (already appended to the host). */
  el: HTMLElement;
  /** Show a toast; returns a function that dismisses it. */
  show(message: string, opts?: ToastOptions): () => void;
  clear(): void;
}

/** Create a toast stack inside `host`. */
export function createToaster(host: HTMLElement, opts: { max?: number } = {}): Toaster {
  const max = opts.max ?? 4;
  const el = h('section', { class: 'rw-toasts', 'aria-label': 'Notifications' });
  host.append(el);
  const live = new Set<() => void>();

  const show = (message: string, topts: ToastOptions = {}): (() => void) => {
    const kind = topts.kind ?? 'info';
    const timeout = topts.timeoutMs ?? TOAST_TIMEOUT_MS[kind];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let remaining = timeout;
    let startedAt = 0;
    const toastEl = h(
      'div',
      {
        class: `rw-toast rw-toast--${kind}`,
        role: kind === 'warning' || kind === 'error' ? 'alert' : 'status',
        dataset: { kind },
      },
      h('span', { class: 'rw-toast__icon' }, icon(KIND_ICON[kind])),
      h('p', { class: 'rw-toast__message' }, message),
    );
    const dismiss = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      live.delete(dismiss);
      toastEl.remove();
    };
    const closeBtn = h(
      'button',
      { type: 'button', class: 'rw-toast__close', 'aria-label': 'Dismiss notification', on: { click: dismiss } },
      icon('close', { size: '16px' }),
    );
    toastEl.append(closeBtn);
    const start = (): void => {
      if (timeout <= 0 || timer) return;
      startedAt = Date.now();
      timer = setTimeout(dismiss, remaining);
    };
    const pause = (): void => {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      remaining = Math.max(500, remaining - (Date.now() - startedAt));
    };
    toastEl.addEventListener('pointerenter', pause);
    toastEl.addEventListener('pointerleave', start);
    toastEl.addEventListener('focusin', pause);
    toastEl.addEventListener('focusout', start);

    el.append(toastEl);
    live.add(dismiss);
    // Drop the oldest beyond `max` (insertion order = DOM order = Set order).
    for (const old of [...live].slice(0, Math.max(0, live.size - max))) old();
    start();
    return dismiss;
  };

  return {
    el,
    show,
    clear() {
      [...live].forEach((d) => d());
    },
  };
}
