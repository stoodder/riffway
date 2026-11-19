/**
 * Lazy service registry (frozen by T-010). Each factory dynamically imports its module so screens
 * that don't need audio never load it. Services are singletons per app; `get` caches the promise
 * (a failed creation is not cached, so it can be retried after e.g. a permission prompt).
 * @module
 */
import type { AppContext, ServiceFactory, ServiceId, ServiceMap, ServiceRegistry } from '@shared/ui';

/** Factory per service id. */
export const SERVICE_FACTORIES: { [K in ServiceId]: ServiceFactory<K> } = {
  engine: async (ctx) => {
    const { createEngine } = await import('../audio/engine');
    const s = ctx.settings.get();
    return createEngine({ sinkId: s.output.sinkId });
  },
  input: async (ctx) => {
    const { createInputService } = await import('../audio/input');
    return createInputService(await ctx.services.get('engine'), ctx.settings);
  },
  monitor: async (ctx) => {
    const { createMonitor } = await import('../audio/monitor');
    return createMonitor(await ctx.services.get('engine'), await ctx.services.get('input'), ctx.settings);
  },
  songLoader: async () => {
    const { createSongLoader } = await import('../audio/guide');
    return createSongLoader();
  },
  guide: async (ctx) => {
    const { createGuide } = await import('../audio/guide');
    return createGuide(await ctx.services.get('engine'), await ctx.services.get('songLoader'));
  },
  backing: async (ctx) => {
    const { createBacking } = await import('../audio/backing');
    return createBacking(await ctx.services.get('engine'), ctx.api, ctx.storage);
  },
};

/** Create the registry; `getCtx` is late-bound because the context contains the registry. */
export function createServiceRegistry(
  getCtx: () => AppContext,
  factories: { [K in ServiceId]: ServiceFactory<K> } = SERVICE_FACTORIES,
): ServiceRegistry {
  const pending = new Map<ServiceId, Promise<unknown>>();
  const ready = new Map<ServiceId, unknown>();
  return {
    get<K extends ServiceId>(id: K): Promise<ServiceMap[K]> {
      let p = pending.get(id) as Promise<ServiceMap[K]> | undefined;
      if (!p) {
        const factory = factories[id] as ServiceFactory<K>;
        p = factory(getCtx()).then(
          (svc) => {
            ready.set(id, svc);
            return svc;
          },
          (err: unknown) => {
            pending.delete(id);
            throw err;
          },
        );
        pending.set(id, p);
      }
      return p;
    },
    peek<K extends ServiceId>(id: K): ServiceMap[K] | null {
      return (ready.get(id) as ServiceMap[K] | undefined) ?? null;
    },
  };
}
