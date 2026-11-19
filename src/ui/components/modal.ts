/**
 * Modal dialog: overlay + centred panel (`role="dialog"`, `aria-modal`), focus moved inside and
 * trapped (Tab cycles; the rest of the page is `inert`), Esc / overlay click / close button dismiss
 * (unless `dismissible: false`), focus returns to the opener on close. Also `confirmDialog`.
 * @module
 */
import { button, type ButtonOptions } from './button';
import { focusables, h, uid, type Child } from './dom';

/** A footer action; resolves the modal with `value` when clicked (unless `onClick` prevents it). */
export interface ModalAction extends Omit<ButtonOptions, 'onClick'> {
  value: string;
  /** Receive focus when the modal opens (default: the first action, else the close button). */
  autofocus?: boolean;
}

/** Options for {@link openModal}. */
export interface ModalOptions {
  title: string;
  /** Body content (text is wrapped in a paragraph). */
  content?: Child | readonly Child[];
  actions?: readonly ModalAction[];
  /** Esc / overlay / close button allowed (default true); they resolve with `null`. */
  dismissible?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** Where to attach (default `document.body`). */
  host?: HTMLElement;
}

/** An open modal. */
export interface Modal {
  el: HTMLElement;
  /** Body container (to update content while open). */
  body: HTMLElement;
  /** Close with a value (`null` = dismissed). Idempotent. */
  close(value?: string | null): void;
  /** Resolves with the action value, or `null` when dismissed. */
  readonly result: Promise<string | null>;
}

/** Options for {@link presentLayer}. */
export interface LayerOptions {
  host: HTMLElement;
  /** Full-screen element appended to `host`. */
  overlay: HTMLElement;
  /** Focus stays inside this element (Tab / Shift+Tab cycle). */
  panel: HTMLElement;
  initialFocus: HTMLElement;
  /** Esc inside the layer (default: nothing). */
  onEscape?: () => void;
}

/**
 * Present a modal layer: append `overlay` to `host`, make the host's other children `inert`, move focus
 * to `initialFocus`, trap Tab inside `panel`, route Esc to `onEscape`. `release()` undoes all of it and
 * returns focus to the element that had it before. Shared by modals and the audio-gesture overlay.
 */
export function presentLayer(opts: LayerOptions): { release(): void } {
  const { host, overlay, panel } = opts;
  const doc = host.ownerDocument;
  const opener = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      opts.onEscape?.();
    } else if (ev.key === 'Tab') {
      const items = focusables(panel);
      const first = items[0];
      const last = items[items.length - 1];
      const active = doc.activeElement;
      if (!first || !last) {
        ev.preventDefault();
        panel.focus();
      } else if (ev.shiftKey && (active === first || active === panel)) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && active === last) {
        ev.preventDefault();
        first.focus();
      }
    }
  };
  overlay.addEventListener('keydown', onKeyDown);
  const inerted = Array.from(host.children).filter((c): c is HTMLElement => c instanceof HTMLElement && !c.inert);
  inerted.forEach((c) => (c.inert = true));
  host.append(overlay);
  opts.initialFocus.focus();
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      overlay.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      inerted.forEach((c) => (c.inert = false));
      if (opener?.isConnected) opener.focus();
    },
  };
}

/** Open a modal dialog. */
export function openModal(opts: ModalOptions): Modal {
  const host = opts.host ?? document.body;
  const dismissible = opts.dismissible ?? true;
  const titleId = uid('modal-title');

  let resolve: (v: string | null) => void = () => {};
  const result = new Promise<string | null>((r) => (resolve = r));

  const body = h(
    'div',
    { class: 'rw-modal__body' },
    ...[opts.content ?? []].flat().map((c) => (typeof c === 'string' ? h('p', null, c) : c)),
  );
  const actionButtons = (opts.actions ?? []).map((a) => button({ ...a, onClick: () => close(a.value) }));
  const closeBtn = dismissible ? button({ label: 'Close', icon: 'close', iconOnly: true, variant: 'ghost', size: 'sm', onClick: () => close(null) }) : null;
  const panel = h(
    'div',
    { class: `rw-modal rw-modal--${opts.size ?? 'md'}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    h('header', { class: 'rw-modal__header' }, h('h2', { class: 'rw-modal__title', id: titleId }, opts.title), closeBtn),
    body,
    actionButtons.length ? h('footer', { class: 'rw-modal__footer' }, ...actionButtons) : null,
  );
  const overlay = h('div', { class: 'rw-modal-overlay' }, panel);

  overlay.addEventListener('pointerdown', (ev) => {
    if (ev.target === overlay && dismissible) close(null);
  });
  const autofocusIndex = (opts.actions ?? []).findIndex((a) => a.autofocus);
  const layer = presentLayer({
    host,
    overlay,
    panel,
    initialFocus: actionButtons[autofocusIndex >= 0 ? autofocusIndex : 0] ?? closeBtn ?? panel,
    onEscape: () => {
      if (dismissible) close(null);
    },
  });

  let open = true;
  function close(value: string | null = null): void {
    if (!open) return;
    open = false;
    layer.release();
    resolve(value);
  }

  return { el: panel, body, close, result };
}

/** Options for {@link confirmDialog}. */
export interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive action: confirm button is red and Cancel gets initial focus. */
  danger?: boolean;
  host?: HTMLElement;
}

/** Ask a yes/no question. Resolves true only when the confirm button is chosen. */
export async function confirmDialog(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  const modal = openModal({
    title: opts.title ?? 'Are you sure?',
    content: message,
    size: 'sm',
    host: opts.host,
    actions: [
      { label: opts.cancelLabel ?? 'Cancel', value: 'cancel', variant: 'ghost', autofocus: Boolean(opts.danger) },
      { label: opts.confirmLabel ?? 'OK', value: 'confirm', variant: opts.danger ? 'danger' : 'primary', autofocus: !opts.danger },
    ],
  });
  return (await modal.result) === 'confirm';
}
