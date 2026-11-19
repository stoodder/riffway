/**
 * Test page for the input and tuner panels (T-022), served by Vite from the repo root at
 * `/tests/input/e2e/harness.html`. Builds the real `AppContext` (IndexedDB settings, lazy services:
 * engine + input) and mounts both panels. `?tuning=drop-d` passes Drop D to the tuner.
 */
import type { AppContext } from '@shared/ui';
import { createAppContext } from '../../../src/app/context';
import '../../../src/ui/design';
import { mountPanel } from '../../../src/ui/panels';
import { createHashRouter } from '../../../src/ui/router';
import { createUi } from '../../../src/ui/shell';

const TUNINGS: Record<string, number[]> = { 'drop-d': [64, 59, 55, 50, 45, 38] };

let ctx: AppContext | null = null;
const ui = createUi({
  getAudio: async () => {
    if (!ctx) throw new Error('not ready');
    return ctx.services.get('engine');
  },
});
ctx = await createAppContext({ router: createHashRouter(), ui });
const tuning = TUNINGS[new URLSearchParams(location.search).get('tuning') ?? ''];
await mountPanel('input', document.getElementById('input')!, ctx, {});
await mountPanel('tuner', document.getElementById('tuner')!, ctx, tuning ? { tuning } : {});
document.body.dataset.ready = '1';
