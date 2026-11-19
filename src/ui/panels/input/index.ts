/**
 * Guitar input panel (T-022): input/output device pickers, channel select for multi-channel
 * interfaces, a live level meter (zones, 1 s peak hold, clip lamp, "No signal") and the warnings
 * from opening the input (processing flags left on, saved input missing, input unplugged).
 * Exports `mount: PanelMount<PanelPropsMap['input']>` (contract in `@shared/ui`); registered in
 * `src/ui/panels/index.ts`. See docs/audio-input.md.
 * @module
 */
import type { Unsubscribe } from '@shared/clock';
import type { AudioDeviceInfo, AudioEngine, InputService, TimedAnalysisEvent } from '@shared/services';
import type { InputChannel } from '@shared/settings';
import type { AppContext, PanelMount, PanelPropsMap } from '@shared/ui';
import { processingWarningText } from '../../../audio/input/constraints';
import { displayLabel, isAlias, labelsHidden } from '../../../audio/input/devices';
import { badge, button, card, h, icon, meter, select, setBusy, type SelectOption } from '../../components';
import { audioPanelServices, connectInput, describeOpenError, isGestureDismissed, unavailablePanel } from './connect';
import { LevelModel, METER_HOT_DB, METER_MIN_DB, METER_WARN_DB, formatDb } from './level-model';
import './input.css';

/** Hint under the meter. */
export const LEVEL_HINT = 'Aim for peaks around −12 dB; turn the guitar volume up if the meter barely moves.';

const CHANNEL_OPTIONS: SelectOption[] = [
  { value: '0', label: 'Channel 1 (left / input 1)' },
  { value: '1', label: 'Channel 2 (right / input 2)' },
  { value: 'mix', label: 'Mix of channels 1 + 2' },
];

type Notice = { kind: 'warning' | 'danger' | 'info'; text: string; id: string };

export const mount: PanelMount<PanelPropsMap['input']> = async (el, ctx) => {
  const services = await audioPanelServices(ctx);
  if ('error' in services) return unavailablePanel(el, { title: 'Guitar input', eyebrow: 'Step 1', panel: 'input', message: services.error });
  const panel = new InputPanel(el, ctx, services.engine, services.input);
  await panel.start();
  return { unmount: () => panel.destroy() };
};

