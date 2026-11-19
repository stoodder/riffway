/**
 * Monitoring panel (T-023, docs/monitoring.md): hear-my-guitar switch with status, headphone card,
 * speaker / feedback guard banners, amp presets with drive / tone / level knobs, and the monitoring
 * latency estimate (input · processing · output, "estimated" until a play-to-click calibration).
 * Exports `mount: PanelMount<PanelPropsMap['monitor']>` (contract in `@shared/ui`).
 * @module
 */
import type { InputService, MonitorGuardEvent, MonitorService } from '@shared/services';
import type { AmpPresetId, Settings } from '@shared/settings';
import type { AppContext, PanelHandle, PanelMount, PanelPropsMap } from '@shared/ui';
import { AMP_PRESETS, AMP_PRESET_ORDER, AMP_RANGES, driveCharacter } from '@core/dsp/amp';
import { isBuiltInMic } from '../../../audio/monitor/devices';
import { LATENCY_TIPS, latencyBreakdown } from '../../../audio/monitor/latency';
import { AudioGestureDismissedError } from '../../shell/audio-gesture';
import { badge, button, card, h, icon, rovingFocus, setBusy, slider, toggle, type BadgeTone, type Slider } from '../../components';
import './monitor.css';

/** How often the latency readout refreshes (Chrome refines `outputLatency` while running). */
const LATENCY_REFRESH_MS = 2000;

/** What the player hears right now. */
export type MonitorStatus = 'live' | 'off' | 'no-input' | 'speaker-muted' | 'feedback';

/** Status from the switch, the input and the guards (guards win: they explain why it's silent). */
export function monitorStatus(s: { enabled: boolean; hasInput: boolean; speakerMuted: boolean; feedback: boolean }): MonitorStatus {
  if (!s.enabled) return 'off';
  if (s.feedback) return 'feedback';
  if (s.speakerMuted) return 'speaker-muted';
  if (!s.hasInput) return 'no-input';
  return 'live';
}

const STATUS_BADGE: Record<MonitorStatus, { text: string; tone: BadgeTone }> = {
  live: { text: 'Live', tone: 'success' },
  off: { text: 'Off', tone: 'neutral' },
  'no-input': { text: 'No input', tone: 'warning' },
  'speaker-muted': { text: 'Muted on speakers', tone: 'warning' },
  feedback: { text: 'Feedback detected', tone: 'danger' },
};

const BAND_BADGE = {
  great: { text: 'Great', tone: 'success' },
  playable: { text: 'Playable', tone: 'info' },
  noticeable: { text: 'Noticeable — see tips', tone: 'warning' },
} as const satisfies Record<string, { text: string; tone: BadgeTone }>;

const fmtDb = (v: number): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} dB`;
const fmtMs = (v: number): string => `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`;
const driveToDb = (drive: number): number => 20 * Math.log10(drive);
const dbToDrive = (db: number): number => 10 ** (db / 20);

/** Mount the monitoring panel. */
export const mount: PanelMount<PanelPropsMap['monitor']> = async (el, ctx): Promise<PanelHandle<PanelPropsMap['monitor']>> => {
  const root = h('section', { class: 'rw-monitor', 'aria-label': 'Monitoring' }, h('p', { class: 'rw-monitor__loading' }, 'Loading monitoring…'));
  el.append(root);
  const cleanups: (() => void)[] = [];
  let unmounted = false;
  const handle = {
    unmount() {
      unmounted = true;
      for (const c of cleanups.splice(0)) c();
      root.remove();
    },
  };
  try {
    const [monitor, input] = await Promise.all([ctx.services.get('monitor'), ctx.services.get('input')]);
    if (!unmounted) build(root, ctx, monitor, input, cleanups);
  } catch (err) {
    root.replaceChildren(
      h('p', { class: 'rw-monitor__error', role: 'alert' }, icon('error'), `Monitoring is unavailable: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  return handle;
};

