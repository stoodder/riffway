/**
 * Graceful fallback for the home and song screens (T-034) when the app context lacks a service they
 * need (e.g. a shell that failed to start, or a test mounting with `{}`): a titled explanation
 * instead of a thrown mount.
 * @module
 */
import type { AppContext, ScreenHandle } from '@shared/ui';
import { emptyState, h } from '../../components';

/** Context members a screen relies on. */
export type ContextKey = keyof AppContext;

/** The `keys` missing from `ctx`. */
export function missingContext(ctx: AppContext, keys: readonly ContextKey[]): ContextKey[] {
  return keys.filter((key) => !(ctx as Partial<AppContext>)[key]);
}

/** Render the screen title and a "<title> unavailable" explanation into `el`. */
export function unavailableView(el: HTMLElement, title: string, missing: readonly string[]): ScreenHandle {
  const root = h(
    'div',
    { class: 'hm', dataset: { state: 'unavailable' } },
    h('h1', { class: 'hm-hero__title', tabindex: '-1' }, title),
    emptyState({
      title: `${title} unavailable`,
      message: `The app didn't finish starting (missing: ${missing.join(', ')}). Reload the page to try again.`,
      icon: 'warning',
    }),
  );
  el.append(root);
  return { unmount: () => root.remove() };
}
