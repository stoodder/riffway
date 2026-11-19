/**
 * Import screen (T-028). Exports `mount: ScreenMount` (contract in `@shared/ui`); registered in
 * `src/ui/screens/index.ts`. **Stub (T-010):** renders a placeholder.
 * @module
 */
import type { ScreenMount } from '@shared/ui';
import { placeholderScreen } from '../../placeholder';

export const mount: ScreenMount = placeholderScreen('Import', 'T-028');
