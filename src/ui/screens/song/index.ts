/**
 * Song page (T-034). Exports `mount: ScreenMount`; registered in `src/ui/screens/index.ts` at
 * `#/song/:id?arr=<track>` (the library passes `arr`).
 *
 * Shows title/artist/source, the difficulty pill with the "why" (highlights + per-section bars),
 * tuning with a retune prompt when needed (opens the tuner panel), technique tags, the arrangement
 * picker, best scores per speed bucket with an accuracy sparkline, the section mastery map with
 * "Loop this", Play / Practice, "Align rhythm" for text tabs, and the backing-audio panel (T-027),
 * which mounts only on request (see `./backing.ts`).
 *
 * Data: `GET /api/songs/:id` (meta), the song model through the song worker (sections; needed by the
 * backing panel) and IndexedDB (bests, section progress, runs, audio link). Opening a song refreshes
 * its `songCache` entry so the home screen can show it without a server round trip.
 * @module
 */
import type { SongMeta } from '@shared/api';
import type { Song, SongBundle } from '@shared/song';
import type { StoreName } from '@shared/storage';
import type { AppContext, PanelHandle, PanelPropsMap, RouteParams, ScreenMount } from '@shared/ui';
import { ApiError } from '../../../api/client';
import { mountPanel } from '../../panels';
import { emptyState, h, openModal } from '../../components';
import { missingContext, unavailableView } from '../home/unavailable';
import { backingSlot, type BackingSlot } from './backing';
import {
  accuracyTrend,
  arrangementOptions,
  bestsView,
  difficultyBars,
  masterySummary,
  resolveArrangement,
  sectionRows,
  toSearchResult,
  tuningView,
  TREND_RUNS,
} from './model';
import { renderSong, type SongActions, type SongPageState } from './view';
import './song.css';

/** Coalesce bursts of storage changes (a finished run writes several stores). */
export const RELOAD_DEBOUNCE_MS = 150;
/** Stores that change what the song page shows. */
const WATCHED: ReadonlySet<StoreName> = new Set<StoreName>(['runs', 'bests', 'sectionProgress', 'audioLinks']);

/** Local (IndexedDB) data for one arrangement. */
interface LocalData {
  bests: Awaited<ReturnType<AppContext['storage']['getBests']>>;
  progress: Awaited<ReturnType<AppContext['storage']['getSectionProgress']>>;
  runs: Awaited<ReturnType<AppContext['storage']['listRuns']>>;
  attached: string | null;
  lastTuning: { id: string; label: string } | null;
}

function describeError(err: unknown): { title: string; message: string } {
  if (err instanceof ApiError && err.status === 404) {
    return { title: 'Song not found', message: 'It may have been moved or removed from your library folder.' };
  }
  if (err instanceof ApiError && err.status > 0) return { title: 'Couldn’t open this song', message: err.message };
  return {
    title: 'Can’t reach the companion server',
    message: 'Start it with npm run dev (or npm start), then try again.',
  };
}

