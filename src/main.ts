/**
 * Browser entry (T-018): design system → router + UI → `createAppContext` → app-wide wiring
 * (`startAppWiring`: calibration follows device switches) → `installTestHooks` (`?e2e=1`) → shell. Keep `installTestHooks(ctx)`: the e2e suite relies on it.
 * If the context cannot be created (e.g. IndexedDB unavailable) a boot error is shown instead.
 */
import type { AppContext } from '@shared/ui';
import { createAppContext } from './app/context';
import { startAppWiring } from './app/startup';
import { installTestHooks } from './test-hooks';
import './ui/design';
import { emptyState } from './ui/components';
import { createHashRouter } from './ui/router';
import { createUi, startShell } from './ui/shell';

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

// index.html has no icon link (T-010 owns it); the mark ships in public/.
if (!document.querySelector('link[rel~="icon"]')) {
  document.head.append(Object.assign(document.createElement('link'), { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }));
}

let ctxRef: AppContext | null = null;
const ui = createUi({
  getAudio: async () => {
    if (!ctxRef) throw new Error('App is still starting');
    return ctxRef.services.get('engine');
  },
});

try {
  const ctx = await createAppContext({ router: createHashRouter(), ui });
  ctxRef = ctx;
  startAppWiring(ctx);
  installTestHooks(ctx);
  startShell(root, ctx);
} catch (err) {
  console.error('Riffway failed to start', err);
  root.replaceChildren(
    emptyState({
      title: "Riffway couldn't start",
      message: `${err instanceof Error ? err.message : String(err)}. Check that this page is opened from the Riffway server and reload.`,
      icon: 'warning',
      headingLevel: 1,
      action: { label: 'Reload', onClick: () => location.reload() },
    }),
  );
  root.firstElementChild?.classList.add('rw-boot-error');
}
