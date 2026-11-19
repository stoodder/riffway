/**
 * Backing-audio slot on the song page (T-034). Shows a short intro (and the attached file, if any)
 * and mounts the backing panel (T-027) only when the player opens it: the panel creates the audio
 * engine and its previews drive the engine transport, so it is never mounted on page load, never
 * inside a game session, and not while the transport is already playing something.
 * @module
 */
import type { Song } from '@shared/song';
import type { AppContext, PanelHandle, PanelPropsMap } from '@shared/ui';
import { mountPanel } from '../../panels';
import { append, button, h, icon, setBusy } from '../../components';

/** What the slot needs to mount the panel. */
export interface BackingTarget {
  songId: string;
  arrangement: number;
  /** The loaded song, or null while loading / after a load error. */
  song: Song | null;
  songState: 'loading' | 'ready' | 'error';
  /** Attached file name, if a link exists. */
  attached: string | null;
}

/** The slot element plus lifecycle. */
export interface BackingSlot {
  readonly el: HTMLElement;
  /** Update the target. A different song/arrangement unmounts an open panel. */
  set(target: BackingTarget): void;
  destroy(): void;
}

/** True while the engine transport is running (a game session or another preview is driving it). */
export function transportBusy(ctx: AppContext): boolean {
  const state = ctx.services.peek('engine')?.transport.state;
  return state === 'playing' || state === 'count-in';
}

/** Create the slot. */
export function backingSlot(ctx: AppContext): BackingSlot {
  const el = h('section', { class: 'sg-card sg-backing', 'aria-labelledby': 'sg-backing-title' });
  let target: BackingTarget | null = null;
  let panel: PanelHandle<PanelPropsMap['backing']> | null = null;
  let opening = false;
  let destroyed = false;

  function closePanel(): void {
    panel?.unmount();
    panel = null;
  }

  function renderIntro(): void {
    if (!target) return;
    const t = target;
    const open = button({
      label: t.attached ? 'Open backing audio' : 'Attach backing audio',
      icon: t.attached ? 'headphones' : 'plus',
      disabled: t.songState !== 'ready',
      onClick: () => void openPanel(open),
    });
    el.className = 'sg-card sg-backing';
    el.replaceChildren();
    append(el, [
      h('header', { class: 'sg-card__head' }, h('h2', { class: 'sg-card__title', id: 'sg-backing-title' }, 'Backing audio')),
      h(
        'p',
        { class: 'sg-card__sub' },
        'Play along with a recording you own. Riffway lines it up with the tab and slows it down without changing the pitch.',
      ),
      t.attached ? h('p', { class: 'sg-backing__file' }, icon('music', { size: '16px' }), h('span', null, t.attached)) : null,
      h(
        'div',
        { class: 'sg-backing__actions' },
        open,
        t.songState === 'loading' ? h('span', { class: 'rw-muted' }, 'Loading the song…') : null,
        t.songState === 'error' ? h('span', { class: 'rw-muted' }, 'The song couldn’t be loaded, so backing audio can’t be aligned.') : null,
      ),
    ]);
  }

  async function openPanel(trigger: HTMLButtonElement): Promise<void> {
    const t = target;
    if (!t?.song || opening || panel) return;
    if (transportBusy(ctx)) {
      ctx.ui.toast('Something is already playing. Stop it first: backing previews use the same transport.', { kind: 'warning' });
      return;
    }
    opening = true;
    setBusy(trigger, true);
    const host = h('div', { class: 'sg-backing__panel' });
    try {
      const handle = await mountPanel('backing', host, ctx, { songId: t.songId, arrangement: t.arrangement, song: t.song });
      if (destroyed || target !== t) {
        handle.unmount();
        return;
      }
      panel = handle;
      el.className = 'sg-backing is-open';
      el.replaceChildren(host);
    } catch (err) {
      ctx.ui.toast(`Couldn’t open backing audio: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
      setBusy(trigger, false);
    } finally {
      opening = false;
    }
  }

  return {
    el,
    set(next) {
      const prev = target;
      const same = prev !== null && prev.songId === next.songId && prev.arrangement === next.arrangement;
      target = next;
      if (!same) closePanel();
      if (panel) {
        if (next.song && next.song !== prev?.song) panel.update?.({ song: next.song });
        return;
      }
      if (!opening) renderIntro();
    },
    destroy() {
      destroyed = true;
      closePanel();
      el.remove();
    },
  };
}
