/**
 * Keyboard input mode (D6, docs/game-mechanics.md § Keyboard input mode): keys `1`–`6` (remappable,
 * settings `keyboard.lanes`, `lanes[0]` = string 1 = high e) give an onset with the pitch of the
 * nearest note on that lane within the Good window, else the lane's open-string pitch; holding the
 * wrong-pitch modifier (Shift) adds +1 semitone for a deliberate WrongNote. Events then go through
 * the same judge path as the guitar (`GameSession.input`).
 *
 * The pitch lookup is pure ({@link laneMidi}); {@link attachKeyboard} binds the DOM listener.
 * @module
 */
import type { KeyboardSettings } from '@shared/settings';
import type { Note, Song, StringNumber } from '@shared/song';

/** One lane key press, before it is converted to a judge event. */
export interface LanePress {
  lane: StringNumber;
  /** +1 semitone (Shift held). */
  wrongPitch: boolean;
  /** `KeyboardEvent.timeStamp` (the `performance.now()` clock), ms. */
  timeStampMs: number;
}

/** Lane (1–6) bound to a `KeyboardEvent.code`, or null. */
export function laneForCode(code: string, lanes: KeyboardSettings['lanes']): StringNumber | null {
  const idx = lanes.indexOf(code);
  return idx >= 0 ? ((idx + 1) as StringNumber) : null;
}

/** Sounding pitch of the open `lane` (tuning + capo); E4 for a malformed tuning. */
export function openStringMidi(song: Pick<Song, 'meta'>, lane: StringNumber): number {
  const base = song.meta.tuning[lane - 1];
  return (typeof base === 'number' ? base : 64) + (song.meta.capo || 0);
}

/**
 * Notes per lane sorted by time, tied destinations excluded (they are not judge targets).
 * Build once per song with {@link laneIndex} and pass to {@link laneMidi}.
 */
export type LaneIndex = readonly (readonly Note[])[];

/** Index `song.notes` per lane (index 0 unused). */
export function laneIndex(song: Pick<Song, 'notes'>): LaneIndex {
  const lanes: Note[][] = [[], [], [], [], [], [], []];
  for (const n of song.notes) if (n.tiedFrom === undefined) lanes[n.string]?.push(n);
  for (const l of lanes) l.sort((a, b) => a.time - b.time);
  return lanes;
}

/**
 * Pitch for a key press on `lane` at `songTime`: the nearest note on that lane within
 * `windowSongSec` (the Good window converted to song seconds: `good × speed`), else the open
 * string. `wrongPitch` adds one semitone.
 */
export function laneMidi(
  song: Pick<Song, 'meta'>,
  index: LaneIndex,
  lane: StringNumber,
  songTime: number,
  windowSongSec: number,
  wrongPitch = false,
): number {
  const notes = index[lane] ?? [];
  let best: Note | null = null;
  let bestDist = Infinity;
  // Binary search for the first note at or after songTime − window, then scan the window.
  let lo = 0;
  let hi = notes.length;
  const from = songTime - windowSongSec;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((notes[mid] as Note).time < from) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < notes.length; i++) {
    const n = notes[i] as Note;
    if (n.time > songTime + windowSongSec) break;
    const d = Math.abs(n.time - songTime);
    if (d < bestDist) {
      best = n;
      bestDist = d;
    }
  }
  const midi = best ? best.midi : openStringMidi(song, lane);
  return wrongPitch ? midi + 1 : midi;
}

/** Callbacks for {@link attachKeyboard}. */
export interface KeyboardHandlers {
  /** A lane key went down (key repeats are ignored). */
  lane(press: LanePress): void;
  /** `Escape`: pause / resume. */
  escape?(): void;
  /** `Space` / `Enter` outside interactive controls: start or resume. */
  start?(): void;
}

/** True when the key event targets a form control or button (it must keep its own keys). */
function isInteractive(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  return (target as Element).closest('input, textarea, select, button, [contenteditable="true"], [role="slider"], a[href]') !== null;
}

/**
 * Listen for lane keys on `target` (usually `window`). Lane keys work even while a button has
 * focus (they are digits, no control uses them); `Space`/`Enter` only when no control is focused.
 * Returns a detach function.
 */
export function attachKeyboard(target: EventTarget, getLanes: () => KeyboardSettings, handlers: KeyboardHandlers): () => void {
  const onKeyDown = (raw: Event): void => {
    const ev = raw as KeyboardEvent;
    if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const settings = getLanes();
    const lane = laneForCode(ev.code, settings.lanes);
    if (lane !== null) {
      if (isInteractive(ev.target) && (ev.target as Element).closest('input, textarea, select, [contenteditable="true"]')) return;
      ev.preventDefault();
      if (ev.repeat) return;
      handlers.lane({ lane, wrongPitch: ev.getModifierState(settings.wrongPitchModifier), timeStampMs: ev.timeStamp });
      return;
    }
    if (ev.code === 'Escape' && handlers.escape) {
      ev.preventDefault();
      handlers.escape();
      return;
    }
    if ((ev.code === 'Space' || ev.code === 'Enter') && handlers.start && !isInteractive(ev.target)) {
      ev.preventDefault();
      if (!ev.repeat) handlers.start();
    }
  };
  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}

/** Human-readable key label for a `KeyboardEvent.code` (`Digit1` → `1`, `KeyA` → `A`). */
export function keyLabel(code: string): string {
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  return code;
}
