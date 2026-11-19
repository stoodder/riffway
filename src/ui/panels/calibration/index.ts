/**
 * Latency calibration panel (T-033, docs/timing.md § Latency calibration). Exports
 * `mount: PanelMount<PanelPropsMap['calibration']>` (contract in `@shared/ui`).
 *
 * - **Summary:** the current device pair and its guitar / keyboard / visual offsets with method,
 *   consistency and date, a note when they were measured on another device, and how each is applied.
 * - **Tabs** (`props.mode` picks the first): Guitar (play-to-click, plus loopback under "Advanced"),
 *   Keyboard (tap-to-click), Visual (flash vs click nudge). A running measurement locks the tabs.
 * While mounted it keeps the active calibration on the current device pair's profile.
 * @module
 */
import type { AudioEngine, InputService } from '@shared/services';
import type { Settings } from '@shared/settings';
import type { AppContext, PanelHandle, PanelMount, PanelPropsMap } from '@shared/ui';
import { calibratedForOtherDevice, currentProfile } from '../../../audio/calibration';
import { badge, h, icon, tabs, type Tabs } from '../../components';
import { METHOD_LABEL, appliedSentence, deviceLine, fmtMs, fmtSignedMs, fmtSpread, fmtWhen, visualSentence } from './model';
import { createRunStep, type RunStep } from './run-step';
import { createVisualStep, type VisualStep } from './visual-step';
import './calibration.css';

type Props = PanelPropsMap['calibration'];
type Mode = NonNullable<Props['mode']>;

