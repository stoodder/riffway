/**
 * Results screen building blocks (T-031): outcome tiles, the early ↔ late timing histogram, the
 * section heatmap with the weakest section's "Loop this", progress updates and "next up" cards.
 * Plain DOM; data comes from a {@link RunResult}.
 * @module
 */
import type { Outcome } from '@shared/judge';
import { OUTCOMES } from '@shared/judge';
import type { Recommendation } from '@shared/storage';
import { sectionEventText, type SectionUpdate } from '../../../game/session/progress';
import { timingTendency, type NextStep, type ResultSection, type RunResult } from '../../../game/session/results';
import { button, difficultyPill, h, icon } from '../../components';
import { OUTCOME_SLUG } from '../../design/tokens';

const TILE_LABEL: Record<Outcome, string> = { Perfect: 'Perfect', Great: 'Great', Good: 'Good', WrongNote: 'Wrong', Miss: 'Miss' };

/** Per-outcome note counts. */
export function outcomeTiles(r: RunResult): HTMLElement {
  return h(
    'div',
    { class: 'rs-counts' },
    OUTCOMES.map((o) =>
      h(
        'div',
        { class: 'rs-count', dataset: { outcome: OUTCOME_SLUG[o] } },
        h('span', { class: 'rs-count__value rw-num' }, String(r.counts[o])),
        h('span', { class: 'rs-count__label' }, TILE_LABEL[o]),
      ),
    ),
  );
}

/** Timing histogram (10 ms bins, −120 … +120 ms) with the Perfect/Great bands and a tendency line. */
export function timingHistogram(r: RunResult): HTMLElement {
  const { bins, binMs, minMs } = r.histogram;
  const max = Math.max(1, ...bins);
  const tendency = timingTendency(r.histogram);
  const bars = bins.map((count, i) => {
    const lo = minMs + i * binMs;
    const centre = lo + binMs / 2;
    const band = Math.abs(centre) <= 35 ? 'perfect' : Math.abs(centre) <= 70 ? 'great' : 'good';
    return h(
      'span',
      { class: 'rs-hist__bar', dataset: { band }, style: `--h: ${(count / max) * 100}%`, title: `${lo} to ${lo + binMs} ms: ${count}` },
      h('span', { class: 'rs-hist__fill' }),
    );
  });
  return h(
    'figure',
    { class: 'rs-hist' },
    h('div', { class: 'rs-hist__plot', role: 'img', 'aria-label': `Timing histogram. ${tendency.text}` }, bars, h('span', { class: 'rs-hist__zero' })),
    h(
      'div',
      { class: 'rs-hist__axis', 'aria-hidden': 'true' },
      h('span', null, `Early ${minMs} ms`),
      h('span', null, 'On time'),
      h('span', null, `+${minMs + bins.length * binMs} ms Late`),
    ),
    h('figcaption', { class: `rs-hist__tendency rs-hist__tendency--${tendency.label}` }, tendency.text),
  );
}

/** Heat colour band of a section accuracy. */
function heat(accuracy: number): string {
  return accuracy >= 90 ? 'hot' : accuracy >= 70 ? 'warm' : 'cold';
}

/** Section heatmap; the weakest section (below 100%) gets "Loop this". */
export function sectionHeatmap(r: RunResult, onLoop: (s: ResultSection) => void): HTMLElement {
  if (r.sections.length === 0) return h('p', { class: 'rs-muted' }, 'No sections were judged.');
  const weakest = r.weakestSection !== null ? r.sections.find((s) => s.idx === r.weakestSection) : undefined;
  const showWeakest = weakest !== undefined && weakest.accuracy < 100;
  return h(
    'div',
    { class: 'rs-heat-wrap' },
    h(
      'ol',
      { class: 'rs-heat' },
      r.sections.map((s) =>
        h(
          'li',
          {
            class: `rs-heat__cell${showWeakest && s.idx === weakest.idx ? ' is-weakest' : ''}`,
            dataset: { heat: heat(s.accuracy) },
            style: `--acc: ${Math.max(0, Math.min(100, s.accuracy))}%`,
            title: `${s.name}: ${s.hits}/${s.notes} notes`,
          },
          h('span', { class: 'rs-heat__name' }, s.name),
          h('span', { class: 'rs-heat__acc rw-num' }, `${Math.round(s.accuracy)}%`),
          h('span', { class: 'rs-heat__bar' }),
        ),
      ),
    ),
    showWeakest
      ? h(
          'div',
          { class: 'rs-weakest' },
          h(
            'p',
            null,
            h('strong', null, 'Weakest section: '),
            `${weakest.name} — ${Math.round(weakest.accuracy)}% (${weakest.hits}/${weakest.notes} notes)`,
          ),
          button({ label: 'Loop this', icon: 'loop', variant: 'primary', onClick: () => onLoop(weakest) }),
        )
      : h('p', { class: 'rs-weakest rs-weakest--clear' }, icon('check', { size: '16px' }), 'Every section at 100%.'),
  );
}

