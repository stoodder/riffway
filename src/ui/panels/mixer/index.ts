/**
 * Mixer panel (T-032): a fader and a mute button per bus — guitar monitor, backing track, guide
 * synth, metronome and master (docs/monitoring.md § mixer buses).
 * Exports `mount: PanelMount<PanelPropsMap['mixer']>` (contract in `@shared/ui`); registered in
 * `src/ui/panels/index.ts`.
 *
 * - Levels persist in `settings.mixer` (the engine follows settings); while a fader is dragged the
 *   level is also applied straight to the engine bus (`engine.setLevel`) for instant feedback.
 * - Mute is the per-bus `settings.mixerMute` flag: the engine plays a muted bus at 0 and the fader
 *   keeps its level, so unmuting restores it. The guide's mute is the `game.guide` assist toggle
 *   and, with a session, `session.setGuideMuted`.
 * - Usable mid-song: `G` toggles the guide (see `../practice/shortcuts.ts`); mouse use never keeps
 *   keyboard focus away from the game.
 * @module
 */
import type { Unsubscribe } from '@shared/clock';
import type { GameSession, MixerBus } from '@shared/services';
import type { DeepPartial, Settings } from '@shared/settings';
import type { AppContext, PanelHandle, PanelMount, PanelPropsMap } from '@shared/ui';
import { h, slider, type Slider } from '../../components';
import { MIXER_SHORTCUTS, bindShortcuts, releasePointerFocus } from '../practice/shortcuts';
import { FADER_MAX, MIXER_CHANNELS, faderToLevel, formatLevelDb, levelToFader } from './model';
import './mixer.css';

type Props = PanelPropsMap['mixer'];

/** Quiet time while dragging before a level is written to settings (IndexedDB). */
export const PERSIST_DELAY_MS = 200;

/** Mount the mixer panel (optionally bound to a running session). */
export const mount: PanelMount<Props> = (el, ctx, props): PanelHandle<Props> => {
  const panel = new MixerPanel(el, ctx, props.session ?? null);
  return {
    update(next) {
      if ('session' in next) panel.setSession(next.session ?? null);
    },
    unmount() {
      panel.destroy();
    },
  };
};

interface Row {
  bus: MixerBus;
  label: string;
  el: HTMLElement;
  fader: Slider;
  mute: HTMLButtonElement;
  hint: HTMLElement;
}

class MixerPanel {
  private readonly root: HTMLElement;
  private readonly rows: Row[];
  private readonly cleanups: Unsubscribe[] = [];
  private settings: Settings;
  /** Bus being dragged (its fader is not overwritten by settings echoes). */
  private dragging: MixerBus | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: Partial<Record<MixerBus, number>> = {};
  /** Mute flags not yet echoed by the settings store. */
  private pendingMute: Partial<Record<MixerBus, boolean>> = {};

  constructor(
    host: HTMLElement,
    private readonly ctx: AppContext,
    private session: GameSession | null,
  ) {
    this.settings = ctx.settings.get();
    this.rows = MIXER_CHANNELS.map((c) => this.buildRow(c.bus, c.label));
    this.root = h(
      'section',
      { class: 'rw-mixer', 'aria-label': 'Mixer' },
      h('header', { class: 'rw-mixer__header' }, h('h2', { class: 'rw-mixer__title' }, 'Mixer'), h('span', { class: 'rw-mixer__key' }, h('kbd', null, 'G'), ' guide on/off')),
      h('div', { class: 'rw-mixer__rows' }, this.rows.map((r) => r.el)),
    );
    host.append(this.root);
    this.refresh();
    this.cleanups.push(
      ctx.settings.subscribe((s) => {
        this.settings = s;
        // Drop local overrides the store has caught up with.
        for (const [bus, level] of Object.entries(this.pending) as [MixerBus, number][]) {
          if (Math.abs(s.mixer[bus] - level) < 1e-9) delete this.pending[bus];
        }
        for (const [bus, muted] of Object.entries(this.pendingMute) as [MixerBus, boolean][]) {
          if (s.mixerMute[bus] === muted) delete this.pendingMute[bus];
        }
        this.refresh();
      }),
      bindShortcuts(MIXER_SHORTCUTS, { toggleGuide: () => this.toggleMute('guide') }, { laneCodes: () => this.settings.keyboard.lanes }),
      releasePointerFocus(this.root),
    );
  }

  setSession(session: GameSession | null): void {
    this.session = session;
    this.refresh();
  }

