// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteMatch } from '@shared/ui';
import { createHashRouter, toHash, type HashRouter } from '../../src/ui/router';

const nextHashChange = (): Promise<void> => new Promise((r) => window.addEventListener('hashchange', () => r(), { once: true }));

describe('hash router', () => {
  let router: HashRouter;

  beforeEach(async () => {
    window.location.hash = '';
    // Let queued hashchange events from earlier tests flush before subscribing.
    await new Promise((r) => setTimeout(r, 10));
    router = createHashRouter(window);
  });
  afterEach(() => router.dispose());

  it('normalises paths to hashes', () => {
    expect(toHash('/library')).toBe('#/library');
    expect(toHash('library')).toBe('#/library');
    expect(toHash('#/library?q=a')).toBe('#/library?q=a');
    expect(toHash('#library')).toBe('#/library');
  });

  it('resolves the current route from the registry (empty hash = home, unknown = null)', () => {
    expect(router.current()?.screen).toBe('home');
    window.location.hash = '#/song/local%3Aab12?arr=1';
    expect(router.current()).toEqual({ screen: 'song', path: '/song/local%3Aab12?arr=1', params: { id: 'local:ab12', arr: '1' } });
    window.location.hash = '#/nope';
    expect(router.current()).toBeNull();
  });

  it('builds hrefs with encoded params and query', () => {
    expect(router.href('library')).toBe('#/library');
    expect(router.href('game', { id: 'starter:ode', arr: '0', mode: 'practice' })).toBe('#/play/starter%3Aode?arr=0&mode=practice');
  });

  it('navigates and notifies subscribers with the matched route', async () => {
    const seen: RouteMatch[] = [];
    const off = router.onChange((r) => seen.push(r));
    const changed = nextHashChange();
    router.navigate('/library?q=metal');
    await changed;
    expect(window.location.hash).toBe('#/library?q=metal');
    expect(seen).toEqual([{ screen: 'library', path: '/library?q=metal', params: { q: 'metal' } }]);
    off();
    const again = nextHashChange();
    router.navigate('#/settings');
    await again;
    expect(seen).toHaveLength(1);
  });

  it('does not notify for unknown paths, and ignores navigation to the current path', async () => {
    const cb = vi.fn();
    router.onChange(cb);
    const changed = nextHashChange();
    router.navigate('/does-not-exist');
    await changed;
    expect(cb).not.toHaveBeenCalled();
    const spy = vi.spyOn(window.location, 'replace');
    router.navigate('/does-not-exist', { replace: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it('replace() uses location.replace', () => {
    const spy = vi.spyOn(window.location, 'replace').mockImplementation(() => undefined);
    router.navigate('/import', { replace: true });
    expect(spy).toHaveBeenCalledWith('#/import');
    spy.mockRestore();
  });

  it('back() falls back to home when there is no history', () => {
    const fake = {
      location: { hash: '#/song/x' },
      history: { length: 1, back: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const r = createHashRouter(fake as unknown as Window);
    r.back();
    expect(fake.history.back).not.toHaveBeenCalled();
    expect(fake.location.hash).toBe('#/');
    fake.history.length = 3;
    r.back();
    expect(fake.history.back).toHaveBeenCalledOnce();
  });
});
