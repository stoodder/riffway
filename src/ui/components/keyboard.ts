/**
 * Keyboard navigation for menus, nav bars, tab lists and item lists (roving `tabindex`).
 * One item in the group is tabbable (`tabindex=0`), the rest `-1`; arrow keys move focus,
 * Home/End jump, Enter/Space activate non-native items, Esc calls `onEscape`.
 * @module
 */

/** Which arrow keys move focus. */
export type RovingOrientation = 'horizontal' | 'vertical' | 'both';

/** Options for {@link rovingFocus}. */
export interface RovingFocusOptions {
  /** Items in navigation order (re-read on every key press, so the list may change). */
  items: () => HTMLElement[];
  orientation?: RovingOrientation;
  /** Wrap from last to first and back (default true). */
  wrap?: boolean;
  /** Called on Esc while focus is inside the group (the event is then `preventDefault`ed). */
  onEscape?: (ev: KeyboardEvent) => void;
  /** Called after an arrow/Home/End moved focus to `item` (e.g. tabs select on focus). */
  onMove?: (item: HTMLElement, index: number) => void;
  /**
   * Enter/Space call `item.click()` (default true). Native links/buttons get the browser's own Enter
   * behaviour, so only Space on links and Enter/Space on other elements are synthesised.
   */
  activate?: boolean;
}

/** Handle returned by {@link rovingFocus}. */
export interface RovingFocus {
  /** Make `index` the tabbable item (and focus it unless `focus: false`). */
  focusItem(index: number, opts?: { focus?: boolean }): void;
  /** Re-apply tabindexes after items were added/removed (keeps the current item when possible). */
  refresh(): void;
  /** Index of the tabbable item. */
  current(): number;
  destroy(): void;
}

const NEXT: Record<RovingOrientation, string[]> = {
  horizontal: ['ArrowRight'],
  vertical: ['ArrowDown'],
  both: ['ArrowRight', 'ArrowDown'],
};
const PREV: Record<RovingOrientation, string[]> = {
  horizontal: ['ArrowLeft'],
  vertical: ['ArrowUp'],
  both: ['ArrowLeft', 'ArrowUp'],
};

function isNativeActivatable(el: HTMLElement): boolean {
  return el instanceof HTMLButtonElement || (el instanceof HTMLAnchorElement && el.hasAttribute('href'));
}

function isDisabled(el: HTMLElement): boolean {
  return el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled === true;
}

/**
 * Install roving-focus keyboard navigation on `container`.
 * @example rovingFocus(nav, { items: () => [...nav.querySelectorAll('a')], orientation: 'horizontal' })
 */
export function rovingFocus(container: HTMLElement, opts: RovingFocusOptions): RovingFocus {
  const orientation = opts.orientation ?? 'both';
  const wrap = opts.wrap ?? true;
  const activate = opts.activate ?? true;
  let index = 0;

  const enabledItems = (): HTMLElement[] => opts.items();

  const applyTabindex = (items: HTMLElement[]): void => {
    items.forEach((el, i) => el.setAttribute('tabindex', i === index ? '0' : '-1'));
  };

  const focusItem = (i: number, fopts: { focus?: boolean } = {}): void => {
    const items = enabledItems();
    if (items.length === 0) return;
    index = Math.min(items.length - 1, Math.max(0, i));
    applyTabindex(items);
    if (fopts.focus !== false) items[index]?.focus();
  };

  const step = (items: HTMLElement[], from: number, dir: 1 | -1): number => {
    const n = items.length;
    let i = from;
    for (let tries = 0; tries < n; tries++) {
      let next = i + dir;
      if (next < 0 || next >= n) {
        if (!wrap) return from;
        next = (next + n) % n;
      }
      i = next;
      if (!isDisabled(items[i] as HTMLElement)) return i;
    }
    return from;
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.defaultPrevented || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const items = enabledItems();
    const target = ev.target as HTMLElement | null;
    const pos = target ? items.findIndex((el) => el === target || el.contains(target)) : -1;
    if (ev.key === 'Escape') {
      if (opts.onEscape) {
        ev.preventDefault();
        opts.onEscape(ev);
      }
      return;
    }
    if (pos < 0) return;
    let next: number;
    if (NEXT[orientation].includes(ev.key)) next = step(items, pos, 1);
    else if (PREV[orientation].includes(ev.key)) next = step(items, pos, -1);
    else if (ev.key === 'Home') next = step(items, -1, 1);
    else if (ev.key === 'End') next = step(items, items.length, -1);
    else if (activate && (ev.key === 'Enter' || ev.key === ' ')) {
      const item = items[pos] as HTMLElement;
      const native = isNativeActivatable(item);
      const nativeHandles = native && (ev.key === 'Enter' || item instanceof HTMLButtonElement);
      if (!nativeHandles && !isDisabled(item)) {
        ev.preventDefault();
        item.click();
      }
      return;
    } else return;
    ev.preventDefault();
    if (next >= 0 && next < items.length) {
      focusItem(next);
      opts.onMove?.(items[next] as HTMLElement, next);
    }
  };

  const onFocusIn = (ev: FocusEvent): void => {
    const items = enabledItems();
    const pos = items.findIndex((el) => el === ev.target);
    if (pos >= 0 && pos !== index) {
      index = pos;
      applyTabindex(items);
    }
  };

  container.addEventListener('keydown', onKeyDown);
  container.addEventListener('focusin', onFocusIn);
  applyTabindex(enabledItems());

  return {
    focusItem,
    refresh() {
      const items = enabledItems();
      if (index >= items.length) index = Math.max(0, items.length - 1);
      applyTabindex(items);
    },
    current: () => index,
    destroy() {
      container.removeEventListener('keydown', onKeyDown);
      container.removeEventListener('focusin', onFocusIn);
    },
  };
}
