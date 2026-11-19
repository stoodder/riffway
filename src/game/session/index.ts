/**
 * Game session (T-031): loads the song via the worker, sets up guide/backing, transport, guitar +
 * keyboard input → judge → HUD, practice loop/trainer, saves runs/bests/progress.
 * Signature frozen by T-010.
 * @module
 */
import type { GameSession, SessionOptions } from '@shared/services';
import type { AppContext } from '@shared/ui';
import { notImplemented } from '@shared/errors';

export async function createSession(ctx: AppContext, opts: SessionOptions): Promise<GameSession> {
  return notImplemented('createSession', 'T-031');
}
