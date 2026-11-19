/**
 * Link-out row: "Search on Songsterr / Ultimate Guitar", "Get the free Guitar Pro pack". Each opens the
 * site in a new browser tab with `noopener` (D1); the app itself never requests these sites. Without
 * a query the row teaches instead ("type a song to also search …").
 * @module
 */
import type { LinkOut } from '@shared/sources';
import { h } from '../../components';

/** `window.features` for link-outs: no opener (the site can't script this tab) and no referrer. */
export const LINK_OUT_FEATURES = 'noopener,noreferrer';

/** Open a link-out URL in a new tab without giving the site a handle on this window. */
export function openLinkOut(url: string, win: Window = window): void {
  win.open(url, '_blank', LINK_OUT_FEATURES);
}

/** A mounted link-out section. */
export interface LinkOutSection {
  el: HTMLElement;
  /**
   * Show the link-outs for `query` (`[]` with a blank query shows the teaching hint). `localTitle`
   * resolves a matched id to a display title.
   */
  render(linkOuts: readonly LinkOut[], query: string, localTitle: (id: string) => string | undefined): void;
}

/** Create the link-out section. */
export function linkOutSection(win: Window = window): LinkOutSection {
  const headingId = 'lib-linkouts-heading';
  const list = h('ul', { class: 'lib-linkouts__list' });
  const hint = h('p', { class: 'lib-linkouts__hint rw-muted' });
  const el = h(
    'section',
    { class: 'lib-linkouts', 'aria-labelledby': headingId },
    h('h2', { class: 'lib-linkouts__title', id: headingId }, 'Find more tabs'),
    hint,
    list,
  );
  return {
    el,
    render(linkOuts, query, localTitle) {
      const q = query.trim();
      hint.textContent = q
        ? 'Not in your library? These open in a new tab. Get the file or copy the tab there, then bring it in here.'
        : 'Type a song name above to also search Songsterr and Ultimate Guitar in a new tab.';
      list.hidden = linkOuts.length === 0;
      list.replaceChildren(
        ...linkOuts.map((out) => {
          const matches = (out.localMatchIds ?? []).map(localTitle).filter((t): t is string => Boolean(t));
          return h(
            'li',
            { class: 'lib-linkout', dataset: { source: out.source } },
            h(
              'button',
              {
                type: 'button',
                class: 'rw-btn rw-btn--secondary rw-btn--md lib-linkout__btn',
                'aria-label': `${out.label} (opens a new tab)`,
                on: { click: () => openLinkOut(out.url, win) },
              },
              h('span', { class: 'rw-btn__label' }, out.label),
              h('span', { class: 'lib-linkout__ext', 'aria-hidden': 'true' }, '↗'),
            ),
            out.hint ? h('p', { class: 'lib-linkout__hint' }, out.hint) : null,
            matches.length
              ? h(
                  'p',
                  { class: 'lib-linkout__match' },
                  'Already in your library: ',
                  h('strong', null, matches.join(', ')),
                )
              : null,
          );
        }),
      );
    },
  };
}
