/**
 * Builds the `AppContext` handed to every screen and panel (frozen by T-010). The shell (T-018)
 * supplies the router and UI helpers; everything else is wired here:
 * `api` (typed client), `storage` + `settings` (T-020), `services` (lazy registry).
 * @module
 */
import type { AppContext, AppFlags, RouterApi, UiApi } from '@shared/ui';
import { createApiClient } from '../api/client';
import { openStorage } from '../storage';
import { createServiceRegistry } from './services';

/** Parts provided by the shell. */
export interface AppContextParts {
  router: RouterApi;
  ui: UiApi;
  /** Override flags (tests); default from `location.search` and `import.meta.env.DEV`. */
  flags?: Partial<AppFlags>;
}

/** Read flags from the current URL (`?e2e=1`). */
export function readFlags(search: string = typeof location === 'undefined' ? '' : location.search): AppFlags {
  const q = new URLSearchParams(search);
  return { e2e: q.get('e2e') === '1', dev: Boolean(import.meta.env?.DEV) };
}

/** Open storage and assemble the context. */
export async function createAppContext(parts: AppContextParts): Promise<AppContext> {
  const storage = await openStorage();
  let ctx: AppContext | null = null;
  const services = createServiceRegistry(() => {
    if (!ctx) throw new Error('AppContext not ready');
    return ctx;
  });
  ctx = {
    api: createApiClient(),
    storage,
    settings: storage.settings,
    services,
    router: parts.router,
    ui: parts.ui,
    flags: { ...readFlags(), ...parts.flags },
  };
  return ctx;
}
