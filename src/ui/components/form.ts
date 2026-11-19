/**
 * Form controls: slider, toggle (switch) and select. Each returns `{ el, … }` where `el` is the
 * labelled field wrapper to insert, plus typed accessors for the value.
 * @module
 */
import { h, uid } from './dom';
import { icon } from './icons';

/** Options for {@link slider}. */
export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  /** Readout text (also `aria-valuetext`), e.g. `v => `${Math.round(v * 100)}%``. */
  format?: (value: number) => string;
  /** Hint under the control. */
  hint?: string;
  disabled?: boolean;
  /** Fires continuously while dragging. */
  onInput?: (value: number) => void;
  /** Fires when the user commits a value (release / key up). */
  onChange?: (value: number) => void;
}

/** A labelled range slider. */
export interface Slider {
  el: HTMLElement;
  input: HTMLInputElement;
  readonly value: number;
  /** Set the value programmatically (no callbacks). */
  set(value: number): void;
  setDisabled(disabled: boolean): void;
}

/** A labelled range slider with a value readout and an accent fill. */
export function slider(opts: SliderOptions): Slider {
  const id = uid('slider');
  const format = opts.format ?? ((v: number) => String(v));
  const input = h('input', {
    id,
    class: 'rw-slider__input',
    type: 'range',
    min: opts.min,
    max: opts.max,
    step: opts.step ?? 1,
    disabled: opts.disabled,
  });
  const readout = h('output', { class: 'rw-slider__value rw-num', for: id });
  const hintId = opts.hint ? uid('hint') : undefined;
  if (hintId) input.setAttribute('aria-describedby', hintId);
  const el = h(
    'div',
    { class: 'rw-field rw-slider' },
    h('div', { class: 'rw-field__top' }, h('label', { class: 'rw-field__label', for: id }, opts.label), readout),
    input,
    opts.hint ? h('p', { class: 'rw-field__hint', id: hintId }, opts.hint) : null,
  );
  const sync = (): void => {
    const v = Number(input.value);
    const pct = opts.max === opts.min ? 0 : ((v - opts.min) / (opts.max - opts.min)) * 100;
    input.style.setProperty('--fill', `${pct}%`);
    const text = format(v);
    readout.textContent = text;
    input.setAttribute('aria-valuetext', text);
  };
  const set = (value: number): void => {
    input.value = String(Math.min(opts.max, Math.max(opts.min, value)));
    sync();
  };
  input.addEventListener('input', () => {
    sync();
    opts.onInput?.(Number(input.value));
  });
  input.addEventListener('change', () => opts.onChange?.(Number(input.value)));
  set(opts.value);
  return {
    el,
    input,
    get value() {
      return Number(input.value);
    },
    set,
    setDisabled(disabled) {
      input.disabled = disabled;
    },
  };
}

/** Options for {@link toggle}. */
export interface ToggleOptions {
  label: string;
  checked: boolean;
  /** Secondary text under the label. */
  description?: string;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}

/** A labelled on/off switch. */
export interface Toggle {
  el: HTMLElement;
  button: HTMLButtonElement;
  readonly checked: boolean;
  /** Set the state programmatically (no callback). */
  set(checked: boolean): void;
}

/** An on/off switch (`role="switch"`). Click, Space or Enter toggles. */
export function toggle(opts: ToggleOptions): Toggle {
  const labelId = uid('toggle');
  const descId = opts.description ? uid('desc') : undefined;
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'rw-switch',
      role: 'switch',
      'aria-labelledby': labelId,
      'aria-describedby': descId,
      disabled: opts.disabled,
    },
    h('span', { class: 'rw-switch__thumb' }),
  );
  let checked = opts.checked;
  const set = (v: boolean): void => {
    checked = v;
    btn.setAttribute('aria-checked', String(v));
  };
  btn.addEventListener('click', () => {
    set(!checked);
    opts.onChange?.(checked);
  });
  set(checked);
  const el = h(
    'div',
    { class: 'rw-field rw-toggle' },
    h(
      'div',
      { class: 'rw-toggle__text' },
      h('span', { class: 'rw-field__label', id: labelId, on: { click: () => btn.click() } }, opts.label),
      opts.description ? h('span', { class: 'rw-field__hint', id: descId }, opts.description) : null,
    ),
    btn,
  );
  return {
    el,
    button: btn,
    get checked() {
      return checked;
    },
    set,
  };
}

/** One select option. */
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** Options for {@link select}. */
export interface SelectOptions {
  label: string;
  options: readonly SelectOption[];
  value?: string;
  hint?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
}

/** A labelled native select. */
export interface Select {
  el: HTMLElement;
  select: HTMLSelectElement;
  readonly value: string;
  set(value: string): void;
  /** Replace the options (keeps the value if still present). */
  setOptions(options: readonly SelectOption[]): void;
}

/** A labelled native `<select>` styled to match (keyboard and screen-reader behaviour stay native). */
export function select(opts: SelectOptions): Select {
  const id = uid('select');
  const hintId = opts.hint ? uid('hint') : undefined;
  const sel = h('select', { id, class: 'rw-select__input', disabled: opts.disabled, 'aria-describedby': hintId });
  const fill = (options: readonly SelectOption[]): void => {
    const prev = sel.value;
    sel.replaceChildren(...options.map((o) => h('option', { value: o.value, disabled: o.disabled }, o.label)));
    if (options.some((o) => o.value === prev)) sel.value = prev;
  };
  fill(opts.options);
  if (opts.value !== undefined) sel.value = opts.value;
  sel.addEventListener('change', () => opts.onChange?.(sel.value));
  const el = h(
    'div',
    { class: 'rw-field rw-select' },
    h('label', { class: 'rw-field__label', for: id }, opts.label),
    h('div', { class: 'rw-select__wrap' }, sel, icon('chevronDown')),
    opts.hint ? h('p', { class: 'rw-field__hint', id: hintId }, opts.hint) : null,
  );
  return {
    el,
    select: sel,
    get value() {
      return sel.value;
    },
    set(value) {
      sel.value = value;
    },
    setOptions: fill,
  };
}
