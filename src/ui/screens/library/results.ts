/**
 * The result list: one row per song with title/artist, difficulty pill, source badge, tuning, style
 * tags, the rhythm source when it is worth a mention (see {@link RHYTHM_NOTE}) and a playable-state chip. Rows are a roving-focus group (↑/↓, Home/End; Enter
 * opens; Esc returns to the search box) so the list is one Tab stop.
 * @module
 */
import type { SearchResult } from '@shared/sources';
import { badge, difficultyPill, h, rovingFocus, uid, type RovingFocus } from '../../components';
import { RHYTHM_NOTE, SOURCE_LABEL, availabilityChip, byLine, formatDuration } from './labels';

/** Options for {@link resultList}. */
export interface ResultListOptions {
  /** A row's primary action (click / Enter). */
  onOpen: (result: SearchResult) => void;
  /** Esc inside the list. */
  onEscape: () => void;
}

/** A mounted result list. */
export interface ResultList {
  el: HTMLUListElement;
  /** Replace the rows. `isNew(result)` marks freshly imported songs. */
  render(results: readonly SearchResult[], isNew: (result: SearchResult) => boolean): void;
  /** Focus the first row (false when empty). */
  focusFirst(): boolean;
  destroy(): void;
}

/** Display genres per row (style tags are always shown). */
const MAX_GENRES = 2;

function difficulty(r: SearchResult): HTMLElement {
  if (r.tier === null) return badge('Unrated', { title: 'Difficulty is computed when the song can be analysed' });
  const pill = difficultyPill({ tier: r.tier, rating: r.rating ?? undefined, size: 'sm' });
  if (!r.ratingProvisional) return pill;
  // The pill already fills the column: the estimate marker sits inside it (dashed outline + "≈").
  pill.classList.add('lib-row__provisional');
  pill.title = 'Estimate: the rating is provisional until the rhythm is aligned';
  pill.querySelector('.rw-diff__num')?.before(h('span', { class: 'lib-row__est', 'aria-hidden': 'true' }, '≈'));
  pill.setAttribute('aria-label', `${pill.getAttribute('aria-label') ?? 'Difficulty'} (estimate)`);
  return pill;
}

function row(r: SearchResult, isNew: boolean, onOpen: (r: SearchResult) => void): HTMLLIElement {
  const avail = availabilityChip(r);
  const byId = uid('lib-by');
  const metaId = uid('lib-meta');
  const stateId = uid('lib-state');
  const open = h(
    'button',
    {
      type: 'button',
      class: 'lib-row__open',
      'aria-describedby': `${byId} ${metaId} ${stateId}`,
      on: { click: () => onOpen(r) },
    },
    r.title,
  );
  const tags = [...r.tags.style, ...r.tags.genre.slice(0, MAX_GENRES)];
  const meta = h(
    'div',
    { class: 'lib-row__meta', id: metaId },
    badge(SOURCE_LABEL[r.source], { tone: 'neutral', title: `Source: ${SOURCE_LABEL[r.source]}` }),
    h('span', { class: 'lib-row__tuning', title: 'Tuning' }, r.tuningLabel),
    RHYTHM_NOTE[r.rhythm] ? h('span', { class: 'lib-row__rhythm' }, RHYTHM_NOTE[r.rhythm]) : null,
    tags.length ? h('span', { class: 'lib-row__tags' }, ...tags.map((t) => h('span', { class: 'lib-tag' }, t))) : null,
  );
  const duration = formatDuration(r.durationSec);
  return h(
    'li',
    { class: 'lib-row', dataset: { id: r.id, availability: r.availability } },
    h(
      'div',
      { class: 'lib-row__title' },
      h('div', { class: 'lib-row__name' }, open, isNew ? badge('New', { tone: 'accent' }) : null),
      h('span', { class: 'lib-row__by', id: byId }, byLine(r)),
    ),
    h('div', { class: 'lib-row__diff' }, difficulty(r)),
    meta,
    h(
      'div',
      { class: 'lib-row__state', id: stateId },
      badge(avail.label, { tone: avail.tone, icon: avail.icon, title: avail.help }),
      duration ? h('span', { class: 'lib-row__dur rw-num', 'aria-label': `Length ${duration}` }, duration) : null,
    ),
  );
}

/** Create the result list. */
export function resultList(opts: ResultListOptions): ResultList {
  const el = h('ul', { class: 'lib-results', 'aria-label': 'Songs' });
  const buttons = (): HTMLElement[] => Array.from(el.querySelectorAll<HTMLElement>('.lib-row__open'));
  const roving: RovingFocus = rovingFocus(el, { items: buttons, orientation: 'vertical', wrap: false, onEscape: opts.onEscape });
  return {
    el,
    render(results, isNew) {
      const focusedId = el.contains(document.activeElement) ? (document.activeElement?.closest<HTMLElement>('.lib-row')?.dataset.id ?? null) : null;
      el.replaceChildren(...results.map((r) => row(r, isNew(r), opts.onOpen)));
      // Keep keyboard focus on the same song across live refreshes (or the first row if it vanished).
      const index = focusedId ? results.findIndex((r) => r.id === focusedId) : -1;
      roving.focusItem(Math.max(0, index), { focus: focusedId !== null });
      if (focusedId !== null && !results.length) opts.onEscape();
    },
    focusFirst() {
      if (!buttons().length) return false;
      roving.focusItem(0);
      return true;
    },
    destroy: () => roving.destroy(),
  };
}
