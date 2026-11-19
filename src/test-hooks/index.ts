/**
 * e2e test hook (D6): with `?e2e=1`, `window.__riffwayTest` is installed. It drives the game session
 * currently on screen through the same judge path as keyboard/guitar input (T-031; T-041 uses it).
 *
 * - `ready()`: a session is on screen and loaded (state other than `loading` / `error`).
 * - `inject({lane, songTime, wrongPitch})`: an onset on `lane` at exactly `songTime` in the current
 *   pass (`source: 'test'`), pitched like the nearest note on that lane (Shift-style +1 semitone with
 *   `wrongPitch`). Injections for times not reached yet are queued until the pass gets there, so a
 *   test can script a whole song before or right after pressing Play. Throws without a session.
 * - `getState()`: route + session snapshot (song, state, song time, speed, live judge state).
 * - `getJudgements()`: the run's **final** judgements in emission order (a provisional WrongNote
 *   appears once, as its final outcome) — of the last session, also after it left the screen
 *   (results page).
 * - `getNotes()` (**extension**, not yet in the frozen `RiffwayTestHook` contract): the session song's
 *   judge targets `{id, songTime, lane, midi, chord}` (tied destinations excluded), so a test can
 *   script a whole song with `inject`. Empty without a session.
 * - `setSpeed(speed)`: like the practice panel (bar-aligned while playing; resolves when the guide
 *   render for that speed is ready). `seek(songTime)`: like the practice panel (starts a new pass).
 * @module
 */
import type { StringNumber } from '@shared/song';
import type { AppContext, RiffwayTestHook, TestHookState } from '@shared/ui';
import { getActiveSession, getLastSession } from '../game/session/active';
import type { GameSessionImpl } from '../game/session/core';

/** One judge target of the session's song (`getNotes()`). */
export interface TestHookNote {
  id: number;
  songTime: number;
  lane: StringNumber;
  midi: number;
  /** Chord group id, when the note belongs to a chord. */
  chord: number | null;
}

/** The installed hook: the contract plus extensions documented in the module doc. */
export interface RiffwayTestHookExt extends RiffwayTestHook {
  getNotes(): TestHookNote[];
}

function requireSession(method: string): GameSessionImpl {
  const s = getActiveSession();
  if (!s) throw new Error(`__riffwayTest.${method}: no game session on screen`);
  return s;
}

/** Install `window.__riffwayTest` when `ctx.flags.e2e` is set. Returns the hook (or null). */
export function installTestHooks(ctx: AppContext): RiffwayTestHookExt | null {
  if (!ctx.flags.e2e) return null;
  const hook: RiffwayTestHookExt = {
    version: 1,
    ready: () => {
      const s = getActiveSession();
      return s !== null && s.state !== 'loading' && s.state !== 'error';
    },
    inject: (args) => requireSession('inject').injectTest(args),
    getState: (): TestHookState => {
      const s = getActiveSession();
      return {
        route: ctx.router.current(),
        session: s
          ? {
              songId: s.songId,
              arrangement: s.arrangement,
              state: s.state,
              songTime: s.clock.nowSong(),
              speed: s.speed,
              judge: s.judgeState(),
            }
          : null,
      };
    },
    getJudgements: () => {
      const s = getActiveSession() ?? getLastSession();
      return s ? s.judgements().filter((j) => j.final) : [];
    },
    getNotes: () => {
      const s = getActiveSession();
      if (!s) return [];
      return s.song.notes
        .filter((n) => n.tiedFrom === undefined)
        .map((n) => ({ id: n.id, songTime: n.time, lane: n.string, midi: n.midi, chord: n.chordId ?? null }));
    },
    setSpeed: (speed) => requireSession('setSpeed').setSpeed(speed),
    seek: (songTime) => requireSession('seek').seek(songTime),
  };
  window.__riffwayTest = hook;
  return hook;
}