/** Mount the calibration panel. */
export const mount: PanelMount<Props> = async (el, ctx, props): Promise<PanelHandle<Props>> => {
  const root = h('section', { class: 'rw-calib', 'aria-label': 'Latency calibration' }, h('p', { class: 'rw-calib__loading' }, 'Loading calibration…'));
  el.append(root);
  const cleanups: (() => void)[] = [];
  let unmounted = false;
  let view: { select(mode: Mode): void } | null = null;
  const handle: PanelHandle<Props> = {
    update(next) {
      if (next.mode) view?.select(next.mode);
    },
    unmount() {
      unmounted = true;
      for (const c of cleanups.splice(0).reverse()) c();
      root.remove();
    },
  };
  try {
    const [engine, input] = await Promise.all([ctx.services.get('engine'), ctx.services.get('input')]);
    if (!unmounted) view = build(root, ctx, engine, input, props.mode ?? 'guitar', cleanups);
  } catch (err) {
    root.replaceChildren(
      h('p', { class: 'rw-calib__error', role: 'alert' }, icon('error'), `Calibration is unavailable: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  return handle;
};

function build(root: HTMLElement, ctx: AppContext, engine: AudioEngine, input: InputService, mode: Mode, cleanups: (() => void)[]): { select(mode: Mode): void } {
  // ---- Summary -----------------------------------------------------------------------------------
  const device = h('p', { class: 'rw-calib__device' });
  const otherNote = h(
    'p',
    { class: 'rw-calib__note', role: 'status' },
    icon('info'),
    h('span', null, 'These offsets were measured with another input or output. Calibrate again for this setup.'),
  );
  const rows = {
    guitar: summaryRow('Guitar'),
    keyboard: summaryRow('Keyboard'),
    visual: summaryRow('Visual'),
  };
  const summary = h(
    'div',
    { class: 'rw-calib__summary' },
    h('div', { class: 'rw-calib__summary-head' }, h('h4', { class: 'rw-calib__h' }, 'Current calibration'), device),
    otherNote,
    h('dl', { class: 'rw-calib__rows' }, rows.guitar.el, rows.keyboard.el, rows.visual.el),
  );

  const renderSummary = (s: Settings): void => {
    const c = s.calibration;
    const profile = currentProfile(s);
    const other = calibratedForOtherDevice(s);
    device.replaceChildren(icon('headphones'), deviceLine(s));
    otherNote.hidden = !other;

    const m = METHOD_LABEL[c.method === 'tap-to-click' ? 'none' : c.method];
    const guitarCalibrated = c.method === 'play-to-click' || c.method === 'loopback' || c.method === 'estimated';
    rows.guitar.set(
      guitarCalibrated ? fmtMs(c.inputOffsetMs) : '—',
      badge(m.text, { tone: m.tone }),
      [
        c.method === 'play-to-click' && c.spreadMs !== null ? fmtSpread(c.spreadMs) : null,
        guitarCalibrated && c.measuredAt !== null ? fmtWhen(c.measuredAt) : null,
        profile?.loopbackMs != null ? `loopback ${fmtMs(profile.loopbackMs)}` : null,
      ],
      guitarCalibrated ? appliedSentence('guitar', c.inputOffsetMs) : 'Plucks are judged without a latency correction until you calibrate.',
    );
    const kbAt = !other && profile?.keyboardMeasuredAt != null ? profile.keyboardMeasuredAt : c.method === 'tap-to-click' ? c.measuredAt : null;
    const kbSpread = !other && profile?.keyboardSpreadMs != null ? profile.keyboardSpreadMs : c.method === 'tap-to-click' ? c.spreadMs : null;
    const kbSet = kbAt !== null || c.keyboardOffsetMs !== 0;
    const kbTag = kbAt !== null ? { text: 'Tap-to-click', tone: 'success' as const } : kbSet ? METHOD_LABEL.estimated : METHOD_LABEL.none;
    rows.keyboard.set(
      kbSet ? fmtMs(c.keyboardOffsetMs) : '—',
      badge(kbTag.text, { tone: kbTag.tone }),
      [kbSpread !== null ? fmtSpread(kbSpread) : null, kbAt !== null ? fmtWhen(kbAt) : null],
      kbSet ? appliedSentence('keyboard', c.keyboardOffsetMs) : 'Key presses are judged as heard until you calibrate.',
    );
    rows.visual.set(fmtSignedMs(c.visualOffsetMs), null, [], visualSentence(c.visualOffsetMs));
  };

  // ---- Steps -------------------------------------------------------------------------------------
  let running = false;
  const steps: { guitar?: RunStep; loopback?: RunStep; keyboard?: RunStep; visual?: VisualStep } = {};
  const onRunningChange = (on: boolean): void => {
    running = on;
    root.dataset.running = String(on);
    for (const tab of root.querySelectorAll<HTMLButtonElement>('.rw-tabs__tab')) {
      if (tab.getAttribute('aria-selected') !== 'true') tab.disabled = on;
    }
  };
  const deps = { ctx, engine, input, onRunningChange };

  const renderGuitar = (): Node => {
    steps.guitar = createRunStep('guitar', deps);
    steps.loopback = createRunStep('loopback', deps);
    return h(
      'div',
      { class: 'rw-calib__tab' },
      steps.guitar.el,
      h(
        'details',
        { class: 'rw-calib__advanced' },
        h('summary', null, 'Advanced: measure the hardware with a loopback cable'),
        steps.loopback.el,
      ),
    );
  };
  const renderKeyboard = (): Node => {
    steps.keyboard = createRunStep('keyboard', deps);
    return h('div', { class: 'rw-calib__tab' }, steps.keyboard.el);
  };
  const renderVisual = (): Node => {
    steps.visual = createVisualStep(ctx, engine);
    return h('div', { class: 'rw-calib__tab' }, steps.visual.el);
  };

  const stopAll = (): void => {
    steps.guitar?.abort();
    steps.loopback?.abort();
    steps.keyboard?.abort();
    steps.visual?.stop();
  };
  const tabset: Tabs = tabs({
    label: 'Calibration method',
    variant: 'segmented',
    selected: mode,
    tabs: [
      { id: 'guitar', label: 'Guitar', render: renderGuitar },
      { id: 'keyboard', label: 'Keyboard', render: renderKeyboard },
      { id: 'visual', label: 'Visual', render: renderVisual },
    ],
    onChange: stopAll,
  });

  root.replaceChildren(summary, tabset.el);
  renderSummary(ctx.settings.get());
  cleanups.push(
    ctx.settings.subscribe(renderSummary),
    () => {
      tabset.destroy();
      steps.guitar?.destroy();
      steps.loopback?.destroy();
      steps.keyboard?.destroy();
      steps.visual?.destroy();
    },
  );
  return {
    select(next) {
      if (!running) tabset.select(next);
    },
  };
}

/** One summary row: label, value, badge, detail chips and the "how it applies" line. */
function summaryRow(label: string): { el: HTMLElement; set(value: string, tag: HTMLElement | null, details: (string | null)[], applied: string): void } {
  const value = h('span', { class: 'rw-calib__row-value rw-num' });
  const tag = h('span', { class: 'rw-calib__row-tag' });
  const details = h('span', { class: 'rw-calib__row-details rw-num' });
  const applied = h('p', { class: 'rw-calib__row-applied' });
  const el = h(
    'div',
    { class: 'rw-calib__row', dataset: { row: label.toLowerCase() } },
    h('dt', null, label),
    h('dd', null, h('div', { class: 'rw-calib__row-line' }, value, tag, details), applied),
  );
  return {
    el,
    set(v, t, d, a) {
      value.textContent = v;
      tag.replaceChildren(...(t ? [t] : []));
      details.textContent = d.filter((x): x is string => x !== null).join(' · ');
      applied.textContent = a;
    },
  };
}
