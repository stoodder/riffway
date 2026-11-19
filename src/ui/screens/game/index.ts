/**
 * Play screen (T-031, `#/play/:id?arr&mode&section&speed&input`). Loads a {@link GameSessionImpl}
 * (song, guide, backing, inputs), draws the canvas highway (T-024) under the HUD, binds keyboard mode
 * (D6), mounts the practice + mixer panels (T-032) in a side drawer, and navigates to the results
 * screen when a run ends. Registered in `src/ui/screens/index.ts`.
 *
 * While a run plays (or counts in) the app's top nav is hidden so the lanes get the height
 * (`game.css`, R2-U-04); it returns on pause, on the start card and on results. Leaving while the
 * session still loads aborts that load (R2-I-01).
 *
 * Query params: `arr` (arrangement; default the song's default), `mode` (`play` | `practice`),
 * `section` (loop this section; practice), `speed` (fraction), `input` (`auto` | `keyboard` |
 * `guitar`; `?e2e=1` defaults to `keyboard` so a fake capture device can't add onsets).
 * @module
 */
import type { Judgement, StrayEvent } from '@shared/judge';
import type { SessionState } from '@shared/services';
import type { AppContext, PanelHandle, ScreenHandle, ScreenMount } from '@shared/ui';
import { computePositions } from '@core/handpos';
import { barAt } from '@core/model';
import { createHighway, type GameHighway } from '../../../game/highway';
import { attachKeyboard } from '../../../game/input';
import {
  clearActiveSession,
  createGameSession,
  type GameSessionImpl,
  resultKey,
  setActiveSession,
  type SessionInputMode,
} from '../../../game/session';
import { button, emptyState, h, openModal } from '../../components';
import { mountPanel } from '../../panels';
import { displayArtist, GameHud } from './hud';
import { errorCard, loadingCard, notFoundCard, pauseMenu, startCard } from './overlays';
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

