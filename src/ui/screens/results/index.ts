/**
 * Results screen (T-031, `#/results/:runId`; docs/game-mechanics.md § Results screen): score, stars,
 * accuracy, max combo, per-outcome counts, early ↔ late histogram with the timing tendency, section
 * heatmap with the weakest section → "Loop this" (practice, speed trainer on), personal best,
 * clean-run / mastery updates and "next up" suggestions (plus stretch picks from the library). The
 * main next actions (Play again · Loop the weakest section · Song page) sit right under the score
 * card, above the fold at 1280×720 (R2-U-22).
 *
 * A just-played run comes from the game screen's hand-off (`recallResult`); otherwise the stored run
 * is loaded (`runId` = run id) and shown without the live-only extras. Registered in
 * `src/ui/screens/index.ts`.
 * @module
 */
import type { Recommendation } from '@shared/storage';
import type { AppContext, RouteParams, ScreenHandle, ScreenMount } from '@shared/ui';
import { comfortTier, recommend, speedBucket } from '@core/progress';
import {
  nextSteps,
  recallResult,
  resultFromRecord,
  type NextStep,
  type ResultSection,
  type RunResult,
} from '../../../game/session/results';
import { badge, button, emptyState, h, starRating } from '../../components';
import { displayArtist } from '../game/hud';
import { nextStepCards, notesSummary, outcomeTiles, progressList, recommendationList, sectionHeatmap, timingHistogram } from './view';
import './results.css';

const REQUIRED = ['api', 'router', 'storage'] as const;
/** What "Timing precision" means (tooltip + screen-reader description). */
const TIMING_PRECISION_HELP = 'How close your hits were to the beat: 100% if every hit was Perfect, 75% Great, 50% Good.';
/** What the "Clean run" badge means (a section's own clean run is listed under Progress). */
const CLEAN_RUN_HELP = 'A clean run is 90% or better across the whole run. Each section counts its own clean runs: see Progress.';
const pct = (s: number): string => `${Math.round(s * 100)}%`;

function unavailableView(el: HTMLElement, missing: readonly string[]): ScreenHandle {
  const root = h(
    'div',
    { class: 'rs', dataset: { state: 'unavailable' } },
    emptyState({
      title: 'Results unavailable',
      message: `The app didn't finish starting (missing: ${missing.join(', ')}). Reload the page to try again.`,
      icon: 'warning',
      headingLevel: 1,
    }),
  );
  el.append(root);
  return { unmount: () => root.remove() };
}

/** Load a stored run and rebuild its result (section names from the song's difficulty report). */
async function loadStored(ctx: AppContext, runId: number): Promise<RunResult | null> {
  const runs = await ctx.storage.listRuns({ limit: 5000 });
  const record = runs.find((r) => r.id === runId);
  if (!record) return null;
  const names = new Map<number, string>();
  let title = record.songId;
  let artist: string | null = null;
  try {
    const meta = await ctx.api.song(record.songId);
    title = meta.entry.title;
    artist = meta.entry.artist ?? null;
    for (const s of meta.difficulty[record.arrangement]?.sections ?? []) names.set(s.sectionIndex, s.name);
  } catch {
    const cached = await ctx.storage.getSongCache(record.songId).catch(() => null);
    if (cached) {
      title = cached.meta.title;
      artist = cached.meta.artist ?? null;
    }
  }
  const bests = await ctx.storage.getBests(record.songId, record.arrangement).catch(() => []);
  const best = bests.find((b) => b.speedBucket === speedBucket(record.speed)) ?? null;
  return resultFromRecord(record, { title, artist, sectionName: (i) => names.get(i) ?? `Section ${i + 1}`, best: record.loop ? null : best });
}

/** Stretch picks from the library for after the run (excluding this song). */
async function libraryPicks(ctx: AppContext, songId: string): Promise<{ rec: Recommendation; title: string; artist?: string }[]> {
  const [search, runs, dueChecks] = await Promise.all([
    ctx.api.search({ playable: true, limit: 200 }),
    ctx.storage.listRuns({ limit: 1000 }),
    ctx.storage.listDueChecks(Date.now()),
  ]);
  const byId = new Map(search.results.map((r) => [r.id, r]));
  const prefs = ctx.settings.get().preferences;
  const recs = recommend({
    candidates: search.results,
    comfortTier: comfortTier(runs, (id) => byId.get(id)?.tier ?? null),
    recentRuns: runs,
    dueChecks,
    preferences: { style: prefs.style, fingerstyle: prefs.fingerstyle, genres: prefs.genres },
    now: Date.now(),
  });
  return recs
    .filter((r) => r.songId !== songId && (r.kind === 'stretch' || r.kind === 'review'))
    .slice(0, 3)
    .map((rec) => {
      const meta = byId.get(rec.songId);
      const artist = displayArtist(meta?.artist);
      return { rec, title: meta?.title ?? rec.songId, ...(artist ? { artist } : {}) };
    });
}

