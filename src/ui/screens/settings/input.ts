/**
 * Input settings: the guitar input and calibration at a glance (changed in Audio setup) and the
 * keyboard-mode key map.
 * @module
 */
import type { CalibrationSettings, Settings } from '@shared/settings';
import type { AppContext } from '@shared/ui';
import { badge, h } from '../../components';
import { group, section, type Binder } from './controls';
import { keyMapBlock } from './keys';

/** One line of the calibration summary. */
export interface CalibrationLine {
  label: string;
  value: string;
}

const METHOD_TEXT: Record<CalibrationSettings['method'], string> = {
  none: 'Not calibrated yet',
  'play-to-click': 'Calibrated by playing along to clicks',
  'tap-to-click': 'Calibrated by tapping along to clicks',
  loopback: 'Measured with a loopback cable',
  estimated: 'Estimated from what the browser reports',
};

const signedMs = (v: number): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v))} ms`;

/** Calibration status text and offsets for display. */
export function calibrationSummary(cal: CalibrationSettings, now: number = Date.now()): { status: string; calibrated: boolean; lines: CalibrationLine[] } {
  const calibrated = cal.method !== 'none';
  let status = METHOD_TEXT[cal.method];
  if (calibrated && cal.measuredAt !== null) status += ` · ${relativeDays(cal.measuredAt, now)}`;
  const lines: CalibrationLine[] = [
    { label: 'Guitar offset', value: signedMs(cal.inputOffsetMs) },
    { label: 'Keyboard offset', value: signedMs(cal.keyboardOffsetMs) },
    { label: 'Visual offset', value: signedMs(cal.visualOffsetMs) },
  ];
  if (cal.spreadMs !== null) lines.push({ label: 'Spread', value: `±${Math.round(cal.spreadMs)} ms` });
  return { status, calibrated, lines };
}

/** "today", "yesterday", "N days ago" for an epoch-ms time. */
export function relativeDays(at: number, now: number): string {
  const startOf = (t: number): number => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((startOf(now) - startOf(at)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/** The Input tab. Returns the element and a destroy hook (the key listener). */
export function inputTab(ctx: AppContext, b: Binder): { el: HTMLElement; destroy(): void } {
  const setupHref = (step: string, mode?: string): string => ctx.router.href('audio-setup', mode ? { step, mode } : { step });
  const device = h('p', { class: 'set-device__name' });
  const output = h('p', { class: 'set-device__name' });
  const calStatus = h('p', { class: 'set-cal__status' });
  const calList = h('dl', { class: 'set-cal__list' });
  b.bind((s: Settings) => {
    device.replaceChildren(s.input.label ? s.input.label : h('span', { class: 'rw-muted' }, 'No guitar input chosen yet'));
    output.replaceChildren(s.output.label ? s.output.label : h('span', { class: 'rw-muted' }, 'System default'));
    const cal = calibrationSummary(s.calibration);
    calStatus.replaceChildren(badge(cal.calibrated ? 'Calibrated' : 'Not calibrated', { tone: cal.calibrated ? 'success' : 'warning' }), ' ', cal.status);
    calList.replaceChildren(...cal.lines.flatMap((l) => [h('dt', null, l.label), h('dd', { class: 'rw-num' }, l.value)]));
  });

  const link = (label: string, href: string, primary = false): HTMLAnchorElement =>
    h('a', { class: `rw-btn rw-btn--${primary ? 'primary' : 'secondary'} rw-btn--sm`, href }, h('span', { class: 'rw-btn__label' }, label));

  const keys = keyMapBlock(ctx);
  b.bind((s) => keys.sync(s));

  const el = h(
    'div',
    { class: 'set-tab' },
    section(
      'Guitar and audio',
      'Devices, levels, tuning, monitoring and latency are set up in Audio setup.',
      group(
        null,
        h(
          'div',
          { class: 'set-device' },
          h('div', null, h('p', { class: 'rw-eyebrow' }, 'Guitar input'), device),
          h('div', null, h('p', { class: 'rw-eyebrow' }, 'Output'), output),
          link('Open Audio setup', setupHref('input'), true),
        ),
      ),
      group('Latency calibration', calStatus, calList, h('div', { class: 'rw-row' }, link('Calibrate guitar', setupHref('calibration')), link('Calibrate keyboard', setupHref('calibration', 'keyboard')))),
    ),
    section(
      'Keyboard mode',
      'No guitar handy? Play the highway with the keyboard: each key is one string lane, judged exactly like the guitar.',
      keys.el,
    ),
  );
  return { el, destroy: () => keys.destroy() };
}

