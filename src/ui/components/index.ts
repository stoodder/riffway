/**
 * Component kit (T-018). Plain-DOM factories styled by `components.css` (installed by
 * `src/ui/design`). Screens and panels import from here:
 * `import { button, card, slider, difficultyPill } from '../../components';`
 * @module
 */
export { append, focusables, h, uid, type Attrs, type Child, type Listeners } from './dom';
export { icon, ICON_NAMES, type IconName } from './icons';
export { button, setBusy, type ButtonOptions, type ButtonSize, type ButtonVariant } from './button';
export { badge, card, emptyState, type BadgeTone, type CardOptions, type EmptyStateOptions } from './card';
export {
  comboBadge,
  difficultyPill,
  flash,
  judgementTag,
  starRating,
  type DifficultyPillOptions,
  type JudgementTagOptions,
  type StarRatingOptions,
} from './feedback';
export {
  select,
  slider,
  toggle,
  type Select,
  type SelectOption,
  type SelectOptions,
  type Slider,
  type SliderOptions,
  type Toggle,
  type ToggleOptions,
} from './form';
export { meter, type Meter, type MeterOptions } from './meter';
export { tabs, type TabSpec, type Tabs, type TabsOptions } from './tabs';
export { menuButton, type MenuButton, type MenuButtonOptions, type MenuItem } from './menu';
export { rovingFocus, type RovingFocus, type RovingFocusOptions, type RovingOrientation } from './keyboard';
export {
  confirmDialog,
  openModal,
  presentLayer,
  type ConfirmOptions,
  type LayerOptions,
  type Modal,
  type ModalAction,
  type ModalOptions,
} from './modal';
export { createToaster, TOAST_TIMEOUT_MS, type Toaster, type ToastOptions } from './toast';
