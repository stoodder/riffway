// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext, AppFlags, RouteParams } from '@shared/ui';
import { createHashRouter, type HashRouter } from '../../src/ui/router';
import { AudioGestureDismissedError, createUi, startShell, type Shell } from '../../src/ui/shell';

// Library: a screen that updates in place. Import: a screen whose mount fails.
const libraryUpdate = vi.fn<(p: RouteParams) => void>();
const libraryMount = vi.fn((el: HTMLElement) => {
  const h1 = document.createElement('h1');
  h1.textContent = 'Library';
  el.append(h1);
  return { unmount: () => h1.remove(), update: libraryUpdate };
});
vi.mock('../../src/ui/screens/library', () => ({ mount: (el: HTMLElement) => libraryMount(el) }));
vi.mock('../../src/ui/screens/import', () => ({
  mount: () => {
    throw new Error('boom');
  },
}));

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe('app shell', () => {
  let router: HashRouter;
  let shell: Shell | null = null;
  let root: HTMLElement;

  async function start(flags: Partial<AppFlags> = {}): Promise<Shell> {
    const ctx = { router, ui: createUi(), flags: { e2e: false, dev: false, ...flags } } as unknown as AppContext;
    shell = startShell(root, ctx);
    await shell.settled();
    return shell;
  }

  async function go(hash: string): Promise<void> {
    const changed = new Promise<void>((r) => window.addEventListener('hashchange', () => r(), { once: true }));
    window.location.hash = hash;
    await changed;
    await shell?.settled();
  }

  const h1 = (): string | undefined => root.querySelector('main h1')?.textContent ?? undefined;
  const current = (): string[] => Array.from(root.querySelectorAll('nav a[aria-current="page"]')).map((a) => a.textContent ?? '');

  beforeEach(async () => {
    window.location.hash = '';
    await flush();
    root = document.createElement('div');
    document.body.replaceChildren(root);
    router = createHashRouter(window);
    libraryMount.mockClear();
    libraryUpdate.mockClear();
  });

  afterEach(() => {
    shell?.destroy();
    shell = null;
    router.dispose();
    delete document.documentElement.dataset.motion;
  });

  it('renders the top nav from the registry and mounts the routed screen', async () => {
    await start();
    const nav = root.querySelector('nav[aria-label="Main"]');
    expect(Array.from(nav?.querySelectorAll('a') ?? []).map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Home', '#/'],
      ['Library', '#/library'],
      ['Import', '#/import'],
      ['Audio setup', '#/audio-setup'],
      ['Settings', '#/settings'],
    ]);
    expect(h1()).toBe('Home');
    expect(current()).toEqual(['Home']);
    expect(document.title).toBe('Home · Riffway');
  });

  it('switches screens on hash change, unmounting the previous one and moving focus to the heading', async () => {
    await start();
    (root.querySelector('nav a[href="#/library"]') as HTMLElement).focus();
    await go('#/library');
    expect(h1()).toBe('Library');
    expect(root.querySelectorAll('.rw-screen')).toHaveLength(1);
    expect(current()).toEqual(['Library']);
    expect(document.activeElement).toBe(root.querySelector('main h1'));
    expect(document.title).toBe('Library · Riffway');
  });

  it('calls update() instead of remounting when only params change', async () => {
    await start();
    await go('#/library');
    await go('#/library?q=metal');
    expect(libraryMount).toHaveBeenCalledOnce();
    expect(libraryUpdate).toHaveBeenCalledWith({ q: 'metal' });
  });

  it('shows "Page not found" for unknown paths and hides dev screens outside dev/e2e', async () => {
    await start();
    await go('#/nope');
    expect(h1()).toBe('Page not found');
    expect(current()).toEqual([]);
    await go('#/dev/components');
    expect(h1()).toBe('Page not found');
    root.querySelector<HTMLButtonElement>('.rw-empty button')?.click();
    await flush();
    await shell?.settled();
    expect(h1()).toBe('Home');
  });

  it('shows "Page not found" for a malformed escape in a route parameter (R1-P-11)', async () => {
    await start();
    await go('#/library');
    expect(h1()).toBe('Library');
    await go('#/song/%');
    expect(h1()).toBe('Page not found');
    await go('#/song/%E0%A4%A');
    expect(h1()).toBe('Page not found');
  });

  it('renders the component gallery in dev builds', async () => {
    window.location.hash = '#/dev/components';
    await flush();
    await start({ dev: true });
    expect(h1()).toBe('Components');
    expect(root.querySelectorAll('.gal-section').length).toBeGreaterThan(8);
  });

  it('shows an error view with retry when a screen fails to mount', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await start();
    await go('#/import');
    expect(h1()).toBe("Import couldn't open");
    expect(root.textContent).toContain('boom');
    expect(Array.from(root.querySelectorAll('.rw-empty button')).map((b) => b.textContent)).toEqual(['Go to Home', 'Try again']);
  });

  it('supports nav keyboard navigation: arrows move, Esc jumps to the content', async () => {
    await start();
    const links = Array.from(root.querySelectorAll<HTMLAnchorElement>('nav a'));
    expect(links.map((a) => a.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1']);
    links[0]?.focus();
    links[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(links[1]);
    links[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(links[4]);
    links[4]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(root.querySelector('main h1'));
  });

  it('turns motion off in e2e mode and cleans up on destroy', async () => {
    const s = await start({ e2e: true });
    expect(document.documentElement.dataset.motion).toBe('reduced');
    s.destroy();
    shell = null;
    expect(root.childElementCount).toBe(0);
  });
});

describe('createUi', () => {
  beforeEach(() => document.body.replaceChildren());
  afterEach(() => vi.useRealTimers());

  it('shows toasts with the right live role and auto-dismisses them', () => {
    vi.useFakeTimers();
    const ui = createUi();
    ui.toast('Saved', { kind: 'success' });
    ui.toast('Broken', { kind: 'error', timeoutMs: 0 });
    const toasts = Array.from(document.querySelectorAll('.rw-toast'));
    expect(toasts.map((t) => [t.textContent, t.getAttribute('role')])).toEqual([
      ['Saved', 'status'],
      ['Broken', 'alert'],
    ]);
    vi.advanceTimersByTime(5000);
    expect(Array.from(document.querySelectorAll('.rw-toast')).map((t) => t.textContent)).toEqual(['Broken']);
    document.querySelector<HTMLButtonElement>('.rw-toast__close')?.click();
    expect(document.querySelectorAll('.rw-toast')).toHaveLength(0);
  });

  it('keeps at most four toasts, dropping the oldest', () => {
    const ui = createUi();
    for (const n of [1, 2, 3, 4, 5]) ui.toast(`T${n}`);
    expect(Array.from(document.querySelectorAll('.rw-toast')).map((t) => t.textContent)).toEqual(['T2', 'T3', 'T4', 'T5']);
  });

  it('requireAudioGesture resolves at once when audio already runs', async () => {
    const resume = vi.fn(async () => undefined);
    const ui = createUi({ getAudio: async () => ({ running: true, resume }) });
    await ui.requireAudioGesture();
    expect(resume).not.toHaveBeenCalled();
    expect(document.querySelector('.rw-gesture')).toBeNull();
  });

  it('requireAudioGesture shows the overlay and resumes on click (one overlay for concurrent calls)', async () => {
    const target = { running: false, resume: vi.fn(async () => undefined) };
    const ui = createUi({ getAudio: async () => target });
    const a = ui.requireAudioGesture();
    const b = ui.requireAudioGesture();
    await flush();
    expect(document.querySelectorAll('.rw-gesture')).toHaveLength(1);
    expect(document.querySelector('.rw-gesture h2')?.textContent).toBe('Click to enable audio');
    const enable = Array.from(document.querySelectorAll('button')).find((x) => x.textContent === 'Enable audio');
    expect(document.activeElement).toBe(enable);
    enable?.click();
    await Promise.all([a, b]);
    expect(target.resume).toHaveBeenCalledOnce();
    expect(document.querySelector('.rw-gesture')).toBeNull();
  });

  it('shows resume errors and allows a retry; "Not now" / Esc reject', async () => {
    let fail = true;
    const target = {
      running: false,
      resume: vi.fn(async () => {
        if (fail) throw new Error('device busy');
      }),
    };
    const ui = createUi({ getAudio: async () => target });
    const p = ui.requireAudioGesture();
    await flush();
    document.querySelector<HTMLElement>('.rw-gesture')?.click();
    await flush();
    expect(document.querySelector('.rw-gesture__error')?.textContent).toContain('device busy');
    fail = false;
    document.querySelector<HTMLElement>('.rw-gesture')?.click();
    await p;
    expect(target.resume).toHaveBeenCalledTimes(2);

    const dismissed = ui.requireAudioGesture();
    await flush();
    Array.from(document.querySelectorAll('button')).find((x) => x.textContent === 'Not now')?.click();
    await expect(dismissed).rejects.toBeInstanceOf(AudioGestureDismissedError);
    expect(target.resume).toHaveBeenCalledTimes(2);

    const escaped = ui.requireAudioGesture();
    await flush();
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await expect(escaped).rejects.toBeInstanceOf(AudioGestureDismissedError);
  });

  it('requireAudioGesture rejects without an audio engine', async () => {
    await expect(createUi().requireAudioGesture()).rejects.toThrow(/No audio engine/);
  });
});
