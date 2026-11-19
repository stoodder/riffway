/**
 * Tiny DOM helpers shared by the component kit and screens: an `h()` element factory and unique ids
 * for ARIA wiring. No framework; components return plain elements.
 * @module
 */

/** A child accepted by {@link h}: nodes, text, or nothing (skipped). Arrays are flattened. */
export type Child = Node | string | number | null | undefined | false;

/** Event listeners keyed by event name. */
export type Listeners = { [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void };

/**
 * Attributes for {@link h}. `class` sets `className`; `on` adds listeners; `dataset` sets `data-*`;
 * `true` adds a boolean attribute, `false`/`null`/`undefined` skip it; anything else is stringified.
 */
export interface Attrs {
  class?: string;
  on?: Listeners;
  dataset?: Record<string, string>;
  style?: string;
  [attr: string]: unknown;
}

/**
 * Create an element with attributes and children.
 * @example h('button', { class: 'rw-btn', type: 'button', on: { click } }, 'Play')
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: (Child | readonly Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) applyAttrs(el, attrs);
  append(el, children);
  return el;
}

/** Append children (flattening arrays, skipping empty values). */
export function append(el: Element, children: readonly (Child | readonly Child[])[]): void {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'number' ? String(c) : c);
  }
}

function applyAttrs(el: HTMLElement, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'on') {
      for (const [type, fn] of Object.entries(value as Record<string, EventListener>)) el.addEventListener(type, fn);
    } else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
}

let idSeq = 0;

/** A document-unique id with a readable prefix (for `aria-labelledby`, `for`, `aria-controls`). */
export function uid(prefix = 'rw'): string {
  idSeq += 1;
  return `${prefix}-${idSeq.toString(36)}`;
}

/** Elements that can take keyboard focus inside `root`, in DOM order (visible or not). */
export function focusables(root: ParentNode): HTMLElement[] {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
    'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((el) => !el.hasAttribute('inert'));
}
