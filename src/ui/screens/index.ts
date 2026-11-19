/**
 * Screen registry (frozen by T-010). Every planned screen is registered with its route, nav entry and
 * a lazy loader of `./<folder>/index.ts` (which exports `mount: ScreenMount`). Tasks fill in their own
 * folder; they never edit this file. Routes are hash paths: `#/song/local%3Aab12?arr=0`.
 *
 * Query parameters by screen (all optional strings):
 * - `import`: `song` (id of a needs-alignment song to align).
 * - `song`: `arr` (arrangement).
 * - `game`: `arr`, `mode` (`play`|`practice`), `section` (loop this section), `speed` (fraction).
 * - `library`: `q`, plus filter params as in `GET /api/search`.
 * @module
 */
import type { RouteMatch, RouteParams, ScreenId, ScreenRegistration } from '@shared/ui';

/** All screens. Order = nav order for entries with `nav`. */
export const SCREENS: readonly ScreenRegistration[] = [
  { id: 'home', path: '/', title: 'Home', nav: { label: 'Home', order: 1 }, owner: 'T-034', load: () => import('./home') },
  { id: 'library', path: '/library', title: 'Library', nav: { label: 'Library', order: 2 }, owner: 'T-026', load: () => import('./library') },
  { id: 'import', path: '/import', title: 'Import', nav: { label: 'Import', order: 3 }, owner: 'T-028', load: () => import('./import') },
  { id: 'audio-setup', path: '/audio-setup', title: 'Audio setup', nav: { label: 'Audio setup', order: 4 }, owner: 'T-035', load: () => import('./audio-setup') },
  { id: 'settings', path: '/settings', title: 'Settings', nav: { label: 'Settings', order: 5 }, owner: 'T-035', load: () => import('./settings') },
  { id: 'song', path: '/song/:id', title: 'Song', owner: 'T-034', load: () => import('./song') },
  { id: 'game', path: '/play/:id', title: 'Play', owner: 'T-031', load: () => import('./game') },
  { id: 'results', path: '/results/:runId', title: 'Results', owner: 'T-031', load: () => import('./results') },
  { id: 'dev-components', path: '/dev/components', title: 'Components', dev: true, owner: 'T-018', load: () => import('./dev') },
  { id: 'dev-highway', path: '/dev/highway', title: 'Highway (dev)', dev: true, owner: 'T-024', load: () => import('./dev-highway') },
];

/** Registration by id. */
export function screenById(id: ScreenId): ScreenRegistration {
  const reg = SCREENS.find((s) => s.id === id);
  if (!reg) throw new Error(`Unknown screen ${id}`);
  return reg;
}

/** Nav entries in order. */
export function navScreens(): ScreenRegistration[] {
  return SCREENS.filter((s) => s.nav).sort((a, b) => (a.nav?.order ?? 0) - (b.nav?.order ?? 0));
}

/**
 * Match a hash path (`/song/local%3Aab?arr=0`, with or without the leading `#`) to a screen.
 * Path params are URL-decoded; query params are merged in (path params win).
 */
export function matchRoute(hashPath: string): RouteMatch | null {
  const raw = hashPath.replace(/^#/, '') || '/';
  const [pathPart = '/', query = ''] = raw.split('?', 2);
  const path = pathPart.length > 1 ? pathPart.replace(/\/+$/, '') : pathPart;
  const segs = path.split('/').filter(Boolean);
  for (const reg of SCREENS) {
    const pattern = reg.path.split('/').filter(Boolean);
    if (pattern.length !== segs.length) continue;
    const params: RouteParams = Object.fromEntries(new URLSearchParams(query));
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      const p = pattern[i] as string;
      const s = segs[i] as string;
      if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(s);
      else if (p !== s) {
        ok = false;
        break;
      }
    }
    if (ok) return { screen: reg.id, path: raw, params };
  }
  return null;
}

/** Build a hash path for a screen: path params filled (encoded), the rest as query. No leading `#`. */
export function buildPath(id: ScreenId, params: RouteParams = {}): string {
  const rest: RouteParams = { ...params };
  const path = screenById(id)
    .path.split('/')
    .map((seg) => {
      if (!seg.startsWith(':')) return seg;
      const key = seg.slice(1);
      const value = rest[key];
      if (value === undefined) throw new Error(`Missing route param ${key} for ${id}`);
      delete rest[key];
      return encodeURIComponent(value);
    })
    .join('/');
  const q = new URLSearchParams(rest).toString();
  return (path || '/') + (q ? `?${q}` : '');
}
