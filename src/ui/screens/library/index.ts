/**
 * Library screen (T-026): one search box over every enabled source (150 ms debounce) with filters
 * (source, difficulty tier range, tuning, technique, playable now vs needs import/rhythm), result rows,
 * link-outs to Songsterr / Ultimate Guitar / the Guitar Pro free pack (new tab, `noopener`), the
 * ClassTab download offer while it isn't downloaded, a sort control (best match / easiest / A–Z /
 * recently played; applied to the returned rows), the library-folder chooser, whole-window drag-and-drop + file-picker import, live refresh over SSE and
 * the arrangement picker → song page. State lives in the route (`#/library?q=…&tierMax=4`).
 *
 * Keyboard: `/` focuses the search box, ↓ moves into the results, ↑/↓/Home/End move between songs,
 * Enter opens, Esc goes back to the search box (and clears it when pressed there).
 * @module
 */
import { ApiError } from '../../../api/client';
import type { SearchResponse, ServerConfig, ServerEvent } from '@shared/api';
import { SOURCE_IDS } from '@shared/song';
import type { SearchResult } from '@shared/sources';
import type { AppContext, ScreenHandle, ScreenMount } from '@shared/ui';
import { button, emptyState, h, icon, select, uid } from '../../components';
import { pickArrangement } from './arrangement-picker';
import { classtabOffer } from './classtab-offer';
import { dropImport } from './drop-import';
import { filterBar, type SourceFacet, type TuningFacet } from './filters';
import { AVAILABILITY, SOURCE_LABEL, songCount } from './labels';
import { importDestination, libraryFolder } from './library-folder';
import { linkOutSection } from './link-outs';
import { DEFAULT_QUERY, hasFilters, queryFromParams, queryToParams, sameQuery, sortResults, toSearchQuery, type LibraryQuery, type SortOrder } from './query';
import { resultList } from './results';
import './library.css';

/** Search-as-you-type debounce (TASKS.md T-026). */
export const SEARCH_DEBOUNCE_MS = 150;
/** Coalesce bursts of `library.changed` events into one refresh. */
export const REFRESH_DEBOUNCE_MS = 250;
/** Rows read to build the tuning filter and the "library is empty" check (server maximum). */
const FACET_LIMIT = 500;
/** Played songs read for the "Recently played" order. */
const RECENT_LIMIT = 500;

/** Sort select options; the default (`''`) reads "Best match" with a query and "A–Z" without one. */
export function sortOptions(q: string): { value: SortOrder; label: string }[] {
  const typed = q.trim() !== '';
  return [
    { value: '', label: typed ? 'Best match' : 'A–Z' },
    ...(typed ? [{ value: 'az' as const, label: 'A–Z' }] : []),
    { value: 'easiest', label: 'Easiest first' },
    { value: 'recent', label: 'Recently played' },
  ];
}

/** Facets for the filter bar, from `GET /api/sources` and an unfiltered listing. */
interface Facets {
  sources: SourceFacet[];
  tunings: TuningFacet[];
  /** Songs in the library across enabled sources (unfiltered). */
  total: number;
}

/** Tuning options seen in a listing: Standard first, then by label; all custom tunings share one entry. */
export function tuningFacets(results: readonly SearchResult[]): TuningFacet[] {
  const byId = new Map<string, string>();
  for (const r of results) if (!byId.has(r.tuningId)) byId.set(r.tuningId, r.tuningId === 'custom' ? 'Custom' : r.tuningLabel);
  return [...byId]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => Number(b.id === 'standard') - Number(a.id === 'standard') || Number(a.id === 'custom') - Number(b.id === 'custom') || a.label.localeCompare(b.label));
}

/** True for keyboard targets where `/` is typed text, not a shortcut. */
function isTextTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

/** "Can't reach the server" vs any other failure. */
function describeError(err: unknown): string {
  if (err instanceof ApiError && err.status > 0) return err.message;
  return "Can't reach the Riffway companion server. Start it with npm run dev (or npm start), then try again.";
}

/**
 * The page shown when the app context lacks what the library needs (`api`, `router`, `ui`), e.g. a
 * shell that failed to start: the title and an explanation instead of a thrown mount.
 */
function unavailableView(el: HTMLElement, missing: readonly string[]): ScreenHandle {
  const root = h(
    'div',
    { class: 'lib', dataset: { state: 'unavailable' } },
    h('header', { class: 'lib-head' }, h('div', { class: 'lib-head__text' }, h('h1', null, 'Library'))),
    emptyState({
      title: 'Library unavailable',
      message: `The app didn't finish starting (missing: ${missing.join(', ')}). Reload the page to try again.`,
      icon: 'warning',
    }),
  );
  el.append(root);
  return { unmount: () => root.remove() };
}