/** Lines for section progress changes (clean runs, mastery, next-day check, plateau). */
export function progressList(updates: readonly SectionUpdate[]): HTMLElement | null {
  const lines: HTMLElement[] = [];
  // One line per section: its latest update, all events of the run merged.
  const bySection = new Map<number, { update: SectionUpdate; events: Set<string>; cleanCount: number }>();
  for (const u of updates) {
    const cur = bySection.get(u.sectionIdx) ?? { update: u, events: new Set<string>(), cleanCount: 0 };
    cur.update = u;
    for (const e of u.events) cur.events.add(e);
    if (u.events.includes('clean')) cur.cleanCount++;
    bySection.set(u.sectionIdx, cur);
  }
  for (const { update, events, cleanCount } of [...bySection.values()].sort((a, b) => a.update.sectionIdx - b.update.sectionIdx)) {
    const big = (['locked-in', 'mastered', 'check-failed'] as const).find((e) => events.has(e));
    let text: string;
    let tone: string;
    if (big) {
      text = sectionEventText(update.name, big);
      tone = big === 'check-failed' ? 'info' : 'win';
    } else if (cleanCount > 0) {
      text = `${update.name}: ${cleanCount > 1 ? `${cleanCount} clean runs` : 'clean run'} (${update.cleanRuns} total${
        update.sessionCleanAt100 > 0 ? `, ${update.sessionCleanAt100}/2 at 100% this session` : ''
      })`;
      tone = 'clean';
    } else {
      text =
        update.speed < 1 - 1e-6
          ? `${update.name}: ${Math.round(update.accuracy)}% at ${Math.round(update.speed * 100)}% — speed trainer: ${Math.round(update.nextSpeed * 100)}% next`
          : `${update.name}: ${Math.round(update.accuracy)}% — a clean run needs 90%+`;
      tone = 'neutral';
    }
    lines.push(h('li', { class: `rs-progress__item rs-progress__item--${tone}` }, text));
    if (events.has('plateau')) lines.push(h('li', { class: 'rs-progress__item rs-progress__item--info' }, sectionEventText(update.name, 'plateau')));
  }
  return lines.length > 0 ? h('ul', { class: 'rs-progress' }, lines) : null;
}

/** "Next up" suggestion cards. */
export function nextStepCards(steps: readonly NextStep[], href: (s: NextStep) => string): HTMLElement {
  return h(
    'div',
    { class: 'rs-next' },
    steps.map((s, i) =>
      h(
        'a',
        { class: `rs-next__card${i === 0 ? ' is-primary' : ''}`, href: href(s), dataset: { kind: s.kind } },
        h('span', { class: 'rs-next__title' }, icon(s.kind === 'loop-weakest' ? 'loop' : 'play', { size: '16px' }), s.title),
        h('span', { class: 'rs-next__detail' }, s.detail),
      ),
    ),
  );
}

/** Library recommendations (stretch picks) as compact links. */
export function recommendationList(recs: readonly { rec: Recommendation; title: string; artist?: string }[], href: (songId: string) => string): HTMLElement {
  return h(
    'ul',
    { class: 'rs-recs' },
    recs.map(({ rec, title, artist }) =>
      h(
        'li',
        null,
        h(
          'a',
          { class: 'rs-rec', href: href(rec.songId) },
          difficultyPill({ tier: rec.tier, size: 'sm', showName: false }),
          h('span', { class: 'rs-rec__text' }, h('span', { class: 'rs-rec__title' }, title, artist ? h('span', { class: 'rs-rec__artist' }, ` · ${artist}`) : null), h('span', { class: 'rs-rec__reason' }, rec.reason)),
        ),
      ),
    ),
  );
}
