// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmDialog, h, menuButton, openModal, rovingFocus, tabs } from '../../src/ui/components';

function key(target: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
}

const active = (): Element | null => document.activeElement;

afterEach(() => {
  document.body.replaceChildren();
});

describe('rovingFocus', () => {
  function setup(opts: Partial<Parameters<typeof rovingFocus>[1]> = {}) {
    const items = ['a', 'b', 'c', 'd'].map((t) => h('button', { type: 'button' }, t));
    const group = h('div', null, ...items);
    document.body.append(group);
    const roving = rovingFocus(group, { items: () => items, orientation: 'horizontal', ...opts });
    return { items, group, roving };
  }

  it('keeps exactly one item tabbable', () => {
    const { items } = setup();
    expect(items.map((b) => b.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
  });

  it('moves with arrows, wraps, and jumps with Home/End', () => {
    const { items } = setup();
    items[0]?.focus();
    key(items[0] as Element, 'ArrowRight');
    expect(active()).toBe(items[1]);
    expect(items.map((b) => b.getAttribute('tabindex'))).toEqual(['-1', '0', '-1', '-1']);
    key(items[1] as Element, 'ArrowLeft');
    key(items[0] as Element, 'ArrowLeft');
    expect(active()).toBe(items[3]);
    key(items[3] as Element, 'Home');
    expect(active()).toBe(items[0]);
    key(items[0] as Element, 'End');
    expect(active()).toBe(items[3]);
    // Vertical keys are ignored in a horizontal group.
    const ev = key(items[3] as Element, 'ArrowDown');
    expect(ev.defaultPrevented).toBe(false);
    expect(active()).toBe(items[3]);
  });

  it('stops at the ends without wrap and skips disabled items', () => {
    const { items } = setup({ wrap: false });
    items[1]?.setAttribute('aria-disabled', 'true');
    items[0]?.focus();
    key(items[0] as Element, 'ArrowRight');
    expect(active()).toBe(items[2]);
    key(items[2] as Element, 'ArrowRight');
    key(items[3] as Element, 'ArrowRight');
    expect(active()).toBe(items[3]);
  });

  it('calls onEscape and activates non-native items with Enter/Space', () => {
    const onEscape = vi.fn();
    const divs = ['x', 'y'].map((t) => h('div', { role: 'option' }, t));
    const group = h('div', null, ...divs);
    document.body.append(group);
    rovingFocus(group, { items: () => divs, orientation: 'vertical', onEscape });
    const clicked = vi.fn();
    divs[1]?.addEventListener('click', clicked);
    divs[0]?.focus();
    key(divs[0] as Element, 'ArrowDown');
    expect(active()).toBe(divs[1]);
    expect(key(divs[1] as Element, 'Enter').defaultPrevented).toBe(true);
    key(divs[1] as Element, ' ');
    expect(clicked).toHaveBeenCalledTimes(2);
    expect(key(divs[1] as Element, 'Escape').defaultPrevented).toBe(true);
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it('tracks focus moved by mouse/Tab and can be destroyed', () => {
    const { items, roving } = setup();
    items[2]?.focus();
    expect(roving.current()).toBe(2);
    roving.destroy();
    key(items[2] as Element, 'ArrowRight');
    expect(active()).toBe(items[2]);
  });
});

describe('menuButton', () => {
  function setup() {
    const chosen: string[] = [];
    const menu = menuButton({
      trigger: { label: 'Actions' },
      items: [
        { id: 'play', label: 'Play', onSelect: () => chosen.push('play') },
        { id: 'off', label: 'Off', disabled: true, onSelect: () => chosen.push('off') },
        { id: 'loop', label: 'Loop', onSelect: () => chosen.push('loop') },
      ],
    });
    document.body.append(menu.el);
    const items = Array.from(menu.el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    return { menu, items, chosen };
  }

  it('opens on click (Enter/Space) with focus on the first item and wires ARIA', () => {
    const { menu, items } = setup();
    expect(menu.trigger.getAttribute('aria-haspopup')).toBe('menu');
    menu.trigger.click();
    expect(menu.isOpen).toBe(true);
    expect(menu.trigger.getAttribute('aria-expanded')).toBe('true');
    expect(active()).toBe(items[0]);
  });

  it('ArrowUp on the trigger opens on the last enabled item; arrows skip disabled items', () => {
    const { menu, items } = setup();
    menu.trigger.focus();
    key(menu.trigger, 'ArrowUp');
    expect(active()).toBe(items[2]);
    key(items[2] as Element, 'ArrowUp');
    expect(active()).toBe(items[0]);
    key(items[0] as Element, 'ArrowDown');
    expect(active()).toBe(items[2]);
  });

  it('Enter chooses, closes and returns focus to the trigger', () => {
    const { menu, items, chosen } = setup();
    menu.trigger.focus();
    key(menu.trigger, 'ArrowDown');
    key(items[0] as Element, 'ArrowDown');
    key(items[2] as Element, 'Enter');
    expect(chosen).toEqual(['loop']);
    expect(menu.isOpen).toBe(false);
    expect(active()).toBe(menu.trigger);
  });

  it('Esc closes without choosing; disabled items cannot be chosen; outside pointer closes', () => {
    const { menu, items, chosen } = setup();
    menu.open();
    key(items[0] as Element, 'Escape');
    expect(menu.isOpen).toBe(false);
    expect(active()).toBe(menu.trigger);
    menu.open();
    items[1]?.click();
    expect(chosen).toEqual([]);
    expect(menu.isOpen).toBe(true);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(menu.isOpen).toBe(false);
  });
});

describe('tabs', () => {
  it('selects with arrows (automatic activation), renders panels lazily, skips disabled tabs', () => {
    const render = vi.fn(() => h('p', null, 'B panel'));
    const onChange = vi.fn();
    const t = tabs({
      label: 'Demo',
      onChange,
      tabs: [
        { id: 'a', label: 'A', render: () => h('p', null, 'A panel') },
        { id: 'b', label: 'B', render },
        { id: 'c', label: 'C', disabled: true, render: () => h('p') },
      ],
    });
    document.body.append(t.el);
    const tabEls = Array.from(t.el.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const panels = Array.from(t.el.querySelectorAll<HTMLElement>('[role="tabpanel"]'));
    expect(t.selected()).toBe('a');
    expect(render).not.toHaveBeenCalled();
    expect(tabEls[0]?.getAttribute('aria-controls')).toBe(panels[0]?.id);
    tabEls[0]?.focus();
    key(tabEls[0] as Element, 'ArrowRight');
    expect(t.selected()).toBe('b');
    expect(active()).toBe(tabEls[1]);
    expect(tabEls.map((e) => e.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(panels.map((p) => p.hidden)).toEqual([true, false, true]);
    expect(onChange).toHaveBeenCalledWith('b');
    key(tabEls[1] as Element, 'ArrowRight');
    expect(t.selected()).toBe('a');
    key(tabEls[0] as Element, 'ArrowRight');
    expect(render).toHaveBeenCalledOnce();
  });
});

describe('modal', () => {
  it('moves focus in, traps Tab, closes on Esc and restores focus', async () => {
    const opener = h('button', { type: 'button' }, 'Open');
    const app = h('div', { id: 'app' }, opener);
    document.body.append(app);
    opener.focus();
    const modal = openModal({
      title: 'Hello',
      content: 'Body',
      actions: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'OK', value: 'ok', autofocus: true },
      ],
    });
    expect(modal.el.getAttribute('role')).toBe('dialog');
    expect(modal.el.getAttribute('aria-modal')).toBe('true');
    expect(app.inert).toBe(true);
    const buttons = Array.from(modal.el.querySelectorAll('button'));
    const [closeBtn, , ok] = buttons;
    expect(active()).toBe(ok);
    key(ok as Element, 'Tab');
    expect(active()).toBe(closeBtn);
    key(closeBtn as Element, 'Tab', { shiftKey: true });
    expect(active()).toBe(ok);
    key(ok as Element, 'Escape');
    expect(await modal.result).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(app.inert).toBe(false);
    expect(active()).toBe(opener);
  });

  it('resolves with the chosen action; non-dismissible modals ignore Esc', async () => {
    const modal = openModal({ title: 'Pick', dismissible: false, actions: [{ label: 'Go', value: 'go' }] });
    key(modal.el, 'Escape');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    modal.el.querySelector('button')?.click();
    expect(await modal.result).toBe('go');
  });

  it('confirmDialog resolves true on confirm and focuses Cancel for danger', async () => {
    const pending = confirmDialog('Delete it?', { title: 'Delete', confirmLabel: 'Delete', danger: true });
    expect(active()?.textContent).toBe('Cancel');
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Delete')?.click();
    expect(await pending).toBe(true);
    const confirmed = confirmDialog('Sure?');
    (active() as HTMLElement).click(); // OK has focus when not dangerous
    expect(await confirmed).toBe(true);
    const dismissed = confirmDialog('Sure?');
    key(active() as Element, 'Escape');
    expect(await dismissed).toBe(false);
  });
});
