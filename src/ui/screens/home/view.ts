/**
 * Home dashboard rendering (T-034): turns a {@link HomeModel} into DOM. Links are real `<a href>`s
 * (hash routes), so middle-click and keyboard work without extra wiring; the few buttons call back
 * into the screen through {@link HomeActions}.
 * @module
 */
import type { SearchResult } from '@shared/sources';
import type { Tier } from '@shared/song';
import { badge, button, difficultyPill, h, icon, starRating, type ButtonVariant, type Child, type IconName } from '../../components';
import type {
  Checklist,
  CheckItem,
  ContinueItem,
  DailyView,
  GoalItem,
  HomeModel,
  RecGroup,
  RecItem,
  RecentItem,
  RouteTarget,
  StatsView,
  WeekView,
} from './model';
import { freezeGlyph, progressRing } from './viz';

/** Callbacks and route resolution supplied by the screen. */
export interface HomeActions {
  href(to: RouteTarget): string;
  /** "I'm tuned" on the checklist. */
  markTuned(): void;
  /** Hide the setup checklist. */
  hideChecklist(): void;
  /** A session goal was picked (before navigation). */
  pickGoal(item: GoalItem): void;
  /** Retry after a server error. */
  retry(): void;
}

/** "Good evening" etc. by local hour. */
export function greeting(now: number): string {
  const hour = new Date(now).getHours();
  if (hour < 5) return 'Late-night session';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** An `<a>` styled as a kit button. */
function linkButton(label: string, href: string, opts: { variant?: ButtonVariant; size?: 'sm' | 'md' | 'lg'; icon?: IconName; trailing?: IconName } = {}): HTMLAnchorElement {
  return h(
    'a',
    { class: `rw-btn rw-btn--${opts.variant ?? 'secondary'} rw-btn--${opts.size ?? 'md'}`, href },
    opts.icon ? icon(opts.icon) : null,
    h('span', { class: 'rw-btn__label' }, label),
    opts.trailing ? icon(opts.trailing) : null,
  );
}

function sectionHead(title: string, sub?: string, aside?: Child): HTMLElement {
  return h(
    'header',
    { class: 'hm-sec__head' },
    h('div', null, h('h2', { class: 'hm-sec__title' }, title), sub ? h('p', { class: 'hm-sec__sub' }, sub) : null),
    aside ?? null,
  );
}

function tierStyle(tier: number | null): string {
  return `--tier-c: ${tier ? `var(--tier-${tier})` : 'var(--color-border-strong)'}`;
}

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

function checklistCard(c: Checklist, a: HomeActions, big: boolean): HTMLElement {
  const steps = c.steps.map((s, i) =>
    h(
      'li',
      { class: s.done ? 'hm-step is-done' : 'hm-step', dataset: { step: s.id } },
      h('span', { class: 'hm-step__mark', 'aria-hidden': 'true' }, s.done ? icon('check', { size: '16px' }) : String(i + 1)),
      h(
        'div',
        { class: 'hm-step__text' },
        h('span', { class: 'hm-step__title' }, s.title, h('span', { class: 'rw-visually-hidden' }, s.done ? ' (done)' : ' (to do)')),
        h('span', { class: 'hm-step__detail' }, s.detail),
      ),
      s.done
        ? null
        : h(
            'div',
            { class: 'hm-step__actions' },
            s.id === 'tune' ? button({ label: 'I’m tuned', variant: 'ghost', size: 'sm', onClick: () => a.markTuned() }) : null,
            linkButton(s.action.label, a.href(s.action.to), { variant: s.id === nextStep(c) ? 'primary' : 'secondary', size: 'sm' }),
          ),
    ),
  );
  const pct = Math.round((c.doneCount / c.steps.length) * 100);
  return h(
    'section',
    { class: big ? 'hm-card hm-setup hm-setup--big' : 'hm-card hm-setup', 'aria-labelledby': 'hm-setup-title' },
    h(
      'header',
      { class: 'hm-setup__head' },
      h(
        'div',
        null,
        h('p', { class: 'rw-eyebrow' }, 'Setup'),
        h('h2', { class: 'hm-setup__title', id: 'hm-setup-title' }, big ? 'Four steps to your first song' : 'Finish setting up'),
      ),
      h(
        'div',
        { class: 'hm-setup__progress' },
        h('span', { class: 'rw-num' }, `${c.doneCount}/${c.steps.length}`),
        h('span', { class: 'hm-setup__bar', role: 'progressbar', 'aria-label': 'Setup progress', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct }, h('span', { style: `width: ${pct}%` })),
      ),
    ),
    h('ol', { class: 'hm-steps' }, ...steps),
    h(
      'footer',
      { class: 'hm-setup__foot' },
      h('span', { class: 'rw-muted' }, 'No interface yet? Keyboard mode works too: keys 1–6 are the strings.'),
      button({ label: 'Hide checklist', variant: 'ghost', size: 'sm', onClick: () => a.hideChecklist() }),
    ),
  );
}

function nextStep(c: Checklist): string | undefined {
  return c.steps.find((s) => !s.done)?.id;
}

function continueCard(item: ContinueItem, a: HomeActions): HTMLElement {
  const masteryPct = item.mastery && item.mastery.total > 0 ? Math.round((item.mastery.mastered / item.mastery.total) * 100) : 0;
  return h(
    'section',
    { class: 'hm-card hm-continue', style: tierStyle(item.tier), 'aria-labelledby': 'hm-continue-title' },
    h('div', { class: 'hm-continue__glow', 'aria-hidden': 'true' }),
    h('p', { class: 'rw-eyebrow' }, 'Continue where you left off'),
    h(
      'div',
      { class: 'hm-continue__title-row' },
      h(
        'div',
        { class: 'hm-continue__titles' },
        h('h2', { class: 'hm-continue__title', id: 'hm-continue-title' }, h('a', { href: a.href(item.songPage) }, item.title)),
        item.by ? h('p', { class: 'hm-continue__by' }, item.by) : null,
      ),
      item.rating !== null ? difficultyPill({ rating: item.rating, ...(item.tier ? { tier: item.tier } : {}) }) : null,
    ),
    h('p', { class: 'hm-continue__next' }, icon('loop', { size: '18px' }), item.next),
    item.mastery
      ? h(
          'div',
          { class: 'hm-continue__mastery' },
          h('span', { class: 'hm-continue__bar', 'aria-hidden': 'true' }, h('span', { style: `width: ${masteryPct}%` })),
          h('span', { class: 'rw-num' }, `${item.mastery.mastered} of ${item.mastery.total} sections mastered`),
        )
      : null,
    h('p', { class: 'hm-continue__last rw-num' }, item.last),
    h(
      'div',
      { class: 'hm-continue__actions' },
      linkButton(item.primary.label, a.href(item.primary.to), { variant: 'primary', size: 'lg', icon: 'play' }),
      linkButton('Song page', a.href(item.songPage), { variant: 'ghost', trailing: 'chevronRight' }),
    ),
  );
}

function welcomeIntro(model: HomeModel, a: HomeActions): HTMLElement {
  const first = model.starters[0];
  return h(
    'section',
    { class: 'hm-card hm-welcome' },
    h('div', { class: 'hm-welcome__strings', 'aria-hidden': 'true' }, ...[1, 2, 3, 4, 5, 6].map((n) => h('span', { style: `--s: var(--string-${n}); --i: ${n}` }))),
    h('p', { class: 'rw-eyebrow' }, 'Welcome'),
    h('h2', { class: 'hm-welcome__title' }, 'Plug in. Tune up. Play real songs.'),
    h(
      'p',
      { class: 'hm-welcome__text' },
      'Notes scroll toward you on six string lanes and Riffway listens to your guitar. Start slow, go clean, then speed up: that’s how it sticks.',
    ),
    first
      ? h('div', { class: 'hm-welcome__actions' }, linkButton(`Play “${first.title}”`, a.href({ screen: 'song', params: { id: first.id, arr: String(first.defaultArrangement) } }), { variant: 'primary', size: 'lg', icon: 'play' }))
      : null,
  );
}

function weekCard(w: WeekView, d: DailyView): HTMLElement {
  const ring = progressRing({
    fraction: d.fraction,
    label: `Daily goal: ${d.minutes} of ${d.goalMinutes} minutes today`,
    value: String(d.minutes),
    caption: `of ${d.goalMinutes} min`,
  });
  const dots = h(
    'ol',
    { class: 'hm-days', 'aria-label': `This week: ${w.practiced} of ${w.needed} practice days` },
    ...w.days.map((day) =>
      h(
        'li',
        {
          class: ['hm-day', day.practiced ? 'is-practiced' : '', day.today ? 'is-today' : '', day.future ? 'is-future' : ''].filter(Boolean).join(' '),
          title: `${day.name}: ${day.practiced ? `practised ${day.minutes} min` : day.future ? 'still ahead' : day.minutes > 0 ? `${day.minutes} min` : 'rest day'}`,
        },
        h('span', { class: 'hm-day__dot', 'aria-hidden': 'true' }, day.practiced ? icon('check', { size: '14px' }) : null),
        h('span', { class: 'hm-day__letter', 'aria-hidden': 'true' }, day.letter),
        h('span', { class: 'rw-visually-hidden' }, `${day.name}${day.today ? ' (today)' : ''}: ${day.practiced ? 'practised' : day.future ? 'ahead' : 'not practised'}`),
      ),
    ),
  );
  const freezes = h(
    'div',
    { class: 'hm-freezes', title: 'Freezes cover a missed week automatically. You earn one every 2 weeks you hit your target.' },
    ...Array.from({ length: w.maxFreezes }, (_, i) => freezeGlyph(i < w.freezes)),
    h('span', { class: 'hm-freezes__label' }, w.freezes === 0 ? 'Freezes: earn one every 2 weeks' : `${w.freezes} ${w.freezes === 1 ? 'freeze' : 'freezes'} ready`),
  );
  return h(
    'section',
    { class: w.met ? 'hm-card hm-week is-met' : 'hm-card hm-week', 'aria-labelledby': 'hm-week-title' },
    h('header', { class: 'hm-week__head' }, h('p', { class: 'rw-eyebrow' }, 'This week'), w.repairing ? badge('Bonus week', { tone: 'accent' }) : null),
    h(
      'div',
      { class: 'hm-week__top' },
      h('div', { class: 'hm-week__ring' }, ring, h('p', { class: 'hm-week__daily' }, d.message)),
      h(
        'div',
        { class: 'hm-streak' },
        h('h2', { class: 'hm-streak__headline', id: 'hm-week-title' }, w.headline),
        h(
          'dl',
          { class: 'hm-streak__nums' },
          h('div', { class: 'hm-streak__num is-current' }, h('dt', null, 'Week streak'), h('dd', { class: 'rw-num' }, icon('flame', { size: '22px' }), String(w.current))),
          h('div', { class: 'hm-streak__num' }, h('dt', null, 'Best'), h('dd', { class: 'rw-num' }, String(w.best))),
        ),
        freezes,
      ),
    ),
    dots,
    h('p', { class: 'hm-week__msg' }, h('span', { class: 'hm-week__count rw-num' }, `${w.practiced}/${w.needed} days`), w.message),
  );
}

/**
 * Next-day checks due now (or coming tomorrow). The check the continue card already offers is left
 * out, so the same action isn't shown twice in a row.
 */
function checksStrip(all: HomeModel['checks'], a: HomeActions, cont: ContinueItem | null): HTMLElement | null {
  const due = all.due.filter((c) => !(cont && c.songId === cont.songId && c.arrangement === cont.arrangement && c.sectionIdx === cont.checkSection));
  const checks = { due, tomorrow: all.tomorrow };
  if (checks.due.length === 0 && checks.tomorrow === 0) return null;
  const items = checks.due.slice(0, 4).map((c: CheckItem) =>
    h('a', { class: 'hm-check', href: a.href(c.to) }, h('span', { class: 'hm-check__song' }, c.title), h('span', { class: 'hm-check__sec' }, c.section), icon('chevronRight', { size: '16px' })),
  );
  const more = checks.due.length > 4 ? h('span', { class: 'hm-checks__more rw-muted' }, `+${checks.due.length - 4} more`) : null;
  const text =
    checks.due.length > 0
      ? `${checks.due.length === 1 ? 'A section is' : `${checks.due.length} sections are`} ready to lock in. One clean run at full speed does it.`
      : `${checks.tomorrow === 1 ? 'A section' : `${checks.tomorrow} sections`} mastered today. Sleep on it: the next-day check opens tomorrow.`;
  return h(
    'section',
    { class: checks.due.length ? 'hm-checks is-due' : 'hm-checks', 'aria-label': 'Next-day checks' },
    h('span', { class: 'hm-checks__icon', 'aria-hidden': 'true' }, icon(checks.due.length ? 'star' : 'check', { size: '20px' })),
    h('div', { class: 'hm-checks__text' }, h('strong', null, checks.due.length ? 'Next-day checks' : 'Coming tomorrow'), h('span', null, text)),
    items.length ? h('div', { class: 'hm-checks__list' }, ...items, more) : null,
  );
}

function goalsSection(goals: readonly GoalItem[], a: HomeActions): HTMLElement | null {
  if (goals.length === 0) return null;
  const icons: Record<GoalItem['goal']['kind'], IconName> = { 'next-day-check': 'star', 'weakest-section': 'loop', 'new-stretch': 'music' };
  return h(
    'section',
    { class: 'hm-sec' },
    sectionHead('Pick today’s focus', 'One clear goal beats an hour of noodling. Choose one.'),
    h(
      'ol',
      { class: 'hm-goals' },
      ...goals.map((g, i) => {
        const link = h(
          'a',
          { class: g.picked ? 'hm-goal is-picked' : 'hm-goal', href: a.href(g.to), dataset: { kind: g.goal.kind }, style: `--i: ${i}` },
          h('span', { class: 'hm-goal__icon', 'aria-hidden': 'true' }, icon(icons[g.goal.kind], { size: '22px' })),
          h('span', { class: 'hm-goal__title' }, g.title, g.picked ? badge('Today’s focus', { tone: 'accent' }) : null),
          h('span', { class: 'hm-goal__detail' }, g.detail),
          h('span', { class: 'hm-goal__go' }, 'Start', icon('chevronRight', { size: '16px' })),
        );
        link.addEventListener('click', () => a.pickGoal(g));
        return h('li', null, link);
      }),
    ),
  );
}

function songTile(opts: { href: string; title: string; by: string | null; tier: Tier | null; rating: number | null; badgeText?: string; reason?: string; kind?: string }): HTMLElement {
  return h(
    'li',
    null,
    h(
      'a',
      { class: 'hm-song', href: opts.href, style: tierStyle(opts.tier), dataset: opts.kind ? { kind: opts.kind } : {} },
      h(
        'span',
        { class: 'hm-song__top' },
        opts.badgeText ? h('span', { class: 'hm-song__kind' }, opts.badgeText) : h('span'),
        opts.rating !== null || opts.tier !== null
          ? difficultyPill({ ...(opts.rating !== null ? { rating: opts.rating } : {}), ...(opts.tier ? { tier: opts.tier } : {}), size: 'sm', showName: false })
          : badge('Unrated'),
      ),
      h('span', { class: 'hm-song__title' }, opts.title),
      opts.by ? h('span', { class: 'hm-song__by' }, opts.by) : null,
      opts.reason ? h('span', { class: 'hm-song__reason' }, opts.reason) : null,
    ),
  );
}

function recTile(item: RecItem, a: HomeActions): HTMLElement {
  return songTile({ href: a.href(item.to), title: item.title, by: item.by, tier: item.rec.tier, rating: item.rating, badgeText: item.badge, reason: item.reason, kind: item.rec.kind });
}

function recommendationsSection(model: HomeModel, a: HomeActions): HTMLElement {
  if (model.serverDown) {
    return h(
      'section',
      { class: 'hm-sec' },
      sectionHead('Recommended for you'),
      h(
        'div',
        { class: 'hm-offline' },
        icon('warning', { size: '22px' }),
        h('p', null, 'Recommendations need your library, and the Riffway companion server isn’t answering. Start it with npm run dev (or npm start).'),
        button({ label: 'Try again', onClick: () => a.retry() }),
      ),
    );
  }
  if (model.recommendations.length === 0) {
    return h(
      'section',
      { class: 'hm-sec' },
      sectionHead('Recommended for you'),
      h('div', { class: 'hm-offline' }, icon('library', { size: '22px' }), h('p', null, 'Add a few songs to your library and Riffway will line up picks at the right level.'), linkButton('Open library', a.href({ screen: 'library', params: {} }))),
    );
  }
  const group = (g: RecGroup): HTMLElement =>
    h(
      'div',
      { class: `hm-recs hm-recs--${g.id}`, dataset: { group: g.id } },
      h('header', { class: 'hm-recs__head' }, h('h3', null, g.title), h('p', null, g.blurb)),
      h('ul', { class: 'hm-tiles' }, ...g.items.map((i) => recTile(i, a))),
    );
  const stretch = model.recommendations.find((g) => g.id === 'stretch');
  const rest = model.recommendations.filter((g) => g.id !== 'stretch');
  return h(
    'section',
    { class: 'hm-sec' },
    sectionHead(
      'Recommended for you',
      `Picked around your comfort tier (${model.stats.comfortTier}): mostly one step up, some review, one reach.`,
      linkButton('Browse library', a.href({ screen: 'library', params: {} }), { variant: 'ghost', size: 'sm', trailing: 'chevronRight' }),
    ),
    stretch ? group(stretch) : null,
    rest.length ? h('div', { class: 'hm-recs-row' }, ...rest.map(group)) : null,
  );
}

function startersSection(model: HomeModel, a: HomeActions): HTMLElement {
  const tiles = model.starters.map((s: SearchResult) =>
    songTile({
      href: a.href({ screen: 'song', params: { id: s.id, arr: String(s.defaultArrangement) } }),
      title: s.title,
      by: s.artist ?? s.composer ?? null,
      tier: s.tier,
      rating: s.rating,
      badgeText: s.tags.genre.includes('exercise') ? 'Exercise' : 'Song',
    }),
  );
  return h(
    'section',
    { class: 'hm-sec' },
    sectionHead(
      'Start here',
      'Starter songs, easiest first. Public-domain melodies and warm-ups arranged for pick players.',
      linkButton('All songs', a.href({ screen: 'library', params: {} }), { variant: 'ghost', size: 'sm', trailing: 'chevronRight' }),
    ),
    model.serverDown
      ? h('div', { class: 'hm-offline' }, icon('warning', { size: '22px' }), h('p', null, 'The Riffway companion server isn’t answering, so songs can’t load. Start it with npm run dev (or npm start).'), button({ label: 'Try again', onClick: () => a.retry() }))
      : tiles.length
        ? h('ul', { class: 'hm-tiles' }, ...tiles)
        : h('div', { class: 'hm-offline' }, icon('library', { size: '22px' }), h('p', null, 'No starter songs yet. Turn them on in the Library, or drop your own tabs there.'), linkButton('Open library', a.href({ screen: 'library', params: {} }))),
    model.starterOnly
      ? h(
          'p',
          { class: 'hm-tip' },
          icon('import', { size: '18px' }),
          h(
            'span',
            null,
            'Got your own tabs? Drop Guitar Pro, MusicXML or text tabs into the ',
            h('a', { href: a.href({ screen: 'library', params: {} }) }, 'Library'),
            ', or paste one on the ',
            h('a', { href: a.href({ screen: 'import', params: {} }) }, 'Import'),
            ' page.',
          ),
        )
      : null,
  );
}

function recentList(items: readonly RecentItem[], a: HomeActions): HTMLElement {
  return h(
    'section',
    { class: 'hm-card hm-recent', 'aria-labelledby': 'hm-recent-title' },
    h('h2', { class: 'hm-card__title', id: 'hm-recent-title' }, 'Recent results'),
    items.length
      ? h(
          'ol',
          { class: 'hm-runs' },
          ...items.map((r) =>
            h(
              'li',
              null,
              h(
                'a',
                { class: 'hm-run', href: a.href(r.to) },
                starRating({ stars: r.stars, size: 'sm' }),
                h('span', { class: 'hm-run__text' }, h('span', { class: 'hm-run__title' }, r.title), h('span', { class: 'hm-run__meta rw-num' }, `${r.mode === 'play' ? (r.looped ? 'Loop' : 'Play') : 'Practice'} · ${r.speedPct}% speed · ${r.when}`)),
                r.clean ? badge('Clean', { tone: 'success' }) : null,
                h('span', { class: 'hm-run__acc rw-num' }, `${r.accuracy}%`),
              ),
            ),
          ),
        )
      : h('p', { class: 'rw-muted' }, 'Your runs will show up here.'),
  );
}

function statsCard(s: StatsView): HTMLElement {
  const tile = (value: string | HTMLElement, label: string, hint: string, cls = ''): HTMLElement =>
    h('div', { class: `hm-stat ${cls}`.trim(), title: hint }, h('dd', { class: 'hm-stat__value rw-num' }, value), h('dt', { class: 'hm-stat__label' }, label));
  return h(
    'section',
    { class: 'hm-card hm-stats', 'aria-labelledby': 'hm-stats-title' },
    h('h2', { class: 'hm-card__title', id: 'hm-stats-title' }, 'Your progress'),
    h(
      'dl',
      { class: 'hm-stats__grid' },
      tile(String(s.repertoire), s.repertoire === 1 ? 'Song in your repertoire' : 'Songs in your repertoire', 'Every section locked in: ready to play for others.', 'is-hero'),
      tile(String(s.lockedSections), 'Sections locked in', 'Mastered and passed the next-day check.'),
      tile(String(s.masteredSections), 'Sections mastered', 'Two clean runs at full speed in one session.'),
      tile(String(s.cleanRuns), 'Clean runs', 'Runs with at least 90% accuracy and no more than 2 misses in a row.'),
      tile(difficultyPill({ tier: s.comfortTier, size: 'sm' }), 'Comfort tier', s.comfortNote),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------------------------

/** Render the whole dashboard. */
export function renderHome(model: HomeModel, a: HomeActions, now: number): HTMLElement {
  const hero = h(
    'header',
    { class: 'hm-hero' },
    h('h1', { class: 'hm-hero__title', tabindex: '-1' }, model.firstRun ? 'Welcome to Riffway' : greeting(now)),
    h(
      'p',
      { class: 'hm-hero__sub' },
      model.firstRun
        ? 'Your guitar, your songs, a highway of notes. A few quick steps and you’re playing.'
        : model.checks.due.length
          ? 'Fresh day, fresh hands. Start with a next-day check while it’s easy.'
          : 'Ready when you are. Pick a focus and play.',
    ),
  );
  const week = weekCard(model.week, model.daily);
  if (model.firstRun) {
    return h(
      'div',
      { class: 'hm hm--first' },
      hero,
      h('div', { class: 'hm-top' }, h('div', { class: 'hm-top__main' }, model.checklist.visible ? checklistCard(model.checklist, a, true) : welcomeIntro(model, a)), week),
      startersSection(model, a),
    );
  }
  return h(
    'div',
    { class: 'hm' },
    hero,
    h(
      'div',
      { class: 'hm-top' },
      h('div', { class: 'hm-top__main' }, model.continueItem ? continueCard(model.continueItem, a) : null, checksStrip(model.checks, a, model.continueItem)),
      week,
    ),
    model.checklist.visible ? checklistCard(model.checklist, a, false) : null,
    goalsSection(model.goals, a),
    recommendationsSection(model, a),
    h('div', { class: 'hm-bottom' }, recentList(model.recent, a), statsCard(model.stats)),
  );
}

/** Placeholder while the first load is in flight. */
export function renderSkeleton(): HTMLElement {
  const block = (cls: string): HTMLElement => h('div', { class: `hm-skel ${cls}` });
  return h('div', { class: 'hm hm--loading', 'aria-busy': 'true' }, h('p', { class: 'rw-visually-hidden', role: 'status' }, 'Loading your dashboard…'), block('hm-skel--title'), h('div', { class: 'hm-top' }, block('hm-skel--card'), block('hm-skel--card')), block('hm-skel--row'));
}
