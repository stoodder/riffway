/**
 * "On Songsterr" group inside "Find more tabs": opt-in remote search results
 * (`GET /api/search/remote`, docs/guides/songsterr-search.md). Metadata only. A hit that matches a
 * song already in the library offers **Play**; any other hit opens the song page in a new tab
 * (`noopener`, like the link-outs); getting the file stays a manual download. Hidden while remote
 * search is off; shows the server's note when it is on but not set up, refused or failing.
 * @module
 */
import type { RemoteSearchResponse } from '@shared/api';
import type { RemoteSearchHit } from '@shared/sources';
import { h, uid } from '../../components';
import { openLinkOut } from './link-outs';

/** A mounted remote-results group. */
export interface RemoteResults {
  el: HTMLElement;
  /** Show the group with a "Searching Songsterr…" note. */
  loading(): void;
  /** Show a response (`null` or `off` without a message hides the group). `onPlay` opens a library song by id. */
  render(res: RemoteSearchResponse | null, onPlay: (id: string, hit: RemoteSearchHit) => void): void;
}

/** Note shown under the heading for a non-`ok` response. */
export function remoteNote(res: RemoteSearchResponse): string {
  switch (res.status) {
    case 'refused':
      return 'Songsterr declined the search, so it’s off until Riffway restarts. “Search on Songsterr” still works.';
    case 'off':
      return res.message ?? '';
    case 'error':
      return res.message ?? 'Couldn’t reach Songsterr. “Search on Songsterr” still works.';
    default:
      return res.hits.length ? 'These open on Songsterr in a new tab. Download the Guitar Pro file there, then drop it here.' : 'No matches on Songsterr.';
  }
}

/** Create the "On Songsterr" group. */
export function remoteResults(win: Window = window): RemoteResults {
  const headingId = uid('lib-remote-heading');
  const list = h('ul', { class: 'lib-remote__list' });
  const note = h('p', { class: 'lib-remote__note', 'aria-live': 'polite' });
  const el = h(
    'section',
    { class: 'lib-remote', 'aria-labelledby': headingId, hidden: true },
    h('h3', { class: 'lib-remote__title', id: headingId }, 'On Songsterr'),
    note,
    list,
  );
  return {
    el,
    loading() {
      el.hidden = false;
      el.setAttribute('aria-busy', 'true');
      note.textContent = 'Searching Songsterr…';
      list.replaceChildren();
      list.hidden = true;
    },
    render(res, onPlay) {
      el.removeAttribute('aria-busy');
      if (!res || (res.status === 'off' && !res.message)) {
        el.hidden = true;
        note.textContent = '';
        list.replaceChildren();
        return;
      }
      el.hidden = false;
      el.dataset.status = res.status;
      note.textContent = remoteNote(res);
      const hits = res.status === 'ok' ? res.hits : [];
      list.hidden = hits.length === 0;
      list.replaceChildren(
        ...hits.map((hit) => {
          const local = hit.localMatchIds?.[0];
          return h(
            'li',
            { class: 'lib-remote__row', dataset: { remoteId: hit.remoteId } },
            h(
              'div',
              { class: 'lib-remote__meta' },
              h('span', { class: 'lib-remote__name' }, hit.title),
              hit.artist ? h('span', { class: 'lib-remote__artist' }, hit.artist) : null,
              hit.tuningLabel ? h('span', { class: 'lib-remote__tuning' }, hit.tuningLabel) : null,
            ),
            local
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'rw-btn rw-btn--primary rw-btn--sm lib-remote__btn',
                    'aria-label': `Play ${hit.title} (in your library)`,
                    on: { click: () => onPlay(local, hit) },
                  },
                  h('span', { class: 'rw-btn__label' }, 'Play (in your library)'),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    class: 'rw-btn rw-btn--secondary rw-btn--sm lib-remote__btn',
                    'aria-label': `Open ${hit.title} on Songsterr (opens a new tab)`,
                    on: { click: () => openLinkOut(hit.url, win) },
                  },
                  h('span', { class: 'rw-btn__label' }, 'Open on Songsterr'),
                  h('span', { class: 'lib-linkout__ext', 'aria-hidden': 'true' }, '↗'),
                ),
          );
        }),
      );
    },
  };
}
