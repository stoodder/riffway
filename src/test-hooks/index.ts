/**
 * e2e test hook (D6): with `?e2e=1`, `window.__riffwayTest` is installed. It injects events through
 * the same judge path as keyboard/guitar input (T-031 implements the methods; T-041 uses them).
 *
 * **Stub (T-010):** `ready()` is false, `getState()` reports the route, `getJudgements()` is empty,
 * and `inject`/`seek`/`setSpeed` throw `NotImplementedError`.
 * @module
 */
import type { AppContext, RiffwayTestHook } from '@shared/ui';
import { notImplemented } from '@shared/errors';

/** Install `window.__riffwayTest` when `ctx.flags.e2e` is set. Returns the hook (or null). */
export function installTestHooks(ctx: AppContext): RiffwayTestHook | null {
  if (!ctx.flags.e2e) return null;
  const hook: RiffwayTestHook = {
    version: 1,
    ready: () => false,
    inject: () => notImplemented('__riffwayTest.inject', 'T-031'),
    getState: () => ({ route: ctx.router.current(), session: null }),
    getJudgements: () => [],
    setSpeed: async () => notImplemented('__riffwayTest.setSpeed', 'T-031'),
    seek: () => notImplemented('__riffwayTest.seek', 'T-031'),
  };
  window.__riffwayTest = hook;
  return hook;
}
