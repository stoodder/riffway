/**
 * App shell (T-018): top bar with brand and main nav, the routed screen region, toasts, confirm
 * modals and the audio-gesture overlay.
 *
 * - Routing: every hash change renders `ctx.router.current()`; unknown paths show "Page not found";
 *   dev screens (`dev: true`) only render in dev builds or with `?e2e=1`. A param-only change on the
 *   same screen calls `handle.update(params)` when the screen provides it, else remounts.
 * - Focus: after a navigation started from the nav, body or a removed element, focus moves to the new
 *   screen's `h1` (or the main region) so keyboard and screen-reader users land on the content.
 * - Keyboard: ←/→ (Home/End) move along the nav, Enter opens, Esc returns focus to the content.
 * @module
 */
import type { AppContext, RouteMatch, ScreenHandle, ScreenRegistration, UiApi } from '@shared/ui';
import { confirmDialog, createToaster, emptyState, h, icon, rovingFocus, type IconName, type Toaster } from '../components';
import { matchRoute, navScreens, screenById } from '../screens';
import { promptAudioGesture, type AudioGestureTarget } from './audio-gesture';
import './shell.css';

export { AudioGestureDismissedError, type AudioGestureTarget } from './audio-gesture';

/** Options for {@link createUi}. */
export interface UiOptions {
  /**
   * Resolves the audio engine for `requireAudioGesture()` (late-bound: the app context, which owns the
   * service registry, is created after the UI). Without it `requireAudioGesture()` rejects.
   */
  getAudio?: () => Promise<AudioGestureTarget>;
  /** Layer host for toasts and overlays (default `document.body`). */
  host?: HTMLElement;
}

/**
 * Global UI helpers (`ctx.ui`): toasts, confirm dialogs and the audio-gesture overlay.
 * `requireAudioGesture()` resolves at once when the engine already runs, else after the user clicks
 * "Enable audio"; it rejects with `AudioGestureDismissedError` when the user picks "Not now".
 * Concurrent calls share one overlay.
 */
export function createUi(opts: UiOptions = {}): UiApi {
  let toaster: Toaster | null = null;
  let pendingGesture: Promise<void> | null = null;
  const host = (): HTMLElement => opts.host ?? document.body;
  return {
    toast(message, topts) {
      toaster ??= createToaster(host());
      toaster.show(message, topts);
    },
    confirm: (message, copts) => confirmDialog(message, { ...copts, host: host() }),
    requireAudioGesture() {
      pendingGesture ??= (async () => {
        if (!opts.getAudio) throw new Error('No audio engine is configured');
        const target = await opts.getAudio();
        if (!target.running) await promptAudioGesture(host(), target);
      })().finally(() => {
        pendingGesture = null;
      });
      return pendingGesture;
    },
  };
}

/** A running shell. */
export interface Shell {
  /** Resolves when the screen for the current route has finished mounting (or failed). */
  settled(): Promise<void>;
  /** Unmount the screen, remove listeners and clear the root. */
  destroy(): void;
}

/** Nav icons per screen id (screens without one get none). */
const NAV_ICONS: Partial<Record<string, IconName>> = {
  home: 'home',
  library: 'library',
  import: 'import',
  'audio-setup': 'audio',
  settings: 'settings',
};

/** Delay before the loading indicator appears, so fast screens don't flash it. */
const LOADING_DELAY_MS = 150;

/** Six string lines in lane colours: the Riffway mark. */
function brandMark(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 28 28');
  svg.setAttribute('width', '28');
  svg.setAttribute('height', '28');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'rw-brand__mark');
  const lines = [1, 2, 3, 4, 5, 6]
    .map((s, i) => {
      const y = 4.5 + i * 3.8;
      const x2 = 26 - (5 - i) * 1.6;
      return `<line x1="2" y1="${y}" x2="${x2}" y2="${y}" stroke="var(--string-${s})" stroke-width="${1.6 + i * 0.25}" stroke-linecap="round"/>`;
    })
    .join('');
  svg.innerHTML = `${lines}<circle cx="17" cy="12.1" r="3.2" fill="var(--color-bg)" stroke="var(--color-accent)" stroke-width="2"/>`;
  return svg;
}

/**
 * Render the shell into `root` and keep the routed screen mounted. The design system stylesheet must
 * already be installed (`import './ui/design'` in `src/main.ts`).
 */