class SongPage {
  private readonly win: Window;
  private readonly slot: BackingSlot;
  private current: HTMLElement;
  private id = '';
  private arrParam: string | undefined;
  private meta: SongMeta | null = null;
  private arrangement = -1;
  private bundle: Promise<SongBundle> | null = null;
  private song: Song | null = null;
  private songState: SongPageState['songState'] = 'loading';
  private local: LocalData | null = null;
  private seq = 0;
  private localSeq = 0;
  private songSeq = 0;
  private timer: number | undefined;
  private tuner: PanelHandle<PanelPropsMap['tuner']> | null = null;
  private destroyed = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly el: HTMLElement,
    private readonly ctx: AppContext,
  ) {
    this.win = el.ownerDocument.defaultView ?? window;
    this.slot = backingSlot(ctx);
    this.current = this.skeleton();
    el.append(this.current);
    this.unsubscribe = ctx.storage.onChange((store) => {
      if (!WATCHED.has(store) || !this.meta) return;
      this.win.clearTimeout(this.timer);
      this.timer = this.win.setTimeout(() => void this.loadLocal(), RELOAD_DEBOUNCE_MS);
    });
  }

  private readonly actions: SongActions = {
    href: (to) => this.ctx.router.href(to.screen, to.params),
    tune: () => this.openTuner(),
  };

  /** Load (or reload) everything for `params`. */
  async open(params: RouteParams): Promise<void> {
    const my = ++this.seq;
    const idChanged = params.id !== this.id;
    this.id = params.id ?? '';
    this.arrParam = params.arr;
    if (idChanged) {
      this.meta = null;
      this.bundle = null;
      this.show(this.skeleton());
    }
    try {
      const meta = this.meta ?? (await this.ctx.api.song(this.id));
      if (my !== this.seq || this.destroyed) return;
      this.meta = meta;
    } catch (err) {
      if (my !== this.seq || this.destroyed) return;
      const { title, message } = describeError(err);
      this.show(this.errorView(title, message, true));
      return;
    }
    const arrangement = resolveArrangement(this.meta, this.arrParam);
    if (arrangement < 0) {
      this.show(this.errorView('No playable guitar part', this.meta.entry.error ?? 'This file has no 6-string guitar track Riffway can play.', false));
      return;
    }
    if (String(arrangement) !== this.arrParam) {
      // Canonical URL: the update() echo then sees nothing new.
      this.arrParam = String(arrangement);
      this.ctx.router.navigate(this.ctx.router.href('song', { id: this.id, arr: this.arrParam }), { replace: true });
    }
    const arrChanged = arrangement !== this.arrangement || idChanged;
    this.arrangement = arrangement;
    if (arrChanged) {
      this.local = null;
      this.song = null;
      this.songState = 'loading';
      this.render();
      void this.writeCache(this.meta);
      void this.loadSong();
    }
    await this.loadLocal();
  }

  /** Bests, progress, recent runs, backing link and the last-played tuning. */
  private async loadLocal(): Promise<void> {
    const my = ++this.localSeq;
    const { id, arrangement } = this;
    const s = this.ctx.storage;
    try {
      const [bests, progress, runs, link, recent] = await Promise.all([
        s.getBests(id, arrangement),
        s.getSectionProgress(id, arrangement),
        s.listRuns({ songId: id, arrangement, limit: TREND_RUNS }),
        s.getAudioLink(id, arrangement),
        s.listRuns({ limit: 20 }),
      ]);
      const other = recent.find((r) => r.songId !== id);
      const cached = other ? await s.getSongCache(other.songId) : null;
      if (my !== this.localSeq || this.destroyed) return;
      this.local = {
        bests,
        progress,
        runs,
        attached: link?.fileName ?? null,
        lastTuning: cached ? { id: cached.meta.tuningId, label: cached.meta.tuningLabel } : null,
      };
      this.render();
    } catch (err) {
      if (my !== this.localSeq || this.destroyed) return;
      this.ctx.ui.toast(`Couldn’t load your progress: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
    }
  }

  /** Load the song model (sections, backing panel) through the song worker. */
  private async loadSong(): Promise<void> {
    const my = ++this.songSeq;
    const { id, arrangement } = this;
    try {
      this.bundle ??= this.ctx.api.songBundle(id);
      const [bundle, loader] = await Promise.all([this.bundle, this.ctx.services.get('songLoader')]);
      const song = await loader.load(bundle, arrangement);
      if (my !== this.songSeq || this.destroyed) return;
      this.song = song;
      this.songState = 'ready';
    } catch {
      if (my !== this.songSeq || this.destroyed) return;
      this.bundle = null;
      this.songState = 'error';
    }
    this.render();
  }

  /** Refresh the home screen's cached copy of this song (keeps play time and favourite). */
  private async writeCache(meta: SongMeta): Promise<void> {
    try {
      const prev = await this.ctx.storage.getSongCache(meta.entry.id);
      await this.ctx.storage.putSongCache({
        songId: meta.entry.id,
        meta: toSearchResult(meta),
        difficulty: meta.entry.difficulty,
        lastPlayedAt: prev?.lastPlayedAt ?? null,
        favourite: prev?.favourite ?? false,
      });
    } catch {
      // The cache is a convenience for the home screen; the page works without it.
    }
  }

  private state(): SongPageState | null {
    const meta = this.meta;
    if (!meta || this.arrangement < 0) return null;
    const now = Date.now();
    const arr = this.arrangement;
    const report = meta.difficulty[arr] ?? null;
    const track = meta.arrangements.find((t) => t.index === arr);
    const progress = this.local?.progress ?? [];
    const sections = sectionRows(meta.entry.id, arr, this.song, report, progress, now);
    const { options, unplayable } = arrangementOptions(meta, arr);
    return {
      meta,
      arrangement: arr,
      options,
      unplayable,
      tuning: tuningView(track?.tuning ?? meta.entry.tuning, track?.capo ?? meta.entry.capo, this.local?.lastTuning ?? null),
      bars: difficultyBars(report),
      sections,
      mastery: masterySummary(sections, progress),
      bests: bestsView(this.local?.bests ?? [], now),
      trend: accuracyTrend(this.local?.runs ?? []),
      songState: this.songState,
    };
  }

  private render(): void {
    if (this.destroyed) return;
    const s = this.state();
    if (!s) return;
    this.slot.set({ songId: s.meta.entry.id, arrangement: s.arrangement, song: this.song, songState: this.songState, attached: this.local?.attached ?? null });
    this.show(renderSong(s, this.actions, this.slot.el));
  }

  private show(next: HTMLElement): void {
    const focused = this.el.ownerDocument.activeElement;
    const hadFocus = focused instanceof HTMLElement && this.current.contains(focused) && !this.slot.el.contains(focused);
    // Keep the scroll position: a progress refresh must not jump the page.
    const scroll = this.win.scrollY;
    this.current.replaceWith(next);
    this.current = next;
    if (hadFocus) next.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
    if (this.win.scrollY !== scroll) this.win.scrollTo({ top: scroll });
  }

  private skeleton(): HTMLElement {
    return h(
      'div',
      { class: 'sg sg--loading', 'aria-busy': 'true' },
      h('p', { class: 'rw-visually-hidden', role: 'status' }, 'Loading song…'),
      h('div', { class: 'sg-skel sg-skel--hero' }),
      h('div', { class: 'sg-grid' }, h('div', { class: 'sg-skel sg-skel--card' }), h('div', { class: 'sg-skel sg-skel--card' })),
    );
  }

  private errorView(title: string, message: string, retry: boolean): HTMLElement {
    return h(
      'div',
      { class: 'sg sg--error' },
      emptyState({
        title,
        message,
        icon: 'warning',
        headingLevel: 1,
        action: retry ? { label: 'Try again', onClick: () => void this.open({ id: this.id, ...(this.arrParam ? { arr: this.arrParam } : {}) }) } : { label: 'Back to library', onClick: () => this.ctx.router.navigate(this.ctx.router.href('library')) },
        secondary: retry ? { label: 'Back to library', onClick: () => this.ctx.router.navigate(this.ctx.router.href('library')) } : undefined,
      }),
    );
  }

  /** Tuner panel in a modal, set to the song's tuning. */
  private openTuner(): void {
    const s = this.state();
    if (!s || this.tuner) return;
    const host = h('div', { class: 'sg-tuner' });
    const modal = openModal({
      title: `Tune to ${s.tuning.label}`,
      content: [h('p', { class: 'rw-muted' }, s.tuning.prompt?.text ?? 'Play each open string and follow the needle.'), host],
      actions: [{ label: 'Done', value: 'done', variant: 'primary' }],
      size: 'lg',
    });
    let closed = false;
    void modal.result.then(() => {
      closed = true;
      this.tuner?.unmount();
      this.tuner = null;
    });
    mountPanel('tuner', host, this.ctx, { tuning: s.tuning.midi }).then(
      (handle) => {
        if (closed || this.destroyed) handle.unmount();
        else this.tuner = handle;
      },
      (err: unknown) => {
        host.replaceChildren(h('p', { class: 'sg-note' }, `The tuner couldn’t start: ${err instanceof Error ? err.message : String(err)}`));
      },
    );
    this.closeTuner = () => modal.close(null);
  }

  private closeTuner: () => void = () => {};

  destroy(): void {
    this.destroyed = true;
    this.win.clearTimeout(this.timer);
    this.unsubscribe();
    this.closeTuner();
    this.tuner?.unmount();
    this.tuner = null;
    this.slot.destroy();
    this.current.remove();
  }
}

export const mount: ScreenMount = (el, ctx, params) => {
  // The context type promises these, but a broken or partial shell must not crash the screen.
  const missing = missingContext(ctx, ['api', 'router', 'ui', 'storage', 'services']);
  if (missing.length) return unavailableView(el, 'Song', missing);
  const page = new SongPage(el, ctx);
  void page.open(params);
  return {
    update: (next) => void page.open(next),
    unmount: () => page.destroy(),
  };
};
