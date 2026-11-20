// @vitest-environment happy-dom
/**
 * Library screen wiring for the opt-in "On Songsterr" results: off unless enabled, its own debounce,
 * a newer query cancels the request in flight, unmount cancels too, and Play opens the library song.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteSearchResponse } from '@shared/api';
import type { ScreenHandle } from '@shared/ui';
import { mount, REMOTE_DEBOUNCE_MS, SEARCH_DEBOUNCE_MS } from '../../src/ui/screens/library';
import { createFakeServer, fakeContext, meta, result, type FakeCtx, type FakeServer } from './fake-server';

const flush = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
};

const SONGS = () => [result('starter:green', 'Greensleeves'), result('local:riff', 'Fixture Riff', { source: 'local' })];

const ok = (q: string): RemoteSearchResponse => ({
  source: 'songsterr',
  status: 'ok',
  hits: [
    { source: 'songsterr', remoteId: '1', title: `Remote ${q}`, url: `https://fixtures.invalid/${encodeURIComponent(q)}`, tracks: [] },
    { source: 'songsterr', remoteId: '2', title: 'Greensleeves', url: 'https://fixtures.invalid/green', tracks: [], localMatchIds: ['starter:green'] },
    { source: 'songsterr', remoteId: '3', title: 'Elsewhere', url: 'https://fixtures.invalid/else', tracks: [], localMatchIds: ['local:elsewhere'] },
  ],
});

describe('library screen: remote results', () => {
  let server: FakeServer;
  let fake: FakeCtx;
  let el: HTMLElement;
  let handle: ScreenHandle | null;

  const group = (): HTMLElement => el.querySelector('.lib-remote') as HTMLElement;
  const type = async (text: string): Promise<void> => {
    const input = el.querySelector('.lib-search__input') as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new Event('input'));
  };
  async function start(): Promise<void> {
    handle = await mount(el, fake.ctx, {});
    await flush();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    server = createFakeServer(SONGS());
    server.remote = ok;
    fake = fakeContext(server);
    el = document.createElement('div');
    document.body.replaceChildren(el);
    handle = null;
    vi.spyOn(window, 'open').mockImplementation(() => null);
  });
  afterEach(() => {
    handle?.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends nothing while remote search is off in the config', async () => {
    await start();
    await type('fixture riff');
    await flush(SEARCH_DEBOUNCE_MS + REMOTE_DEBOUNCE_MS + 100);
    expect(server.remoteQueries).toEqual([]);
    expect(group().hidden).toBe(true);
  });

  it('debounces typing into one request and renders the group inside "Find more tabs"', async () => {
    server.config.remoteSearch = ['songsterr'];
    await start();
    await type('fix');
    await flush(SEARCH_DEBOUNCE_MS + 100);
    expect(group().hidden).toBe(false);
    expect(group().textContent).toContain('Searching Songsterr…');
    await type('fixture riff');
    await flush(SEARCH_DEBOUNCE_MS + REMOTE_DEBOUNCE_MS + 50);
    expect(server.remoteQueries).toEqual(['fixture riff']);
    expect(group().closest('.lib-linkouts')).not.toBeNull();
    expect(Array.from(group().querySelectorAll('.lib-remote__name')).map((n) => n.textContent)).toEqual(['Remote fixture riff', 'Greensleeves', 'Elsewhere']);

    // A filter or sort change keeps the query: no new remote request.
    (el.querySelector('.lib-search__input') as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush(REMOTE_DEBOUNCE_MS + 50);
    expect(server.remoteQueries).toEqual(['fixture riff']);

    // Short queries clear it without a request.
    await type('fi');
    await flush(SEARCH_DEBOUNCE_MS + REMOTE_DEBOUNCE_MS + 50);
    expect(server.remoteQueries).toEqual(['fixture riff']);
    expect(group().hidden).toBe(true);
  });

  it('a newer query cancels the request in flight; only the newest renders', async () => {
    server.config.remoteSearch = ['songsterr'];
    server.remoteDelayMs = 1000;
    await start();
    await type('first query');
    await flush(SEARCH_DEBOUNCE_MS + REMOTE_DEBOUNCE_MS + 50);
    expect(server.remoteQueries).toEqual(['first query']);
    await type('second query');
    await flush(SEARCH_DEBOUNCE_MS + 50);
    await flush(1000);
    expect(server.remoteAborted).toBe(1);
    await flush(REMOTE_DEBOUNCE_MS + 1000);
    expect(server.remoteQueries).toEqual(['first query', 'second query']);
    expect(group().textContent).toContain('Remote second query');
    expect(group().textContent).not.toContain('Remote first query');
  });

  it('unmount cancels a pending request', async () => {
    server.config.remoteSearch = ['songsterr'];
    server.remoteDelayMs = 1000;
    await start();
    await type('fixture riff');
    await flush(SEARCH_DEBOUNCE_MS + REMOTE_DEBOUNCE_MS + 50);
    handle?.unmount();
    handle = null;
    await flush(1000);
    expect(server.remoteAborted).toBe(1);
  });

  it('Play opens the matched library song; Open goes through window.open', async () => {
    server.config.remoteSearch = ['songsterr'];
    server.metas.set('local:elsewhere', meta(result('local:elsewhere', 'Elsewhere', { source: 'local' }), ['Lead']));
    await start();
    await type('greensleeves');
    await flush(SEARCH_DEBOUNCE_MS + REMOTE_DEBOUNCE_MS + 50);
    const buttons = Array.from(group().querySelectorAll<HTMLButtonElement>('button'));
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Open Remote greensleeves on Songsterr (opens a new tab)',
      'Play Greensleeves (in your library)',
      'Play Elsewhere (in your library)',
    ]);
    buttons[0]!.click();
    expect(window.open).toHaveBeenCalledWith('https://fixtures.invalid/greensleeves', '_blank', 'noopener,noreferrer');
    // In the current results: opens like a row.
    buttons[1]!.click();
    await flush();
    expect(fake.navigations.at(-1)).toBe('#/song/starter%3Agreen?arr=0');
    // Not among the shown results: looked up by id, then opened.
    buttons[2]!.click();
    await flush();
    expect(fake.navigations.at(-1)).toBe('#/song/local%3Aelsewhere?arr=0');
  });
});
