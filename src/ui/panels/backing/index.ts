/**
 * Backing audio panel (T-027). Exports `mount: PanelMount<PanelPropsMap['backing']>` (contract in
 * `@shared/ui`); registered in `src/ui/panels/index.ts`. **Stub (T-010):** renders a placeholder.
 * @module
 */
import type { PanelMount, PanelPropsMap } from '@shared/ui';
import { placeholderPanel } from '../../placeholder';

export const mount: PanelMount<PanelPropsMap['backing']> = placeholderPanel('Backing audio', 'T-027');
