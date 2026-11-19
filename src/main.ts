/**
 * Browser entry (T-018 owns; bootstrap order set by T-010):
 * router + UI → `createAppContext` → `installTestHooks` (`?e2e=1`) → shell.
 * Keep `installTestHooks(ctx)` when replacing this file: the e2e suite relies on it.
 */
import { createAppContext } from './app/context';
import { installTestHooks } from './test-hooks';
import { createHashRouter } from './ui/router';
import { createUi, startShell } from './ui/shell';

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');
const ctx = await createAppContext({ router: createHashRouter(), ui: createUi() });
installTestHooks(ctx);
startShell(root, ctx);
