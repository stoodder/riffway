/**
 * Settings screen (T-035): tabs for Gameplay, Practice & goals, Input (devices at a glance,
 * calibration, keyboard keys), Library & sources (folder, sources, ClassTab refresh) and Data
 * (export, import with preview and merge/replace, resets). Player settings save on change through
 * the settings store (IndexedDB), server config through `PUT /api/config`. The selected tab is the
 * `tab` route param (`#/settings?tab=data`).
 * Exports `mount: ScreenMount` (contract in `@shared/ui`); registered in `src/ui/screens/index.ts`.
 * @module
 */
import type { AppContext, RouteParams, ScreenHandle, ScreenMount } from '@shared/ui';
import { emptyState, h, tabs } from '../../components';
import { binder } from './controls';
import { dataTab } from './data';
import { gameplayTab, practiceTab } from './gameplay';
import { inputTab } from './input';
import { libraryTab } from './library';
import './settings.css';

/** Tab ids, in order (the `tab` route param). */
export const SETTINGS_TABS = ['gameplay', 'practice', 'input', 'library', 'data'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

const TAB_LABELS: Record<SettingsTab, string> = {
  gameplay: 'Gameplay',
  practice: 'Practice & goals',
  input: 'Input',
  library: 'Library & sources',
  data: 'Data',
};

/** The tab named by route params (default `gameplay`). */
export function tabFromParams(params: RouteParams): SettingsTab {
  const t = params.tab;
  return (SETTINGS_TABS as readonly string[]).includes(t ?? '') ? (t as SettingsTab) : 'gameplay';
}

/** What the screen needs from the context. */
const REQUIRED = ['api', 'settings', 'storage', 'router', 'ui'] as const;

/**
 * The page shown when the app context lacks what settings need (a shell that failed to start): the
 * title and an explanation instead of a thrown mount.
 */
function unavailableView(el: HTMLElement, missing: readonly string[]): ScreenHandle {
  const root = h(
    'div',
    { class: 'set', dataset: { state: 'unavailable' } },
    h('header', { class: 'set-head' }, h('h1', null, 'Settings')),
    emptyState({
      title: 'Settings unavailable',
      message: `The app didn't finish starting (missing: ${missing.join(', ')}). Reload the page to try again.`,
      icon: 'warning',
    }),
  );
  el.append(root);
  return { unmount: () => root.remove() };
}

export const mount: ScreenMount = (el: HTMLElement, ctx: AppContext, params) => {
  // The context type promises these, but a broken or partial shell must not crash the screen.
  const missing = REQUIRED.filter((key) => !(ctx as Partial<AppContext>)[key]);
  if (missing.length) return unavailableView(el, missing);
  const b = binder(ctx);
  const destroys: (() => void)[] = [];
  const withDestroy = (part: { el: HTMLElement; destroy(): void }): HTMLElement => {
    destroys.push(() => part.destroy());
    return part.el;
  };
  const renderers: Record<SettingsTab, () => HTMLElement> = {
    gameplay: () => gameplayTab(b),
    practice: () => practiceTab(b),
    input: () => withDestroy(inputTab(ctx, b)),
    library: () => withDestroy(libraryTab(ctx)),
    data: () => withDestroy(dataTab(ctx)),
  };
  const t = tabs({
    label: 'Settings sections',
    selected: tabFromParams(params),
    tabs: SETTINGS_TABS.map((id) => ({ id, label: TAB_LABELS[id], render: renderers[id] })),
    onChange: (id) => ctx.router.navigate(id === 'gameplay' ? '/settings' : `/settings?tab=${id}`, { replace: true }),
  });
  const root = h(
    'div',
    { class: 'set' },
    h(
      'header',
      { class: 'set-head' },
      h('h1', null, 'Settings'),
      h('p', { class: 'rw-muted' }, 'Changes save as you make them and stay after a reload.'),
    ),
    t.el,
  );
  el.append(root);
  return {
    update(next) {
      const id = tabFromParams(next);
      if (id !== t.selected()) t.select(id);
    },
    unmount() {
      t.destroy();
      b.destroy();
      for (const d of destroys.splice(0)) d();
      root.remove();
    },
  };
};