export function startShell(root: HTMLElement, ctx: AppContext): Shell {
  const doc = root.ownerDocument;
  const win = doc.defaultView ?? window;
  if (ctx.flags.e2e) doc.documentElement.dataset.motion = 'reduced';

  const main = h('main', { id: 'screen', class: 'rw-main', tabindex: '-1' });
  const navLinks = new Map<string, HTMLAnchorElement>();
  const nav = h('nav', { class: 'rw-nav', 'aria-label': 'Main' });
  for (const s of navScreens()) {
    const iconName = NAV_ICONS[s.id];
    const a = h(
      'a',
      { class: 'rw-nav__link', href: ctx.router.href(s.id), dataset: { screen: s.id } },
      iconName ? icon(iconName, { size: '18px' }) : null,
      h('span', null, s.nav?.label ?? s.title),
    );
    navLinks.set(s.id, a);
    nav.append(a);
  }
  const focusMain = (): void => {
    const target = main.querySelector<HTMLElement>('h1') ?? main;
    if (!target.hasAttribute('tabindex') && target !== main) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  };
  const roving = rovingFocus(nav, {
    items: () => [...navLinks.values()],
    orientation: 'horizontal',
    onEscape: focusMain,
  });

  const skip = h('button', { type: 'button', class: 'rw-skip', on: { click: focusMain } }, 'Skip to content');
  const brand = h(
    'a',
    { class: 'rw-brand', href: ctx.router.href('home'), 'aria-label': 'Riffway' },
    brandMark(),
    h('span', { class: 'rw-brand__word' }, 'Riff', h('span', null, 'way')),
  );
  const hints = h(
    'p',
    { class: 'rw-topbar__hints', 'aria-hidden': 'true' },
    h('span', null, h('kbd', null, '←'), h('kbd', null, '→'), ' Move'),
    h('span', null, h('kbd', null, 'Enter'), ' Open'),
    h('span', null, h('kbd', null, 'Esc'), ' Jump to page'),
  );
  const topbar = h('header', { class: 'rw-topbar' }, h('div', { class: 'rw-topbar__inner' }, brand, nav, hints));
  const app = h('div', { class: 'rw-app' }, skip, topbar, main);
  root.replaceChildren(app);

  let handle: ScreenHandle | null = null;
  let mounted: { reg: ScreenRegistration; path: string } | null = null;
  let seq = 0;
  // The first render keeps the browser's initial focus (top of the page, skip link first).
  let initial = true;
  let settledPromise: Promise<void> = Promise.resolve();

  const setActiveNav = (id: string | null): void => {
    for (const [screen, a] of navLinks) {
      if (screen === id) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    const activeIndex = id ? [...navLinks.keys()].indexOf(id) : -1;
    if (activeIndex >= 0) roving.focusItem(activeIndex, { focus: false });
  };

  const unmountScreen = (): void => {
    const h0 = handle;
    handle = null;
    mounted = null;
    try {
      h0?.unmount();
    } catch (err) {
      console.error('Screen unmount failed', err);
    }
    main.replaceChildren();
  };

  const shouldMoveFocus = (): boolean => {
    const active = doc.activeElement;
    return !active || active === doc.body || !active.isConnected || nav.contains(active) || main.contains(active) || active === main;
  };

  const showMessage = (title: string, message: string, iconName: IconName, retry?: () => void): void => {
    unmountScreen();
    doc.title = `${title} · Riffway`;
    const view = emptyState({
      title,
      message,
      icon: iconName,
      headingLevel: 1,
      action: { label: 'Go to Home', icon: 'home', onClick: () => ctx.router.navigate('/') },
      secondary: retry ? { label: 'Try again', onClick: retry } : undefined,
    });
    main.append(h('div', { class: 'rw-screen rw-screen--message' }, view));
  };

  const render = async (route: RouteMatch | null): Promise<void> => {
    const my = ++seq;
    const reg = route ? screenById(route.screen) : null;
    const allowed = reg && (!reg.dev || ctx.flags.dev || ctx.flags.e2e);
    if (!route || !reg || !allowed) {
      setActiveNav(null);
      showMessage('Page not found', "That page doesn't exist. Pick a section from the menu above.", 'search');
      return;
    }
    setActiveNav(route.screen);
    doc.title = `${reg.title} · Riffway`;

    // Same screen, new params: let the screen update in place when it can.
    if (mounted?.reg.id === reg.id && handle?.update) {
      mounted.path = route.path;
      handle.update(route.params);
      return;
    }

    const moveFocus = !initial && shouldMoveFocus();
    initial = false;
    unmountScreen();
    main.setAttribute('aria-busy', 'true');
    const loading = h('div', { class: 'rw-screen-loading' }, h('div', { class: 'rw-spinner', role: 'status', 'aria-label': 'Loading' }));
    const loadingTimer = win.setTimeout(() => main.append(loading), LOADING_DELAY_MS);
    try {
      const mod = await reg.load();
      if (my !== seq) return;
      const container = h('div', { class: 'rw-screen', dataset: { screen: reg.id } });
      win.clearTimeout(loadingTimer);
      loading.remove();
      main.append(container);
      const next = await mod.mount(container, ctx, route.params);
      if (my !== seq) {
        next.unmount();
        return;
      }
      handle = next;
      mounted = { reg, path: route.path };
      if (moveFocus) focusMain();
    } catch (err) {
      if (my !== seq) return;
      console.error(`Screen ${reg.id} failed to load`, err);
      const detail = err instanceof Error ? err.message : String(err);
      showMessage(`${reg.title} couldn't open`, detail, 'warning', () => void show());
    } finally {
      win.clearTimeout(loadingTimer);
      loading.remove();
      if (my === seq) main.removeAttribute('aria-busy');
    }
  };

  const show = (): Promise<void> => {
    settledPromise = render(ctx.router.current() ?? (win.location.hash ? null : matchRoute('/')));
    return settledPromise;
  };
  const onHashChange = (): void => void show();
  win.addEventListener('hashchange', onHashChange);
  void show();

  return {
    settled: () => settledPromise,
    destroy() {
      seq++;
      win.removeEventListener('hashchange', onHashChange);
      roving.destroy();
      unmountScreen();
      root.replaceChildren();
    },
  };
}
