/**
 * Tuner panel (T-022). Exports `mount: PanelMount<PanelPropsMap['tuner']>` (contract in
 * `@shared/ui`); registered in `src/ui/panels/index.ts`. **Stub (T-010):** renders a placeholder.
 * @module
 */
import type { PanelMount, PanelPropsMap } from '@shared/ui';
import { placeholderPanel } from '../../placeholder';

export const mount: PanelMount<PanelPropsMap['tuner']> = placeholderPanel('Tuner', 'T-022');
