/**
 * Backing-audio slot on the song page (T-034). Shows a short intro (and the attached file, if any)
 * and mounts the backing panel (T-027) only when the player opens it: the panel creates the audio
 * engine and its previews drive the engine transport, so it is never mounted on page load, never
 * inside a game session, and not while the transport is already playing something. With nothing
 * attached yet, "Attach backing audio" opens the file picker straight away (one click, R3-U-19):
 * the chosen file is attached through the backing service, then the panel opens on it.
 * @module
 */
import type { Song } from '@shared/song';
import type { AppContext, PanelHandle, PanelPropsMap } from '@shared/ui';
import { mountPanel } from '../../panels';
import { BACKING_ACCEPT } from '../../panels/backing/model';
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

/** Same song and arrangement (a re-render of the page passes a new target object for the same one). */
function sameSong(a: BackingTarget | null, b: BackingTarget): boolean {
  return a !== null && a.songId === b.songId && a.arrangement === b.arrangement;
}

/** Create the slot. */
export function backingSlot(ctx: AppContext): BackingSlot {
  const el = h('section', { class: 'sg-card sg-backing', 'aria-labelledby': 'sg-backing-title' });
  let target: BackingTarget | null = null;
  let panel: PanelHandle<PanelPropsMap['backing']> | null = null;
  let opening = false;
  let destroyed = false;
  // The slot's own picker: opened synchronously from the click (a picker needs the user gesture).
  const fileInput = h('input', { type: 'file', accept: BACKING_ACCEPT, class: 'sg-backing__picker', hidden: true, tabindex: '-1' });
  let pickFor: HTMLButtonElement | null = null;
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    const trigger = pickFor;
    pickFor = null;
    if (file && trigger) void attachAndOpen(file, trigger);
  });

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
      onClick: () => (t.attached ? void openPanel(open) : pick(open)),
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
      fileInput,
    ]);
  }

  /** Open the picker for a first attachment (checks first that nothing else is playing). */
  function pick(trigger: HTMLButtonElement): void {
    if (!target?.song || opening || panel) return;
    if (transportBusy(ctx)) {
      ctx.ui.toast('Something is already playing. Stop it first: backing previews use the same transport.', { kind: 'warning' });
      return;
    }
    pickFor = trigger;
    fileInput.click();
  }

  /** Attach the picked file, then open the panel on it (its alignment tools come next). */
  async function attachAndOpen(file: File, trigger: HTMLButtonElement): Promise<void> {
    const t = target;
    if (!t) return;
    setBusy(trigger, true);
    try {
      const service = await ctx.services.get('backing');
      const link = await service.attach(file, t.songId, t.arrangement);
      if (destroyed || !sameSong(target, t)) return;
      ctx.ui.toast(`Attached “${link.fileName}”. Align it to the beat grid below.`, { kind: 'success' });
      target = { ...(target ?? t), attached: link.fileName };
    } catch (err) {
      ctx.ui.toast(err instanceof Error ? err.message : `Something went wrong: ${String(err)}`, { kind: 'error' });
      setBusy(trigger, false);
      return;
    }
    await openPanel(trigger);
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
      if (destroyed || !sameSong(target, t)) {
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
      const same = sameSong(prev, next);
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
