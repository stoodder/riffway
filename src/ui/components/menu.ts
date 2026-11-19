/**
 * Menu button (WAI-ARIA menu button pattern): click, Enter, Space or ↓ open on the first item, ↑ opens
 * on the last; inside, ↑/↓ move, Home/End jump, Enter/Space choose, Esc closes and returns focus to the
 * button, Tab closes. Clicking outside closes.
 * @module
 */
import { button, type ButtonOptions } from './button';
import { h, uid } from './dom';
import { icon, type IconName } from './icons';
import { rovingFocus } from './keyboard';

/** One menu item. */
export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  /** Right-aligned hint (e.g. a shortcut). */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** Options for {@link menuButton}. */
export interface MenuButtonOptions {
  /** Trigger button (label is also the menu's accessible name). */
  trigger: ButtonOptions;
  items: readonly MenuItem[];
  /** Align the popup to the trigger's start or end edge (default end). */
  align?: 'start' | 'end';
}

/** A mounted menu button. */
export interface MenuButton {
  el: HTMLElement;
  trigger: HTMLButtonElement;
  open(focus?: 'first' | 'last'): void;
  close(opts?: { restoreFocus?: boolean }): void;
  readonly isOpen: boolean;
  destroy(): void;
}

/** Create a menu button with a popup menu. */
export function menuButton(opts: MenuButtonOptions): MenuButton {
  const menuId = uid('menu');
  const trigger = button({ trailingIcon: opts.trigger.iconOnly ? undefined : 'chevronDown', ...opts.trigger });
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', menuId);
  const triggerId = trigger.id || uid('menubtn');
  trigger.id = triggerId;

  const itemEls = opts.items.map((item) =>
    h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        class: `rw-menu__item${item.danger ? ' rw-menu__item--danger' : ''}`,
        'aria-disabled': item.disabled ? 'true' : undefined,
        dataset: { item: item.id },
      },
      item.icon ? icon(item.icon) : h('span', { class: 'rw-menu__spacer' }),
      h('span', { class: 'rw-menu__label' }, item.label),
      item.hint ? h('span', { class: 'rw-menu__hint' }, item.hint) : null,
    ),
  );
  const menu = h('div', { class: 'rw-menu', role: 'menu', id: menuId, 'aria-labelledby': triggerId, hidden: true }, ...itemEls);
  const el = h('div', { class: `rw-menu-anchor rw-menu-anchor--${opts.align ?? 'end'}` }, trigger, menu);

  let isOpen = false;
  const roving = rovingFocus(menu, { items: () => itemEls, orientation: 'vertical', activate: false });

  const choose = (i: number): void => {
    const item = opts.items[i];
    if (!item || item.disabled) return;
    close({ restoreFocus: true });
    item.onSelect();
  };

  const onDocPointer = (ev: Event): void => {
    if (!el.contains(ev.target as Node)) close({ restoreFocus: false });
  };

  function open(focus: 'first' | 'last' = 'first'): void {
    if (!isOpen) {
      isOpen = true;
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      el.ownerDocument.addEventListener('pointerdown', onDocPointer, true);
    }
    const enabled = opts.items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
    const target = focus === 'first' ? enabled[0] : enabled[enabled.length - 1];
    if (target !== undefined) roving.focusItem(target);
  }

  function close(copts: { restoreFocus?: boolean } = {}): void {
    if (!isOpen) return;
    isOpen = false;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    el.ownerDocument.removeEventListener('pointerdown', onDocPointer, true);
    if (copts.restoreFocus !== false) trigger.focus();
  }

  // Enter/Space on the trigger arrive here as a native click.
  trigger.addEventListener('click', () => (isOpen ? close() : open('first')));
  trigger.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      open('first');
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      open('last');
    }
  });
  menu.addEventListener('keydown', (ev) => {
    const i = itemEls.indexOf(ev.target as HTMLButtonElement);
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      close();
    } else if (ev.key === 'Tab') close({ restoreFocus: false });
    else if ((ev.key === 'Enter' || ev.key === ' ') && i >= 0) {
      ev.preventDefault();
      choose(i);
    }
  });
  itemEls.forEach((item, i) => item.addEventListener('click', () => choose(i)));

  return {
    el,
    trigger,
    open,
    close,
    get isOpen() {
      return isOpen;
    },
    destroy() {
      close({ restoreFocus: false });
      roving.destroy();
    },
  };
}
