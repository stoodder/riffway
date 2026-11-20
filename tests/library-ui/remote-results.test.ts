// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteSearchResponse } from '@shared/api';
import type { RemoteSearchHit } from '@shared/sources';
import { remoteNote, remoteResults } from '../../src/ui/screens/library/remote-results';

const hit = (title: string, extra: Partial<RemoteSearchHit> = {}): RemoteSearchHit => ({
  source: 'songsterr',
  remoteId: title,
  title,
  url: `https://fixtures.invalid/${encodeURIComponent(title)}`,
  tracks: [],
  ...extra,
});
const ok = (hits: RemoteSearchHit[]): RemoteSearchResponse => ({ source: 'songsterr', status: 'ok', hits });

describe('remote results ("On Songsterr")', () => {
  const open = vi.fn();
  const win = { open } as unknown as Window;
  let group: ReturnType<typeof remoteResults>;
  const onPlay = vi.fn();
  const rows = (): HTMLElement[] => Array.from(group.el.querySelectorAll<HTMLElement>('.lib-remote__row'));
  const note = (): string => group.el.querySelector('.lib-remote__note')?.textContent ?? '';

  beforeEach(() => {
    open.mockReset();
    onPlay.mockReset();
    group = remoteResults(win);
    document.body.replaceChildren(group.el);
  });
  afterEach(() => document.body.replaceChildren());

  it('starts hidden and shows a busy note while loading', () => {
    expect(group.el.hidden).toBe(true);
    group.loading();
    expect(group.el.hidden).toBe(false);
    expect(group.el.getAttribute('aria-busy')).toBe('true');
    expect(note()).toBe('Searching Songsterr…');
    expect(group.el.querySelector('h3')?.textContent).toBe('On Songsterr');
  });

  it('ok: rows with title, artist and tuning; Open goes to a new tab, Play opens the library song', () => {
    group.render(
      ok([
        hit('Fixture Riff', { artist: 'The Testers', tuningLabel: 'Drop D', localMatchIds: ['local:1', 'local:2'] }),
        hit('Remote Only Fixture', { tuningLabel: 'Standard' }),
      ]),
      onPlay,
    );
    expect(group.el.hidden).toBe(false);
    expect(group.el.hasAttribute('aria-busy')).toBe(false);
    expect(note()).toMatch(/new tab.*Guitar Pro file/);
    const [mine, remote] = rows();
    expect(mine?.textContent).toContain('Fixture Riff');
    expect(mine?.querySelector('.lib-remote__artist')?.textContent).toBe('The Testers');
    expect(mine?.querySelector('.lib-remote__tuning')?.textContent).toBe('Drop D');

    const play = mine?.querySelector('button') as HTMLButtonElement;
    expect(play.getAttribute('aria-label')).toBe('Play Fixture Riff (in your library)');
    expect(play.textContent).toBe('Play (in your library)');
    play.click();
    expect(onPlay).toHaveBeenCalledWith('local:1', expect.objectContaining({ title: 'Fixture Riff' }));
    expect(open).not.toHaveBeenCalled();

    const openBtn = remote?.querySelector('button') as HTMLButtonElement;
    expect(openBtn.getAttribute('aria-label')).toBe('Open Remote Only Fixture on Songsterr (opens a new tab)');
    openBtn.click();
    expect(open).toHaveBeenCalledWith('https://fixtures.invalid/Remote%20Only%20Fixture', '_blank', 'noopener,noreferrer');
  });

  it('ok without hits says so', () => {
    group.render(ok([]), onPlay);
    expect(group.el.hidden).toBe(false);
    expect(note()).toBe('No matches on Songsterr.');
    expect(rows()).toHaveLength(0);
  });

  it('refused: explains and keeps the link-out', () => {
    group.render(ok([hit('Stale')]), onPlay);
    group.render({ source: 'songsterr', status: 'refused', message: 'Declined', hits: [] }, onPlay);
    expect(group.el.hidden).toBe(false);
    expect(group.el.dataset.status).toBe('refused');
    expect(note()).toMatch(/declined.*off until Riffway restarts.*Search on Songsterr/);
    expect(rows()).toHaveLength(0);
  });

  it('error: shows the server message', () => {
    group.render({ source: 'songsterr', status: 'error', message: 'It didn’t answer.', hits: [] }, onPlay);
    expect(note()).toBe('It didn’t answer.');
    expect(remoteNote({ source: 'songsterr', status: 'error', hits: [] })).toMatch(/Couldn’t reach Songsterr/);
  });

  it('off hides the group; off with a message (not set up) shows it', () => {
    group.render(ok([hit('Stale')]), onPlay);
    group.render({ source: 'songsterr', status: 'off', hits: [] }, onPlay);
    expect(group.el.hidden).toBe(true);
    expect(rows()).toHaveLength(0);
    group.render({ source: 'songsterr', status: 'off', message: 'Songsterr search isn’t set up yet.', hits: [] }, onPlay);
    expect(group.el.hidden).toBe(false);
    expect(note()).toBe('Songsterr search isn’t set up yet.');
    group.render(null, onPlay);
    expect(group.el.hidden).toBe(true);
  });
});
