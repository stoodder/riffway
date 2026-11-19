/**
 * Hash router driven by the screens registry (T-018). Implements `RouterApi` (`@shared/ui`).
 * **Stub (T-010):** minimal working router (no transitions, no focus management).
 * @module
 */
import type { RouteMatch, RouterApi } from '@shared/ui';
import { buildPath, matchRoute } from './screens';

export function createHashRouter(win: Window = window): RouterApi {
  const subs = new Set<(r: RouteMatch) => void>();
  const current = (): RouteMatch | null => matchRoute(win.location.hash || '#/');
  win.addEventListener('hashchange', () => {
    const r = current();
    if (r) subs.forEach((cb) => cb(r));
  });
  return {
    navigate(path, opts) {
      const hash = path.startsWith('#') ? path : `#${path}`;
      if (opts?.replace) win.location.replace(hash);
      else win.location.hash = hash;
    },
    href: (screen, params) => `#${buildPath(screen, params)}`,
    current,
    back: () => win.history.back(),
    onChange(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}
