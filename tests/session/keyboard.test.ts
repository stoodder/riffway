// @vitest-environment happy-dom
/**
 * Keyboard mode (D6): lane mapping (remappable), nearest-note pitch within the Good window, open
 * string fallback (with capo), Shift = +1 semitone, key repeats, Esc / Space handling.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type KeyboardSettings } from '@shared/settings';
import { attachKeyboard, keyLabel, laneForCode, laneIndex, laneMidi, openStringMidi } from '../../src/game/input';
import { expectedRange, expectedRangeAt, sameRange } from '../../src/game/input';
import { makeSong } from './helpers';

const KEYS: KeyboardSettings = { ...DEFAULT_SETTINGS.keyboard, lanes: [...DEFAULT_SETTINGS.keyboard.lanes] };

describe('keyboard mapping', () => {
  it('maps default and remapped codes to lanes (1 = high e)', () => {
    expect(laneForCode('Digit1', KEYS.lanes)).toBe(1);
    expect(laneForCode('Digit6', KEYS.lanes)).toBe(6);
    expect(laneForCode('Digit7', KEYS.lanes)).toBeNull();
    const remapped: KeyboardSettings['lanes'] = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH'];
    expect(laneForCode('KeyD', remapped)).toBe(3);
    expect(laneForCode('Digit1', remapped)).toBeNull();
  });

  it('labels key codes', () => {
    expect(keyLabel('Digit3')).toBe('3');
    expect(keyLabel('KeyQ')).toBe('Q');
    expect(keyLabel('Numpad4')).toBe('Num 4');
    expect(keyLabel('Semicolon')).toBe('Semicolon');
  });

  it('pitches a press like the nearest note on the lane within the window, else the open string', () => {
    const song = makeSong(
      [
        { time: 1, string: 2, fret: 3 },
        { time: 1.1, string: 2, fret: 5 },
        { time: 3, string: 6, fret: 0 },
      ],
      { bars: 2, capo: 2 },
    );
    const idx = laneIndex(song);
    expect(laneMidi(song, idx, 2, 1.02, 0.12)).toBe(59 + 2 + 3);
    expect(laneMidi(song, idx, 2, 1.08, 0.12)).toBe(59 + 2 + 5);
    // Outside the window → open string (tuning + capo); Shift adds a semitone.
    expect(laneMidi(song, idx, 2, 2, 0.12)).toBe(openStringMidi(song, 2));
    expect(openStringMidi(song, 2)).toBe(61);
    expect(laneMidi(song, idx, 6, 3, 0.12, true)).toBe(40 + 2 + 1);
    // Other lanes' notes never match.
    expect(laneMidi(song, idx, 1, 1, 0.12)).toBe(64 + 2);
  });

  it('attachKeyboard: lane presses with Shift, ignores repeats, Esc and Space/Enter outside controls', () => {
    const lane = vi.fn();
    const escape = vi.fn();
    const start = vi.fn();
    const detach = attachKeyboard(window, () => KEYS, { lane, escape, start });
    const fire = (init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent => {
      const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(ev);
      return ev;
    };
    const ev = fire({ code: 'Digit2' });
    expect(ev.defaultPrevented).toBe(true);
    fire({ code: 'Digit5', shiftKey: true });
    fire({ code: 'Digit5', repeat: true });
    expect(lane.mock.calls.map((c) => [c[0].lane, c[0].wrongPitch])).toEqual([
      [2, false],
      [5, true],
    ]);
    // Practice-panel shortcuts pass through untouched.
    expect(fire({ code: 'KeyL' }).defaultPrevented).toBe(false);
    expect(fire({ code: 'Minus' }).defaultPrevented).toBe(false);
    fire({ code: 'Escape' });
    expect(escape).toHaveBeenCalledTimes(1);
    fire({ code: 'Space' });
    expect(start).toHaveBeenCalledTimes(1);
    // Space on a focused button keeps its native meaning; lane keys still play.
    const btn = document.createElement('button');
    document.body.append(btn);
    fire({ code: 'Space' }, btn);
    expect(start).toHaveBeenCalledTimes(1);
    fire({ code: 'Digit1' }, btn);
    expect(lane).toHaveBeenCalledTimes(3);
    // Typing in a field never plays.
    const input = document.createElement('input');
    document.body.append(input);
    fire({ code: 'Digit1' }, input);
    expect(lane).toHaveBeenCalledTimes(3);
    // Ctrl/Meta combos are left alone.
    fire({ code: 'Digit1', ctrlKey: true });
    expect(lane).toHaveBeenCalledTimes(3);
    detach();
    fire({ code: 'Digit1' });
    expect(lane).toHaveBeenCalledTimes(3);
  });

  it('a focused slider, checkbox or radio never swallows lane keys; text fields do (R2-I-05)', () => {
    const lane = vi.fn();
    const detach = attachKeyboard(window, () => KEYS, { lane, escape: vi.fn(), start: vi.fn() });
    const fire = (target: EventTarget): KeyboardEvent => {
      const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'Digit3' });
      target.dispatchEvent(ev);
      return ev;
    };
    for (const type of ['range', 'checkbox', 'radio', 'button']) {
      const el = document.createElement('input');
      el.type = type;
      document.body.append(el);
      expect(fire(el).defaultPrevented).toBe(true);
    }
    expect(lane).toHaveBeenCalledTimes(4);
    for (const type of ['text', 'number', 'search']) {
      const el = document.createElement('input');
      el.type = type;
      document.body.append(el);
      fire(el);
    }
    fire(document.body.appendChild(document.createElement('textarea')));
    const editable = document.body.appendChild(document.createElement('div'));
    editable.contentEditable = 'true';
    fire(editable);
    const select = document.body.appendChild(document.createElement('select'));
    fire(select);
    expect(lane).toHaveBeenCalledTimes(4);
    detach();
  });
});

describe('expect hints', () => {
  it('covers the pitched notes in the window (bends reach their target, dead notes skipped)', () => {
    const song = makeSong(
      [
        { time: 0.5, string: 6, fret: 0 },
        { time: 1, string: 1, fret: 5 },
        { time: 2, string: 3, fret: 2 },
        { time: 6, string: 1, fret: 12 },
      ],
      { bars: 4 },
    );
    song.notes[2]!.tech = { bend: { semitones: 1.5 } };
    song.notes[0]!.tech = { dead: true };
    expect(expectedRange(song.notes, 0, 3)).toEqual({ minMidi: 57, maxMidi: 69 });
    expect(expectedRangeAt(song, 0.9)).toEqual({ minMidi: 57, maxMidi: 69 });
    expect(expectedRange(song.notes, 3, 5)).toBeNull();
    expect(sameRange(null, null)).toBe(true);
    expect(sameRange({ minMidi: 1, maxMidi: 2 }, { minMidi: 1, maxMidi: 2 })).toBe(true);
    expect(sameRange({ minMidi: 1, maxMidi: 2 }, null)).toBe(false);
  });
});
