/**
 * Play screen (T-031, `#/play/:id?arr&mode&section&speed&input`). Loads a {@link GameSessionImpl}
 * (song, guide, backing, inputs), draws the canvas highway (T-024) under the HUD, binds keyboard mode
 * (D6), mounts the practice + mixer panels (T-032) in a side drawer, and navigates to the results
 * screen when a run ends. Registered in `src/ui/screens/index.ts`.
 *
 * Query params: `arr` (arrangement; default the song's default), `mode` (`play` | `practice`),
 * `section` (loop this section; practice), `speed` (fraction), `input` (`auto` | `keyboard` |
 * `guitar`; `?e2e=1` defaults to `keyboard` so a fake capture device can't add onsets).
 * @module
 */
import type { Judgement, StrayEvent } from '@shared/judge';
import type { Highway, SessionState } from '@shared/services';
import type { AppContext, PanelHandle, ScreenHandle, ScreenMount } from '@shared/ui';
import { computePositions } from '@core/handpos';
import { createHighway } from '../../../game/highway';
import { attachKeyboard } from '../../../game/input';
import {
  clearActiveSession,
  createGameSession,
  type GameSessionImpl,
  resultKey,
  setActiveSession,
  type SessionInputMode,
} from '../../../game/session';
import { button, emptyState, h } from '../../components';
import { mountPanel } from '../../panels';
import { GameHud, highwayJudgement } from './hud';
import { errorCard, loadingCard, pauseMenu, startCard } from './overlays';
import { SectionProgressBar } from './progress-bar';
import './game.css';

/** Seconds of highway (at 100%) considered "on screen" for the chord note. */
const CHORD_LOOKAHEAD_SEC = 4;

