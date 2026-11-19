/**
 * Mixer panel (T-032). Exports `mount: PanelMount<PanelPropsMap['mixer']>` (contract in
 * `@shared/ui`); registered in `src/ui/panels/index.ts`. **Stub (T-010):** renders a placeholder.
 * @module
 */
import type { PanelMount, PanelPropsMap } from '@shared/ui';
import { placeholderPanel } from '../../placeholder';

export const mount: PanelMount<PanelPropsMap['mixer']> = placeholderPanel('Mixer', 'T-032');
