/**
 * Keyboard-mode key map (D6, docs/game-mechanics.md § Keyboard input mode): pure helpers for labels,
 * reserved keys and reassignment, plus the settings block that shows the six lanes and remaps one
 * on a key press. Values are `KeyboardEvent.code`s, persisted in `settings.keyboard.lanes`.
 * @module
 */
import { DEFAULT_SETTINGS, type KeyboardSettings, type Settings } from '@shared/settings';
import type { AppContext } from '@shared/ui';
import { button, h } from '../../components';

/** The six lane codes, `[0]` = string 1 (high e). */
export type LaneKeys = KeyboardSettings['lanes'];

/** Lane names, string 1 (high e) first. */
export const LANE_NAMES: readonly string[] = ['High e', 'B', 'G', 'D', 'A', 'Low E'];

const NAMED_KEYS: Readonly<Record<string, string>> = {
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  IntlBackslash: '§',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num −',
  NumpadMultiply: 'Num ×',
  NumpadDivide: 'Num ÷',
  NumpadDecimal: 'Num .',
};

/** Codes the game or the browser already uses: pause, the wrong-pitch modifier, focus and chords. */
const RESERVED: Readonly<Record<string, string>> = {
  Escape: 'Esc pauses the game.',
  Space: 'Space starts and pauses playback.',
  Enter: 'Enter activates buttons.',
  NumpadEnter: 'Enter activates buttons.',
  Tab: 'Tab moves keyboard focus.',
  ShiftLeft: 'Shift is held for a deliberately wrong note.',
  ShiftRight: 'Shift is held for a deliberately wrong note.',
  ControlLeft: 'Modifier keys can’t be lanes.',
  ControlRight: 'Modifier keys can’t be lanes.',
  AltLeft: 'Modifier keys can’t be lanes.',
  AltRight: 'Modifier keys can’t be lanes.',
  MetaLeft: 'Modifier keys can’t be lanes.',
  MetaRight: 'Modifier keys can’t be lanes.',
  CapsLock: 'Caps Lock can’t be a lane.',
  Backspace: 'Backspace can’t be a lane.',
  ContextMenu: 'That key can’t be a lane.',
};

/** Human label for a `KeyboardEvent.code` (`Digit1` → `1`, `KeyJ` → `J`, `Semicolon` → `;`). */
export function keyLabel(code: string): string {
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
  return NAMED_KEYS[code] ?? code;
}

/** Why `code` can't be a lane key, or null when it can. Function keys are refused too. */
export function reservedReason(code: string): string | null {
  if (!code || code === 'Unidentified') return 'That key can’t be detected reliably.';
  if (/^F\d{1,2}$/.test(code)) return 'Function keys can’t be lanes.';
  return RESERVED[code] ?? null;
}

/**
 * Assign `code` to lane `lane` (0 = string 1). A code already used by another lane is swapped with
 * this lane's old key, so the map never holds duplicates. Returns a new tuple.
 */
export function assignKey(lanes: LaneKeys, lane: number, code: string): LaneKeys {
  if (lane < 0 || lane > 5) throw new RangeError(`lane ${lane} is not 0–5`);
  const next = [...lanes] as LaneKeys;
  const other = next.indexOf(code);
  if (other !== -1 && other !== lane) next[other] = next[lane] as string;
  next[lane] = code;
  return next;
}

/** True when the lanes are the defaults (`1`…`6`). */
export function isDefaultKeys(lanes: LaneKeys): boolean {
  return lanes.every((code, i) => code === DEFAULT_SETTINGS.keyboard.lanes[i]);
}

/** The key-map block: one row per lane with its key and a "Change" button that listens for a key. */
export interface KeyMapBlock {
  el: HTMLElement;
  sync(settings: Settings): void;
  destroy(): void;
}

