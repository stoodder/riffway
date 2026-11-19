/**
 * Placeholder mounts used by stub screens/panels until their owning task lands (T-010).
 * @module
 */
import type { MountHandle, PanelMount, ScreenMount } from '@shared/ui';

function render(el: HTMLElement, tag: 'h1' | 'h2', title: string, owner: string, kind: string): MountHandle {
  const box = document.createElement('section');
  box.className = `placeholder placeholder-${kind}`;
  box.dataset.placeholder = owner;
  const heading = document.createElement(tag);
  heading.textContent = title;
  const note = document.createElement('p');
  note.textContent = `Coming soon (${owner}).`;
  box.append(heading, note);
  el.append(box);
  return { unmount: () => box.remove() };
}

/** A screen that renders its title and the owning task. */
export function placeholderScreen(title: string, owner: string): ScreenMount {
  return (el) => render(el, 'h1', title, owner, 'screen');
}

/** A panel that renders its title and the owning task. */
export function placeholderPanel<P>(title: string, owner: string): PanelMount<P> {
  return (el) => render(el, 'h2', title, owner, 'panel');
}
