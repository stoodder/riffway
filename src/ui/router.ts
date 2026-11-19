/**
 * Hash router driven by the screens registry (T-018). Implements `RouterApi` (`@shared/ui`).
 * Routes are hash paths (`#/song/local%3Aab12?arr=0`) resolved with `matchRoute` from the registry;
 * `onChange` fires on every hash change that resolves to a screen. Unknown paths, including ones with
 * a malformed `%` escape, resolve to `null` from `current()` (the shell renders "not found"). Rendering, focus and transitions live in the shell.
 * @module
 */
import type { RouteMatch, RouterApi } from '@shared/ui';
import { buildPath, matchRoute } from './screens';

/** `RouterApi` plus `dispose()` (removes the window listener; used by tests and hot reload). */
export interface HashRouter extends RouterApi {
  dispose(): void;
}

/** Normalise `'/library'`, `'library'`, `'#/library'` or `'#library'` to `'#/library'`. */
export function toHash(path: string): string {
  const bare = path.replace(/^#/, '');
  return `#${bare.startsWith('/') ? bare : `/${bare}`}`;
}

/** Create the app's hash router on `win` (default `window`). */
export function createHashRouter(win: Window = window): HashRouter {
  const subs = new Set<(r: RouteMatch) => void>();
  const current = (): RouteMatch | null => {
    try {
      return matchRoute(win.location.hash || '#/');
    } catch (err) {
      // A malformed escape in a path parameter (`#/song/%`) is an unknown path, not a crash (R1-P-11).
      if (err instanceof URIError) return null;
      throw err;
    }
  };
  const onHashChange = (): void => {
    const r = current();
    if (r) [...subs].forEach((cb) => cb(r));
  };
  win.addEventListener('hashchange', onHashChange);

  const navigate = (path: string, opts?: { replace?: boolean }): void => {
    const hash = toHash(path);
    if (hash === (win.location.hash || '#/')) return;
    if (opts?.replace) win.location.replace(hash);
    else win.location.hash = hash;
  };

  return {
    navigate,
    href: (screen, params) => `#${buildPath(screen, params)}`,
    current,
    back() {
      // A deep link opened in a fresh tab has nothing to go back to: go home instead.
      if (win.history.length > 1) win.history.back();
      else navigate('/');
    },
    onChange(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    dispose() {
      win.removeEventListener('hashchange', onHashChange);
      subs.clear();
    },
  };
}