function build(root: HTMLElement, ctx: AppContext, monitor: MonitorService, input: InputService, cleanups: (() => void)[]): void {
  const guard = { speakerLabel: null as string | null, feedback: false };
  let settings: Settings = ctx.settings.get();

  // ---- Switch + status -------------------------------------------------------------------------
  const statusSlot = h('span', { class: 'rw-monitor__status', 'aria-live': 'polite' });
  const power = toggle({
    label: 'Hear my guitar',
    description: 'Play your guitar through the amp sim. Headphones recommended.',
    checked: settings.monitor.enabled,
    onChange: (on) => void setEnabled(on),
  });

  // ---- Headphone card (first time) -------------------------------------------------------------
  const headphones = card({
    class: 'rw-monitor__phones',
    accent: 'var(--color-info)',
    title: 'Use headphones',
    headingLevel: 4,
    body: [
      h('p', null, 'Hear yourself clearly and avoid feedback. Wired headphones keep the delay lowest.'),
    ],
    aside: icon('headphones', { size: '28px' }),
    footer: button({
      label: 'Got it',
      size: 'sm',
      onClick: () => {
        ctx.settings.update({ monitor: { headphonesCardSeen: true } }).catch(() => undefined);
      },
    }),
  });

  // ---- Guard banners ---------------------------------------------------------------------------
  const turnOnAnyway = button({
    label: 'Turn on anyway',
    size: 'sm',
    variant: 'secondary',
    onClick: () => {
      setBusy(turnOnAnyway, true);
      monitor
        .allowSpeakers(ctx.settings.get().output.sinkId, true)
        .catch((err: unknown) => ctx.ui.toast(`Could not change monitoring: ${message(err)}`, { kind: 'error' }))
        .finally(() => setBusy(turnOnAnyway, false));
    },
  });
  const speakerBanner = h(
    'div',
    { class: 'rw-monitor__banner rw-monitor__banner--warning', role: 'status' },
    icon('warning'),
    h(
      'div',
      { class: 'rw-monitor__banner-text' },
      h('strong', null, 'Monitoring is off on laptop speakers'),
      h('p', { class: 'rw-monitor__speaker-label' }),
      h('p', null, 'Speakers next to a microphone can howl. Plug in headphones, or turn it on at a low level.'),
    ),
    turnOnAnyway,
  );
  const reenable = button({ label: 'Turn monitoring back on', size: 'sm', variant: 'secondary', onClick: () => void setEnabled(true) });
  const feedbackBanner = h(
    'div',
    { class: 'rw-monitor__banner rw-monitor__banner--danger', role: 'alert' },
    icon('error'),
    h(
      'div',
      { class: 'rw-monitor__banner-text' },
      h('strong', null, 'Feedback detected — monitoring lowered'),
      h('p', null, 'Turn the volume down or move away from the speakers, then turn monitoring back on.'),
    ),
    reenable,
  );
  const micNote = h(
    'p',
    { class: 'rw-monitor__note' },
    icon('info'),
    'The input is the built-in microphone, not a guitar interface: monitoring will also pick up the room.',
  );

  // ---- Amp: presets + knobs --------------------------------------------------------------------
  const presetButtons = new Map<AmpPresetId, HTMLButtonElement>();
  const presetGroup = h('div', { class: 'rw-monitor__presets', role: 'radiogroup', 'aria-label': 'Amp preset' });
  for (const id of AMP_PRESET_ORDER) {
    const b = h(
      'button',
      { type: 'button', class: 'rw-monitor__preset', role: 'radio', dataset: { preset: id }, on: { click: () => monitor.setPreset(id) } },
      AMP_PRESETS[id].label,
    );
    presetButtons.set(id, b);
    presetGroup.append(b);
  }
  const roving = rovingFocus(presetGroup, { items: () => [...presetButtons.values()], orientation: 'horizontal', onMove: (item) => item.click() });
  cleanups.push(() => roving.destroy());
  const presetDesc = h('p', { class: 'rw-monitor__preset-desc' });

  const knob = (opts: { label: string; min: number; max: number; step: number; format: (v: number) => string; apply: (v: number) => void }): Slider =>
    slider({ ...opts, value: 0, onInput: throttled(opts.apply), onChange: opts.apply });
  const drive = knob({
    label: 'Drive',
    min: 0,
    max: Math.round(driveToDb(AMP_RANGES.drive.max)),
    step: 0.5,
    format: (v) => `${fmtDb(v)} · ${driveCharacter(dbToDrive(v))}`,
    apply: (v) => monitor.setParams({ drive: dbToDrive(v) }),
  });
  const toneKnob = (label: string, band: 'low' | 'mid' | 'high'): Slider =>
    knob({ label, min: AMP_RANGES.tone.min, max: AMP_RANGES.tone.max, step: 0.5, format: fmtDb, apply: (v) => monitor.setParams({ [band]: v }) });
  const bass = toneKnob('Bass', 'low');
  const mid = toneKnob('Mid', 'mid');
  const treble = toneKnob('Treble', 'high');
  const level = knob({ label: 'Level', min: AMP_RANGES.level.min, max: AMP_RANGES.level.max, step: 0.5, format: fmtDb, apply: (v) => monitor.setParams({ level: v }) });
  const knobs = [drive, bass, mid, treble, level];

  // ---- Latency ---------------------------------------------------------------------------------
  const latTotal = h('span', { class: 'rw-monitor__lat-total rw-num' });
  const latBand = h('span');
  const latSegs = {
    input: h('span', { class: 'rw-monitor__seg rw-monitor__seg--input' }),
    processing: h('span', { class: 'rw-monitor__seg rw-monitor__seg--processing' }),
    output: h('span', { class: 'rw-monitor__seg rw-monitor__seg--output' }),
  };
  const latLegend = {
    input: h('dd', { class: 'rw-num' }),
    processing: h('dd', { class: 'rw-num' }),
    output: h('dd', { class: 'rw-num' }),
  };
  const latCalib = h('p', { class: 'rw-monitor__calib' });
  const tips = h('ul', { class: 'rw-monitor__tips' }, ...LATENCY_TIPS.map((t) => h('li', null, t)));
  const tipsBox = h('details', { class: 'rw-monitor__tips-box' }, h('summary', null, 'Tips to lower the delay'), tips);
  const latency = h(
    'section',
    { class: 'rw-monitor__latency', 'aria-labelledby': 'rw-monitor-lat-title' },
    h(
      'div',
      { class: 'rw-monitor__lat-head' },
      h('h4', { id: 'rw-monitor-lat-title', class: 'rw-monitor__h' }, 'Monitoring delay'),
      latBand,
    ),
    h('p', { class: 'rw-monitor__lat-line' }, h('span', { class: 'rw-monitor__approx' }, '≈'), latTotal, badge('estimated', { tone: 'neutral', title: 'Computed from what the browser reports; calibrate to measure.' })),
    h('div', { class: 'rw-monitor__bar', 'aria-hidden': 'true' }, latSegs.input, latSegs.processing, latSegs.output),
    h(
      'dl',
      { class: 'rw-monitor__legend' },
      h('div', null, h('dt', null, h('i', { class: 'rw-monitor__dot rw-monitor__dot--input' }), 'Input'), latLegend.input),
      h('div', null, h('dt', null, h('i', { class: 'rw-monitor__dot rw-monitor__dot--processing' }), 'Processing'), latLegend.processing),
      h('div', null, h('dt', null, h('i', { class: 'rw-monitor__dot rw-monitor__dot--output' }), 'Output'), latLegend.output),
    ),
    latCalib,
    tipsBox,
  );

  root.replaceChildren(
    h('div', { class: 'rw-monitor__top' }, power.el, statusSlot),
    headphones,
    speakerBanner,
    feedbackBanner,
    micNote,
    h(
      'section',
      { class: 'rw-monitor__amp', 'aria-labelledby': 'rw-monitor-amp-title' },
      h('h4', { id: 'rw-monitor-amp-title', class: 'rw-monitor__h' }, 'Amp'),
      presetGroup,
      presetDesc,
      h('div', { class: 'rw-monitor__knobs' }, ...knobs.map((k) => k.el)),
    ),
    latency,
  );

  // ---- Rendering -------------------------------------------------------------------------------
  const renderStatus = (): void => {
    const status = monitorStatus({
      enabled: settings.monitor.enabled,
      hasInput: input.getInputNode() !== null,
      speakerMuted: guard.speakerLabel !== null,
      feedback: guard.feedback,
    });
    const b = STATUS_BADGE[status];
    statusSlot.replaceChildren(badge(b.text, { tone: b.tone }));
    root.dataset.status = status;
    speakerBanner.hidden = guard.speakerLabel === null;
    speakerBanner.querySelector('.rw-monitor__speaker-label')!.textContent = guard.speakerLabel ? `Output: ${guard.speakerLabel}` : '';
    feedbackBanner.hidden = !guard.feedback;
    micNote.hidden = !isBuiltInMic(input.current?.device.label);
  };

  const renderAmp = (): void => {
    const m = settings.monitor;
    headphones.hidden = m.headphonesCardSeen;
    power.set(m.enabled);
    for (const [id, b] of presetButtons) b.setAttribute('aria-checked', String(id === m.preset));
    roving.focusItem(AMP_PRESET_ORDER.indexOf(m.preset), { focus: false });
    presetDesc.textContent = AMP_PRESETS[m.preset].description;
    const bypass = AMP_PRESETS[m.preset].amp.bypass;
    drive.set(driveToDb(m.drive));
    bass.set(m.tone.low);
    mid.set(m.tone.mid);
    treble.set(m.tone.high);
    level.set(m.level);
    for (const k of knobs) k.setDisabled(bypass);
  };

  const renderLatency = (): void => {
    const est = monitor.latency();
    const b = latencyBreakdown(est);
    latTotal.textContent = fmtMs(b.totalMs);
    const band = BAND_BADGE[est.band];
    latBand.replaceChildren(badge(band.text, { tone: band.tone }));
    latency.dataset.band = est.band;
    const pct = (v: number): string => `${((v / Math.max(b.totalMs, 1e-9)) * 100).toFixed(2)}%`;
    latSegs.input.style.width = pct(b.inputMs);
    latSegs.processing.style.width = pct(b.processingMs);
    latSegs.output.style.width = pct(b.outputMs);
    latLegend.input.textContent = `${fmtMs(b.inputMs)}${b.assumedInput ? ' (assumed)' : ''}`;
    latLegend.processing.textContent = fmtMs(b.processingMs);
    latLegend.output.textContent = `${fmtMs(b.outputMs)}${b.assumedOutput ? ' (assumed)' : ''}`;
    latCalib.textContent =
      est.calibratedOffsetMs !== null
        ? `Calibrated offset ≈ ${Math.round(est.calibratedOffsetMs)} ms (measured round trip, including your own timing).`
        : 'This is an estimate from what the browser reports. Run latency calibration to measure the real round trip.';
    tipsBox.open = est.band === 'noticeable';
  };

  const renderAll = (): void => {
    renderAmp();
    renderStatus();
    renderLatency();
  };

  async function setEnabled(on: boolean): Promise<void> {
    power.button.disabled = true;
    reenable.disabled = true;
    try {
      if (on) await ctx.ui.requireAudioGesture();
      await monitor.setEnabled(on);
      if (on) guard.feedback = false;
    } catch (err) {
      if (!(err instanceof AudioGestureDismissedError)) ctx.ui.toast(`Could not turn monitoring ${on ? 'on' : 'off'}: ${message(err)}`, { kind: 'error' });
    } finally {
      power.button.disabled = false;
      reenable.disabled = false;
      settings = ctx.settings.get();
      renderAll();
    }
  }

  cleanups.push(
    ctx.settings.subscribe((next) => {
      settings = next;
      renderAll();
    }),
    monitor.onGuard((ev: MonitorGuardEvent) => {
      if (ev.type === 'speaker-muted') guard.speakerLabel = ev.sinkLabel;
      else if (ev.type === 'feedback-ducked') guard.feedback = true;
      else {
        guard.speakerLabel = null;
        guard.feedback = false;
      }
      renderStatus();
    }),
    input.onDevicesChanged(() => {
      renderStatus();
      renderLatency();
    }),
  );
  const timer = setInterval(renderLatency, LATENCY_REFRESH_MS);
  cleanups.push(() => clearInterval(timer));
  renderAll();
}

/** Run `fn` at most once per animation frame with the latest value. */
function throttled(fn: (v: number) => void): (v: number) => void {
  let pending: number | null = null;
  return (v) => {
    const first = pending === null;
    pending = v;
    if (first) {
      requestAnimationFrame(() => {
        const value = pending!;
        pending = null;
        fn(value);
      });
    }
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
