/**
 * Keyboard shortcuts for the practice and mixer panels (T-032), designed to be used mid-song
 * without stealing the game's keys.
 *
 * **Shortcut map** (physical `KeyboardEvent.code`s, no Ctrl/Alt/Meta):
 *
 * | Key | Action | Panel |
 * |---|---|---|
 * | `-` | Slower: −5% | practice |
 * | `=` (`+`) | Faster: +5% | practice |
 * | `A` | Set loop start (A) at the heard position | practice |
 * | `B` | Set loop end (B) at the heard position | practice |
 * | `L` | Loop the current section; again clears the loop | practice |
 * | `[` / `]` | Loop the previous / next section | practice |
 * | `T` | Speed trainer on/off | practice |
 * | `M` | Metronome on/off | practice |
 * | `C` | Count-in: 0 → 1 → 2 bars | practice |
 * | `G` | Guide synth on/off | mixer |
 *
 * Reserved for the game screen and never handled here: the lane keys (default `1`–`6`, read from
 * `settings.keyboard.lanes`, so a remapped lane always wins over a shortcut), Shift (wrong pitch),
 * `Esc` (pause), Space, Enter, Tab and the arrow keys.
 *
 * Shortcuts are ignored while typing (inputs, textareas, selects, contenteditable), while a modal
 * is open, on auto-repeat (except speed), and when another handler already `preventDefault`ed.
 * {@link releasePointerFocus} drops focus after mouse/touch use so a clicked control never keeps
 * keyboard focus away from the game; keyboard users keep normal focus behaviour.
 * @module
 */
import type { Unsubscribe } from '@shared/clock';

/** Every shortcut action. */
export type ShortcutAction =
  | 'slower'
  | 'faster'
  | 'setA'
  | 'setB'
  | 'toggleLoop'
  | 'prevSection'
  | 'nextSection'
  | 'toggleTrainer'
  | 'toggleMetronome'
  | 'cycleCountIn'
  | 'toggleGuide';

/** One documented shortcut. */
export interface ShortcutDef {
  action: ShortcutAction;
  /** `KeyboardEvent.code`s that trigger it. */
  codes: readonly string[];
  /** Key cap shown in the UI. */
  keyLabel: string;
  description: string;
  /** Fire on auto-repeat (held key). */
  repeat?: boolean;
  /** Also fire with Shift held (`+` is Shift+`=` on US layouts). */
  allowShift?: boolean;
}

/** Practice-panel shortcuts. */
export const PRACTICE_SHORTCUTS: readonly ShortcutDef[] = [
  { action: 'slower', codes: ['Minus', 'NumpadSubtract'], keyLabel: '−', description: 'Slower (−5%)', repeat: true },
  { action: 'faster', codes: ['Equal', 'NumpadAdd'], keyLabel: '+', description: 'Faster (+5%)', repeat: true, allowShift: true },
  { action: 'setA', codes: ['KeyA'], keyLabel: 'A', description: 'Set loop start here' },
  { action: 'setB', codes: ['KeyB'], keyLabel: 'B', description: 'Set loop end here' },
  { action: 'toggleLoop', codes: ['KeyL'], keyLabel: 'L', description: 'Loop this section / clear loop' },
  { action: 'prevSection', codes: ['BracketLeft'], keyLabel: '[', description: 'Loop previous section' },
  { action: 'nextSection', codes: ['BracketRight'], keyLabel: ']', description: 'Loop next section' },
  { action: 'toggleTrainer', codes: ['KeyT'], keyLabel: 'T', description: 'Speed trainer on/off' },
  { action: 'toggleMetronome', codes: ['KeyM'], keyLabel: 'M', description: 'Metronome on/off' },
  { action: 'cycleCountIn', codes: ['KeyC'], keyLabel: 'C', description: 'Count-in 0 → 1 → 2 bars' },
];

/** Mixer-panel shortcuts. */
export const MIXER_SHORTCUTS: readonly ShortcutDef[] = [
  { action: 'toggleGuide', codes: ['KeyG'], keyLabel: 'G', description: 'Guide synth on/off' },
];

/** Keys the game owns besides the (configurable) lane keys. */
export const GAME_RESERVED_CODES: readonly string[] = [
  'Escape',
  'Space',
  'Enter',
  'Tab',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'ShiftLeft',
  'ShiftRight',
];

/** True when `target` is a text-entry element (shortcuts must not fire while typing). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes(type);
  }
  return false;
}

/** Options for {@link bindShortcuts}. */
export interface BindShortcutsOptions {
  /** Codes the game uses for lanes right now (`settings.keyboard.lanes`). Re-read on every key. */
  laneCodes: () => readonly string[];
  /** Where to listen (default `window`). */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** Extra guard (e.g. the panel is hidden); return false to ignore all keys. */
  enabled?: () => boolean;
}

/**
 * Resolve a keydown to a shortcut action, or null when it must be left alone (modifiers, typing,
 * game keys, modal open, auto-repeat, already handled).
 */
export function matchShortcut(ev: KeyboardEvent, defs: readonly ShortcutDef[], laneCodes: readonly string[]): ShortcutDef | null {
  if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return null;
  if (laneCodes.includes(ev.code) || GAME_RESERVED_CODES.includes(ev.code)) return null;
  if (isEditableTarget(ev.target)) return null;
  if (typeof document !== 'undefined' && document.querySelector('[aria-modal="true"]')) return null;
  const def = defs.find((d) => d.codes.includes(ev.code));
  if (!def) return null;
  if (ev.shiftKey && !def.allowShift) return null;
  if (ev.repeat && !def.repeat) return null;
  return def;
}

/**
 * Listen for `defs` on the window and call `handlers[action]`. Handled keys are
 * `preventDefault`ed; everything else (lane keys included) passes through untouched.
 */
export function bindShortcuts(
  defs: readonly ShortcutDef[],
  handlers: Partial<Record<ShortcutAction, () => void>>,
  opts: BindShortcutsOptions,
): Unsubscribe {
  const target = opts.target ?? window;
  const onKey = (ev: Event): void => {
    const kev = ev as KeyboardEvent;
    if (opts.enabled && !opts.enabled()) return;
    const def = matchShortcut(kev, defs, opts.laneCodes());
    const fn = def ? handlers[def.action] : undefined;
    if (!def || !fn) return;
    kev.preventDefault();
    fn();
  };
  target.addEventListener('keydown', onKey);
  return () => target.removeEventListener('keydown', onKey);
}

/** Shortcuts whose key collides with a lane key are disabled; list them for the help text. */
export function activeShortcuts(defs: readonly ShortcutDef[], laneCodes: readonly string[]): ShortcutDef[] {
  return defs.filter((d) => d.codes.some((c) => !laneCodes.includes(c)));
}

/**
 * After a mouse/touch interaction inside `root`, blur the control that took focus so the game's
 * keys (and Space / arrows) are not captured by a button or slider. Keyboard focus is untouched.
 */
export function releasePointerFocus(root: HTMLElement): Unsubscribe {
  const release = (): void => {
    setTimeout(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body && root.contains(active) && !isEditableTarget(active)) active.blur();
    }, 0);
  };
  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', release);
  return () => {
    root.removeEventListener('pointerup', release);
    root.removeEventListener('pointercancel', release);
  };
}
