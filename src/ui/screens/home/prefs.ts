/**
 * Per-viewer home conveniences kept in `localStorage` (T-034): the setup checklist's "I'm tuned" tick
 * and "hide" choice, and the session goal picked today. Not progress data (that lives in IndexedDB);
 * every access is guarded so a private window or blocked storage just falls back to defaults.
 * @module
 */
import type { FocusPick } from './model';

const CHECKLIST_KEY = 'riffway.home.checklist';
const FOCUS_KEY = 'riffway.home.focus';

/** Checklist state stored per viewer. */
export interface ChecklistPrefs {
  tunedMarked: boolean;
  hidden: boolean;
}

function read(storage: Storage | null, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function write(storage: Storage | null, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the preference simply isn't remembered.
  }
}

/** `window.localStorage`, or null where it throws (blocked site data). */
export function localStore(win: Window): Storage | null {
  try {
    return win.localStorage;
  } catch {
    return null;
  }
}

/** Read the checklist state (defaults: not tuned, visible). */
export function readChecklist(storage: Storage | null): ChecklistPrefs {
  const v = read(storage, CHECKLIST_KEY) as Partial<ChecklistPrefs> | null;
  return { tunedMarked: v?.tunedMarked === true, hidden: v?.hidden === true };
}

/** Merge and store checklist state. */
export function writeChecklist(storage: Storage | null, patch: Partial<ChecklistPrefs>): void {
  write(storage, CHECKLIST_KEY, { ...readChecklist(storage), ...patch });
}

/** Today's picked session goal, if any. */
export function readFocus(storage: Storage | null): FocusPick | null {
  const v = read(storage, FOCUS_KEY) as Partial<FocusPick> | null;
  if (!v || typeof v.date !== 'string' || typeof v.kind !== 'string' || typeof v.songId !== 'string') return null;
  return { date: v.date, kind: v.kind, songId: v.songId };
}

/** Remember the picked session goal. */
export function writeFocus(storage: Storage | null, pick: FocusPick): void {
  write(storage, FOCUS_KEY, pick);
}
