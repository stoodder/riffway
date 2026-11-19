/**
 * Song page rendering (T-034): turns the song page state into DOM. The backing-audio slot is passed
 * in as a persistent element so a re-render (progress changed, song finished loading) never tears
 * down a mounted backing panel.
 * @module
 */
import type { SongMeta } from '@shared/api';
import type { RunMode } from '@shared/storage';
import { badge, button, difficultyPill, h, icon, starRating, type IconName } from '../../components';
import { RHYTHM_LABEL, SOURCE_LABEL, formatDuration } from '../library/labels';
import { playRoute, type RouteTarget } from '../home/model';
import { sparkline } from '../home/viz';
import type { ArrangementOption, BestView, DifficultyBar, SectionRow, TuningView } from './model';

/** Everything the song page shows. */
export interface SongPageState {
  meta: SongMeta;
  arrangement: number;
  options: ArrangementOption[];
  unplayable: number;
  tuning: TuningView;
  bars: DifficultyBar[];
  sections: SectionRow[];
  mastery: { mastered: number; locked: number; total: number; repertoire: boolean };
  bests: BestView[];
  trend: { values: number[]; label: string; min: number };
  /** Song model load state (sections come from the report until it is loaded). */
  songState: 'loading' | 'ready' | 'error';
}

/** Callbacks supplied by the screen. */
export interface SongActions {
  href(to: RouteTarget): string;
  /** Open the tuner for the song's tuning. */
  tune(): void;
}

function linkButton(label: string, href: string, opts: { variant?: 'primary' | 'secondary' | 'ghost'; size?: 'sm' | 'md' | 'lg'; icon?: IconName } = {}): HTMLAnchorElement {
  return h(
    'a',
    { class: `rw-btn rw-btn--${opts.variant ?? 'secondary'} rw-btn--${opts.size ?? 'md'}`, href },
    opts.icon ? icon(opts.icon) : null,
    h('span', { class: 'rw-btn__label' }, label),
  );
}

