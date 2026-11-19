/**
 * Panel registry (frozen by T-010). Panels are reusable blocks embedded by screens (audio setup,
 * song page, game). Each `./<id>/index.ts` exports `mount: PanelMount<PanelPropsMap[id]>`.
 * @module
 */
import type { AppContext, PanelHandle, PanelId, PanelPropsMap, PanelRegistration } from '@shared/ui';

/** Every panel, keyed by id. */
export const PANELS: { readonly [K in PanelId]: PanelRegistration<K> } = {
  input: { id: 'input', title: 'Guitar input', owner: 'T-022', load: () => import('./input') },
  tuner: { id: 'tuner', title: 'Tuner', owner: 'T-022', load: () => import('./tuner') },
  monitor: { id: 'monitor', title: 'Monitoring', owner: 'T-023', load: () => import('./monitor') },
  calibration: { id: 'calibration', title: 'Latency calibration', owner: 'T-033', load: () => import('./calibration') },
  backing: { id: 'backing', title: 'Backing audio', owner: 'T-027', load: () => import('./backing') },
  practice: { id: 'practice', title: 'Practice', owner: 'T-032', load: () => import('./practice') },
  mixer: { id: 'mixer', title: 'Mixer', owner: 'T-032', load: () => import('./mixer') },
};

/** Load and mount a panel into `el`. Unmount the returned handle when the host unmounts. */
export async function mountPanel<K extends PanelId>(
  id: K,
  el: HTMLElement,
  ctx: AppContext,
  props: PanelPropsMap[K],
): Promise<PanelHandle<PanelPropsMap[K]>> {
  const mod = await PANELS[id].load();
  return mod.mount(el, ctx, props);
}
