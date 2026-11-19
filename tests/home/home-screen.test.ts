// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext, ScreenHandle } from '@shared/ui';
import { mount } from '../../src/ui/screens/home';
import { eventually, testContext, type TestCtx } from './context';
import { DAY, HOUR, NOW, progress, result, run } from './fixtures';

const SONGS = () => [
  result('starter:open', 'Open Strings', { tier: 1, rating: 1.3, tags: { style: ['pick'], genre: ['exercise'], skills: [] } }),
  result('starter:ode', 'Ode to Joy', { tier: 2, rating: 1.9, composer: 'Beethoven' }),
  result('starter:hall', 'In the Hall of the Mountain King', { tier: 4, rating: 4.3, composer: 'Edvard Grieg' }),
  result('starter:scar', 'Scarborough Fair', { tier: 3, rating: 3.3 }),
];

describe('home screen', () => {
  let t: TestCtx;
  let el: HTMLElement;
  let handle: ScreenHandle | null;

  const text = (sel: string): string[] => Array.from(el.querySelectorAll(sel)).map((n) => n.textContent?.trim() ?? '');
  const start = async (): Promise<void> => {
    handle = await mount(el, t.ctx, {});
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    localStorage.clear();
    t = await testContext(SONGS());
    el = document.createElement('div');
    document.body.replaceChildren(el);
    handle = null;
  });

  afterEach(() => {
    handle?.unmount();
    t.storage.close();
    vi.useRealTimers();
  });

  it('greets a first-time player with the setup checklist and the easiest starter songs', async () => {
    await start();
    await eventually(() => expect(el.querySelector('h1')?.textContent).toBe('Welcome to Riffway'));
    expect(text('.hm-step__title')).toEqual(['Pick your guitar input (to do)', 'Tune up (to do)', 'Calibrate latency (to do)', 'Play your first song (to do)']);
    expect(Array.from(el.querySelectorAll<HTMLAnchorElement>('.hm-song')).map((a) => [a.querySelector('.hm-song__title')?.textContent, a.getAttribute('href')])).toEqual([
      ['Open Strings', '#/song/starter%3Aopen?arr=0'],
      ['Ode to Joy', '#/song/starter%3Aode?arr=0'],
      ['Scarborough Fair', '#/song/starter%3Ascar?arr=0'],
      ['In the Hall of the Mountain King', '#/song/starter%3Ahall?arr=0'],
    ]);
    expect(el.querySelector('.hm-tip')?.textContent).toMatch(/Got your own tabs\?/);
    expect(el.querySelector('.hm-week .hm-streak__headline')?.textContent).toBe('Start a streak');
    expect(el.querySelector('.hm-ring')?.getAttribute('aria-label')).toBe('Daily goal: 0 of 15 minutes today');
    // No goals, recommendations or recent results before the first run.
    expect(el.querySelector('.hm-goals, .hm-recs, .hm-recent')).toBeNull();
  });

  it('remembers “I’m tuned” and hiding the checklist per viewer', async () => {
    await start();
    await eventually(() => expect(el.querySelector('[data-step="tune"] button')).not.toBeNull());
    (el.querySelector('[data-step="tune"] button') as HTMLButtonElement).click();
    await eventually(() => expect(el.querySelector('[data-step="tune"]')?.classList.contains('is-done')).toBe(true));
    expect(JSON.parse(localStorage.getItem('riffway.home.checklist') ?? '{}')).toEqual({ tunedMarked: true, hidden: false });
    Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Hide checklist')!.click();
    await eventually(() => expect(el.querySelector('.hm-setup')).toBeNull());
    expect(el.querySelector('.hm-welcome')).not.toBeNull();
    expect(t.toasts.at(-1)?.message).toMatch(/Checklist hidden/);
  });

  it('shows continue, goals, recommendations, streak, recent results and repertoire once the player has played', async () => {
    const s = t.storage;
    await s.addRun(run({ songId: 'starter:ode', speed: 1, accuracy: 95, clean: true, startedAt: NOW - 3 * DAY, endedAt: NOW - 3 * DAY + 60_000 }));
    const last = await s.addRun(run({ songId: 'starter:hall', speed: 0.85, accuracy: 89, startedAt: NOW - 2 * HOUR, endedAt: NOW - HOUR, sections: [{ idx: 1, notes: 20, hits: 15, accuracy: 75 }] }));
    await s.putSectionProgress(progress({ songId: 'starter:hall', sectionIdx: 1, bestAccuracy: 75, trainer: { speed: 0.8, failStreak: 0 } }));
    for (const i of [0, 1]) await s.putSectionProgress(progress({ songId: 'starter:ode', sectionIdx: i, masteredAt: 1, lockedInAt: 2 }));
    await s.addPracticeTime('2026-11-16', 1200, 2);
    await s.addPracticeTime('2026-11-19', 540, 1);
    await s.settings.update({ input: { deviceId: 'dev', label: 'Scarlett' } });
    await start();
    await eventually(() => expect(el.querySelector('.hm-continue')).not.toBeNull());

    expect(el.querySelector('h1')?.textContent).toBe('Good evening');
    expect(el.querySelector('.hm-continue__title')?.textContent).toBe('In the Hall of the Mountain King');
    expect(el.querySelector('.hm-continue__next')?.textContent).toBe('Next up: Section 2 at 80%');
    expect(el.querySelector<HTMLAnchorElement>('.hm-continue .rw-btn--primary')?.getAttribute('href')).toBe('#/play/starter%3Ahall?arr=0&mode=practice&section=1&speed=0.8');
    // Always three goals to choose from (R2-U-15); the extra slot is another new song.
    expect(text('.hm-goal__title')).toEqual(['Fix the tricky bit', 'Start something new', 'Start something new']);
    expect(el.querySelectorAll('.hm-recs--stretch .hm-song').length).toBeGreaterThan(0);
    expect(el.querySelector('.hm-recs--stretch .hm-song__reason')?.textContent).toMatch(/comfort tier/);
    expect(text('.hm-run__title')).toEqual(['In the Hall of the Mountain King', 'Ode to Joy']);
    expect(el.querySelector<HTMLAnchorElement>('.hm-run')?.getAttribute('href')).toBe(`#/results/${last}`);
    expect(el.querySelector('.hm-stat.is-hero .hm-stat__value')?.textContent).toBe('1');
    expect(text('.hm-day.is-practiced .hm-day__letter')).toEqual(['M', 'T']);
    expect(el.querySelector('.hm-setup__title')?.textContent).toBe('Finish setting up');
    // The streak is evaluated lazily on open and stored.
    expect(await s.getStreak()).toMatchObject({ weekTarget: 4, current: 0, best: 0 });
  });

  it('records the picked goal for today', async () => {
    await t.storage.addRun(run({ songId: 'starter:hall', sections: [{ idx: 0, notes: 10, hits: 5, accuracy: 50 }] }));
    await start();
    await eventually(() => expect(el.querySelector('.hm-goal')).not.toBeNull());
    (el.querySelector('.hm-goal') as HTMLAnchorElement).click();
    expect(JSON.parse(localStorage.getItem('riffway.home.focus') ?? '{}')).toEqual({ date: '2026-11-19', kind: 'weakest-section', songId: 'starter:hall' });
  });

  it('keeps the local panels when the server is down and offers a retry', async () => {
    await t.storage.addRun(run());
    t.server.down = true;
    await start();
    await eventually(() => expect(el.querySelector('.hm-offline')).not.toBeNull());
    expect(el.querySelector('.hm-offline')?.textContent).toMatch(/companion server isn’t answering/);
    expect(el.querySelector('.hm-week')).not.toBeNull();
    expect(el.querySelector('.hm-continue__title')?.textContent).toBe('Unknown song');
    t.server.down = false;
    (el.querySelector('.hm-offline button') as HTMLButtonElement).click();
    await eventually(() => expect(el.querySelector('.hm-continue__title')?.textContent).toBe('In the Hall of the Mountain King'));
  });

  it('refreshes after new runs and library changes', async () => {
    await start();
    await eventually(() => expect(el.querySelector('h1')?.textContent).toBe('Welcome to Riffway'));
    await t.storage.addRun(run({ songId: 'starter:scar' }));
    await eventually(() => expect(el.querySelector('.hm-continue__title')?.textContent).toBe('Scarborough Fair'), 3000);
    const before = t.server.searches;
    t.emitLibraryChanged();
    await eventually(() => expect(t.server.searches).toBe(before + 1));
  });

  it('degrades to an explanation when the app context is incomplete', async () => {
    handle = await mount(el, {} as AppContext, {});
    expect(el.querySelector('h1')?.textContent).toBe('Home');
    expect(el.textContent).toMatch(/Home unavailable/);
    handle.unmount();
    expect(el.childElementCount).toBe(0);
    handle = null;
  });
});
