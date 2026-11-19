// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { AppContext, PanelId, ScreenId, ServiceMap } from '@shared/ui';
import { buildPath, matchRoute, SCREENS } from '../../src/ui/screens';
import { mountPanel, PANELS } from '../../src/ui/panels';
import { createServiceRegistry } from '../../src/app/services';
import { installTestHooks } from '../../src/test-hooks';

// The real engine needs Web Audio (browser tests cover it); here we only check the factory's wiring.
const createEngine = vi.hoisted(() => vi.fn(async (opts: unknown) => ({ tag: 'engine', opts })));
vi.mock('../../src/audio/engine', () => ({ createEngine }));

const ALL_SCREENS: ScreenId[] = ['home', 'library', 'import', 'song', 'game', 'results', 'settings', 'audio-setup', 'dev-components', 'dev-highway'];
const ALL_PANELS: PanelId[] = ['input', 'tuner', 'monitor', 'calibration', 'backing', 'practice', 'mixer'];

describe('screen registry', () => {
  it('registers every screen with a loadable mount', async () => {
    expect(SCREENS.map((s) => s.id).sort()).toEqual([...ALL_SCREENS].sort());
    for (const reg of SCREENS) {
      const mod = await reg.load();
      const el = document.createElement('div');
      const handle = await mod.mount(el, {} as AppContext, {});
      expect(el.textContent).toContain(reg.title);
      handle.unmount();
      expect(el.childElementCount).toBe(0);
    }
  });

  it('nav lists Home, Library, Import, Audio setup, Settings', () => {
    expect(SCREENS.filter((s) => s.nav).map((s) => s.nav?.label)).toEqual(['Home', 'Library', 'Import', 'Audio setup', 'Settings']);
  });

  it('round-trips routes with encoded ids and query params', () => {
    const path = buildPath('game', { id: 'local:ab12', arr: '1', mode: 'practice' });
    expect(path).toBe('/play/local%3Aab12?arr=1&mode=practice');
    expect(matchRoute(`#${path}`)).toEqual({ screen: 'game', path, params: { id: 'local:ab12', arr: '1', mode: 'practice' } });
    expect(matchRoute('#/')?.screen).toBe('home');
    expect(matchRoute('')?.screen).toBe('home');
    expect(matchRoute('/dev/highway')?.screen).toBe('dev-highway');
    expect(matchRoute('/nope')).toBeNull();
  });

  it('treats a malformed escape in a path param as no match (R1-P-11)', () => {
    expect(matchRoute('#/song/%')).toBeNull();
    expect(matchRoute('#/play/%E0%A4%A?arr=0')).toBeNull();
    expect(matchRoute('#/song/ok%20id')?.params).toEqual({ id: 'ok id' });
  });
});

describe('panel registry', () => {
  it('registers every panel with a loadable mount', async () => {
    expect(Object.keys(PANELS).sort()).toEqual([...ALL_PANELS].sort());
    const el = document.createElement('div');
    const handle = await mountPanel('tuner', el, {} as AppContext, {});
    expect(el.textContent).toContain('Tuner');
    handle.unmount();
  });
});

describe('service registry', () => {
  it('creates once, caches, and retries after a failure', async () => {
    let calls = 0;
    const engine = { tag: 'engine' } as unknown as ServiceMap['engine'];
    const factories = {
      engine: async () => {
        calls++;
        if (calls === 1) throw new Error('first try fails');
        return engine;
      },
    } as unknown as Parameters<typeof createServiceRegistry>[1];
    const reg = createServiceRegistry(() => ({}) as AppContext, factories);
    await expect(reg.get('engine')).rejects.toThrow('first try fails');
    expect(reg.peek('engine')).toBeNull();
    expect(await reg.get('engine')).toBe(engine);
    expect(await reg.get('engine')).toBe(engine);
    expect(calls).toBe(2);
    expect(reg.peek('engine')).toBe(engine);
  });

  it('the engine factory hands the app settings store to createEngine', async () => {
    const settings = { get: vi.fn(), set: vi.fn(), subscribe: vi.fn() };
    const reg = createServiceRegistry(() => ({ settings }) as unknown as AppContext);
    const engine = await reg.get('engine');
    expect(createEngine).toHaveBeenCalledTimes(1);
    expect(createEngine).toHaveBeenCalledWith({ settings });
    expect(engine).toEqual({ tag: 'engine', opts: { settings } });
    expect(await reg.get('engine')).toBe(engine);
    expect(createEngine).toHaveBeenCalledTimes(1);
  });
});

describe('e2e test hook', () => {
  it('installs window.__riffwayTest only with ?e2e=1', () => {
    const router = { current: () => null } as unknown as AppContext['router'];
    expect(installTestHooks({ flags: { e2e: false, dev: false }, router } as AppContext)).toBeNull();
    const hook = installTestHooks({ flags: { e2e: true, dev: false }, router } as AppContext);
    expect(window.__riffwayTest).toBe(hook);
    expect(hook?.version).toBe(1);
    expect(hook?.ready()).toBe(false);
    expect(hook?.getState()).toEqual({ route: null, session: null });
  });
});