function render(ctx: AppContext, r: RunResult): HTMLElement {
  const gameHref = (p: { mode: string; section?: number; speed?: number }): string => {
    const params: RouteParams = { id: r.songId, arr: String(r.arrangement), mode: p.mode };
    if (p.section !== undefined) params.section = String(p.section);
    if (p.speed !== undefined) params.speed = String(p.speed);
    return ctx.router.href('game', params);
  };
  const loopSection = (s: ResultSection): void => ctx.router.navigate(gameHref({ mode: 'practice', section: s.idx }));
  const chips = [
    r.mode === 'practice' ? 'Practice' : 'Play',
    `${pct(r.speed)} speed`,
    r.loop ? `Loop: bars ${r.loop.startBar + 1}–${r.loop.endBar}` : r.completed ? 'Full song' : 'Ended early',
    r.inputSource === 'guitar' ? 'Guitar' : r.inputSource === 'keyboard' ? 'Keyboard' : 'Scripted',
  ];
  const badges = h(
    'div',
    { class: 'rs-badges' },
    r.newBest
      ? badge(`New best at ${pct(r.speed)}${r.previousBestScore !== null ? ` (+${(r.score - r.previousBestScore).toLocaleString('en-US')})` : ''}`, { tone: 'success', icon: 'star' })
      : null,
    // Overall accuracy; sections are judged on their own, so say which (R3-U-12).
    r.clean ? badge('Clean run · 90%+ overall', { tone: 'success', icon: 'check', title: CLEAN_RUN_HELP }) : null,
  );
  const bestLine =
    r.best && !r.newBest
      ? h('p', { class: 'rs-best' }, `Personal best at ${r.best.speedBucket}%: ${r.best.score.toLocaleString('en-US')} · ${Math.round(r.best.accuracy)}%`)
      : r.loop
        ? h('p', { class: 'rs-best' }, 'Loop runs build section progress; bests come from full-song runs.')
        : null;

  const hero = h(
    'section',
    { class: 'rs-hero' },
    h(
      'div',
      { class: 'rs-hero__main' },
      h('span', { class: 'rs-label' }, 'Score'),
      h('span', { class: 'rs-score rw-num' }, r.score.toLocaleString('en-US')),
      starRating({ stars: r.stars, size: 'lg', animate: true, suffix: `at ${pct(r.speed)} speed` }),
      badges,
      bestLine,
    ),
    h(
      'dl',
      { class: 'rs-kpis' },
      h('div', { class: 'rs-kpi rs-kpi--acc' }, h('dt', null, 'Accuracy'), h('dd', { class: 'rw-num' }, `${r.accuracy.toFixed(1)}%`)),
      h('div', { class: 'rs-kpi' }, h('dt', null, 'Max combo'), h('dd', { class: 'rw-num' }, String(r.maxCombo))),
      r.timingScore !== null
        ? h(
            'div',
            { class: 'rs-kpi', title: TIMING_PRECISION_HELP },
            h('dt', null, 'Timing precision'),
            h('dd', { class: 'rw-num', 'aria-describedby': 'rs-timing-help' }, `${Math.round(r.timingScore * 100)}%`),
            h('span', { class: 'rw-visually-hidden', id: 'rs-timing-help' }, TIMING_PRECISION_HELP),
          )
        : null,
      h('div', { class: 'rs-kpi' }, h('dt', null, 'Notes'), h('dd', { class: 'rw-num' }, String(r.judgedNotes))),
    ),
  );

  const weakest = r.weakestSection !== null ? r.sections.find((x) => x.idx === r.weakestSection) : undefined;
  const actions = h(
    'nav',
    { class: 'rs-actions', 'aria-label': 'Next actions' },
    button({ label: 'Play again', icon: 'play', variant: 'primary', onClick: () => ctx.router.navigate(gameHref({ mode: r.mode, speed: r.speed })) }),
    weakest && weakest.accuracy < 100
      ? button({ label: `Loop ${weakest.name}`, icon: 'loop', variant: 'secondary', onClick: () => loopSection(weakest) })
      : null,
    button({ label: 'Song page', variant: 'secondary', onClick: () => ctx.router.navigate(ctx.router.href('song', { id: r.songId })) }),
    button({ label: 'Library', variant: 'ghost', onClick: () => ctx.router.navigate(ctx.router.href('library')) }),
  );
  // "Play again" and "Loop the weakest section" are in the action row: not repeated as cards.
  const steps = nextSteps(r).filter((st) => st.kind !== 'replay' && st.kind !== 'loop-weakest');
  const recsSlot = h('div', { class: 'rs-recs-slot' });
  const progress = progressList(r.sectionUpdates);
  const artist = displayArtist(r.artist);
  const page = h(
    'div',
    { class: 'rs' },
    h(
      'header',
      { class: 'rs-head' },
      h('p', { class: 'rs-eyebrow' }, chips.join(' · ')),
      h('h1', { class: 'rs-title', tabindex: '-1' }, r.title, artist ? h('span', { class: 'rs-title__artist' }, ` — ${artist}`) : null),
    ),
    hero,
    actions,
    h(
      'section',
      { class: 'rs-block', 'aria-labelledby': 'rs-notes-h' },
      h('h2', { id: 'rs-notes-h' }, 'Notes'),
      outcomeTiles(r),
      h('p', { class: 'rs-notes-summary' }, notesSummary(r)),
      r.lenientChordNotes ? h('p', { class: 'rs-muted' }, `${r.lenientChordNotes} chord notes judged leniently (timing + any chord tone).`) : null,
    ),
    h('section', { class: 'rs-block', 'aria-labelledby': 'rs-timing-h' }, h('h2', { id: 'rs-timing-h' }, 'Timing'), timingHistogram(r)),
    h('section', { class: 'rs-block rs-block--wide', 'aria-labelledby': 'rs-sec-h' }, h('h2', { id: 'rs-sec-h' }, 'Sections'), sectionHeatmap(r)),
    progress ? h('section', { class: 'rs-block rs-block--wide', 'aria-labelledby': 'rs-prog-h' }, h('h2', { id: 'rs-prog-h' }, 'Progress'), progress) : null,
    h(
      'section',
      { class: 'rs-block rs-block--wide', 'aria-labelledby': 'rs-next-h' },
      h('h2', { id: 'rs-next-h' }, 'Next up'),
      steps.length > 0 ? nextStepCards(steps, (s: NextStep) => gameHref(s.game)) : null,
      recsSlot,
    ),
  );
  void libraryPicks(ctx, r.songId)
    .then((picks) => {
      if (picks.length === 0 || !page.isConnected) return;
      recsSlot.append(h('h3', { class: 'rs-subhead' }, 'Stretch picks from your library'), recommendationList(picks, (id) => ctx.router.href('song', { id })));
    })
    .catch(() => undefined);
  return page;
}

export const mount: ScreenMount = (el, ctx, params): ScreenHandle => {
  const missing = REQUIRED.filter((key) => !(ctx as Partial<AppContext>)[key]);
  if (missing.length) return unavailableView(el, missing);
  const key = params.runId ?? '';
  const host = h('div', { class: 'rs-host' });
  el.append(host);
  let alive = true;

  const show = (r: RunResult | null): void => {
    if (!alive) return;
    host.replaceChildren(
      r
        ? render(ctx, r)
        : emptyState({
            title: 'Run not found',
            message: 'This run is not stored on this computer (it may have been deleted or not saved).',
            icon: 'info',
            headingLevel: 1,
            action: { label: 'Library', onClick: () => ctx.router.navigate(ctx.router.href('library')) },
          }),
    );
  };

  const handed = recallResult(key);
  if (handed) show(handed);
  else {
    const id = Number(key);
    if (!Number.isInteger(id)) show(null);
    else
      void loadStored(ctx, id).then(show, (err: unknown) => {
        console.error('Riffway: could not load the run', err);
        show(null);
      });
  }
  return {
    unmount(): void {
      alive = false;
      host.remove();
    },
  };
};

