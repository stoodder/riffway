/**
 * Home dashboard (T-034). Exports `mount: ScreenMount`; registered in `src/ui/screens/index.ts`.
 *
 * - First run (no runs yet): setup checklist (input → tune → calibrate → first starter song) and the
 *   easiest starter songs.
 * - Afterwards: continue where you left off, next-day checks, 3 session goals (process goals; the
 *   player picks one), recommendations 6 stretch / 3 review-comfort / 1 reach with readable reasons,
 *   weekly streak (current and best, week dots, freezes; no loss alerts) with the daily goal ring,
 *   recent results and the repertoire count.
 *
 * Data: `GET /api/search` (listing) + IndexedDB, re-read on storage/settings changes and on
 * `library.changed`. The view model is pure (`./model.ts`).
 * @module
 */
import type { StoreName } from '@shared/storage';
import type { AppContext, ScreenMount } from '@shared/ui';
import { localDate } from '@core/progress';
import { loadHomeInput } from './data';
import { buildHomeModel } from './model';
import { localStore, writeChecklist, writeFocus } from './prefs';
import { missingContext, unavailableView } from './unavailable';
import { renderHome, renderSkeleton, type HomeActions } from './view';
import './home.css';

/** Coalesce bursts of storage/settings/server changes into one reload. */
export const RELOAD_DEBOUNCE_MS = 150;

/** Stores whose changes don't affect the dashboard, or that the dashboard writes itself. */
const IGNORED_STORES: ReadonlySet<StoreName> = new Set<StoreName>(['streak', 'audioLinks']);

export const mount: ScreenMount = (el: HTMLElement, ctx: AppContext) => {
  // The context type promises these, but a broken or partial shell must not crash the screen.
  const missing = missingContext(ctx, ['api', 'router', 'ui', 'storage', 'settings']);
  if (missing.length) return unavailableView(el, 'Home', missing);
  const win = el.ownerDocument.defaultView ?? window;
  const prefs = localStore(win);
  let destroyed = false;
  let seq = 0;
  let timer: number | undefined;
  let current: HTMLElement = renderSkeleton();
  el.append(current);

  const actions: HomeActions = {
    href: (to) => ctx.router.href(to.screen, to.params),
    markTuned: () => {
      writeChecklist(prefs, { tunedMarked: true });
      void load();
    },
    hideChecklist: () => {
      writeChecklist(prefs, { hidden: true });
      ctx.ui.toast('Checklist hidden. Audio setup is always in the top bar.', { kind: 'info' });
      void load();
    },
    pickGoal: (item) => writeFocus(prefs, { date: localDate(Date.now()), kind: item.goal.kind, songId: item.goal.songId }),
    retry: () => void load(),
  };

  async function load(): Promise<void> {
    const my = ++seq;
    const now = Date.now();
    try {
      const input = await loadHomeInput(ctx, now, prefs);
      if (my !== seq || destroyed) return;
      show(renderHome(buildHomeModel(input), actions, now));
    } catch (err) {
      if (my !== seq || destroyed) return;
      ctx.ui.toast(`Couldn’t load your progress: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
    }
  }

  function show(next: HTMLElement): void {
    const focused = el.ownerDocument.activeElement;
    const hadFocus = focused instanceof HTMLElement && current.contains(focused);
    current.replaceWith(next);
    current = next;
    // A re-render replaced the focused control: keep keyboard users inside the screen.
    if (hadFocus) next.querySelector<HTMLElement>('h1')?.focus();
  }

  const schedule = (): void => {
    win.clearTimeout(timer);
    timer = win.setTimeout(() => void load(), RELOAD_DEBOUNCE_MS);
  };

  const unsubs = [
    ctx.storage.onChange((store) => {
      if (!IGNORED_STORES.has(store)) schedule();
    }),
    ctx.settings.subscribe(schedule),
    ctx.api.subscribe((event) => {
      if (event.type === 'library.changed') schedule();
    }),
  ];

  void load();

  return {
    unmount() {
      destroyed = true;
      win.clearTimeout(timer);
      for (const off of unsubs) off();
      current.remove();
    },
  };
};
