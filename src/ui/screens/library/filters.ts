/**
 * Filter bar: source chips, difficulty tier range, tuning, technique (pick / fingerstyle), "playable
 * now" vs "needs import or rhythm", extra tag chips and "Clear filters". Every control is keyboard
 * operable: chips are toggle buttons, segmented groups are radio groups (←/→), ranges are native selects.
 * @module
 */
import type { SourceId, Tier } from '@shared/song';
import { button, h, icon, rovingFocus, select, uid, type Select } from '../../components';
import { tierBandName } from '../../design/tokens';
import { DEFAULT_QUERY, hasFilters, TIER_MAX, TIER_MIN, type LibraryQuery, type PlayableFilter, type Technique } from './query';

/** A source the user can filter by. */
export interface SourceFacet {
  id: SourceId;
  label: string;
  /** Indexed songs (shown on the chip). */
  count: number;
}

/** A tuning option. */
export interface TuningFacet {
  id: string;
  label: string;
}

/** Options for {@link filterBar}. */
export interface FilterBarOptions {
  /** A control changed; apply the patch and search. */
  onChange: (patch: Partial<LibraryQuery>) => void;
}

/** A mounted filter bar. */
export interface FilterBar {
  el: HTMLElement;
  /** Reflect the query in the controls (no callbacks). */
  set(query: LibraryQuery): void;
  setSources(sources: readonly SourceFacet[]): void;
  setTunings(tunings: readonly TuningFacet[]): void;
  destroy(): void;
}

/** One radio of a segmented group. */
interface Segment<V extends string> {
  value: V;
  label: string;
}

/** A segmented single-choice control (`role="radiogroup"`, arrows move and select). */
function segmented<V extends string>(label: string, segments: readonly Segment<V>[], onSelect: (value: V) => void) {
  const labelId = uid('seg');
  const radios = segments.map((s) =>
    h('button', { type: 'button', role: 'radio', class: 'lib-seg__item', dataset: { value: s.value }, on: { click: () => choose(s.value) } }, s.label),
  );
  const group = h('div', { class: 'lib-seg', role: 'radiogroup', 'aria-labelledby': labelId }, ...radios);
  const el = h('div', { class: 'lib-filter' }, h('span', { class: 'lib-filter__label', id: labelId }, label), group);
  const roving = rovingFocus(group, { items: () => radios, orientation: 'horizontal', onMove: (item) => item.click() });
  let current: V | null = null;
  function set(value: V): void {
    current = value;
    radios.forEach((r, i) => {
      const on = r.dataset.value === value;
      r.setAttribute('aria-checked', String(on));
      if (on) roving.focusItem(i, { focus: false });
    });
  }
  function choose(value: V): void {
    if (value === current) return;
    set(value);
    onSelect(value);
  }
  return { el, set, destroy: () => roving.destroy() };
}

const tierOption = (t: number): { value: string; label: string } => ({ value: String(t), label: `${t} · ${tierBandName(t as Tier)}` });
const TIER_OPTIONS = Array.from({ length: TIER_MAX - TIER_MIN + 1 }, (_, i) => tierOption(TIER_MIN + i));

