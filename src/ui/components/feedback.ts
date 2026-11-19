/**
 * Game-flavoured display components: difficulty pill (tier colours), star rating, judgement tag and
 * combo multiplier. Neon styling is reserved for these feedback elements.
 * @module
 */
import type { Outcome, TimingLabel } from '@shared/judge';
import type { Tier } from '@shared/song';
import { clampStars, clampTier, OUTCOME_LABEL, OUTCOME_SLUG, tierBandName } from '../design/tokens';
import { h } from './dom';
import { icon } from './icons';

/** Options for {@link difficultyPill}. */
export interface DifficultyPillOptions {
  /** Rating 1.0–10.0; shown with one decimal. The tier is derived when `tier` is omitted. */
  rating?: number;
  tier?: Tier;
  /** Show the band name (Beginner … Expert); default true. */
  showName?: boolean;
  size?: 'sm' | 'md';
}

/**
 * Difficulty pill: tier-coloured number, 5-step band meter and band name.
 * Accessible name: "Difficulty 4.1, tier 4, Developing".
 */
export function difficultyPill(opts: DifficultyPillOptions): HTMLSpanElement {
  const tier = opts.tier ?? clampTier(opts.rating ?? 1);
  const name = tierBandName(tier);
  const band = Math.ceil(tier / 2);
  const number = opts.rating !== undefined ? opts.rating.toFixed(1) : String(tier);
  const bars = h('span', { class: 'rw-diff__bars', 'aria-hidden': 'true' });
  for (let i = 1; i <= 5; i++) bars.append(h('span', { class: i <= band ? 'rw-diff__bar is-on' : 'rw-diff__bar' }));
  const label = `Difficulty ${number}, tier ${tier}, ${name}`;
  return h(
    'span',
    {
      class: `rw-diff rw-diff--${opts.size ?? 'md'}`,
      role: 'img',
      'aria-label': label,
      title: label,
      dataset: { tier: String(tier) },
      style: `--tier-color: var(--tier-${tier})`,
    },
    bars,
    h('span', { class: 'rw-diff__num rw-num' }, number),
    opts.showName === false ? null : h('span', { class: 'rw-diff__name' }, name),
  );
}

/** Options for {@link starRating}. */
export interface StarRatingOptions {
  /** Earned stars, 0–5. */
  stars: number;
  size?: 'sm' | 'md' | 'lg';
  /** Pop the earned stars in one after another (results screen). Honours reduced motion. */
  animate?: boolean;
  /** Extra text after the accessible name, e.g. "at 70% speed". */
  suffix?: string;
}

/** Five-star rating with neon gold earned stars. Accessible name: "3 of 5 stars". */
export function starRating(opts: StarRatingOptions): HTMLSpanElement {
  const earned = clampStars(opts.stars);
  const label = `${earned} of 5 stars${opts.suffix ? ` ${opts.suffix}` : ''}`;
  const el = h('span', {
    class: `rw-stars rw-stars--${opts.size ?? 'md'}${opts.animate ? ' rw-stars--animate' : ''}`,
    role: 'img',
    'aria-label': label,
    title: label,
  });
  for (let i = 1; i <= 5; i++) {
    const star = h('span', { class: i <= earned ? 'rw-star is-earned' : 'rw-star', style: `--i: ${i - 1}` }, icon('star', { size: '1em' }));
    el.append(star);
  }
  return el;
}

/** Options for {@link judgementTag}. */
export interface JudgementTagOptions {
  /** Early/late label (shown for Good only, per D5, but rendered whenever given). */
  timing?: TimingLabel;
  /** Extra detail, e.g. "played G3" for a wrong note. */
  detail?: string;
  size?: 'sm' | 'md' | 'lg';
}

/** Neon outcome label ("PERFECT", "WRONG NOTE · played G3"). Call {@link flash} to replay the hit flash. */
export function judgementTag(outcome: Outcome, opts: JudgementTagOptions = {}): HTMLSpanElement {
  const slug = OUTCOME_SLUG[outcome];
  return h(
    'span',
    { class: `rw-judge rw-judge--${opts.size ?? 'md'}`, dataset: { outcome: slug } },
    h('span', { class: 'rw-judge__label' }, OUTCOME_LABEL[outcome]),
    opts.timing ? h('span', { class: 'rw-judge__timing' }, opts.timing) : null,
    opts.detail ? h('span', { class: 'rw-judge__detail' }, opts.detail) : null,
  );
}

/** Combo multiplier badge (×1–×4); the flame grows with the multiplier. */
export function comboBadge(multiplier: 1 | 2 | 3 | 4, combo?: number): HTMLSpanElement {
  const label = combo !== undefined ? `Combo ${combo}, multiplier ×${multiplier}` : `Multiplier ×${multiplier}`;
  return h(
    'span',
    { class: 'rw-combo', role: 'img', 'aria-label': label, title: label, dataset: { mult: String(multiplier) } },
    h('span', { class: 'rw-combo__flame' }, icon('flame', { size: '1em' })),
    h('span', { class: 'rw-combo__mult rw-num' }, `×${multiplier}`),
    combo !== undefined ? h('span', { class: 'rw-combo__count rw-num' }, String(combo)) : null,
  );
}

/**
 * Replay the hit-flash animation on any element (judgement tags, gems in DOM HUDs).
 * A no-op visual under reduced motion (durations collapse), but the class still toggles.
 */
export function flash(el: HTMLElement): void {
  el.classList.remove('is-flashing');
  // Reading layout restarts the CSS animation on the next class add.
  void el.offsetWidth;
  el.classList.add('is-flashing');
}
