/**
 * The game session currently on screen (at most one). The game screen registers it; the e2e test
 * hook (`src/test-hooks`) reads it.
 * @module
 */
import type { GameSessionImpl } from './core';

let active: GameSessionImpl | null = null;
let last: GameSessionImpl | null = null;
const listeners = new Set<(s: GameSessionImpl | null) => void>();

/** Register (or clear with null) the active session. */
export function setActiveSession(session: GameSessionImpl | null): void {
  active = session;
  if (session) last = session;
  for (const cb of [...listeners]) cb(session);
}

/** The active session, or null. */
export function getActiveSession(): GameSessionImpl | null {
  return active;
}

/** The most recent session registered (still available after it left the screen), or null. */
export function getLastSession(): GameSessionImpl | null {
  return last;
}

/** Clear the active session only if it is still `session` (a newer one may have replaced it). */
export function clearActiveSession(session: GameSessionImpl): void {
  if (active === session) setActiveSession(null);
}

/** Subscribe to active-session changes. */
export function onActiveSession(cb: (s: GameSessionImpl | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