class InputPanel {
  private readonly root: HTMLElement;
  private readonly status = h('span', { class: 'rw-input__status' });
  private readonly notices = h('div', { class: 'rw-input__notices', 'aria-live': 'polite' });
  private readonly connectBox: HTMLElement;
  private readonly connectBtn: HTMLButtonElement;
  private readonly live: HTMLElement;
  private readonly deviceSel = select({ label: 'Input device', options: [], onChange: (v) => void this.pickInput(v) });
  private readonly channelSel = select({
    label: 'Input channel',
    options: CHANNEL_OPTIONS,
    hint: 'Your interface has more than one input: pick the one the guitar is plugged into.',
    onChange: (v) => void this.pickChannel(v),
  });
  private readonly outputSel = select({ label: 'Output device', options: [], onChange: (v) => void this.pickOutput(v) });
  private readonly levelMeter = meter({
    label: 'Input level',
    kind: 'level',
    min: METER_MIN_DB,
    max: 0,
    format: formatDb,
    zones: { warn: dbFrac(METER_WARN_DB), hot: dbFrac(METER_HOT_DB) },
  });
  private readonly clipLamp = h('span', { class: 'rw-input__clip', 'aria-hidden': 'true' }, 'CLIP');
  private readonly signalNote = h('p', { class: 'rw-input__signal', role: 'status' });
  private readonly details = h('p', { class: 'rw-input__details rw-muted rw-num' });
  private readonly resumeBox: HTMLElement;
  private readonly level = new LevelModel(performance.now());
  private readonly unsubs: Unsubscribe[] = [];
  private raf = 0;
  /** The input was open and closed without the player asking: it was unplugged. */
  private wasOpen = false;
  private disconnected = false;
  private error: string | null = null;
  private destroyed = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly ctx: AppContext,
    private readonly engine: AudioEngine,
    private readonly input: InputService,
  ) {
    this.connectBtn = button({ label: 'Connect guitar input', variant: 'primary', size: 'lg', icon: 'audio', onClick: () => void this.connect() });
    this.connectBox = h(
      'div',
      { class: 'rw-input__connect' },
      h('p', null, 'Plug in your USB guitar cable, then connect. Chrome asks once for microphone access so it can list your inputs.'),
      this.connectBtn,
    );
    this.resumeBox = h(
      'div',
      { class: 'rw-input__resume' },
      icon('power', { size: '18px' }),
      h('span', null, 'Audio is paused, so the meter is still.'),
      button({ label: 'Enable audio', size: 'sm', onClick: () => void this.enableAudio() }),
    );
    this.live = h(
      'div',
      { class: 'rw-input__live' },
      h('div', { class: 'rw-input__pickers' }, this.deviceSel.el, this.channelSel.el, this.outputSel.el),
      this.resumeBox,
      h('div', { class: 'rw-input__meter' }, this.levelMeter.el, this.clipLamp),
      h('p', { class: 'rw-field__hint' }, LEVEL_HINT),
      this.signalNote,
      this.details,
    );
    this.root = card({
      title: 'Guitar input',
      eyebrow: 'Step 1',
      aside: this.status,
      class: 'rw-input',
      body: [this.notices, this.connectBox, this.live],
    });
    this.root.dataset.panel = 'input';
    host.append(this.root);
  }

  async start(): Promise<void> {
    this.unsubs.push(
      this.input.onAnalysis((ev) => this.onAnalysis(ev)),
      this.input.onDevicesChanged(() => this.onDevicesChanged()),
    );
    if (!this.input.current && (await microphoneGranted())) {
      // Permission was given before: re-open the saved input without a prompt.
      try {
        await this.input.open();
      } catch (err) {
        this.error = describeOpenError(err);
      }
    }
    this.wasOpen = this.input.current !== null;
    await this.render();
    this.tick();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    for (const u of this.unsubs.splice(0)) u();
    this.root.remove();
  }

  // ---------------------------------------------------------------------------------------------

  private async connect(): Promise<void> {
    setBusy(this.connectBtn, true);
    this.error = null;
    try {
      await connectInput(this.ctx, this.engine, this.input);
      this.disconnected = false;
      this.wasOpen = true;
      this.level.restart(performance.now());
    } catch (err) {
      if (!isGestureDismissed(err)) this.error = describeOpenError(err);
    } finally {
      setBusy(this.connectBtn, false);
    }
    await this.render();
  }

  private async enableAudio(): Promise<void> {
    try {
      await this.ctx.ui.requireAudioGesture();
    } catch (err) {
      if (!isGestureDismissed(err)) this.ctx.ui.toast(describeOpenError(err), { kind: 'error' });
    }
    this.level.restart(performance.now());
    await this.render();
  }

  private async pickInput(deviceId: string): Promise<void> {
    if (deviceId === this.input.current?.device.deviceId) return;
    this.deviceSel.select.disabled = true;
    try {
      await this.input.open(deviceId);
      this.error = null;
      this.disconnected = false;
      this.wasOpen = true;
      this.level.restart(performance.now());
    } catch (err) {
      this.ctx.ui.toast(describeOpenError(err), { kind: 'error' });
    } finally {
      this.deviceSel.select.disabled = false;
    }
    await this.render();
  }

  private async pickChannel(value: string): Promise<void> {
    const channel: InputChannel = value === 'mix' ? 'mix' : value === '1' ? 1 : 0;
    await this.ctx.settings.update({ input: { channel } });
    this.level.restart(performance.now());
  }

  private async pickOutput(sinkId: string): Promise<void> {
    const outputs = await this.input.listOutputs();
    const label = outputs.find((d) => d.deviceId === sinkId)?.label ?? null;
    try {
      await this.engine.setSinkId(sinkId);
      await this.ctx.settings.update({ output: { sinkId, label } });
    } catch (err) {
      this.ctx.ui.toast(`Couldn't switch the output: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
      this.outputSel.set(this.ctx.settings.get().output.sinkId);
    }
  }

  private onDevicesChanged(): void {
    const open = this.input.current !== null;
    if (this.wasOpen && !open) this.disconnected = true;
    if (open) {
      this.disconnected = false;
      this.level.restart(performance.now());
    }
    this.wasOpen = open;
    void this.render();
  }

  private onAnalysis(ev: TimedAnalysisEvent): void {
    if (ev.type === 'level') this.level.push(ev.peakDb, performance.now());
  }

  private tick = (): void => {
    if (this.destroyed) return;
    const now = performance.now();
    const v = this.level.view(now);
    this.levelMeter.set(v.barDb, v.holdDb);
    this.clipLamp.classList.toggle('is-on', v.clip);
    const listening = this.input.current !== null && this.engine.running;
    const silent = listening && v.noSignal;
    this.signalNote.hidden = !silent;
    this.signalNote.textContent = silent
      ? 'No signal. Check the cable, the guitar’s volume knob and the input channel.'
      : '';
    this.resumeBox.hidden = this.input.current === null || this.engine.running;
    this.raf = requestAnimationFrame(this.tick);
  };

  /** Re-read devices and state into the view. */
  private async render(): Promise<void> {
    const cur = this.input.current;
    const [inputs, outputs] = await Promise.all([this.input.listInputs(), this.input.listOutputs()]);
    if (this.destroyed) return;
    this.connectBox.hidden = cur !== null;
    this.live.hidden = cur === null;
    this.status.replaceChildren(
      cur
        ? badge('Listening', { tone: 'success', icon: 'audio' })
        : this.disconnected
          ? badge('Disconnected', { tone: 'danger', icon: 'warning' })
          : badge('Not connected', { tone: 'neutral' }),
    );

    this.deviceSel.setOptions(deviceOptions(inputs));
    if (cur) this.deviceSel.set(cur.device.deviceId);
    this.channelSel.el.hidden = !cur || cur.channelCount < 2;
    this.channelSel.set(String(this.ctx.settings.get().input.channel));
    this.renderOutputs(outputs);

    if (cur) {
      const parts = [
        `${(cur.sampleRate / 1000).toLocaleString('en', { maximumFractionDigits: 1 })} kHz`,
        cur.channelCount === 1 ? 'mono' : `${cur.channelCount} channels`,
      ];
      if (cur.latency !== null) parts.push(`input latency ${Math.round(cur.latency * 1000)} ms`);
      this.details.textContent = parts.join(' · ');
    }
    this.renderNotices();
  }

  private renderOutputs(outputs: AudioDeviceInfo[]): void {
    const sinkSupported = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
    const opts = deviceOptions(outputs.filter((d) => d.deviceId !== 'default'));
    opts.unshift({ value: '', label: 'System default' });
    this.outputSel.setOptions(opts);
    this.outputSel.set(this.ctx.settings.get().output.sinkId);
    this.outputSel.select.disabled = !sinkSupported || labelsHidden(outputs);
  }

  private renderNotices(): void {
    const cur = this.input.current;
    const list: Notice[] = [];
    if (this.error) list.push({ kind: 'danger', text: this.error, id: 'error' });
    if (!cur && this.disconnected) {
      list.push({
        kind: 'danger',
        id: 'disconnected',
        text: 'Your guitar input was disconnected. Plug it back in and Riffway reconnects automatically.',
      });
    }
    if (cur?.fellBackToDefault) {
      const saved = this.ctx.settings.get().input.label;
      list.push({
        kind: 'warning',
        id: 'fallback',
        text: `Your guitar input wasn’t found${saved ? ` (${saved})` : ''}. Using ${cur.device.label || 'the default input'} for now; plug it in or pick another input.`,
      });
    }
    const processing = cur ? processingWarningText(cur.processingWarnings) : null;
    if (processing) list.push({ kind: 'warning', id: 'processing', text: processing });
    this.notices.replaceChildren(
      ...list.map((n) =>
        h(
          'p',
          { class: `rw-input__notice rw-input__notice--${n.kind}`, dataset: { notice: n.id } },
          icon(n.kind === 'info' ? 'info' : 'warning', { size: '18px' }),
          h('span', null, n.text),
        ),
      ),
    );
  }
}

/** Select options for devices, aliases last; placeholder names while labels are hidden. */
export function deviceOptions(devices: readonly AudioDeviceInfo[]): SelectOption[] {
  const ordered = [...devices.filter((d) => !isAlias(d)), ...devices.filter(isAlias)];
  return ordered.map((d) => ({ value: d.deviceId, label: displayLabel(d, devices.indexOf(d)) }));
}

/** Fraction of the meter (−60…0 dB) at `db`. */
function dbFrac(db: number): number {
  return (db - METER_MIN_DB) / -METER_MIN_DB;
}

/** True when microphone permission is already granted (no prompt would appear). */
async function microphoneGranted(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return status.state === 'granted';
  } catch {
    return false;
  }
}
