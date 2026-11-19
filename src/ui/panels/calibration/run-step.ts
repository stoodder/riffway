/**
 * One calibration step of the panel (guitar play-to-click, keyboard tap-to-click or loopback):
 * instructions → live run (beat dots that fill in as plucks/taps pair with clicks, a running
 * median) → result (offset in ms, consistency, residual strip against the Perfect window, saved
 * with Undo) or failure (why, what to do, Try again, and the "estimated" fallback for the guitar).
 * @module
 */
import type { Unsubscribe } from '@shared/clock';
import type { AudioEngine, InputService } from '@shared/services';
import type { AppContext } from '@shared/ui';
import { WINDOWS } from '@core/judge/constants';
import {
  CALIBRATION,
  CalibrationAbortedError,
  createLiveCalibration,
  estimateGuitarOffsetMs,
  estimatedGuitarPatch,
  guitarResultPatch,
  keyboardResultPatch,
  loopbackGuitarPatch,
  loopbackResultPatch,
  onsetSource,
  restorePatch,
  snapshot,
  tapKeys,
  tapSource,
  type CalibrationKind,
  type CalibrationPatch,
  type CalibrationRunOptions,
  type LiveCalibration,
  type OffsetEstimate,
  type PlannedClick,
} from '../../../audio/calibration';
import { AudioGestureDismissedError } from '../../shell/audio-gesture';
import { badge, button, h, icon, setBusy } from '../../components';
import {
  ACTION,
  QUALITY_LABEL,
  STRIP_HALF_MS,
  appliedSentence,
  deviceLine,
  failureMessage,
  fmtMs,
  fmtSignedMs,
  fmtSpread,
  perfectShare,
  residualDots,
} from './model';

/** Services a step needs. */
export interface RunStepDeps {
  ctx: AppContext;
  engine: AudioEngine;
  input: InputService;
  /** Notified when a run starts / ends (the panel locks the other tabs while running). */
  onRunningChange?(running: boolean): void;
  /** Run overrides (tests use a faster click plan); the panel uses the documented defaults. */
  runOptions?: CalibrationRunOptions;
}

/** A mounted step. */
export interface RunStep {
  el: HTMLElement;
  /** Stop a run in progress (tab switch). */
  abort(): void;
  destroy(): void;
}

const TITLES: Record<CalibrationKind, string> = {
  guitar: 'Play to the click',
  keyboard: 'Tap to the click',
  loopback: 'Loopback measurement',
};

const INTRO: Record<CalibrationKind, readonly string[]> = {
  guitar: [
    'Put on the headphones you play with and set a comfortable volume.',
    'Rest your fretting hand lightly on the strings (or leave the low E open).',
    'After four count-in clicks, pick once on each of the next 16 clicks.',
  ],
  keyboard: [
    'Use the keyboard and headphones you play with.',
    'After four count-in clicks, tap Space (or a lane key) once on each of the next 16 clicks.',
  ],
  loopback: [
    'Connect the headphone or line output to the guitar input with a cable.',
    'Turn the output volume up to about half. Monitoring is switched off during the measurement.',
    'The clicks travel out and back in; no playing needed.',
  ],
};