/** Create the filter bar. */
export function filterBar(opts: FilterBarOptions): FilterBar {
  let query: LibraryQuery = { ...DEFAULT_QUERY };
  let tunings: readonly TuningFacet[] = [];

  // Sources: "All" + one toggle chip per source.
  const sourcesLabelId = uid('src');
  const sourceChips = h('div', { class: 'lib-chips', role: 'group', 'aria-labelledby': sourcesLabelId });
  const sourcesEl = h('div', { class: 'lib-filter' }, h('span', { class: 'lib-filter__label', id: sourcesLabelId }, 'Source'), sourceChips);
  let sourceFacets: readonly SourceFacet[] = [];
  const renderSourceChips = (): void => {
    const chip = (label: string, pressed: boolean, onClick: () => void, count?: number): HTMLButtonElement =>
      h(
        'button',
        { type: 'button', class: 'lib-chip', 'aria-pressed': String(pressed), on: { click: onClick } },
        label,
        count !== undefined ? h('span', { class: 'lib-chip__count rw-num', 'aria-label': `(${count})` }, String(count)) : null,
      );
    // Chips are rebuilt on every change: keep keyboard focus on the same chip.
    const focused = Array.from(sourceChips.children).indexOf(document.activeElement as Element);
    sourceChips.replaceChildren(
      chip('All', query.sources.length === 0, () => opts.onChange({ sources: [] })),
      ...sourceFacets.map((s) => {
        const on = query.sources.includes(s.id);
        return chip(s.label, on, () => opts.onChange({ sources: on ? query.sources.filter((x) => x !== s.id) : [...query.sources, s.id] }), s.count);
      }),
    );
    if (focused >= 0) (sourceChips.children[focused] as HTMLElement | undefined)?.focus();
  };

  // Difficulty range.
  const tierFrom: Select = select({
    label: 'Difficulty from',
    options: TIER_OPTIONS,
    onChange: (v) => {
      const min = Number(v);
      opts.onChange({ tierMin: min, tierMax: Math.max(min, query.tierMax) });
    },
  });
  const tierTo: Select = select({
    label: 'to',
    options: TIER_OPTIONS,
    onChange: (v) => {
      const max = Number(v);
      opts.onChange({ tierMax: max, tierMin: Math.min(max, query.tierMin) });
    },
  });
  const tierEl = h('div', { class: 'lib-filter lib-filter--range' }, tierFrom.el, tierTo.el);

  // Tuning.
  const tuning: Select = select({ label: 'Tuning', options: [{ value: '', label: 'Any tuning' }], onChange: (v) => opts.onChange({ tuning: v }) });
  const renderTunings = (): void => {
    const known = [...tunings];
    if (query.tuning && !known.some((t) => t.id === query.tuning)) known.push({ id: query.tuning, label: query.tuning });
    tuning.setOptions([{ value: '', label: 'Any tuning' }, ...known.map((t) => ({ value: t.id, label: t.label }))]);
    tuning.set(query.tuning);
  };

  const technique = segmented<Technique | 'any'>(
    'Technique',
    [
      { value: 'any', label: 'Any' },
      { value: 'pick', label: 'Pick' },
      { value: 'fingerstyle', label: 'Fingerstyle' },
    ],
    (v) => opts.onChange({ technique: v === 'any' ? '' : v }),
  );
  const playable = segmented<PlayableFilter>(
    'Show',
    [
      { value: 'all', label: 'All' },
      { value: 'playable', label: 'Playable now' },
      { value: 'needs-work', label: 'Needs import or rhythm' },
    ],
    (v) => opts.onChange({ playable: v }),
  );

  // Extra tags (from links such as "songs with bends") and "Clear filters".
  const tagChips = h('div', { class: 'lib-chips lib-chips--tags', 'aria-label': 'Tag filters', role: 'group' });
  const clear = button({ label: 'Clear filters', variant: 'ghost', size: 'sm', icon: 'close', onClick: () => opts.onChange({ ...DEFAULT_QUERY, q: query.q }) });
  const footer = h('div', { class: 'lib-filters__footer' }, tagChips, clear);

  const el = h(
    'section',
    { class: 'lib-filters', 'aria-label': 'Filters' },
    h('div', { class: 'lib-filters__row' }, sourcesEl, playable.el),
    h('div', { class: 'lib-filters__row' }, tierEl, tuning.el, technique.el),
    footer,
  );

  return {
    el,
    set(next) {
      query = next;
      renderSourceChips();
      tierFrom.set(String(next.tierMin));
      tierTo.set(String(next.tierMax));
      renderTunings();
      technique.set(next.technique || 'any');
      playable.set(next.playable);
      tagChips.replaceChildren(
        ...next.tags.map((tag) =>
          h(
            'button',
            {
              type: 'button',
              class: 'lib-chip lib-chip--removable',
              'aria-label': `Remove tag filter ${tag}`,
              on: { click: () => opts.onChange({ tags: query.tags.filter((t) => t !== tag) }) },
            },
            `Tag: ${tag}`,
            icon('close', { size: '14px' }),
          ),
        ),
      );
      footer.hidden = !hasFilters(next);
    },
    setSources(sources) {
      sourceFacets = sources;
      renderSourceChips();
      sourcesEl.hidden = sources.length < 2 && query.sources.length === 0;
    },
    setTunings(next) {
      tunings = next;
      renderTunings();
    },
    destroy() {
      technique.destroy();
      playable.destroy();
    },
  };
}