function sgCard(title: string, body: (HTMLElement | null)[], opts: { aside?: HTMLElement | null; cls?: string; id?: string } = {}): HTMLElement {
  const headingId = opts.id ?? `sg-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return h(
    'section',
    { class: `sg-card ${opts.cls ?? ''}`.trim(), 'aria-labelledby': headingId },
    h('header', { class: 'sg-card__head' }, h('h2', { class: 'sg-card__title', id: headingId }, title), opts.aside ?? null),
    ...body,
  );
}

/** Host name of an http(s) URL, or null for anything else (never linked). */
function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname : null;
  } catch {
    return null;
  }
}

const isAscii = (meta: SongMeta): boolean => meta.entry.format === 'ascii';

// ---------------------------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------------------------

function hero(s: SongPageState, a: SongActions): HTMLElement {
  const e = s.meta.entry;
  const report = s.meta.difficulty[s.arrangement] ?? null;
  const needsRhythm = e.rhythm === 'needs-alignment';
  const composer = e.composer && !(e.artist && e.composer.startsWith(e.artist)) ? e.composer : null;
  const by = [e.artist, composer ? (e.artist ? `comp. ${composer}` : composer) : null].filter(Boolean).join(' · ');
  const chips: (string | null)[] = [
    formatDuration(e.durationSec) || null,
    e.bpm ? `${Math.round(e.bpm)} BPM` : null,
    s.tuning.label,
    s.tuning.capo > 0 ? `Capo ${s.tuning.capo}` : null,
    RHYTHM_LABEL[e.rhythm],
  ];
  const play = (mode: RunMode): string => a.href(playRoute(e.id, s.arrangement, mode));
  return h(
    'header',
    { class: 'sg-hero', style: `--tier-c: ${report ? `var(--tier-${report.tier})` : 'var(--color-border-strong)'}` },
    h('div', { class: 'sg-hero__fx', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'sg-hero__main' },
      h('p', { class: 'rw-eyebrow sg-hero__eyebrow' }, SOURCE_LABEL[e.source], h('span', { class: 'sg-hero__file' }, e.fileName)),
      h('h1', { class: 'sg-hero__title', tabindex: '-1' }, e.title),
      by ? h('p', { class: 'sg-hero__by' }, by) : null,
      h('ul', { class: 'sg-chips', 'aria-label': 'Song details' }, ...chips.filter((c): c is string => !!c).map((c) => h('li', { class: 'sg-chip rw-num' }, c))),
    ),
    h(
      'div',
      { class: 'sg-hero__side' },
      report
        ? h('div', { class: 'sg-hero__diff' }, difficultyPill({ rating: report.rating, tier: report.tier }), report.provisional ? h('span', { class: 'sg-est', title: 'Estimated until the rhythm is aligned' }, '≈ estimated') : null)
        : badge('Unrated'),
      needsRhythm
        ? h(
            'div',
            { class: 'sg-hero__actions' },
            linkButton('Align rhythm to play', a.href({ screen: 'import', params: { song: e.id } }), { variant: 'primary', size: 'lg', icon: 'import' }),
            h('p', { class: 'sg-hero__hint' }, 'This tab has frets but no timing yet. Align it once, then play.'),
          )
        : h(
            'div',
            { class: 'sg-hero__actions' },
            linkButton('Play', play('play'), { variant: 'primary', size: 'lg', icon: 'play' }),
            linkButton('Practice', play('practice'), { variant: 'secondary', size: 'lg', icon: 'loop' }),
          ),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Main column
// ---------------------------------------------------------------------------------------------

function tuningPrompt(t: TuningView, a: SongActions): HTMLElement | null {
  if (!t.prompt) return null;
  return h(
    'section',
    { class: 'sg-retune', 'aria-labelledby': 'sg-retune-title' },
    h('span', { class: 'sg-retune__icon', 'aria-hidden': 'true' }, icon('warning', { size: '22px' })),
    h(
      'div',
      { class: 'sg-retune__text' },
      h('h2', { id: 'sg-retune-title' }, t.prompt.title),
      h('p', null, t.prompt.text),
      h(
        'ol',
        { class: 'sg-strings', 'aria-label': `${t.label}, low to high` },
        ...t.strings.map((s) =>
          h('li', { class: s.delta ? 'sg-string is-changed' : 'sg-string', style: `--s: var(--string-${s.string})`, title: s.delta ? `String ${s.string}: ${s.delta > 0 ? '+' : ''}${s.delta} semitones` : `String ${s.string}` }, s.note),
        ),
      ),
    ),
    button({ label: 'Open tuner', icon: 'audio', variant: 'primary', onClick: () => a.tune() }),
  );
}

function masteryMap(s: SongPageState, a: SongActions): HTMLElement {
  const rows = s.sections;
  const summary = rows.length
    ? s.mastery.repertoire
      ? 'Every section locked in: this one’s in your repertoire.'
      : `${s.mastery.mastered} of ${s.mastery.total} mastered · ${s.mastery.locked} locked in`
    : '';
  const strip = h(
    'ol',
    { class: 'sg-map', 'aria-hidden': 'true' },
    ...rows.map((r) => h('li', { class: `sg-map__seg is-${r.state}`, style: `flex-grow: ${Math.max(0.02, r.share).toFixed(4)}; --tier-c: ${r.tier ? `var(--tier-${r.tier})` : 'var(--color-border-strong)'}`, title: `${r.name}: ${r.stateLabel}` })),
  );
  const list = h(
    'ol',
    { class: 'sg-sections' },
    ...rows.map((r) =>
      h(
        'li',
        { class: `sg-sec is-${r.state}`, dataset: { idx: String(r.idx), state: r.state } },
        h('span', { class: 'sg-sec__state', 'aria-hidden': 'true' }, r.state === 'locked' ? icon('star', { size: '16px' }) : r.state === 'mastered' || r.state === 'check-due' ? icon('check', { size: '16px' }) : null),
        h(
          'div',
          { class: 'sg-sec__text' },
          h('span', { class: 'sg-sec__name' }, r.name, r.tier ? difficultyPill({ tier: r.tier, ...(r.rating !== null ? { rating: r.rating } : {}), size: 'sm', showName: false }) : null),
          h('span', { class: 'sg-sec__detail' }, h('span', { class: 'sg-sec__label' }, r.stateLabel), ' · ', r.detail),
        ),
        linkButton(r.state === 'check-due' ? 'Take the check' : 'Loop this', a.href(r.loop), { size: 'sm', variant: r.state === 'check-due' ? 'primary' : 'secondary', icon: 'loop' }),
      ),
    ),
  );
  return sgCard(
    'Sections',
    rows.length
      ? [h('p', { class: 'sg-card__sub' }, summary), strip, list]
      : [h('p', { class: 'rw-muted' }, s.songState === 'loading' ? 'Loading sections…' : 'This arrangement has no sections yet.')],
    {
      aside: h(
        'ul',
        { class: 'sg-legend', 'aria-label': 'Legend' },
        ...(['new', 'practising', 'mastered', 'locked'] as const).map((k) => h('li', { class: `is-${k}` }, { new: 'New', practising: 'Practising', mastered: 'Mastered', locked: 'Locked in' }[k])),
      ),
      cls: 'sg-mastery',
    },
  );
}

function difficultyCard(s: SongPageState): HTMLElement | null {
  const report = s.meta.difficulty[s.arrangement];
  if (!report) return null;
  return sgCard(
    `Why it’s a ${report.rating.toFixed(1)}`,
    [
      report.highlights.length
        ? h('ul', { class: 'sg-why' }, ...report.highlights.map((w) => h('li', null, w)))
        : h('p', { class: 'rw-muted' }, 'No single thing stands out: a steady, even part.'),
      h(
        'ol',
        { class: 'sg-bars' },
        ...s.bars.map((b) =>
          h(
            'li',
            { class: b.hardest ? 'sg-bar is-hardest' : 'sg-bar', style: `--tier-c: var(--tier-${b.tier})` },
            h('span', { class: 'sg-bar__name' }, b.name),
            h('span', { class: 'sg-bar__track', role: 'img', 'aria-label': `${b.name}: ${b.rating.toFixed(1)} of 10${b.why.length ? `, ${b.why.join(', ')}` : ''}` }, h('span', { class: 'sg-bar__fill', style: `width: ${b.pct}%` })),
            h('span', { class: 'sg-bar__num rw-num' }, b.rating.toFixed(1)),
            h('span', { class: 'sg-bar__why' }, b.hardest ? badge('Hardest', { tone: 'warning' }) : null, b.why.join(' · ')),
          ),
        ),
      ),
      report.provisional ? h('p', { class: 'sg-note' }, 'Estimated from proportional timing; it firms up once the rhythm is aligned.') : null,
    ],
    { id: 'sg-why-title', cls: 'sg-diff' },
  );
}

// ---------------------------------------------------------------------------------------------
// Side column
// ---------------------------------------------------------------------------------------------

function arrangementsCard(s: SongPageState, a: SongActions): HTMLElement | null {
  if (s.options.length <= 1 && s.unplayable === 0) return null;
  return sgCard(
    'Arrangements',
    [
      h(
        'ul',
        { class: 'sg-arrs' },
        ...s.options.map((o) =>
          h(
            'li',
            null,
            h(
              'a',
              { class: o.current ? 'sg-arr is-current' : 'sg-arr', href: a.href({ screen: 'song', params: { id: s.meta.entry.id, arr: String(o.index) } }), 'aria-current': o.current ? 'page' : undefined },
              h('span', { class: 'sg-arr__text' }, h('span', { class: 'sg-arr__name' }, o.name, o.isDefault ? badge('Default', { tone: 'accent' }) : null), h('span', { class: 'sg-arr__details' }, o.details)),
              o.tier ? difficultyPill({ tier: o.tier, ...(o.rating !== null ? { rating: o.rating } : {}), size: 'sm', showName: false }) : badge('Unrated'),
            ),
          ),
        ),
      ),
      s.unplayable > 0 ? h('p', { class: 'sg-note' }, `${s.unplayable} other ${s.unplayable === 1 ? 'track' : 'tracks'} (bass, drums or non-6-string) can’t be played.`) : null,
    ],
  );
}

function techniquesCard(s: SongPageState): HTMLElement | null {
  const t = s.meta.entry.tags;
  const report = s.meta.difficulty[s.arrangement];
  const skills = [...new Set([...(report?.skills ?? []), ...t.skills])];
  if (!skills.length && !t.style.length && !t.genre.length) return null;
  const chips = (items: readonly string[], cls: string): HTMLElement[] => items.map((x) => h('li', { class: `sg-tag ${cls}` }, x.replace(/-/g, ' ')));
  return sgCard('Techniques', [h('ul', { class: 'sg-tags' }, ...chips(skills, 'is-skill'), ...chips(t.style, 'is-style'), ...chips(t.genre, 'is-genre'))]);
}

function bestsCard(s: SongPageState, a: SongActions): HTMLElement {
  const body: (HTMLElement | null)[] = [];
  if (s.trend.values.length > 1) {
    body.push(h('div', { class: 'sg-trend' }, sparkline({ values: s.trend.values, label: s.trend.label, reference: 90, min: s.trend.min, width: 280, height: 64 }), h('p', { class: 'sg-trend__label' }, s.trend.label)));
  }
  if (s.bests.length) {
    body.push(
      h(
        'ol',
        { class: 'sg-bests' },
        ...s.bests.map((b) =>
          h(
            'li',
            null,
            h(
              'a',
              { class: b.full ? 'sg-best is-full' : 'sg-best', href: a.href({ screen: 'results', params: { runId: String(b.runId) } }) },
              h('span', { class: 'sg-best__speed rw-num' }, b.label),
              starRating({ stars: b.stars, size: 'sm', suffix: `at ${b.label} speed` }),
              h('span', { class: 'sg-best__acc rw-num' }, `${b.accuracy}%`),
              h('span', { class: 'sg-best__meta rw-num' }, `${b.score.toLocaleString('en-US')} · ${b.when}`),
            ),
          ),
        ),
      ),
    );
  } else {
    body.push(h('p', { class: 'rw-muted' }, 'No scores yet. Your first run sets the bar; slower speeds get their own bests.'));
  }
  return sgCard('Best scores', body, { aside: s.bests.some((b) => b.full) ? badge('Full speed', { tone: 'neon', icon: 'star' }) : null });
}

function rhythmCard(s: SongPageState, a: SongActions): HTMLElement | null {
  const e = s.meta.entry;
  if (!isAscii(s.meta)) return null;
  const text =
    e.rhythm === 'needs-alignment'
      ? 'This text tab has fret numbers but no timing. Tap or snap the rhythm once and it plays like any other song.'
      : e.rhythm === 'aligned'
        ? 'You aligned this tab’s rhythm. Re-align it if notes feel early or late.'
        : `Timing comes from ${e.rhythm === 'midi' ? 'a paired MIDI file' : 'the tab’s beat ruler'}. Re-align it if it feels off.`;
  return sgCard('Rhythm', [
    h('p', { class: 'sg-card__sub' }, text),
    h('div', null, linkButton(e.rhythm === 'needs-alignment' ? 'Align rhythm' : 'Re-align rhythm', a.href({ screen: 'import', params: { song: e.id } }), { size: 'sm', icon: 'import', variant: e.rhythm === 'needs-alignment' ? 'primary' : 'secondary' })),
  ]);
}

function sourceCard(s: SongPageState): HTMLElement {
  const e = s.meta.entry;
  const rows: [string, HTMLElement | string][] = [
    ['Source', SOURCE_LABEL[e.source]],
    ['File', h('code', null, e.path)],
  ];
  if (e.origin) rows.push(['Origin', e.origin]);
  const host = e.url ? hostOf(e.url) : null;
  if (e.url && host) rows.push(['Web page', h('a', { href: e.url, target: '_blank', rel: 'noopener noreferrer' }, host, h('span', { class: 'rw-visually-hidden' }, ' (opens a new tab)'))]);
  return sgCard('Source', [h('dl', { class: 'sg-dl' }, ...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]))]);
}

/** Render the song page; `backingSlot` is re-inserted as-is (it may hold a mounted panel). */
export function renderSong(s: SongPageState, a: SongActions, backingSlot: HTMLElement): HTMLElement {
  return h(
    'div',
    { class: 'sg' },
    h('a', { class: 'sg-back', href: a.href({ screen: 'library', params: {} }) }, icon('chevronRight', { size: '16px' }), 'Library'),
    hero(s, a),
    h(
      'div',
      { class: 'sg-grid' },
      h('div', { class: 'sg-main' }, tuningPrompt(s.tuning, a), masteryMap(s, a), difficultyCard(s), backingSlot),
      h('aside', { class: 'sg-side' }, arrangementsCard(s, a), bestsCard(s, a), techniquesCard(s), rhythmCard(s, a), sourceCard(s)),
    ),
  );
}
