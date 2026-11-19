/**
 * Cards, badges and empty states: the static building blocks of screens.
 * @module
 */
import { button, type ButtonOptions } from './button';
import { h, type Child } from './dom';
import { icon, type IconName } from './icons';

/** Options for {@link card}. */
export interface CardOptions {
  /** Heading text (rendered as `headingLevel`, default h3). */
  title?: string;
  headingLevel?: 2 | 3 | 4;
  /** Small caps label above the title. */
  eyebrow?: string;
  body?: Child | readonly Child[];
  /** Right side of the header (badges, menu button). */
  aside?: Child | readonly Child[];
  footer?: Child | readonly Child[];
  /** Hover lift + accent edge; use for cards that are links or have a primary click target. */
  interactive?: boolean;
  /** Coloured left edge (any CSS colour or `var(--tier-4)`). */
  accent?: string;
  /** Semantic element (default `section`). */
  as?: 'section' | 'article' | 'div' | 'li';
  class?: string;
}

/** A surface card with optional header, body and footer. */
export function card(opts: CardOptions = {}): HTMLElement {
  const classes = ['rw-card'];
  if (opts.interactive) classes.push('rw-card--interactive');
  if (opts.accent) classes.push('rw-card--accent');
  if (opts.class) classes.push(opts.class);
  const heading = opts.title ? h(`h${opts.headingLevel ?? 3}` as 'h3', { class: 'rw-card__title' }, opts.title) : null;
  const hasHeader = Boolean(heading || opts.eyebrow || opts.aside);
  const el = h(
    opts.as ?? 'section',
    { class: classes.join(' '), style: opts.accent ? `--card-accent: ${opts.accent}` : undefined },
    hasHeader
      ? h(
          'header',
          { class: 'rw-card__header' },
          h('div', { class: 'rw-card__heading' }, opts.eyebrow ? h('p', { class: 'rw-eyebrow' }, opts.eyebrow) : null, heading),
          opts.aside ? h('div', { class: 'rw-card__aside' }, ...[opts.aside].flat()) : null,
        )
      : null,
    opts.body !== undefined ? h('div', { class: 'rw-card__body' }, ...[opts.body].flat()) : null,
    opts.footer !== undefined ? h('footer', { class: 'rw-card__footer' }, ...[opts.footer].flat()) : null,
  );
  return el;
}

export type BadgeTone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger' | 'neon';

/** A small status label. `neon` is reserved for celebratory feedback (personal best, new record). */
export function badge(text: string, opts: { tone?: BadgeTone; icon?: IconName; title?: string } = {}): HTMLSpanElement {
  return h(
    'span',
    { class: `rw-badge rw-badge--${opts.tone ?? 'neutral'}`, title: opts.title },
    opts.icon ? icon(opts.icon, { size: '1em' }) : null,
    text,
  );
}

/** Options for {@link emptyState}. */
export interface EmptyStateOptions {
  title: string;
  message?: string;
  icon?: IconName;
  /** Primary call to action. */
  action?: ButtonOptions;
  /** Secondary action (rendered as a ghost button). */
  secondary?: ButtonOptions;
  /** Heading level (default 2; 1 when the empty state is the whole screen). */
  headingLevel?: 1 | 2 | 3;
}

/** A friendly "nothing here yet" block with an optional call to action. */
export function emptyState(opts: EmptyStateOptions): HTMLElement {
  return h(
    'section',
    { class: 'rw-empty' },
    h('div', { class: 'rw-empty__icon' }, icon(opts.icon ?? 'music', { size: '28px' })),
    h(`h${opts.headingLevel ?? 2}` as 'h2', { class: 'rw-empty__title' }, opts.title),
    opts.message ? h('p', { class: 'rw-empty__message' }, opts.message) : null,
    opts.action || opts.secondary
      ? h(
          'div',
          { class: 'rw-empty__actions' },
          opts.action ? button({ variant: 'primary', ...opts.action }) : null,
          opts.secondary ? button({ variant: 'ghost', ...opts.secondary }) : null,
        )
      : null,
  );
}