/** Create the key-map block bound to the settings store. */
export function keyMapBlock(ctx: AppContext): KeyMapBlock {
  const doc = typeof document === 'undefined' ? null : document;
  let lanes: LaneKeys = [...ctx.settings.get().keyboard.lanes] as LaneKeys;
  let listening: number | null = null;
  const status = h('p', { class: 'set-keys__status', role: 'status', 'aria-live': 'polite' });
  const rows = LANE_NAMES.map((name, i) => {
    const key = h('kbd', { class: 'set-keys__key' });
    const change = button({ label: 'Change', size: 'sm', variant: 'ghost', onClick: () => (listening === i ? stop(null) : listen(i)) });
    change.setAttribute('aria-label', `Change the key for string ${i + 1} (${name})`);
    const row = h(
      'li',
      { class: 'set-keys__row', dataset: { lane: String(i + 1) } },
      h('span', { class: 'set-keys__swatch', style: `--lane: var(--string-${i + 1})`, 'aria-hidden': 'true' }),
      h('span', { class: 'set-keys__lane' }, h('span', { class: 'set-keys__num rw-num' }, `String ${i + 1}`), h('span', { class: 'rw-muted' }, name)),
      key,
      change,
    );
    return { row, key, change };
  });
  const reset = button({
    label: 'Restore 1–6',
    size: 'sm',
    variant: 'ghost',
    icon: 'loop',
    onClick: () => void save([...DEFAULT_SETTINGS.keyboard.lanes] as LaneKeys, 'Keys restored to 1–6.'),
  });
  const el = h(
    'div',
    { class: 'set-keys' },
    h('ol', { class: 'set-keys__list', 'aria-label': 'Lane keys' }, rows.map((r) => r.row)),
    h(
      'div',
      { class: 'set-keys__foot' },
      h('p', { class: 'rw-field__hint' }, 'Hold ', h('kbd', null, 'Shift'), ' with a lane key for a deliberately wrong note. ', h('kbd', null, 'Esc'), ' pauses.'),
      reset,
    ),
    status,
  );

  const render = (): void => {
    rows.forEach((r, i) => {
      const on = listening === i;
      r.key.textContent = on ? 'Press a key…' : keyLabel(lanes[i] as string);
      r.key.classList.toggle('set-keys__key--listening', on);
      r.row.classList.toggle('set-keys__row--listening', on);
      (r.change.querySelector('.rw-btn__label') as HTMLElement).textContent = on ? 'Cancel' : 'Change';
    });
    reset.disabled = isDefaultKeys(lanes);
  };

  async function save(next: LaneKeys, message: string): Promise<void> {
    lanes = next;
    render();
    status.textContent = message;
    try {
      await ctx.settings.update({ keyboard: { lanes: next } });
    } catch (err) {
      ctx.ui.toast(`Couldn’t save the keys: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
    }
  }

  const onKey = (ev: KeyboardEvent): void => {
    if (listening === null) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.code === 'Escape') {
      stop('Key change cancelled.');
      return;
    }
    const reason = reservedReason(ev.code);
    if (reason) {
      status.textContent = `${keyLabel(ev.code)} can’t be used: ${reason} Press another key, or Esc to cancel.`;
      return;
    }
    const lane = listening;
    const swappedWith = lanes.indexOf(ev.code);
    const next = assignKey(lanes, lane, ev.code);
    listening = null;
    doc?.removeEventListener('keydown', onKey, true);
    const swapNote = swappedWith !== -1 && swappedWith !== lane ? ` String ${swappedWith + 1} now uses ${keyLabel(next[swappedWith] as string)}.` : '';
    void save(next, `String ${lane + 1} now uses ${keyLabel(ev.code)}.${swapNote}`);
    rows[lane]?.change.focus();
  };

  function listen(lane: number): void {
    if (listening === null) doc?.addEventListener('keydown', onKey, true);
    listening = lane;
    status.textContent = `Press the key for string ${lane + 1} (${LANE_NAMES[lane]}). Esc cancels.`;
    render();
  }

  function stop(message: string | null): void {
    listening = null;
    doc?.removeEventListener('keydown', onKey, true);
    if (message !== null) status.textContent = message;
    render();
  }

  render();
  return {
    el,
    sync(settings) {
      lanes = [...settings.keyboard.lanes] as LaneKeys;
      render();
    },
    destroy() {
      doc?.removeEventListener('keydown', onKey, true);
    },
  };
}
