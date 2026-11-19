/**
 * Small building blocks shared by the settings sections: a radio-card group, a section wrapper and
 * a binder that keeps controls in step with the settings store (imports and resets change settings
 * from elsewhere) and saves patches with an error toast.
 * @module
 */
import type { DeepPartial, Settings } from '@shared/settings';
import type { AppContext } from '@shared/ui';
import { h, uid, type Child } from '../../components';

/** One option of a {@link choiceGroup}. */
export interface Choice<V extends string> {
  value: V;
  label: string;
  description?: string;
  /** Small badge text after the label ("Recommended"). */
  tag?: string;
}

/** Options for {@link choiceGroup}. */
export interface ChoiceGroupOptions<V extends string> {
  /** Group label (the `legend`). */
  label: string;
  hint?: string;
  choices: readonly Choice<V>[];
  value: V;
  /** `cards` (stacked, with descriptions) or `inline` (compact segmented row). */
  layout?: 'cards' | 'inline';
  onChange: (value: V) => void;
}

/** A radio group whose value can also be set from outside. */
export interface ChoiceGroup<V extends string> {
  el: HTMLFieldSetElement;
  readonly value: V;
  set(value: V): void;
}

/**
 * A native radio group styled as cards or a segmented row: arrow keys move and select, the whole
 * card is the click target, and the legend names the group for screen readers.
 */
export function choiceGroup<V extends string>(opts: ChoiceGroupOptions<V>): ChoiceGroup<V> {
  const name = uid('choice');
  const hintId = opts.hint ? uid('hint') : undefined;
  let value = opts.value;
  const inputs = opts.choices.map((c) => {
    const id = `${name}-${c.value}`;
    const descId = c.description ? `${id}-desc` : undefined;
    const input = h('input', { type: 'radio', class: 'set-choice__input', name, id, value: c.value, 'aria-describedby': descId });
    input.addEventListener('change', () => {
      if (!input.checked) return;
      value = c.value;
      opts.onChange(c.value);
    });
    const label = h(
      'label',
      { class: 'set-choice__option', for: id },
      input,
      h(
        'span',
        { class: 'set-choice__text' },
        h('span', { class: 'set-choice__label' }, c.label, c.tag ? h('span', { class: 'set-choice__tag' }, c.tag) : null),
        c.description ? h('span', { class: 'set-choice__desc', id: descId }, c.description) : null,
      ),
    );
    return { input, label, value: c.value };
  });
  const el = h(
    'fieldset',
    { class: `set-choice set-choice--${opts.layout ?? 'cards'}`, 'aria-describedby': hintId },
    h('legend', { class: 'rw-field__label set-choice__legend' }, opts.label),
    h('div', { class: 'set-choice__options' }, inputs.map((i) => i.label)),
    opts.hint ? h('p', { class: 'rw-field__hint', id: hintId }, opts.hint) : null,
  );
  const set = (v: V): void => {
    value = v;
    for (const i of inputs) i.input.checked = i.value === v;
  };
  set(value);
  return {
    el,
    get value() {
      return value;
    },
    set,
  };
}

/** A titled settings section (`h2` + intro + body). */
export function section(title: string, intro: Child, ...body: Child[]): HTMLElement {
  const id = uid('set-sec');
  return h(
    'section',
    { class: 'set-section', 'aria-labelledby': id },
    h('header', { class: 'set-section__head' }, h('h2', { class: 'set-section__title', id }, title), intro ? h('p', { class: 'set-section__intro rw-muted' }, intro) : null),
    h('div', { class: 'set-section__body' }, ...body),
  );
}

/** A group of related controls inside a section, optionally with a sub-heading. */
export function group(title: string | null, ...children: Child[]): HTMLElement {
  return h('div', { class: 'set-group' }, title ? h('h3', { class: 'set-group__title' }, title) : null, h('div', { class: 'set-group__body' }, ...children));
}

/** Keeps controls in step with the store and saves patches. */
export interface Binder {
  /** Register a function that refreshes a control from settings (called now and on every change). */
  bind(sync: (s: Settings) => void): void;
  /** Persist a patch; failures toast and re-sync the controls to the stored value. */
  save(patch: DeepPartial<Settings>): Promise<void>;
  destroy(): void;
}

/** Create a {@link Binder} over `ctx.settings`. */
export function binder(ctx: AppContext): Binder {
  const syncs: ((s: Settings) => void)[] = [];
  const unsub = ctx.settings.subscribe((s) => {
    for (const fn of syncs) fn(s);
  });
  return {
    bind(sync) {
      syncs.push(sync);
      sync(ctx.settings.get());
    },
    async save(patch) {
      try {
        await ctx.settings.update(patch);
      } catch (err) {
        ctx.ui.toast(`Couldn’t save that setting: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
        const current = ctx.settings.get();
        for (const fn of syncs) fn(current);
      }
    },
    destroy() {
      unsub();
      syncs.length = 0;
    },
  };
}