/** Create a step for `kind`. */
export function createRunStep(kind: CalibrationKind, deps: RunStepDeps): RunStep {
  const { ctx, engine, input } = deps;
  const root = h('div', { class: `rw-calib__step rw-calib__step--${kind}`, dataset: { kind, phase: 'intro' } });
  let live: LiveCalibration | null = null;
  let raf = 0;
  let cleanup: (() => void) | null = null;
  let destroyed = false;

  // ---- Intro -------------------------------------------------------------------------------------
  const inputLine = h('p', { class: 'rw-calib__input-line' });
  const startBtn = button({ label: kind === 'loopback' ? 'Measure loopback' : 'Start', icon: 'play', variant: kind === 'loopback' ? 'secondary' : 'primary', onClick: () => void start() });
  const intro = h(
    'div',
    { class: 'rw-calib__intro' },
    h('ol', { class: 'rw-calib__steps' }, ...INTRO[kind].map((t) => h('li', null, t))),
    kind === 'guitar' || kind === 'loopback' ? inputLine : null,
    h('div', { class: 'rw-calib__actions' }, startBtn, h('span', { class: 'rw-calib__hint' }, `${CALIBRATION.bpm} BPM · about 15 s`)),
  );

  const renderInputLine = (): void => {
    const cur = input.current;
    inputLine.replaceChildren(
      icon(cur ? 'audio' : 'warning'),
      cur ? `Input: ${cur.device.label}` : 'No guitar input is open yet. Start will ask for it.',
    );
    inputLine.dataset.state = cur ? 'ok' : 'missing';
  };
  const offDevices = input.onDevicesChanged(renderInputLine);
  renderInputLine();

  // ---- Live --------------------------------------------------------------------------------------
  const dots = h('ol', { class: 'rw-calib__beats', 'aria-hidden': 'true' });
  const liveStatus = h('p', { class: 'rw-calib__live-status', 'aria-live': 'polite' });
  const liveMedian = h('p', { class: 'rw-calib__live-median rw-num' });
  const cancelBtn = button({ label: 'Cancel', variant: 'ghost', size: 'sm', onClick: () => live?.run.abort() });
  const pad = kind === 'keyboard' ? h('div', { class: 'rw-calib__pad', 'aria-hidden': 'true' }, 'Space') : null;
  const liveEl = h(
    'div',
    { class: 'rw-calib__live', tabindex: '-1', 'aria-label': `${TITLES[kind]} in progress` },
    dots,
    pad,
    h('div', { class: 'rw-calib__live-row' }, liveStatus, liveMedian, cancelBtn),
  );

  // ---- Result ------------------------------------------------------------------------------------
  const resultEl = h('div', { class: 'rw-calib__result', 'aria-live': 'polite' });

  root.append(intro, liveEl, resultEl);
  const setPhase = (phase: 'intro' | 'live' | 'result'): void => {
    root.dataset.phase = phase;
    intro.hidden = phase !== 'intro';
    liveEl.hidden = phase !== 'live';
    resultEl.hidden = phase !== 'result';
  };
  setPhase('intro');

  // ---- Run ---------------------------------------------------------------------------------------
  async function prepare(): Promise<{ listen: (cb: (t: number) => void) => Unsubscribe; cleanup: () => void } | null> {
    try {
      await ctx.ui.requireAudioGesture();
    } catch (err) {
      if (err instanceof AudioGestureDismissedError) return null;
      throw err;
    }
    await engine.resume();
    if (kind === 'keyboard') {
      const taps = tapSource(engine, tapKeys(ctx.settings.get().keyboard.lanes));
      const flashPad = taps.listen(() => {
        if (!pad) return;
        pad.classList.remove('rw-calib__pad--hit');
        void pad.offsetWidth; // restart the CSS animation
        pad.classList.add('rw-calib__pad--hit');
      });
      return { listen: (cb) => taps.listen(cb), cleanup: flashPad };
    }
    if (!input.current) await input.open();
    let restoreMonitor = (): void => undefined;
    if (kind === 'loopback') {
      const monitor = await ctx.services.get('monitor');
      if (monitor.enabled) {
        await monitor.setEnabled(false);
        restoreMonitor = () => void monitor.setEnabled(true).catch(() => undefined);
      }
    }
    return { listen: onsetSource(engine, input), cleanup: restoreMonitor };
  }

  async function start(): Promise<void> {
    if (live) return;
    setBusy(startBtn, true);
    let prepared: Awaited<ReturnType<typeof prepare>>;
    try {
      prepared = await prepare();
    } catch (err) {
      setBusy(startBtn, false);
      ctx.ui.toast(`Could not start: ${message(err)}`, { kind: 'error' });
      return;
    } finally {
      renderInputLine();
    }
    setBusy(startBtn, false);
    if (!prepared || destroyed) {
      prepared?.cleanup();
      return;
    }
    cleanup = prepared.cleanup;
    live = createLiveCalibration(engine, prepared.listen, deps.runOptions);
    const run = live.run;
    const done = run.start();
    buildDots(run.plan);
    setPhase('live');
    liveEl.focus({ preventScroll: true });
    deps.onRunningChange?.(true);
    liveStatus.textContent = 'Count-in…';
    liveMedian.textContent = '';
    run.onProgress((p) => paintPairs(p.estimate));
    animate(run.plan);
    try {
      const estimate = await done;
      showResult(estimate);
    } catch (err) {
      if (err instanceof CalibrationAbortedError) {
        setPhase('intro');
        if (err.message !== 'Calibration stopped') ctx.ui.toast(err.message, { kind: 'warning' });
      } else {
        setPhase('intro');
        ctx.ui.toast(`Calibration failed: ${message(err)}`, { kind: 'error' });
      }
    } finally {
      endRun();
    }
  }

  function endRun(): void {
    cancelAnimationFrame(raf);
    live?.dispose();
    live = null;
    cleanup?.();
    cleanup = null;
    if (!destroyed) deps.onRunningChange?.(false);
  }

  function buildDots(plan: readonly PlannedClick[]): void {
    let measured = 0;
    dots.replaceChildren(
      ...plan.map((c, i) =>
        h('li', {
          class: `rw-calib__beat${c.measured ? '' : ' rw-calib__beat--count'}${c.accent ? ' rw-calib__beat--accent' : ''}`,
          dataset: { index: String(i), ...(c.measured ? { click: String(measured++) } : {}) },
        }),
      ),
    );
  }

  function paintPairs(e: OffsetEstimate): void {
    for (const p of e.pairs) {
      const dot = dots.querySelector<HTMLElement>(`[data-click="${p.click}"]`);
      if (!dot) continue;
      dot.dataset.status = p.status;
      dot.title = fmtSignedMs(p.deltaMs);
    }
    if (e.offsetMs !== null) liveMedian.textContent = `Median so far ${fmtMs(e.offsetMs)}`;
  }

  function animate(plan: readonly PlannedClick[]): void {
    const measuredTotal = plan.filter((c) => c.measured).length;
    const frame = (): void => {
      const heard = engine.perfToCtxTime(performance.now());
      let current = -1;
      for (let i = 0; i < plan.length && plan[i]!.ctxTime <= heard; i++) current = i;
      for (const el of dots.children) {
        const i = Number((el as HTMLElement).dataset.index);
        el.classList.toggle('rw-calib__beat--past', i < current);
        el.classList.toggle('rw-calib__beat--now', i === current && heard - plan[i]!.ctxTime < 0.15);
      }
      const c = current >= 0 ? plan[current]! : null;
      if (!c || !c.measured) liveStatus.textContent = current < 0 ? 'Get ready…' : `Count-in ${current + 1}`;
      else liveStatus.textContent = `${ACTION[kind].verb} on each click · ${current - (plan.length - measuredTotal) + 1} / ${measuredTotal}`;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }

  // ---- Results -----------------------------------------------------------------------------------
  function showResult(e: OffsetEstimate): void {
    setPhase('result');
    root.dataset.outcome = e.ok ? 'ok' : (e.failure ?? 'failed');
    if (!e.ok) {
      resultEl.replaceChildren(failureView(e));
      return;
    }
    const s = ctx.settings.get();
    const before = snapshot(s);
    const now = Date.now();
    const patch: CalibrationPatch =
      kind === 'guitar'
        ? guitarResultPatch(s, { offsetMs: e.offsetMs!, spreadMs: e.spreadMs! }, now)
        : kind === 'keyboard'
          ? keyboardResultPatch(s, { offsetMs: e.offsetMs!, spreadMs: e.spreadMs! }, now)
          : loopbackResultPatch(s, e.offsetMs!, now);
    save(patch, kind === 'loopback' ? 'Loopback measurement saved.' : 'Calibration saved.');
    resultEl.replaceChildren(successView(e, before));
  }

  function save(patch: CalibrationPatch, done?: string): void {
    ctx.settings
      .update(patch)
      .then(() => done && ctx.ui.toast(done, { kind: 'success', timeoutMs: 2500 }))
      .catch((err: unknown) => ctx.ui.toast(`Could not save the calibration: ${message(err)}`, { kind: 'error' }));
  }

  function successView(e: OffsetEstimate, before: ReturnType<typeof snapshot>): HTMLElement {
    const q = QUALITY_LABEL[e.quality!];
    const label = kind === 'guitar' ? 'Guitar offset' : kind === 'keyboard' ? 'Keyboard offset' : 'Hardware round trip';
    const s = ctx.settings.get();
    const actions: HTMLElement[] = [];
    if (kind === 'loopback') {
      actions.push(
        button({
          label: 'Use as guitar offset',
          variant: 'primary',
          onClick: (ev) => {
            save(loopbackGuitarPatch(ctx.settings.get(), e.offsetMs!, Date.now()), 'Guitar offset set from the loopback measurement.');
            (ev.currentTarget as HTMLButtonElement).disabled = true;
          },
        }),
      );
    } else {
      const undo = button({
        label: 'Undo',
        variant: 'secondary',
        onClick: () => {
          save(restorePatch(ctx.settings.get(), before), 'Previous calibration restored.');
          undo.disabled = true;
        },
      });
      actions.push(undo);
    }
    actions.push(button({ label: 'Run again', variant: 'ghost', icon: 'loop', onClick: () => void start() }));
    return h(
      'div',
      { class: 'rw-calib__outcome rw-calib__outcome--ok' },
      h(
        'div',
        { class: 'rw-calib__big' },
        h('span', { class: 'rw-calib__big-label' }, label),
        h('span', { class: 'rw-calib__big-value rw-num', dataset: { testid: 'calib-offset' } }, fmtMs(e.offsetMs!)),
        badge(q.text, { tone: q.tone, icon: 'check' }),
      ),
      h(
        'p',
        { class: 'rw-calib__stats rw-num' },
        `Spread ${fmtSpread(e.spreadMs!)} · ${e.kept} of ${e.pairs.length + e.missed} clicks used`,
        e.missed ? ` · ${e.missed} missed` : '',
      ),
      kind === 'loopback' ? null : residualStrip(e),
      h(
        'p',
        { class: 'rw-calib__applied' },
        kind === 'loopback'
          ? 'This is output + input latency of your audio hardware only. Play-to-click also includes your own timing habit, which is what scoring needs; use this if you cannot play along.'
          : `${appliedSentence(kind, e.offsetMs!)} Saved for ${deviceLine(s)}.`,
      ),
      h('div', { class: 'rw-calib__actions' }, ...actions),
    );
  }

  function failureView(e: OffsetEstimate): HTMLElement {
    const f = failureMessage(e.failure!, kind, e);
    const actions: HTMLElement[] = [button({ label: 'Try again', variant: 'primary', icon: 'loop', onClick: () => void start() })];
    if (kind === 'guitar' && e.failure === 'no-events') {
      const s = ctx.settings.get();
      const est = estimateGuitarOffsetMs({
        keyboardOffsetMs: s.calibration.keyboardOffsetMs,
        inputLatencySec: input.current?.latency ?? null,
        baseLatencySec: engine.ctx.baseLatency,
        outputLatencySec: engine.ctx.outputLatency,
      });
      actions.push(
        button({
          label: `Use an estimate (${fmtMs(est)})`,
          variant: 'secondary',
          title: 'Keyboard offset + the latency the browser reports. Marked "estimated".',
          onClick: (ev) => {
            save(estimatedGuitarPatch(ctx.settings.get(), est, Date.now()), 'Estimated guitar offset saved.');
            (ev.currentTarget as HTMLButtonElement).disabled = true;
          },
        }),
      );
    }
    return h(
      'div',
      { class: 'rw-calib__outcome rw-calib__outcome--fail', role: 'alert' },
      h('div', { class: 'rw-calib__fail-head' }, icon('warning'), h('strong', null, f.title)),
      h('p', null, f.advice),
      e.offsetMs !== null ? h('p', { class: 'rw-calib__stats rw-num' }, `Provisional ${fmtMs(e.offsetMs)} from ${e.kept} ${ACTION[kind].noun} — not saved.`) : null,
      e.pairs.length ? residualStrip(e) : null,
      h('div', { class: 'rw-calib__actions' }, ...actions),
    );
  }

  return {
    el: root,
    abort: () => live?.run.abort(),
    destroy() {
      destroyed = true;
      offDevices();
      live?.run.abort();
      endRun();
    },
  };
}

/** Residuals after the offset on a ±80 ms strip with the Perfect window shaded. */
function residualStrip(e: OffsetEstimate): HTMLElement {
  const dots = residualDots(e);
  const perfect = WINDOWS.perfect * 1000;
  const pct = (ms: number): string => `${(((ms + STRIP_HALF_MS) / (2 * STRIP_HALF_MS)) * 100).toFixed(2)}%`;
  const share = Math.round(perfectShare(e) * 100);
  return h(
    'figure',
    { class: 'rw-calib__strip' },
    h(
      'div',
      { class: 'rw-calib__strip-track', role: 'img', 'aria-label': `${share}% of the used ${e.kept === 1 ? 'note' : 'notes'} land in the Perfect window after the offset` },
      h('span', { class: 'rw-calib__strip-perfect', style: `left: ${pct(-perfect)}; right: calc(100% - ${pct(perfect)})` }),
      h('span', { class: 'rw-calib__strip-zero' }),
      ...dots.map((d) =>
        h('span', {
          class: `rw-calib__strip-dot rw-calib__strip-dot--${d.status}${d.clipped ? ' rw-calib__strip-dot--clipped' : ''}`,
          style: `left: ${(d.x * 100).toFixed(2)}%`,
          title: fmtSignedMs(d.ms),
        }),
      ),
    ),
    h(
      'figcaption',
      { class: 'rw-calib__strip-caption' },
      h('span', null, `−${STRIP_HALF_MS} ms`),
      h('span', null, `Perfect ±${Math.round(perfect)} ms · ${share}% inside`),
      h('span', null, `+${STRIP_HALF_MS} ms`),
    ),
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
