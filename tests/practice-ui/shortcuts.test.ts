// @vitest-environment happy-dom
/**
 * Panel shortcuts (T-032): the map never collides with the game's keys, lane keys always win,
 * typing/modals/modifiers/auto-repeat are ignored, and pointer use releases focus.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/settings';
import {
  GAME_RESERVED_CODES,
  MIXER_SHORTCUTS,
  PRACTICE_SHORTCUTS,
  activeShortcuts,
  bindShortcuts,
  isEditableTarget,
  matchShortcut,
  releasePointerFocus,
} from '../../src/ui/panels/practice/shortcuts';
import { flush, press } from './helpers';

const LANES = DEFAULT_SETTINGS.keyboard.lanes;
const key = (code: string, init: KeyboardEventInit = {}): KeyboardEvent => new KeyboardEvent('keydown', { code, cancelable: true, ...init });

afterEach(() => {
  document.body.replaceChildren();
});

describe('shortcut map', () => {
  it('uses unique codes that avoid the default lanes and reserved game keys', () => {
    const all = [...PRACTICE_SHORTCUTS, ...MIXER_SHORTCUTS].flatMap((d) => d.codes);
    expect(new Set(all).size).toBe(all.length);
    for (const c of all) {
      expect(LANES).not.toContain(c);
      expect(GAME_RESERVED_CODES).not.toContain(c);
    }
  });

  it('drops a shortcut whose key was remapped to a lane', () => {
    const lanes = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH'];
    expect(activeShortcuts(PRACTICE_SHORTCUTS, lanes).map((d) => d.action)).not.toContain('setA');
    expect(matchShortcut(key('KeyA'), PRACTICE_SHORTCUTS, lanes)).toBeNull();
    expect(matchShortcut(key('KeyG'), MIXER_SHORTCUTS, lanes)).toBeNull();
    expect(matchShortcut(key('KeyB'), PRACTICE_SHORTCUTS, lanes)?.action).toBe('setB');
  });
});

describe('matchShortcut', () => {
  it('matches plain keys and ignores lane digits', () => {
    expect(matchShortcut(key('Minus'), PRACTICE_SHORTCUTS, LANES)?.action).toBe('slower');
    expect(matchShortcut(key('Equal', { shiftKey: true }), PRACTICE_SHORTCUTS, LANES)?.action).toBe('faster');
    for (const lane of LANES) expect(matchShortcut(key(lane), PRACTICE_SHORTCUTS, LANES)).toBeNull();
    expect(matchShortcut(key('Digit3', { shiftKey: true }), PRACTICE_SHORTCUTS, LANES)).toBeNull();
    expect(matchShortcut(key('Escape'), PRACTICE_SHORTCUTS, LANES)).toBeNull();
  });

  it('ignores modifiers, Shift on letters, repeats (except speed) and handled events', () => {
    expect(matchShortcut(key('KeyL', { ctrlKey: true }), PRACTICE_SHORTCUTS, LANES)).toBeNull();
    expect(matchShortcut(key('KeyL', { metaKey: true }), PRACTICE_SHORTCUTS, LANES)).toBeNull();
    expect(matchShortcut(key('KeyL', { shiftKey: true }), PRACTICE_SHORTCUTS, LANES)).toBeNull();
    expect(matchShortcut(key('KeyL', { repeat: true }), PRACTICE_SHORTCUTS, LANES)).toBeNull();
    expect(matchShortcut(key('Minus', { repeat: true }), PRACTICE_SHORTCUTS, LANES)?.action).toBe('slower');
    const handled = key('KeyL');
    handled.preventDefault();
    expect(matchShortcut(handled, PRACTICE_SHORTCUTS, LANES)).toBeNull();
  });

  it('ignores typing and open modals', () => {
    const text = document.createElement('input');
    const range = document.createElement('input');
    range.type = 'range';
    document.body.append(text, range);
    expect(isEditableTarget(text)).toBe(true);
    expect(isEditableTarget(range)).toBe(false);
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    const ev = key('KeyL');
    Object.defineProperty(ev, 'target', { value: text });
    expect(matchShortcut(ev, PRACTICE_SHORTCUTS, LANES)).toBeNull();
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.append(modal);
    expect(matchShortcut(key('KeyL'), PRACTICE_SHORTCUTS, LANES)).toBeNull();
  });
});

describe('bindShortcuts', () => {
  it('calls the handler, prevents default, and lets lane keys through', () => {
    const toggleLoop = vi.fn();
    const off = bindShortcuts(PRACTICE_SHORTCUTS, { toggleLoop }, { laneCodes: () => LANES });
    const ev = press('KeyL');
    expect(toggleLoop).toHaveBeenCalledOnce();
    expect(ev.defaultPrevented).toBe(true);
    const lane = press('Digit1');
    expect(lane.defaultPrevented).toBe(false);
    off();
    press('KeyL');
    expect(toggleLoop).toHaveBeenCalledOnce();
  });

  it('respects the enabled guard and missing handlers', () => {
    const setA = vi.fn();
    let on = false;
    const off = bindShortcuts(PRACTICE_SHORTCUTS, { setA }, { laneCodes: () => LANES, enabled: () => on });
    press('KeyA');
    expect(setA).not.toHaveBeenCalled();
    on = true;
    press('KeyA');
    expect(setA).toHaveBeenCalledOnce();
    expect(press('KeyB').defaultPrevented).toBe(false); // no handler → untouched
    off();
  });
});

describe('releasePointerFocus', () => {
  it('blurs a control clicked with the pointer so the game keeps the keys', async () => {
    const root = document.createElement('div');
    const btn = document.createElement('button');
    root.append(btn);
    document.body.append(root);
    const off = releasePointerFocus(root);
    btn.focus();
    expect(document.activeElement).toBe(btn);
    btn.dispatchEvent(new Event('pointerup', { bubbles: true }));
    await flush();
    expect(document.activeElement).not.toBe(btn);
    // Keyboard focus (no pointer) stays.
    btn.focus();
    await flush();
    expect(document.activeElement).toBe(btn);
    off();
  });
});
