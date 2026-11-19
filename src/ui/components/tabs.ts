/**
 * Tabs (WAI-ARIA tabs pattern, automatic activation): ←/→ (or ↑/↓) move and select, Home/End jump,
 * only the selected tab is in the Tab order. Panels render lazily on first selection.
 * @module
 */
import { h, uid } from './dom';
import { rovingFocus } from './keyboard';

/** One tab. */
export interface TabSpec {
  id: string;
  label: string;
  /** Built on first selection; the result stays mounted (hidden) afterwards. */
  render: () => Node;
  /** Small count or badge text after the label. */
  count?: string | number;
  disabled?: boolean;
}

/** Options for {@link tabs}. */
export interface TabsOptions {
  /** Accessible name of the tab list. */
  label: string;
  tabs: readonly TabSpec[];
  selected?: string;
  /** `underline` (default, page sections) or `segmented` (compact switcher). */
  variant?: 'underline' | 'segmented';
  onChange?: (id: string) => void;
}

/** A mounted tab set. */
export interface Tabs {
  el: HTMLElement;
  select(id: string, opts?: { focus?: boolean }): void;
  selected(): string;
  destroy(): void;
}

/** Create a tab list with panels. */
export function tabs(opts: TabsOptions): Tabs {
  const base = uid('tabs');
  const list = h('div', { class: `rw-tabs__list rw-tabs__list--${opts.variant ?? 'underline'}`, role: 'tablist', 'aria-label': opts.label });
  const panels = h('div', { class: 'rw-tabs__panels' });
  const tabEls = new Map<string, HTMLButtonElement>();
  const panelEls = new Map<string, HTMLElement>();
  let current = '';

  for (const spec of opts.tabs) {
    const tabId = `${base}-tab-${spec.id}`;
    const panelId = `${base}-panel-${spec.id}`;
    const tab = h(
      'button',
      {
        type: 'button',
        class: 'rw-tabs__tab',
        role: 'tab',
        id: tabId,
        'aria-controls': panelId,
        'aria-selected': 'false',
        'aria-disabled': spec.disabled ? 'true' : undefined,
        dataset: { tab: spec.id },
      },
      h('span', null, spec.label),
      spec.count !== undefined ? h('span', { class: 'rw-tabs__count rw-num' }, String(spec.count)) : null,
    );
    tab.addEventListener('click', () => {
      if (!spec.disabled) select(spec.id);
    });
    const panel = h('div', { class: 'rw-tabs__panel', role: 'tabpanel', id: panelId, 'aria-labelledby': tabId, tabindex: '0', hidden: true });
    tabEls.set(spec.id, tab);
    panelEls.set(spec.id, panel);
    list.append(tab);
    panels.append(panel);
  }

  const items = (): HTMLElement[] => opts.tabs.map((t) => tabEls.get(t.id) as HTMLElement);
  const roving = rovingFocus(list, {
    items,
    orientation: 'both',
    activate: false,
    onMove: (item) => {
      const id = item.dataset.tab;
      if (id) select(id);
    },
  });

  function select(id: string, sopts: { focus?: boolean } = {}): void {
    const spec = opts.tabs.find((t) => t.id === id);
    if (!spec || spec.disabled) return;
    const changed = id !== current;
    current = id;
    for (const t of opts.tabs) {
      const on = t.id === id;
      tabEls.get(t.id)?.setAttribute('aria-selected', String(on));
      const panel = panelEls.get(t.id) as HTMLElement;
      panel.hidden = !on;
      if (on && panel.childNodes.length === 0) panel.append(t.render());
    }
    roving.focusItem(opts.tabs.indexOf(spec), { focus: sopts.focus ?? false });
    if (changed) opts.onChange?.(id);
  }

  const first = opts.tabs.find((t) => t.id === opts.selected && !t.disabled) ?? opts.tabs.find((t) => !t.disabled);
  if (first) {
    current = first.id;
    select(first.id);
  }

  const el = h('div', { class: 'rw-tabs' }, list, panels);
  return {
    el,
    select,
    selected: () => current,
    destroy: () => roving.destroy(),
  };
}
