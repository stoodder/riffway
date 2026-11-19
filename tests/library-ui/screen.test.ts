// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenHandle } from '@shared/ui';
import { mount, REFRESH_DEBOUNCE_MS, SEARCH_DEBOUNCE_MS } from '../../src/ui/screens/library';
import { createFakeServer, fakeContext, FakeEventSource, meta, result, type FakeCtx, type FakeServer } from './fake-server';

const flush = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
};

const SONGS = () => [
  result('starter:hall', 'In the Hall of the Mountain King', { composer: 'Edvard Grieg', tier: 4, rating: 4.3 }),
  result('local:aaa', 'Campfire Song', { source: 'local', artist: 'Some Artist', availability: 'needs-rhythm', rhythm: 'needs-alignment', ratingProvisional: true }),
  result('local:bbb', 'Twin Lead Etude', { source: 'local', arrangements: 2, tags: { style: ['fingerstyle'], genre: [], skills: [] } }),
  result('local:ccc', 'Broken Download', { source: 'local', availability: 'needs-import', tier: null, rating: null }),
  result('starter:chug', 'Drop-D Palm-Mute Chug', { tuningId: 'drop-d', tuningLabel: 'Drop D', tier: 4 }),
];

describe('library screen', () => {
  let server: FakeServer;
  let fake: FakeCtx;
  let el: HTMLElement;
  let handle: ScreenHandle | null;
  const open = vi.fn();

  async function start(params: Record<string, string> = {}): Promise<ScreenHandle> {
    handle = await mount(el, fake.ctx, params);
    await flush();
    return handle;
  }
  const rows = (): string[] => Array.from(el.querySelectorAll('.lib-row__open')).map((b) => b.textContent ?? '');
  const row = (title: string): HTMLElement => {
    const btn = Array.from(el.querySelectorAll<HTMLElement>('.lib-row__open')).find((b) => b.textContent === title);
    if (!btn) throw new Error(`no row ${title}`);
    return btn.closest('.lib-row') as HTMLElement;
  };
  const input = (): HTMLInputElement => el.querySelector('.lib-search__input') as HTMLInputElement;
  const type = async (text: string): Promise<void> => {
    input().value = text;
    input().dispatchEvent(new Event('input'));
  };
  const lastSearch = (): URLSearchParams => server.searches.at(-1) as URLSearchParams;
  const key = (target: EventTarget, k: string): KeyboardEvent => {
    const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    return ev;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    server = createFakeServer(SONGS());
    fake = fakeContext(server);
    el = document.createElement('div');
    document.body.replaceChildren(el);
    handle = null;
    open.mockReset();
    vi.spyOn(window, 'open').mockImplementation(open);
  });

  afterEach(() => {
    handle?.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders result rows with difficulty, source, tuning, style tags, rhythm and playable state', async () => {
    await start();
    expect(rows()).toEqual(['In the Hall of the Mountain King', 'Campfire Song', 'Twin Lead Etude', 'Broken Download', 'Drop-D Palm-Mute Chug']);
    const hall = row('In the Hall of the Mountain King');
    expect(hall.querySelector('.rw-diff')?.getAttribute('aria-label')).toBe('Difficulty 4.3, tier 4, Developing');
    expect(hall.querySelector('.lib-row__meta')?.textContent).toContain('Starter');
    expect(hall.querySelector('.lib-row__tuning')?.textContent).toBe('Standard');
    expect(hall.querySelector('.lib-row__rhythm')?.textContent).toBe('Rhythm from file');
    expect(Array.from(hall.querySelectorAll('.lib-tag')).map((t) => t.textContent)).toEqual(['pick', 'rock']);
    expect(hall.querySelector('.lib-row__state')?.textContent).toContain('Playable now');
    expect(hall.querySelector('.lib-row__by')?.textContent).toBe('Edvard Grieg');
    expect(row('Campfire Song').querySelector('.lib-row__state')?.textContent).toContain('Needs rhythm');
    expect(row('Campfire Song').querySelector('.lib-row__est')?.textContent).toBe('est.');
    expect(row('Broken Download').querySelector('.lib-row__state')?.textContent).toContain('Needs import');
    expect(row('Broken Download').textContent).toContain('Unrated');
    expect(el.querySelector('.lib-status')?.textContent).toBe('5 songs');
    expect(el.querySelector('.lib-folder__path')?.textContent).toBe('/Users/me/Music/Tabs');
    // Facets: indexed sources with counts, tunings seen in the library.
    expect(Array.from(el.querySelectorAll('.lib-chips .lib-chip')).map((c) => c.textContent)).toEqual(['All', 'My files3', 'Starter2']);
    const tuning = Array.from(el.querySelectorAll('select')).find((s) => s.options[0]?.text === 'Any tuning') as HTMLSelectElement;
    expect(Array.from(tuning.options).map((o) => o.text)).toEqual(['Any tuning', 'Standard', 'Drop D']);
  });

  it('debounces typing by 150 ms, then searches and writes the URL', async () => {
    await start();
    const before = server.searches.length;
    await type('moun');
    await flush(SEARCH_DEBOUNCE_MS - 10);
    await type('mountain');
    await flush(SEARCH_DEBOUNCE_MS - 10);
    expect(server.searches.length).toBe(before);
    await flush(20);
    expect(server.searches.length).toBe(before + 1);
    expect(lastSearch().get('q')).toBe('mountain');
    expect(fake.navigations.at(-1)).toBe('#/library?q=mountain');
    expect(rows()).toEqual(['In the Hall of the Mountain King']);
    expect(el.querySelector('.lib-status')?.textContent).toBe('1 song for “mountain”');
  });

  it('shows link-outs for a query and opens them in a new tab with noopener, never fetching the site', async () => {
    await start({ q: 'mountain' });
    expect(el.querySelector('.lib-linkouts__hint')?.textContent).toMatch(/open in a new tab/);
    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('.lib-linkout__btn'));
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Search on Songsterr (opens a new tab)', 'Search on Ultimate Guitar (opens a new tab)']);
    expect(el.querySelector('.lib-linkout__match')?.textContent).toBe('Already in your library: In the Hall of the Mountain King');
    buttons[0]!.click();
    buttons[1]!.click();
    expect(open.mock.calls).toEqual([
      ['https://www.songsterr.com/?pattern=mountain', '_blank', 'noopener,noreferrer'],
      ['https://www.ultimate-guitar.com/search.php?search_type=title&value=mountain', '_blank', 'noopener,noreferrer'],
    ]);
    expect(server.requests.every((r) => r.includes(' 127.0.0.1:5174/api/'))).toBe(true);
    expect(server.requests.some((r) => /songsterr|ultimate-guitar/.test(r))).toBe(false);
  });

  it('teaches link-outs when there is no query', async () => {
    await start();
    expect(el.querySelector('.lib-linkouts__hint')?.textContent).toBe('Type a song name above to also search Songsterr and Ultimate Guitar in a new tab.');
    expect((el.querySelector('.lib-linkouts__list') as HTMLElement).hidden).toBe(true);
  });

  it('applies every filter to the search and the URL', async () => {
    await start();
    const chip = Array.from(el.querySelectorAll<HTMLButtonElement>('.lib-chip')).find((c) => c.textContent?.startsWith('My files'))!;
    chip.click();
    await flush();
    expect(lastSearch().get('source')).toBe('local');
    expect(rows()).toEqual(['Campfire Song', 'Twin Lead Etude', 'Broken Download']);

    (el.querySelector('.lib-seg__item[data-value="fingerstyle"]') as HTMLElement).click();
    await flush();
    expect(lastSearch().get('tags')).toBe('fingerstyle');
    expect(rows()).toEqual(['Twin Lead Etude']);

    (el.querySelector('.lib-seg__item[data-value="needs-work"]') as HTMLElement).click();
    await flush();
    expect(lastSearch().get('playable')).toBe('false');
    expect(el.querySelector('.rw-empty__title')?.textContent).toBe('No songs match these filters');

    // Clear filters from the empty state.
    (Array.from(el.querySelectorAll<HTMLButtonElement>('.rw-empty button')).find((b) => b.textContent === 'Clear filters') as HTMLButtonElement).click();
    await flush();
    expect(rows()).toHaveLength(5);
    expect(fake.navigations.at(-1)).toBe('#/library');

    const [from, to, tuning] = Array.from(el.querySelectorAll('select'));
    to!.value = '3';
    to!.dispatchEvent(new Event('change'));
    await flush();
    expect(lastSearch().get('tierMax')).toBe('3');
    from!.value = '5';
    from!.dispatchEvent(new Event('change'));
    await flush();
    expect([lastSearch().get('tierMin'), lastSearch().get('tierMax')]).toEqual(['5', '5']);
    tuning!.value = 'drop-d';
    tuning!.dispatchEvent(new Event('change'));
    await flush();
    expect(lastSearch().get('tuning')).toBe('drop-d');
    expect(fake.navigations.at(-1)).toBe('#/library?tierMin=5&tierMax=5&tuning=drop-d');
  });

  it('reads its state from route params and follows param updates', async () => {
    const h = await start({ q: 'chug', tierMax: '4', tags: 'pick,metal' });
    expect(input().value).toBe('chug');
    expect(lastSearch().get('tags')).toBe('pick,metal');
    expect(el.querySelector('.lib-seg__item[data-value="pick"]')?.getAttribute('aria-checked')).toBe('true');
    expect(el.querySelector('.lib-chip--removable')?.textContent).toBe('Tag: metal');
    h.update?.({ q: 'campfire' });
    await flush();
    expect(input().value).toBe('campfire');
    expect(rows()).toEqual(['Campfire Song']);
    // Our own URL echo is ignored even when the user typed on since.
    await type('campfire so');
    h.update?.({ q: 'campfire' });
    expect(input().value).toBe('campfire so');
  });

  it('is keyboard navigable: / focuses search, ↓ enters the list, arrows move, Esc returns', async () => {
    await start();
    key(document.body, '/');
    expect(document.activeElement).toBe(input());
    key(input(), 'ArrowDown');
    expect(document.activeElement?.textContent).toBe('In the Hall of the Mountain King');
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement?.textContent).toBe('Campfire Song');
    key(document.activeElement!, 'End');
    expect(document.activeElement?.textContent).toBe('Drop-D Palm-Mute Chug');
    // One tab stop for the whole list.
    expect(Array.from(el.querySelectorAll('.lib-row__open')).map((b) => b.getAttribute('tabindex'))).toEqual(['-1', '-1', '-1', '-1', '0']);
    key(document.activeElement!, 'Escape');
    expect(document.activeElement).toBe(input());
    await type('x');
    key(input(), 'Escape');
    expect(input().value).toBe('');
  });

  it('opens a song: single arrangement → song page, needs rhythm → align, needs import → explains', async () => {
    server.metas.set('local:ccc', meta(SONGS()[3]!, [], "No playable 6-string guitar track"));
    await start();
    (row('In the Hall of the Mountain King').querySelector('button') as HTMLButtonElement).click();
    await flush();
    expect(fake.navigations.at(-1)).toBe('#/song/starter%3Ahall?arr=0');
    (row('Campfire Song').querySelector('button') as HTMLButtonElement).click();
    await flush();
    expect(fake.navigations.at(-1)).toBe('#/import?song=local%3Aaaa');
    (row('Broken Download').querySelector('button') as HTMLButtonElement).click();
    await flush();
    expect(fake.toasts.at(-1)).toEqual({ message: 'Broken Download: No playable 6-string guitar track', kind: 'warning' });
  });

  it('asks which arrangement to open when a song has several', async () => {
    server.metas.set('local:bbb', meta(SONGS()[2]!, ['Lead Guitar', 'Rhythm Guitar']));
    await start();
    (row('Twin Lead Etude').querySelector('button') as HTMLButtonElement).click();
    await flush();
    const options = Array.from(document.querySelectorAll<HTMLButtonElement>('.lib-arr'));
    expect(options.map((o) => o.querySelector('.lib-arr__name')?.textContent)).toEqual(['Lead Guitar', 'Rhythm Guitar']);
    expect(document.activeElement).toBe(options[0]);
    options[1]!.click();
    await flush();
    expect(fake.navigations.at(-1)).toBe('#/song/local%3Abbb?arr=1');
    expect(document.querySelector('.lib-arr')).toBeNull();
  });

  it('imports dropped files and shows the new song when the server reports it over SSE', async () => {
    await start();
    expect(FakeEventSource.last?.url).toBe('/api/events');
    const files = [new File(['riff'], 'New Riff.gp'), new File(['x'], 'notes.pdf')];
    const drag = (type: string): Event => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'], files, dropEffect: 'none' } });
      window.dispatchEvent(ev);
      return ev;
    };
    drag('dragenter');
    const overlay = el.querySelector('.lib-drop') as HTMLElement;
    expect(overlay.hidden).toBe(false);
    expect(overlay.textContent).toContain('Copied into /Users/me/Music/Tabs');
    expect(drag('dragover').defaultPrevented).toBe(true);
    expect(drag('drop').defaultPrevented).toBe(true);
    expect(overlay.hidden).toBe(true);
    await flush();
    expect(server.requests.filter((r) => r.startsWith('POST'))).toEqual(['POST 127.0.0.1:5174/api/library/import']);
    expect(fake.toasts).toEqual([
      { message: 'Added 1 file to your library. It appears below once indexed.', kind: 'success' },
      { message: "Couldn't add notes.pdf: .pdf files aren't song files.", kind: 'error' },
    ]);
    // The watcher indexes it; the server pushes library.changed; the list refreshes.
    server.songs.push(result('local:new', 'New Riff', { source: 'local', fileName: 'New Riff.gp' }));
    FakeEventSource.last?.emit({ type: 'library.changed', ids: ['local:new'], reason: 'added' });
    await flush(REFRESH_DEBOUNCE_MS);
    expect(rows()).toContain('New Riff');
    expect(row('New Riff').textContent).toContain('New');
    expect(el.querySelector('.lib-status')?.textContent).toBe('6 songs');
  });

  it('shows indexing progress from SSE', async () => {
    await start();
    FakeEventSource.last?.emit({ type: 'index.progress', source: 'local', done: 25, total: 100 });
    expect(el.querySelector('.lib-indexing')?.textContent).toBe('Indexing My files: 25 of 100…');
    FakeEventSource.last?.emit({ type: 'index.progress', source: 'local', done: 100, total: 100 });
    expect(el.querySelector('.lib-indexing')?.textContent).toBe('');
  });

  it('teaches when the library is empty and turns the starter songs on', async () => {
    server.songs = [];
    server.config.enabledSources = ['local', 'songsterr', 'ultimate-guitar', 'gp-pack'];
    await start();
    expect(el.querySelector('.rw-empty__title')?.textContent).toBe('Your library is empty');
    expect(el.querySelector('.rw-empty__message')?.textContent).toMatch(/starter songs.*drop a \.gp file/);
    (Array.from(el.querySelectorAll<HTMLButtonElement>('.rw-empty button')).find((b) => b.textContent === 'Turn on starter songs') as HTMLButtonElement).click();
    await flush();
    expect(server.config.enabledSources).toEqual(['local', 'starter', 'songsterr', 'ultimate-guitar', 'gp-pack']);
    expect(fake.toasts.at(-1)?.kind).toBe('success');
  });

  it('suggests link-outs when nothing matches a query', async () => {
    await start({ q: 'master of puppets' });
    expect(el.querySelector('.rw-empty__title')?.textContent).toBe('No songs in your library match “master of puppets”');
    expect(el.querySelector('.rw-empty__message')?.textContent).toMatch(/Songsterr or Ultimate Guitar below/);
    expect(el.querySelectorAll('.lib-linkout')).toHaveLength(2);
  });

  it('changes the library folder with validation and shows server errors', async () => {
    await start();
    (Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Change folder') as HTMLButtonElement).click();
    const field = el.querySelector('.lib-folder__input') as HTMLInputElement;
    const form = el.querySelector('.lib-folder__form') as HTMLFormElement;
    expect(form.hidden).toBe(false);
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('/Users/me/Music/Tabs');

    field.value = 'Music/Tabs';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(el.querySelector('.lib-folder__error')?.textContent).toMatch(/full path/);
    expect(server.requests.some((r) => r.startsWith('PUT'))).toBe(false);

    server.configError = 'libraryDir must be an absolute path';
    field.value = '~/Tabs';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(el.querySelector('.lib-folder__error')?.textContent).toBe('libraryDir must be an absolute path');

    server.configError = null;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(server.config.libraryDir).toBe('~/Tabs');
    expect(form.hidden).toBe(true);
    expect(el.querySelector('.lib-folder__path')?.textContent).toBe('~/Tabs');
    expect(fake.toasts.at(-1)).toEqual({ message: 'Library folder set to ~/Tabs. Scanning it now…', kind: 'success' });
  });

  it('shows a retryable error when the server is unreachable', async () => {
    server.down = true;
    await start();
    expect(el.querySelector('.rw-empty__title')?.textContent).toBe('Library unavailable');
    expect(el.querySelector('.rw-empty__message')?.textContent).toMatch(/companion server/);
    server.down = false;
    (Array.from(el.querySelectorAll<HTMLButtonElement>('.rw-empty button')).find((b) => b.textContent === 'Try again') as HTMLButtonElement).click();
    await flush();
    expect(rows()).toHaveLength(5);
  });

  it('cleans up on unmount: SSE closed, shortcuts and drop zone removed', async () => {
    const h = await start();
    h.unmount();
    handle = null;
    expect(FakeEventSource.last?.closed).toBe(true);
    expect(el.children).toHaveLength(0);
    const ev = key(document.body, '/');
    expect(ev.defaultPrevented).toBe(false);
  });
});
