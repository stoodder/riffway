// @vitest-environment happy-dom
/**
 * `window.__riffwayTest` (`?e2e=1`): drives the active session through the same judge path.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '@shared/ui';
import { clearActiveSession, setActiveSession } from '../../src/game/session/active';
import { installTestHooks } from '../../src/test-hooks';
import { makeSong, Rig } from './helpers';

const ctx = (e2e: boolean): AppContext =>
  ({ flags: { e2e, dev: false }, router: { current: () => ({ screen: 'game', path: '/play/x', params: {} }) } }) as unknown as AppContext;

afterEach(() => {
  delete window.__riffwayTest;
});

describe('test hooks', () => {
  it('is only installed with ?e2e=1', () => {
    expect(installTestHooks(ctx(false))).toBeNull();
    expect(window.__riffwayTest).toBeUndefined();
  });

  it('scripts a run: inject, getState, getJudgements, seek, setSpeed, getNotes', async () => {
    const hook = installTestHooks(ctx(true))!;
    expect(window.__riffwayTest).toBe(hook);
    expect(hook.ready()).toBe(false);
    expect(() => hook.inject({ lane: 1, songTime: 1 })).toThrow(/no game session/);
    expect(hook.getState().session).toBeNull();

    const song = makeSong([{ time: 1 }, { time: 1.5 }, { time: 2 }, { time: 2.5, string: 2 }], { bars: 2 });
    const rig = new Rig({ song });
    setActiveSession(rig.session);
    expect(hook.ready()).toBe(true);
    expect(hook.getNotes().map((n) => [n.songTime, n.lane])).toEqual([
      [1, 1],
      [1.5, 1],
      [2, 1],
      [2.5, 2],
    ]);
    rig.session.play();
    hook.inject({ lane: 1, songTime: 1 });
    hook.inject({ lane: 1, songTime: 1.5, wrongPitch: true });
    hook.inject({ lane: 2, songTime: 2.5 });
    rig.until(() => rig.session.state === 'ended', 10);
    const outcomes = hook.getJudgements().map((j) => j.outcome);
    expect(outcomes).toEqual(['Perfect', 'WrongNote', 'Miss', 'Perfect']);
    const state = hook.getState();
    expect(state.route?.screen).toBe('game');
    expect(state.session).toMatchObject({ songId: 'test:song', state: 'ended', speed: 1 });
    expect(state.session?.judge.counts.Perfect).toBe(2);

    await hook.setSpeed(0.7);
    expect(rig.session.speed).toBe(0.7);
    hook.seek(1.5);
    expect(rig.core.state).toBe('stopped');

    // After the session leaves the screen the last run's judgements stay readable.
    clearActiveSession(rig.session);
    expect(hook.ready()).toBe(false);
    expect(hook.getJudgements()).toHaveLength(4);
    await rig.session.dispose();
  });
});
