/**
 * App shell (T-018): layout, top nav, screen mounting, toasts, modals, audio-gesture overlay.
 * **Stub (T-010):** header + nav from the registry, mounts the routed screen, console toasts.
 * @module
 */
import type { AppContext, RouteMatch, ScreenHandle, UiApi } from '@shared/ui';
import { matchRoute, navScreens, screenById } from '../screens';

/** UI helpers (toast/confirm/gesture). */
export function createUi(): UiApi {
  return {
    toast: (message, opts) => console.info(`[toast:${opts?.kind ?? 'info'}] ${message}`),
    confirm: async (message) => window.confirm(message),
    requireAudioGesture: async () => {},
  };
}

/** Render the shell into `root` and keep the routed screen mounted. */
export function startShell(root: HTMLElement, ctx: AppContext): void {
  root.replaceChildren();
  const header = document.createElement('header');
  const brand = document.createElement('strong');
  brand.textContent = 'Riffway';
  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'Main');
  for (const s of navScreens()) {
    const a = document.createElement('a');
    a.href = ctx.router.href(s.id);
    a.textContent = s.nav?.label ?? s.title;
    nav.append(a);
  }
  header.append(brand, nav);
  const main = document.createElement('main');
  main.id = 'screen';
  root.append(header, main);

  let handle: ScreenHandle | null = null;
  let seq = 0;
  const show = async (route: RouteMatch | null): Promise<void> => {
    const my = ++seq;
    handle?.unmount();
    handle = null;
    main.replaceChildren();
    const r = route ?? matchRoute('/');
    if (!r) return;
    const reg = screenById(r.screen);
    document.title = `${reg.title} · Riffway`;
    const mod = await reg.load();
    if (my !== seq) return;
    handle = await mod.mount(main, ctx, r.params);
  };
  ctx.router.onChange((r) => void show(r));
  void show(ctx.router.current());
}