  private buildRow(bus: MixerBus, label: string): Row {
    const fader = slider({
      label,
      min: 0,
      max: FADER_MAX,
      step: 1,
      value: levelToFader(this.settings.mixer[bus]),
      format: (p) => formatLevelDb(faderToLevel(p)),
      onInput: (p) => this.onFader(bus, p, false),
      onChange: (p) => this.onFader(bus, p, true),
    });
    const mute = h('button', { type: 'button', class: 'rw-mixer__mute', 'aria-pressed': 'false', 'aria-label': `Mute ${label}`, title: `Mute ${label}` }, 'M');
    mute.addEventListener('click', () => this.toggleMute(bus));
    const hint = h('p', { class: 'rw-field__hint rw-mixer__hint', hidden: true });
    const el = h('div', { class: 'rw-mixer__row', dataset: { bus } }, h('div', { class: 'rw-mixer__fader' }, fader.el, hint), mute);
    return { bus, label, el, fader, mute, hint };
  }

  /** Re-read settings/services into every row. */
  private refresh(): void {
    for (const r of this.rows) {
      const level = this.pending[r.bus] ?? this.settings.mixer[r.bus];
      if (this.dragging !== r.bus) r.fader.set(levelToFader(level));
      const muted = this.isMuted(r.bus);
      r.mute.setAttribute('aria-pressed', String(muted));
      r.el.classList.toggle('rw-mixer__row--muted', muted);
      const hint = this.hintFor(r.bus, muted);
      r.hint.textContent = hint ?? '';
      r.hint.hidden = hint === null;
    }
  }

  private isMuted(bus: MixerBus): boolean {
    if (bus === 'guide') return !this.settings.game.guide;
    return this.pendingMute[bus] ?? this.settings.mixerMute[bus];
  }

  private hintFor(bus: MixerBus, muted: boolean): string | null {
    switch (bus) {
      case 'guide': {
        if (muted) return 'Guide off (assist). Press G to bring it back.';
        const link = this.ctx.services.peek('backing')?.link;
        return this.settings.game.muteGuideWithBacking && link?.enabled ? 'Auto-muted while the backing track plays.' : null;
      }
      case 'backing': {
        const backing = this.ctx.services.peek('backing');
        return this.session && backing && !backing.link ? 'No backing track attached to this song.' : null;
      }
      case 'monitor': {
        const monitor = this.ctx.services.peek('monitor');
        return monitor && !monitor.enabled ? 'Monitoring is off (Audio setup → Monitoring).' : null;
      }
      default:
        return null;
    }
  }

  private onFader(bus: MixerBus, pos: number, commit: boolean): void {
    const level = faderToLevel(pos);
    this.dragging = commit ? null : bus;
    // A muted bus stays silent while its level is set (the engine applies it on unmute).
    if (!this.isMuted(bus) || bus === 'guide') this.ctx.services.peek('engine')?.setLevel(bus, level);
    this.pending[bus] = level;
    this.schedulePersist(commit ? 0 : PERSIST_DELAY_MS);
    this.refreshRow(bus);
  }

  private toggleMute(bus: MixerBus): void {
    if (bus === 'guide') {
      const on = !this.settings.game.guide;
      this.session?.setGuideMuted(!on);
      this.settings = { ...this.settings, game: { ...this.settings.game, guide: on } };
      this.refresh();
      this.persist({ game: { guide: on } });
      return;
    }
    const muted = !this.isMuted(bus);
    this.ctx.services.peek('engine')?.setLevel(bus, muted ? 0 : (this.pending[bus] ?? this.settings.mixer[bus]));
    this.pendingMute[bus] = muted;
    this.refresh();
    this.persist({ mixerMute: { [bus]: muted } });
  }

  private refreshRow(bus: MixerBus): void {
    const r = this.rows.find((x) => x.bus === bus);
    if (!r) return;
    const muted = this.isMuted(bus);
    r.mute.setAttribute('aria-pressed', String(muted));
    r.el.classList.toggle('rw-mixer__row--muted', muted);
  }

  private schedulePersist(delayMs: number): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    const flush = (): void => {
      this.persistTimer = null;
      // `pending` stays as the displayed value until the settings echo matches it.
      const mixer = { ...this.pending };
      if (Object.keys(mixer).length > 0) this.persist({ mixer });
    };
    if (delayMs > 0) this.persistTimer = setTimeout(flush, delayMs);
    else flush();
  }

  private persist(patch: DeepPartial<Settings>): void {
    this.ctx.settings.update(patch).catch((err: unknown) => {
      // Show what is actually stored again.
      this.pending = {};
      this.pendingMute = {};
      this.settings = this.ctx.settings.get();
      this.refresh();
      this.ctx.ui.toast(`Couldn't save the mixer: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
    });
  }

  destroy(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.schedulePersist(0);
    }
    for (const c of this.cleanups.splice(0)) c();
    this.root.remove();
  }
}