function parseInputMode(v: string | undefined): SessionInputMode | undefined {
  return v === 'auto' || v === 'keyboard' || v === 'guitar' ? v : undefined;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** What the game needs from the app context. */
const REQUIRED = ['api', 'router', 'ui', 'services', 'settings', 'storage'] as const;

/** Shown when the app context is incomplete (a shell that failed to start): no throw from mount. */
function unavailableView(el: HTMLElement, missing: readonly string[]): ScreenHandle {
  const root = h(
    'div',
    { class: 'gm gm--unavailable', dataset: { state: 'unavailable' } },
    h('h1', { class: 'gm-unavailable__title' }, 'Play'),
    emptyState({
      title: 'Game unavailable',
      message: `The app didn't finish starting (missing: ${missing.join(', ')}). Reload the page to try again.`,
      icon: 'warning',
    }),
  );
  el.append(root);
  return { unmount: () => root.remove() };
}

export const mount: ScreenMount = (el, ctx, params): ScreenHandle => {
  const missing = REQUIRED.filter((key) => !(ctx as Partial<AppContext>)[key]);
  if (missing.length) return unavailableView(el, missing);
  const songId = params.id ?? '';
  const mode = params.mode === 'practice' ? 'practice' : 'play';
  const root = h('div', { class: 'gm', dataset: { mode, state: 'loading' } });
  const stageCards = h('div', { class: 'gm-cards' });
  el.append(root);

  let disposed = false;
  let session: GameSessionImpl | null = null;
  let highway: Highway | null = null;
  let hud: GameHud | null = null;
  let rafId = 0;
  let quitting = false;
  let drawerOpen = false;
  const panels: PanelHandle<unknown>[] = [];
  const cleanups: (() => void)[] = [];
  const notices: string[] = [];

  const songHref = (): string => ctx.router.href('song', { id: songId });
  const back = (): void => ctx.router.navigate(songHref());

  // ---- Loading ----------------------------------------------------------------------------
  const loading = loadingCard();
  const showCard = (card: HTMLElement | null, focus?: HTMLElement): void => {
    stageCards.replaceChildren(...(card ? [card] : []));
    stageCards.hidden = card === null;
    focus?.focus({ preventScroll: true });
  };

  const load = async (): Promise<void> => {
    root.replaceChildren(h('div', { class: 'gm-stage gm-stage--loading' }, stageCards));
    root.dataset.state = 'loading';
    showCard(loading.el);
    try {
      const arrangement = num(params.arr) ?? (await ctx.api.song(songId)).entry.defaultArrangement;
      const speed = num(params.speed);
      const section = num(params.section);
      const input = parseInputMode(params.input);
      const s = await createGameSession(
        ctx,
        {
          songId,
          arrangement: Math.max(0, arrangement),
          mode,
          ...(speed !== undefined ? { speed } : {}),
          ...(section !== undefined ? { loopSection: section } : {}),
        },
        {
          ...(input ? { input } : {}),
          onProgress: (label, fraction) => loading.set(label, fraction),
          onNotice: (text) => notices.push(text),
        },
      );
      if (disposed) {
        void s.dispose();
        return;
      }
      session = s;
      setActiveSession(s);
      build(s);
    } catch (err) {
      if (disposed) return;
      console.error('Riffway: game failed to load', err);
      root.dataset.state = 'error';
      showCard(errorCard(err instanceof Error ? err.message : String(err), back, () => void load()));
    }
  };

  // ---- Game view --------------------------------------------------------------------------
  const build = (s: GameSessionImpl): void => {
    const settings = ctx.settings.get();
    const pauseBtn = button({ label: 'Pause', icon: 'pause', iconOnly: true, variant: 'ghost', title: 'Pause (Esc)', onClick: () => togglePause() });
    const toolsBtn = button({ label: 'Practice tools', icon: 'settings', variant: 'ghost', size: 'sm', onClick: () => toggleDrawer() });
    toolsBtn.setAttribute('aria-expanded', 'false');
    const actions = h('div', { class: 'gm-actions' }, toolsBtn, pauseBtn);
    const hudView = new GameHud({ title: s.title, artist: s.artist, mode: s.mode }, actions, () => ctx.settings.get().game.feedbackDetail);
    hud = hudView;
    const canvas = h('canvas', { class: 'gm-canvas', role: 'img', 'aria-label': `Note highway for ${s.title}` });
    const stage = h('div', { class: 'gm-stage' }, canvas, hudView.overlays, stageCards);
    const bar = new SectionProgressBar(s.song, s.mode === 'practice' ? (t) => s.seek(t) : null);
    const drawer = h('aside', { class: 'gm-drawer', 'aria-label': 'Practice tools', hidden: true });
    const footer = h(
      'footer',
      { class: 'gm-footer' },
      bar.el,
      h('p', { class: 'gm-footer__hint' }, s.hasGuitar ? 'Guitar + keys 1–6 · Shift = wrong note · Esc = pause' : 'Keys 1–6 play the strings (1 = high e) · Shift = wrong note · Esc = pause'),
    );
    root.replaceChildren(hudView.bar, h('div', { class: 'gm-body' }, h('div', { class: 'gm-main' }, stage, footer), drawer));

    const hw = createHighway(canvas, s.song, s.clock, {
      noteSpeed: settings.game.noteSpeed,
      handCues: settings.game.handCues,
      fretNumbers: settings.game.fretNumbers,
      positions: computePositions(s.song),
      loop: s.loop,
    });
    highway = hw;
    hw.start();
    bar.setLoop(s.loop);
    hudView.setSpeed(s.speed);

    // Chord times for the leniency note.
    const chordTimes = s.song.chords.map((c) => c.time).sort((a, b) => a - b);
    const chordInView = (t: number): boolean => {
      const to = t + CHORD_LOOKAHEAD_SEC * s.speed;
      let lo = 0;
      let hi = chordTimes.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((chordTimes[mid] as number) < t - 0.3) lo = mid + 1;
        else hi = mid;
      }
      return lo < chordTimes.length && (chordTimes[lo] as number) <= to;
    };

    // Count-in display state.
    let ciEnd = 0;
    let ciBeat = 0.5;
    const startCountIn = (): void => {
      const start = s.clock.anchor.anchorSongTime;
      const bars = s.song.timing.bars;
      const bar0 = bars.find((b) => b.time + b.dur > Math.max(0, start)) ?? bars[0];
      const beats = bar0 ? Math.max(1, bar0.beats.length || bar0.num) : 4;
      ciBeat = bar0 && beats > 0 ? bar0.dur / beats : 0.5;
      ciEnd = start + s.countInBars * beats * ciBeat;
    };

    // ---- Live updates ----
    const onJudgement = (j: Judgement): void => {
      const detail = ctx.settings.get().game.feedbackDetail;
      hw.feedback(highwayJudgement(j, detail));
      const st = s.judgeState();
      hw.setCombo(st.combo, st.multiplier);
      hudView.setState(st);
      hudView.judgement(j);
      bar.judgement(j);
    };
    const onStray = (x: StrayEvent): void => hw.stray(x);
    cleanups.push(s.onJudgement(onJudgement), s.onStray(onStray), s.onMessage((m) => hudView.message(m)));
    cleanups.push(
      s.clock.onChange((c) => {
        hw.setOptions({ loop: s.loop });
        bar.setLoop(s.loop);
        if (c.state === 'count-in' && (c.reason === 'play' || c.reason === 'seek')) startCountIn();
      }),
    );
    cleanups.push(
      ctx.settings.subscribe((next) => hw.setOptions({ noteSpeed: next.game.noteSpeed, handCues: next.game.handCues, fretNumbers: next.game.fretNumbers })),
    );

    const frame = (): void => {
      if (disposed) return;
      const t = s.clock.heardSongTime();
      bar.setTime(t);
      const idx = s.sectionAtTime(Math.max(0, t));
      hudView.setSection(idx >= 0 && s.song.sections.length > 0 ? s.sectionName(idx) : '');
      hudView.setSpeed(s.speed);
      hudView.setChordNote(s.running && chordInView(t));
      hudView.setCountIn(s.state === 'count-in' && ciEnd > t ? Math.ceil((ciEnd - t) / ciBeat - 1e-6) : 0);
      rafId = window.requestAnimationFrame(frame);
    };
    rafId = window.requestAnimationFrame(frame);

    // ---- Run control ----
    const start = async (): Promise<void> => {
      if (s.state === 'playing' || s.state === 'count-in') return;
      try {
        await ctx.ui.requireAudioGesture();
      } catch (err) {
        if (err instanceof Error && err.name === 'AudioGestureDismissedError') {
          showStart('Audio is off. Press Play to enable it.');
          return;
        }
        throw err;
      }
      if (disposed) return;
      showCard(null);
      if (s.state === 'ready' || s.state === 'ended') {
        hudView.reset();
        bar.reset();
        hudView.setState(s.judgeState());
      }
      s.play();
      canvas.focus?.({ preventScroll: true });
    };

    const showStart = (notice?: string): void => {
      const loop = s.barLoopRange;
      const sec = loop ? s.song.sections.findIndex((x) => x.startBar === loop.startBar && x.endBar === loop.endBar) : -1;
      const card = startCard(
        {
          title: s.title,
          artist: s.artist,
          mode: s.mode,
          speed: s.speed,
          loopLabel: loop ? (sec >= 0 ? s.sectionName(sec) : `bars ${loop.startBar + 1}–${loop.endBar}`) : null,
          guitarLabel: s.hasGuitar ? (ctx.services.peek('input')?.current?.device.label ?? 'connected') : null,
          keys: ctx.settings.get().keyboard,
          ...(notice ? { notice } : notices.length > 0 ? { notice: notices.join(' ') } : {}),
        },
        () => void start(),
        back,
      );
      showCard(card.el, card.focus);
    };

    const showPause = (): void => {
      const judged = s.judgeState().judgedNotes > 0;
      const menu = pauseMenu(
        {
          resume: () => void start(),
          restart: () => {
            showCard(null);
            hudView.reset();
            bar.reset();
            s.restart();
            hudView.setState(s.judgeState());
          },
          tools: () => {
            if (!drawerOpen) toggleDrawer();
          },
          finish: judged ? () => void s.finish() : null,
          quit: () => {
            quitting = true;
            void s.quit().finally(back);
          },
        },
        ctx.settings.get().keyboard,
      );
      showCard(menu.el, menu.focus);
    };

    function togglePause(): void {
      if (s.state === 'playing' || s.state === 'count-in') s.pause();
      else if (s.state === 'paused') void start();
    }

    function toggleDrawer(): void {
      drawerOpen = !drawerOpen;
      drawer.hidden = !drawerOpen;
      root.classList.toggle('has-drawer', drawerOpen);
      toolsBtn.setAttribute('aria-expanded', String(drawerOpen));
      if (drawerOpen && panels.length === 0) {
        const practiceEl = h('div', { class: 'gm-panel' });
        const mixerEl = h('div', { class: 'gm-panel' });
        drawer.append(practiceEl, mixerEl);
        void mountPanel('practice', practiceEl, ctx, { session: s })
          .then((p) => (disposed ? p.unmount() : panels.push(p as PanelHandle<unknown>)))
          .catch((err: unknown) => console.error('Riffway: practice panel failed', err));
        void mountPanel('mixer', mixerEl, ctx, { session: s })
          .then((p) => (disposed ? p.unmount() : panels.push(p as PanelHandle<unknown>)))
          .catch((err: unknown) => console.error('Riffway: mixer panel failed', err));
      }
      // The canvas size changes with the drawer.
      hw.resize();
    }

    cleanups.push(
      s.onStateChange((state: SessionState) => {
        root.dataset.state = state;
        pauseBtn.disabled = state === 'ready' || state === 'ended';
        if (state === 'paused') showPause();
        else if (state === 'playing' || state === 'count-in') showCard(null);
      }),
    );
    cleanups.push(
      s.onRunEnd(() => {
        if (quitting || disposed) return;
        const result = s.lastResult;
        if (result) ctx.router.navigate(ctx.router.href('results', { runId: resultKey(result) }));
        else showStart('No notes were judged in that run.');
      }),
    );
    cleanups.push(
      attachKeyboard(window, () => ctx.settings.get().keyboard, {
        lane: (press) => {
          s.keyPress(press);
        },
        escape: () => {
          if (s.state === 'ready' || s.state === 'ended' || s.state === 'loading') return;
          togglePause();
        },
        start: () => {
          if (s.state === 'ready' || s.state === 'paused' || s.state === 'ended') void start();
        },
      }),
    );
    // Pause when the tab is hidden (no surprise playback while away).
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden' && (s.state === 'playing' || s.state === 'count-in')) s.pause();
    };
    document.addEventListener('visibilitychange', onVisibility);
    cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));

    root.dataset.state = s.state;
    pauseBtn.disabled = true;
    if (s.mode === 'practice' && window.matchMedia?.('(min-width: 1100px)').matches) toggleDrawer();
    showStart();
  };

  void load();

  return {
    unmount(): void {
      disposed = true;
      window.cancelAnimationFrame(rafId);
      for (const c of cleanups.splice(0)) c();
      for (const p of panels.splice(0)) p.unmount();
      highway?.dispose();
      hud?.dispose();
      const s = session;
      session = null;
      if (s) {
        clearActiveSession(s);
        void s.dispose().catch((err: unknown) => console.error('Riffway: session dispose failed', err));
      }
      root.remove();
    },
  };
};
