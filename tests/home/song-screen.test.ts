// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext, ScreenHandle } from '@shared/ui';
import { eventually, testContext, type TestCtx } from './context';
import { HOUR, NOW, progress, result, run, song, songMeta, track } from './fixtures';

/** Panel mounts are recorded instead of loading the real (audio) panels. */
const panelMounts: { id: string; props: unknown; unmounted: boolean }[] = [];
vi.mock('../../src/ui/panels', () => ({
  mountPanel: vi.fn(async (id: string, host: HTMLElement, _ctx: unknown, props: unknown) => {
    const rec = { id, props, unmounted: false };
    panelMounts.push(rec);
    host.append(Object.assign(document.createElement('div'), { className: `fake-panel-${id}` }));
    return { unmount: () => void (rec.unmounted = true), update: vi.fn() };
  }),
}));

const { mount } = await import('../../src/ui/screens/song');

const DROP_D = [64, 59, 55, 50, 45, 38];

describe('song page', () => {
  let t: TestCtx;
  let el: HTMLElement;
  let handle: ScreenHandle | null;

  const start = async (params: Record<string, string>): Promise<ScreenHandle> => {
    handle = await mount(el, t.ctx, params);
    return handle;
  };
  const text = (sel: string): string[] => Array.from(el.querySelectorAll(sel)).map((n) => n.textContent?.trim() ?? '');
  const href = (sel: string): string | null => el.querySelector(sel)?.getAttribute('href') ?? null;
  const buttonNamed = (name: string): HTMLButtonElement => {
    const b = Array.from(el.querySelectorAll('button')).find((x) => x.textContent?.includes(name));
    if (!b) throw new Error(`no button ${name}`);
    return b;
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    panelMounts.length = 0;
    t = await testContext([result('starter:hall', 'Hall')]);
    t.server.metas.set('starter:hall', songMeta('starter:hall', 'In the Hall of the Mountain King'));
    t.songs.set('starter:hall', song('starter:hall'));
    el = document.createElement('div');
    document.body.replaceChildren(el);
    handle = null;
  });

  afterEach(() => {
    handle?.unmount();
    t.storage.close();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('shows meta, difficulty “why”, Play/Practice, sections with Loop this, bests and the trend', async () => {
    const s = t.storage;
    const r1 = await s.addRun(run({ accuracy: 72, startedAt: NOW - 3 * HOUR }));
    await s.addRun(run({ accuracy: 88, startedAt: NOW - 2 * HOUR }));
    await s.putBestIfBetter({ songId: 'starter:hall', arrangement: 0, speedBucket: 80, score: 1234, accuracy: 88, stars: 4, runId: r1, at: NOW - HOUR });
    await s.putSectionProgress(progress({ sectionIdx: 1, trainer: { speed: 0.8, failStreak: 0 }, cleanRuns: 2, bestAccuracy: 84 }));
    await start({ id: 'starter:hall', arr: '0' });
    await eventually(() => expect(text('.sg-sec__name')).toEqual(['Intro2.5', 'Riff4.8', 'Outro3.0']));
    await eventually(() => expect(text('.sg-best__speed')).toEqual(['80%']));

    expect(el.querySelector('h1')?.textContent).toBe('In the Hall of the Mountain King');
    expect(el.querySelector('.sg-hero__by')?.textContent).toBe('Edvard Grieg');
    expect(text('.sg-chip')).toEqual(['0:30', '120 BPM', 'Standard', 'Rhythm from file']);
    expect(el.querySelector('.sg-hero .rw-diff')?.getAttribute('aria-label')).toBe('Difficulty 4.3, tier 4, Developing');
    const actions = Array.from(el.querySelectorAll<HTMLAnchorElement>('.sg-hero__actions a')).map((a) => [a.textContent, a.getAttribute('href')]);
    expect(actions).toEqual([
      ['Play', '#/play/starter%3Ahall?arr=0&mode=play'],
      ['Practice', '#/play/starter%3Ahall?arr=0&mode=practice'],
    ]);
    expect(el.querySelector('#sg-why-title')?.textContent).toBe('Why it’s a 4.3');
    expect(text('.sg-why li')).toEqual(['fast position shifts']);
    expect(el.querySelector('.sg-bar.is-hardest .sg-bar__name')?.textContent).toBe('Riff');
    const states = Array.from(el.querySelectorAll<HTMLElement>('.sg-sec')).map((r) => r.dataset.state);
    expect(states).toEqual(['new', 'practising', 'new']);
    expect(Array.from(el.querySelectorAll('.sg-sec a')).map((a) => a.getAttribute('href'))).toEqual([
      '#/play/starter%3Ahall?arr=0&mode=practice&section=0',
      '#/play/starter%3Ahall?arr=0&mode=practice&section=1&speed=0.8',
      '#/play/starter%3Ahall?arr=0&mode=practice&section=2',
    ]);
    expect(text('.sg-best__speed')).toEqual(['80%']);
    expect(href('.sg-best')).toBe(`#/results/${r1}`);
    expect(el.querySelector('.rw-spark')?.getAttribute('aria-label')).toBe('Accuracy over your last 2 runs: 72% to 88% (best 88%)');
    expect(text('.sg-tag')).toEqual(['position shifts', 'chords', 'pick', 'classical']);
    // No arrangement picker for a single-track song; no retune prompt in standard tuning.
    expect(el.querySelector('.sg-arrs, .sg-retune')).toBeNull();
    // Opening the song refreshes its cache entry for the home screen.
    expect((await s.getSongCache('starter:hall'))?.meta).toMatchObject({ title: 'In the Hall of the Mountain King', tier: 4 });
  });

  it('canonicalises a missing arr and switches arrangements through the picker', async () => {
    t.server.metas.set(
      'starter:hall',
      songMeta('starter:hall', 'Hall', { tracks: [track(0, 'Rhythm'), track(1, 'Bass', { playable: false, unsupportedReason: 'bass' }), track(2, 'Lead', { tuning: DROP_D })] }),
    );
    await start({ id: 'starter:hall' });
    await eventually(() => expect(el.querySelector('.sg-arrs')).not.toBeNull());
    expect(t.navigations[0]).toEqual({ path: '#/song/starter%3Ahall?arr=0', replace: true });
    expect(text('.sg-arr__name')).toEqual(['RhythmDefault', 'Lead']);
    expect(el.querySelector('.sg-arr.is-current .sg-arr__name')?.textContent).toBe('RhythmDefault');
    expect(el.querySelector('.sg-arrs + .sg-note')?.textContent).toMatch(/1 other track/);
    expect(href('.sg-arr:not(.is-current)')).toBe('#/song/starter%3Ahall?arr=2');
    handle!.update!({ id: 'starter:hall', arr: '2' });
    await eventually(() => expect(el.querySelector('.sg-arr.is-current .sg-arr__name')?.textContent).toBe('Lead'));
    expect(el.querySelector('.sg-retune h2')?.textContent).toBe('Retune to Drop D');
    expect(text('.sg-string.is-changed')).toEqual(['D']);
  });

  it('opens the tuner panel for the song’s tuning in a modal', async () => {
    t.server.metas.set('starter:hall', songMeta('starter:hall', 'Chug', { tracks: [track(0, 'Lead', { tuning: DROP_D })] }));
    await start({ id: 'starter:hall', arr: '0' });
    await eventually(() => expect(el.querySelector('.sg-retune')).not.toBeNull());
    buttonNamed('Open tuner').click();
    await eventually(() => expect(panelMounts.map((p) => p.id)).toEqual(['tuner']));
    expect(panelMounts[0]!.props).toEqual({ tuning: DROP_D });
    expect(document.querySelector('[role="dialog"]')?.textContent).toMatch(/Tune to Drop D/);
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((b) => b.textContent === 'Done')!.click();
    await eventually(() => expect(panelMounts[0]!.unmounted).toBe(true));
  });

  it('mounts the backing panel only on request, never while the transport is running', async () => {
    await t.storage.putAudioLink({ songId: 'starter:hall', arrangement: 0, audioId: 'f'.repeat(40), fileName: 'my-take.mp3', anchors: [{ songTime: 0, audioTime: 0 }], gainDb: 0, enabled: true });
    await start({ id: 'starter:hall', arr: '0' });
    await eventually(() => expect(buttonNamed('Open backing audio').disabled).toBe(false));
    expect(el.querySelector('.sg-backing__file')?.textContent).toBe('my-take.mp3');
    expect(panelMounts).toEqual([]);

    t.transport = { state: 'playing' };
    buttonNamed('Open backing audio').click();
    await eventually(() => expect(t.toasts.at(-1)?.message).toMatch(/already playing/));
    expect(panelMounts).toEqual([]);

    t.transport = { state: 'stopped' };
    buttonNamed('Open backing audio').click();
    await eventually(() => expect(el.querySelector('.fake-panel-backing')).not.toBeNull());
    expect(panelMounts[0]).toMatchObject({ id: 'backing', props: { songId: 'starter:hall', arrangement: 0, song: t.songs.get('starter:hall') } });

    // A progress refresh re-renders the page but keeps the mounted panel.
    await t.storage.addRun(run());
    await eventually(() => expect(el.querySelector('.rw-spark, .sg-bests, .sg-card')).not.toBeNull());
    expect(el.querySelector('.fake-panel-backing')).not.toBeNull();
    expect(panelMounts[0]!.unmounted).toBe(false);
    handle!.unmount();
    handle = null;
    expect(panelMounts[0]!.unmounted).toBe(true);
  });

  it('disables backing audio when the song model cannot be loaded', async () => {
    t.songs.clear();
    await start({ id: 'starter:hall', arr: '0' });
    await eventually(() => expect(el.querySelector('.sg-backing')?.textContent).toMatch(/couldn’t be loaded/));
    expect(buttonNamed('Attach backing audio').disabled).toBe(true);
    // Sections fall back to the difficulty report.
    expect(text('.sg-sec__name').map((n) => n.replace(/[\d.]+$/, ''))).toEqual(['Intro', 'Riff', 'Outro']);
  });

  it('sends unaligned text tabs to rhythm alignment instead of Play', async () => {
    t.server.metas.set('local:tab', songMeta('local:tab', 'Campfire', { entry: { format: 'ascii', rhythm: 'needs-alignment', source: 'local' } }));
    t.songs.set('local:tab', song('local:tab'));
    await start({ id: 'local:tab', arr: '0' });
    await eventually(() => expect(el.querySelector('.sg-hero__actions a')?.textContent).toBe('Align rhythm to play'));
    expect(href('.sg-hero__actions a')).toBe('#/import?song=local%3Atab');
    expect(el.querySelector('.sg-hero__actions')?.textContent).not.toMatch(/^Play/);
    expect(el.textContent).toMatch(/Rhythm/);
  });

  it('explains a missing song and an unreachable server', async () => {
    await start({ id: 'local:gone', arr: '0' });
    await eventually(() => expect(el.querySelector('h1')?.textContent).toBe('Song not found'));
    handle!.unmount();
    t.server.down = true;
    await start({ id: 'starter:hall', arr: '0' });
    await eventually(() => expect(el.querySelector('h1')?.textContent).toBe('Can’t reach the companion server'));
    t.server.down = false;
    buttonNamed('Try again').click();
    await eventually(() => expect(el.querySelector('h1')?.textContent).toBe('In the Hall of the Mountain King'));
  });

  it('degrades to an explanation when the app context is incomplete', async () => {
    handle = await mount(el, {} as AppContext, {});
    expect(el.querySelector('h1')?.textContent).toBe('Song');
    expect(el.textContent).toMatch(/Song unavailable/);
  });
});
