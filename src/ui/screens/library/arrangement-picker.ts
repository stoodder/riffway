/**
 * Arrangement picker: a song with several playable guitar tracks asks which one to open (DEC-14:
 * an arrangement is `(songId, trackIndex)`); a single-arrangement song opens directly.
 * @module
 */
import type { SongMeta } from '@shared/api';
import type { SearchResult } from '@shared/sources';
import { describeTuning } from '@core/model';
import { badge, difficultyPill, h, openModal, rovingFocus } from '../../components';

/** Display line for one track: tuning, capo and note count. */
export function trackDetails(track: SongMeta['arrangements'][number]): string {
  const parts = [describeTuning(track.tuning).label];
  if (track.capo > 0) parts.push(`capo ${track.capo}`);
  if (track.noteCount !== undefined) parts.push(`${track.noteCount.toLocaleString('en-US')} notes`);
  return parts.join(' · ');
}

/**
 * Resolve the arrangement to open for `result`: the default one when it is the only playable track,
 * else the user's choice from a modal (null when dismissed). `loadMeta` fetches `GET /api/songs/:id`.
 */
export async function pickArrangement(
  result: Pick<SearchResult, 'id' | 'title' | 'arrangements' | 'defaultArrangement'>,
  loadMeta: (id: string) => Promise<SongMeta>,
  host?: HTMLElement,
): Promise<number | null> {
  if (result.arrangements <= 1) return result.defaultArrangement;
  const meta = await loadMeta(result.id);
  const playable = meta.arrangements.filter((t) => t.playable);
  if (playable.length <= 1) return playable[0]?.index ?? result.defaultArrangement;

  const options = playable.map((track) => {
    const report = meta.difficulty[track.index];
    return h(
      'button',
      { type: 'button', class: 'lib-arr', dataset: { index: String(track.index) } },
      h(
        'span',
        { class: 'lib-arr__text' },
        h('span', { class: 'lib-arr__name' }, track.name || `Track ${track.index + 1}`),
        h('span', { class: 'lib-arr__details' }, trackDetails(track)),
      ),
      track.index === meta.entry.defaultArrangement ? badge('Default', { tone: 'accent' }) : null,
      report ? difficultyPill({ rating: report.rating, tier: report.tier, size: 'sm' }) : badge('Unrated'),
    );
  });
  const list = h('div', { class: 'lib-arrs', role: 'group', 'aria-label': 'Arrangements' }, ...options);
  const modal = openModal({
    title: `Which part of “${result.title}”?`,
    content: [h('p', { class: 'rw-muted' }, 'This file has more than one guitar part. Pick the one to play.'), list],
    actions: [{ label: 'Cancel', value: 'cancel', variant: 'ghost' }],
    host,
  });
  options.forEach((btn) => btn.addEventListener('click', () => modal.close(btn.dataset.index ?? null)));
  const roving = rovingFocus(list, { items: () => options, orientation: 'vertical', wrap: true });
  const preferred = options.findIndex((btn) => Number(btn.dataset.index) === meta.entry.defaultArrangement);
  roving.focusItem(Math.max(0, preferred));
  const value = await modal.result;
  roving.destroy();
  return value === null || value === 'cancel' ? null : Number(value);
}
