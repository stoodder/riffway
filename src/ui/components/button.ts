/**
 * Buttons: primary (one per view), secondary, ghost, danger; three sizes; optional icon or icon-only.
 * @module
 */
import { h } from './dom';
import { icon, type IconName } from './icons';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

/** Options for {@link button}. */
export interface ButtonOptions {
  /** Visible text, or the accessible name when `iconOnly`. */
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  /** Icon after the label (e.g. chevrons). */
  trailingIcon?: IconName;
  /** Render only the icon; `label` becomes `aria-label` and the tooltip. */
  iconOnly?: boolean;
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  /** Tooltip (`title`). */
  title?: string;
  onClick?: (ev: MouseEvent) => void;
}

/** Create a `<button class="rw-btn">`. */
export function button(opts: ButtonOptions): HTMLButtonElement {
  const variant = opts.variant ?? 'secondary';
  const size = opts.size ?? 'md';
  const classes = ['rw-btn', `rw-btn--${variant}`, `rw-btn--${size}`];
  if (opts.iconOnly) classes.push('rw-btn--icon');
  const btn = h(
    'button',
    {
      class: classes.join(' '),
      type: opts.type ?? 'button',
      disabled: opts.disabled,
      title: opts.title ?? (opts.iconOnly ? opts.label : undefined),
      'aria-label': opts.iconOnly ? opts.label : undefined,
      on: opts.onClick ? { click: opts.onClick } : undefined,
    },
    opts.icon ? icon(opts.icon) : null,
    opts.iconOnly ? null : h('span', { class: 'rw-btn__label' }, opts.label),
    opts.trailingIcon && !opts.iconOnly ? icon(opts.trailingIcon) : null,
  );
  return btn;
}

/** Toggle a button's busy state (spinner, `aria-busy`, disabled while busy). */
export function setBusy(btn: HTMLButtonElement, busy: boolean): void {
  btn.classList.toggle('rw-btn--busy', busy);
  btn.disabled = busy;
  if (busy) btn.setAttribute('aria-busy', 'true');
  else btn.removeAttribute('aria-busy');
}
