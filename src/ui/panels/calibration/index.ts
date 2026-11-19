/**
 * Latency calibration panel (T-033). Exports `mount: PanelMount<PanelPropsMap['calibration']>` (contract in
 * `@shared/ui`); registered in `src/ui/panels/index.ts`. **Stub (T-010):** renders a placeholder.
 * @module
 */
import type { PanelMount, PanelPropsMap } from '@shared/ui';
import { placeholderPanel } from '../../placeholder';

export const mount: PanelMount<PanelPropsMap['calibration']> = placeholderPanel('Latency calibration', 'T-033');