export const mount: ScreenMount = (el: HTMLElement, ctx: AppContext, params) => {
  // The context type promises these, but a broken or partial shell must not crash the screen.
  const missing = (['api', 'router', 'ui'] as const).filter((key) => !(ctx as Partial<AppContext>)[key]);
  if (missing.length) return unavailableView(el, missing);
  const doc = el.ownerDocument;
  const win = doc.defaultView ?? window;
  let query: LibraryQuery = queryFromParams(params);
  let config: ServerConfig | null = null;
  let response: SearchResponse | null = null;
  let facets: Facets | null = null;
  let error: string | null = null;
  /** File names (basenames) imported while the screen is open: their rows get a "New" badge. */
  const newFiles = new Set<string>();
  let searchSeq = 0;
  let facetSeq = 0;
  let searchTimer: number | undefined;
  let refreshTimer: number | undefined;
  let destroyed = false;
  /** The route this screen last wrote (its own echo arrives later through `update`). */
  let ownHref = '';

  // ---- Header: title, library folder, actions ------------------------------------------------
  const folder = libraryFolder({ api: ctx.api, ui: ctx.ui, onSaved: (next) => (config = next) });
  const drop = dropImport({
    api: ctx.api,
    ui: ctx.ui,
    win,
    destination: () => (config ? importDestination(config) : 'your library folder'),
    onImported: (paths) => {
      for (const p of paths) newFiles.add(p.split('/').pop() ?? p);
    },
  });
  const header = h(
    'header',
    { class: 'lib-head' },
    h('div', { class: 'lib-head__text' }, h('h1', null, 'Library'), folder.el),
    h(
      'div',
      { class: 'lib-head__actions' },
      button({ label: 'Paste a tab', icon: 'import', onClick: () => ctx.router.navigate(ctx.router.href('import')) }),
      button({ label: 'Add files', icon: 'plus', variant: 'primary', title: 'Or drop files anywhere on this page', onClick: () => drop.pick() }),
    ),
  );

  // ---- Search box -----------------------------------------------------------------------------
  const inputId = uid('lib-q');
  const resultsId = uid('lib-results');
  const input = h('input', {
    id: inputId,
    class: 'lib-search__input',
    type: 'search',
    placeholder: 'Search title, artist, composer or tag',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-controls': resultsId,
    'aria-keyshortcuts': '/',
  });
  input.value = query.q;
  const searchBox = h(
    'div',
    { class: 'lib-search', role: 'search' },
    h('label', { class: 'rw-visually-hidden', for: inputId }, 'Search songs'),
    icon('search', { size: '20px' }),
    input,
    h('kbd', { class: 'lib-search__kbd', 'aria-hidden': 'true', title: 'Press / to search' }, '/'),
  );

  // ---- Filters, status, results, empty states, link-outs --------------------------------------
  const filters = filterBar({ onChange: (patch) => apply({ ...query, ...patch }) });
  const status = h('p', { class: 'lib-status', role: 'status' });
  const sort = select({ label: 'Sort', options: sortOptions(query.q), onChange: (v) => apply({ ...query, sort: v as SortOrder }) });
  sort.el.classList.add('lib-sort');
  /** songId → last played (epoch ms), read when "Recently played" is chosen. */
  let lastPlayed: Map<string, number> | null = null;
  const offer = classtabOffer({
    api: ctx.api,
    onReady: () => {
      ctx.ui.toast('ClassTab is ready: its tabs are now in your library search.', { kind: 'success' });
      refresh();
    },
  });
  const indexing = h('p', { class: 'lib-indexing', 'aria-live': 'polite' });
  const list = resultList({ onOpen: (r) => void open(r), onEscape: () => input.focus() });
  list.el.id = resultsId;
  const empty = h('div', { class: 'lib-empty' });
  const linkOuts = linkOutSection(win);
  const root = h(
    'div',
    { class: 'lib' },
    header,
    drop.progress,
    searchBox,
    filters.el,
    h('div', { class: 'lib-statusbar' }, h('div', { class: 'lib-statusbar__text' }, status, indexing), sort.el),
    list.el,
    empty,
    linkOuts.el,
    drop.overlay,
  );
  linkOuts.el.append(offer.el);
  el.append(root);
  filters.set(query);
  syncSort();

  // ---- Behaviour ------------------------------------------------------------------------------
  const titleOf = (id: string): string | undefined => response?.results.find((r) => r.id === id)?.title;

  /** Keep focus inside the screen when the control that had it disappears (e.g. "Clear filters"). */
  const keepFocus = (hadFocus: boolean): void => {
    const active = doc.activeElement as HTMLElement | null;
    if (hadFocus && (!active || active === doc.body || !root.contains(active) || active.closest('[hidden]'))) input.focus();
  };

  function render(): void {
    if (destroyed) return;
    const hadFocus = root.contains(doc.activeElement);
    root.removeAttribute('aria-busy');
    if (error) {
      list.render([], () => false);
      list.el.hidden = true;
      status.textContent = '';
      empty.replaceChildren(
        emptyState({ title: 'Library unavailable', message: error, icon: 'warning', action: { label: 'Try again', onClick: () => refresh() } }),
      );
      linkOuts.el.hidden = true;
      keepFocus(hadFocus);
      return;
    }
    if (!response) return;
    const { total, linkOuts: outs } = response;
    const results = sortResults(response.results, query.sort, { lastPlayed: lastPlayed ?? undefined });
    list.render(results, (r) => newFiles.has(r.fileName));
    list.el.hidden = results.length === 0;
    const q = query.q.trim();
    const libraryEmpty = facets?.total === 0 && !q && !hasFilters(query);
    status.textContent = libraryEmpty
      ? ''
      : total > results.length
        ? `Showing ${results.length} of ${songCount(total)}${query.sort ? ' (sorted among these)' : ''}. Narrow the search to see the rest.`
        : `${songCount(total)}${q ? ` for “${q}”` : ''}`;
    if (results.length) empty.replaceChildren();
    else empty.replaceChildren(emptyView(q));
    linkOuts.el.hidden = false;
    linkOuts.render(outs, q, titleOf);
    keepFocus(hadFocus);
  }

  function emptyView(q: string): HTMLElement {
    if (facets?.total === 0 && !q && !hasFilters(query)) {
      const starterOff = config !== null && !config.enabledSources.includes('starter');
      return emptyState({
        title: 'Your library is empty',
        message: starterOff
          ? 'Turn on the starter songs to play right away, or drop a .gp file anywhere on this page to copy it into your library folder.'
          : 'Drop a .gp file anywhere on this page to copy it into your library folder, or point Riffway at the folder where your tabs already live.',
        icon: 'library',
        action: starterOff
          ? { label: 'Turn on starter songs', icon: 'music', onClick: () => void enableStarter() }
          : { label: 'Add files', icon: 'plus', onClick: () => drop.pick() },
        secondary: { label: 'Change library folder', onClick: () => folder.edit() },
      });
    }
    return emptyState({
      title: q ? `No songs in your library match “${q}”` : 'No songs match these filters',
      message: hasFilters(query)
        ? 'Try a wider difficulty range or another tuning, or clear the filters.'
        : offer.el.hidden
          ? 'Check the spelling, or find the song on Songsterr or Ultimate Guitar below and drop the file here.'
          : // ClassTab is on but not downloaded: its card is right below (R3-U-18).
            'Check the spelling, find the song on Songsterr or Ultimate Guitar below and drop the file here, or download ClassTab below for classical and fingerstyle pieces.',
      icon: 'search',
      action: hasFilters(query) ? { label: 'Clear filters', onClick: () => apply({ ...DEFAULT_QUERY, q: query.q, sort: query.sort }) } : undefined,
      secondary: q ? { label: 'Clear search', onClick: () => apply({ ...query, q: '' }) } : undefined,
    });
  }

  async function runSearch(): Promise<void> {
    win.clearTimeout(searchTimer);
    const my = ++searchSeq;
    // Reflect the search in the URL (replace: typing doesn't fill the history).
    ownHref = ctx.router.href('library', queryToParams(query));
    ctx.router.navigate(ownHref, { replace: true });
    root.setAttribute('aria-busy', 'true');
    try {
      const next = await ctx.api.search(toSearchQuery(query));
      if (my !== searchSeq || destroyed) return;
      response = next;
      error = null;
    } catch (err) {
      if (my !== searchSeq || destroyed) return;
      error = describeError(err);
    }
    render();
  }

  async function loadFacets(): Promise<void> {
    const my = ++facetSeq;
    try {
      const [cfg, sources, listing] = await Promise.all([ctx.api.getConfig(), ctx.api.sources(), ctx.api.search({ limit: FACET_LIMIT })]);
      if (my !== facetSeq || destroyed) return;
      config = cfg;
      folder.set(cfg);
      // The no-match text mentions the ClassTab card while it is offered: refresh it once known.
      void offer.load(cfg).then(() => {
        if (my === facetSeq && response?.results.length === 0) render();
      });
      const indexed = sources.sources.filter((s) => s.kind !== 'link-out' && s.enabled && (s.indexed > 0 || query.sources.includes(s.id)));
      facets = {
        sources: indexed.map((s) => ({ id: s.id, label: SOURCE_LABEL[s.id], count: s.indexed })),
        tunings: tuningFacets(listing.results),
        total: listing.total,
      };
      filters.setSources(facets.sources);
      filters.setTunings(facets.tunings);
      const busy = sources.sources.find((s) => s.state === 'indexing' || s.state === 'refreshing');
      if (busy && !indexing.textContent) indexing.textContent = `Indexing ${SOURCE_LABEL[busy.id]}…`;
      render();
    } catch (err) {
      if (my !== facetSeq || destroyed) return;
      error = describeError(err);
      render();
    }
  }

  function refresh(): void {
    void loadFacets();
    void runSearch();
  }

  function apply(next: LibraryQuery): void {
    const hadFocus = root.contains(doc.activeElement);
    query = next;
    if (input.value !== query.q) input.value = query.q;
    filters.set(query);
    syncSort();
    keepFocus(hadFocus);
    void runSearch();
  }

  /** Reflect `query.sort` (and the query-dependent default label) in the sort select. */
  function syncSort(): void {
    const options = sortOptions(query.q);
    if (sort.select.options.length !== options.length || sort.select.options[0]?.text !== options[0]?.label) sort.setOptions(options);
    sort.set(options.some((o) => o.value === query.sort) ? query.sort : '');
    if (query.sort === 'recent' && lastPlayed === null) void loadLastPlayed();
  }

  async function loadLastPlayed(): Promise<void> {
    lastPlayed = new Map();
    try {
      const recent = (await ctx.storage?.listRecentSongs(RECENT_LIMIT)) ?? [];
      for (const s of recent) if (s.lastPlayedAt !== null) lastPlayed.set(s.songId, s.lastPlayedAt);
    } catch {
      // No progress store (or it failed): "Recently played" falls back to A–Z.
    }
    render();
  }

  async function enableStarter(): Promise<void> {
    if (!config) return;
    const enabled = new Set([...config.enabledSources, 'starter' as const]);
    try {
      config = await ctx.api.putConfig({ enabledSources: SOURCE_IDS.filter((id) => enabled.has(id)) });
      ctx.ui.toast('Starter songs are on. Loading them…', { kind: 'success' });
    } catch (err) {
      ctx.ui.toast(`Couldn't turn on the starter songs: ${describeError(err)}`, { kind: 'error' });
    }
  }

  async function open(result: SearchResult): Promise<void> {
    try {
      if (result.availability === 'needs-rhythm') {
        ctx.router.navigate(ctx.router.href('import', { song: result.id }));
      } else if (result.availability === 'needs-import') {
        const meta = await ctx.api.song(result.id);
        ctx.ui.toast(`${result.title}: ${meta.entry.error ?? AVAILABILITY['needs-import'].help}`, { kind: 'warning' });
      } else {
        const arr = await pickArrangement(result, (id) => ctx.api.song(id));
        if (arr !== null && !destroyed) ctx.router.navigate(ctx.router.href('song', { id: result.id, arr: String(arr) }));
      }
    } catch (err) {
      ctx.ui.toast(`Couldn't open ${result.title}: ${describeError(err)}`, { kind: 'error' });
    }
  }

  const onServerEvent = (event: ServerEvent): void => {
    offer.onEvent(event);
    if (event.type === 'library.changed') {
      win.clearTimeout(refreshTimer);
      refreshTimer = win.setTimeout(refresh, REFRESH_DEBOUNCE_MS);
    } else if (event.type === 'index.progress') {
      indexing.textContent = event.done < event.total ? `Indexing ${SOURCE_LABEL[event.source]}: ${event.done} of ${event.total}…` : '';
    }
  };

  input.addEventListener('input', () => {
    query = { ...query, q: input.value };
    syncSort();
    win.clearTimeout(searchTimer);
    searchTimer = win.setTimeout(() => void runSearch(), SEARCH_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' && list.focusFirst()) ev.preventDefault();
    else if (ev.key === 'Enter') {
      ev.preventDefault();
      void runSearch();
    } else if (ev.key === 'Escape' && input.value) {
      ev.preventDefault();
      apply({ ...query, q: '' });
    }
  });
  const onWindowKey = (ev: KeyboardEvent): void => {
    if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey || isTextTarget(ev.target) || doc.querySelector('[aria-modal="true"]')) return;
    ev.preventDefault();
    input.focus();
    input.select();
  };
  win.addEventListener('keydown', onWindowKey);
  const unsubscribe = ctx.api.subscribe(onServerEvent);

  root.setAttribute('aria-busy', 'true');
  refresh();

  return {
    update(next) {
      const incoming = queryFromParams(next);
      // Ignore the echo of our own URL write: the user may have typed more since.
      if (ctx.router.href('library', queryToParams(incoming)) === ownHref || sameQuery(incoming, query)) return;
      apply(incoming);
    },
    unmount() {
      destroyed = true;
      win.clearTimeout(searchTimer);
      win.clearTimeout(refreshTimer);
      win.removeEventListener('keydown', onWindowKey);
      unsubscribe();
      drop.destroy();
      filters.destroy();
      list.destroy();
      root.remove();
    },
  };
};