/** True for the API's "not found" (the song id is not in the library). */
function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 404;
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
  let loadAbort: AbortController | null = null;
  let session: GameSessionImpl | null = null;
  let highway: GameHighway | null = null;
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
    loadAbort?.abort();
    const abort = new AbortController();
    loadAbort = abort;
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
          signal: abort.signal,
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
      if (disposed || abort.signal.aborted) return;
      root.dataset.state = 'error';
      if (isNotFound(err)) {
        const card = notFoundCard(
          () => ctx.router.navigate(ctx.router.href('library')),
          async () => {
            await ctx.api.rescan();
            if (!disposed) await load();
          },
        );
        showCard(card.el, card.focus);
        return;
      }
      console.error('Riffway: game failed to load', err);
      showCard(errorCard(err instanceof Error ? err.message : String(err), back, () => void load()));
    }
  };

  // ---- Game view --------------------------------------------------------------------------
  const build = (s: GameSessionImpl): void => {
    const settings = ctx.settings.get();
    // A labelled pause button the same size as "Practice tools", with its key (R2-U-14).
    const pauseBtn = button({ label: 'Pause', icon: 'pause', variant: 'secondary', size: 'sm', title: 'Pause (Esc)', onClick: () => togglePause() });
    pauseBtn.classList.add('gm-pause-btn');
    pauseBtn.append(h('kbd', { class: 'gm-kbd', 'aria-hidden': 'true' }, 'Esc'));
    pauseBtn.setAttribute('aria-keyshortcuts', 'Escape');
    const toolsBtn = button({ label: 'Practice tools', icon: 'settings', variant: 'secondary', size: 'sm', onClick: () => toggleDrawer() });
    toolsBtn.setAttribute('aria-expanded', 'false');
    const actions = h('div', { class: 'gm-actions' }, toolsBtn, pauseBtn);
    const hudView = new GameHud({ title: s.title, artist: s.artist, mode: s.mode }, actions);
    hud = hudView;
    const canvas = h('canvas', { class: 'gm-canvas', role: 'img', 'aria-label': `Note highway for ${s.title}` });
    const stage = h('div', { class: 'gm-stage' }, canvas, hudView.overlays, stageCards);
    const bar = new SectionProgressBar(s.song, s.mode === 'practice' ? (t) => s.seek(t) : null);
    const drawer = h('aside', { class: 'gm-drawer', 'aria-label': 'Practice tools', hidden: true });
    // The key hint shows until the first run starts (the start card and pause menu repeat it).
    const hint = h('p', { class: 'gm-footer__hint' }, s.hasGuitar ? 'Guitar + keys 1–6 · Shift = wrong note · Esc = pause' : 'Keys 1–6 play the strings (1 = high e) · Shift = wrong note · Esc = pause');
    const footer = h('footer', { class: 'gm-footer' }, bar.el, hint);
    root.replaceChildren(hudView.bar, h('div', { class: 'gm-body' }, h('div', { class: 'gm-main' }, stage, footer), drawer));

    const hw = createHighway(canvas, s.song, s.clock, {
      noteSpeed: settings.game.noteSpeed,
      handCues: settings.game.handCues,
      fretNumbers: settings.game.fretNumbers,
      positions: computePositions(s.song),
      loop: s.loop,
    });
    highway = hw;
    hw.setFeedbackDetail(settings.game.feedbackDetail);
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
    /** Beats left before loop A while a loop pass plays its pre-roll (0 outside it). */
    const prerollBeats = (t: number): number => {
      const loop = s.loop;
      if (!loop || t >= loop.start || t < loop.start - loop.preroll - 1e-6) return 0;
      const b = s.song.timing.bars[Math.max(0, barAt(s.song, Math.max(0, t)))];
      const beat = b ? b.dur / Math.max(1, b.beats.length || b.num) : 0.5;
      return Math.max(1, Math.ceil((loop.start - t) / beat - 1e-6));
    };

    // ---- Live updates ----
    const onJudgement = (j: Judgement): void => {
      hw.feedback(j);
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
      ctx.settings.subscribe((next) => {
        hw.setOptions({ noteSpeed: next.game.noteSpeed, handCues: next.game.handCues, fretNumbers: next.game.fretNumbers });
        hw.setFeedbackDetail(next.game.feedbackDetail);
      }),
    );

    const frame = (): void => {
      if (disposed) return;
      const t = s.clock.heardSongTime();
      bar.setTime(t);
      const idx = s.sectionAtTime(Math.max(0, t));
      hudView.setSection(idx >= 0 && s.song.sections.length > 0 ? s.sectionName(idx) : '');
      hudView.setSpeed(s.speed);
      hudView.setChordNote(s.running && chordInView(t));
      if (s.state === 'count-in' && ciEnd > t) hudView.setCountIn(Math.ceil((ciEnd - t) / ciBeat - 1e-6));
      else if (s.state === 'playing') hudView.setCountIn(prerollBeats(t), 'Loop');
      else hudView.setCountIn(0);
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
      hint.hidden = true;
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
          artist: displayArtist(s.artist),
          mode: s.mode,
          speed: s.speed,
          loopLabel: loop ? (sec >= 0 ? s.sectionName(sec) : `bars ${loop.startBar + 1}–${loop.endBar}`) : null,
          guitarLabel: s.hasGuitar ? (ctx.services.peek('input')?.current?.device.label ?? 'connected') : null,
          keys: ctx.settings.get().keyboard,
          tuning: s.song.meta.tuning,
          ...(notice ? { notice } : notices.length > 0 ? { notice: notices.join(' ') } : {}),
        },
        () => void start(),
        back,
        openTuner,
      );
      showCard(card.el, card.focus);
    };

    /** The tuner in a modal, set to the song's tuning (from the start card's retune reminder). */
    let tunerOpen = false;
    function openTuner(): void {
      if (tunerOpen) return;
      tunerOpen = true;
      const host = h('div', { class: 'gm-tuner' });
      const modal = openModal({
        title: 'Tuner',
        content: [h('p', { class: 'rw-muted' }, 'Play each open string and follow the needle.'), host],
        actions: [{ label: 'Done', value: 'done', variant: 'primary' }],
        size: 'lg',
      });
      let panel: PanelHandle<unknown> | null = null;
      let closed = false;
      void modal.result.then(() => {
        closed = true;
        tunerOpen = false;
        panel?.unmount();
      });
      mountPanel('tuner', host, ctx, { tuning: [...s.song.meta.tuning] }).then(
        (p) => {
          if (closed || disposed) p.unmount();
          else panel = p as PanelHandle<unknown>;
        },
        (err: unknown) => host.replaceChildren(h('p', { class: 'rw-muted' }, `The tuner couldn’t start: ${err instanceof Error ? err.message : String(err)}`)),
      );
    }

    let pauseCard: ReturnType<typeof pauseMenu> | null = null;
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
        { notice: s.pauseNotice, tuning: s.song.meta.tuning },
      );
      pauseCard = menu;
      showCard(menu.el, menu.focus);
    };
    // The guitar was unplugged (the session paused) or is back: keep the pause card's notice current.
    cleanups.push(
      s.onInputStatus(() => {
        if (s.state === 'paused') pauseCard?.setNotice(s.pauseNotice);
      }),
    );

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
      loadAbort?.abort();
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
