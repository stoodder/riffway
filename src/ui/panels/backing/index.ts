/**
 * Backing audio panel (T-027): attach a recording the user owns, align it to the tab and preview it.
 * Exports `mount: PanelMount<PanelPropsMap['backing']>` (contract in `@shared/ui`); registered in
 * `src/ui/panels/index.ts`. Alignment model: docs/timing.md § Backing audio alignment.
 *
 * - Waveform of the recording drawn **through the warp** under the tab's beat grid (downbeats
 *   numbered); drag it sideways to set the offset, or nudge ±10 / ±1 ms (arrow keys on the waveform).
 * - "Tap along": the backing plays alone (no click, guide muted) from one bar before the chosen bar;
 *   the player taps Space/T (or the Tap button) on the beat starting at that bar's downbeat. One tap
 *   fixes the offset; taps over ≥ 2 s also fit the tempo ratio (`align.ts`).
 * - "Play check": backing + metronome at 100/85/70 % (time-stretched, no pitch change).
 * - Toggles for backing on/off and "mute guide while backing plays"; gain; remove.
 *
 * Previews drive the engine transport directly, so the panel belongs on the song page, not inside a
 * running game session.
 * @module
 */
import type { Unsubscribe } from '@shared/clock';
import type { AudioEngine, BackingService } from '@shared/services';
import type { AudioLink, WarpAnchor } from '@shared/storage';
import type { AppContext, PanelHandle, PanelMount, PanelPropsMap } from '@shared/ui';
import { alignFromTaps } from '../../../audio/backing/align';
import { BackingError, guideShouldMute } from '../../../audio/backing';
import { audioTimeAt, nudgeAnchors, shiftAnchors, slopeAt, summarizeWarp } from '../../../audio/backing/warp';
import { badge, button, card, h, select, slider, toggle, type Select, type Toggle } from '../../components';
import {
  DEFAULT_ZOOM_BARS,
  ZOOM_BARS,
  type Peaks,
  type ViewWindow,
  beatLines,
  computePeaks,
  downbeatIndex,
  formatOffset,
  formatTempo,
  songToX,
  viewForBar,
  waveformColumns,
} from './model';
import './backing.css';

type Props = PanelPropsMap['backing'];

/** File picker filter (extensions plus the matching MIME types). */
const ACCEPT = '.mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a';
/** Preview speeds offered by "Play check". */
const CHECK_SPEEDS = [1, 0.85, 0.7] as const;
const GAIN_MIN_DB = -24;
const GAIN_MAX_DB = 6;
/** Waveform canvas height (CSS px). */
const WAVE_HEIGHT = 140;

type Mode = 'idle' | 'check' | 'tap';
type State = { kind: 'loading' } | { kind: 'empty' } | { kind: 'error'; message: string } | { kind: 'ready' };

export const mount: PanelMount<Props> = async (el, ctx, props) => {
  const [engine, backing] = await Promise.all([ctx.services.get('engine'), ctx.services.get('backing')]);
  const panel = new BackingPanel(el, ctx, engine, backing, props);
  void panel.init();
  const handle: PanelHandle<Props> = {
    unmount: () => panel.destroy(),
    update: (next) => panel.setProps(next),
  };
  return handle;
};

const errorMessage = (err: unknown): string =>
  err instanceof BackingError ? err.message : `Something went wrong: ${err instanceof Error ? err.message : String(err)}`;

class BackingPanel {
  private readonly root: HTMLElement;
  private readonly body = h('div', { class: 'rw-backing__body' });
  private readonly fileInput = h('input', { type: 'file', accept: ACCEPT, class: 'rw-backing__file', hidden: true, tabindex: '-1' });
  private readonly canvas = h('canvas', {
    class: 'rw-backing__wave',
    tabindex: '0',
    role: 'img',
    'aria-label': 'Backing waveform under the beat grid. Drag sideways or use the arrow keys to shift the backing.',
  });
  private readonly summary = h('p', { class: 'rw-backing__summary rw-num', 'aria-live': 'polite' });
  private readonly tapCount = h('span', { class: 'rw-backing__tap-count rw-num', 'aria-live': 'polite' });
  private readonly unsubs: Unsubscribe[] = [];
  private props: Props;
  private state: State = { kind: 'loading' };
  private link: AudioLink | null = null;
  private peaks: Peaks | null = null;
  private viewBar = 0;
  private zoomBars: number = DEFAULT_ZOOM_BARS;
  private columns: Float32Array | null = null;
  private mode: Mode = 'idle';
  private taps: number[] = [];
  private tapBar = 0;
  private checkSpeed: number = CHECK_SPEEDS[0];
  private guideMutedBefore: boolean | null = null;
  private drag: { x: number; anchors: WarpAnchor[] } | null = null;
  private raf = 0;
  private destroyed = false;
  private enabledToggle: Toggle | null = null;
  private barSelect: Select | null = null;

  constructor(
    host: HTMLElement,
    private readonly ctx: AppContext,
    private readonly engine: AudioEngine,
    private readonly backing: BackingService,
    props: Props,
  ) {
    this.props = props;
    this.root = card({ title: 'Backing audio', headingLevel: 2, class: 'rw-backing', body: [this.body, this.fileInput] });
    this.root.dataset.state = 'loading';
    host.append(this.root);
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (file) void this.attach(file);
    });
    this.bindCanvas();
    this.unsubs.push(this.engine.transport.onEnded(() => this.stopPreview()));
    this.unsubs.push(this.ctx.settings.subscribe(() => this.applyGuideMute()));
    const onResize = (): void => this.redraw(true);
    window.addEventListener('resize', onResize);
    this.unsubs.push(() => window.removeEventListener('resize', onResize));
    const onKey = (ev: KeyboardEvent): void => this.onTapKey(ev);
    document.addEventListener('keydown', onKey, true);
    this.unsubs.push(() => document.removeEventListener('keydown', onKey, true));
  }

  /** Load the song's link (reusing the service's decoded audio when it is already loaded). */
  async init(): Promise<void> {
    this.render();
    const { songId, arrangement } = this.props;
    let link: AudioLink | null;
    try {
      link = await this.ctx.storage.getAudioLink(songId, arrangement);
    } catch (err) {
      return this.setState({ kind: 'error', message: errorMessage(err) });
    }
    if (this.destroyed) return;
    if (!link) return this.setState({ kind: 'empty' });
    await this.load(link);
  }

  setProps(next: Partial<Props>): void {
    const changed =
      (next.songId !== undefined && next.songId !== this.props.songId) ||
      (next.arrangement !== undefined && next.arrangement !== this.props.arrangement);
    this.props = { ...this.props, ...next };
    if (changed) {
      this.stopPreview();
      this.link = null;
      this.peaks = null;
      this.viewBar = 0;
      void this.init();
    } else if (next.song) {
      this.redraw(true);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.stopPreview();
    cancelAnimationFrame(this.raf);
    for (const u of this.unsubs.splice(0)) u();
    this.root.remove();
  }

  // ---------------------------------------------------------------------------------------------
  // Link lifecycle
  // ---------------------------------------------------------------------------------------------

  private async load(link: AudioLink): Promise<void> {
    this.link = link;
    const current = this.backing.link;
    const loaded = current && current.songId === link.songId && current.arrangement === link.arrangement && current.audioId === link.audioId;
    if (!loaded || !this.backing.buffer) {
      this.setState({ kind: 'loading' });
      try {
        await this.backing.load(link);
      } catch (err) {
        if (!this.destroyed) this.setState({ kind: 'error', message: errorMessage(err) });
        return;
      }
    }
    if (this.destroyed) return;
    this.link = this.backing.link ?? link;
    const buffer = this.backing.buffer;
    this.peaks = buffer ? computePeaks(buffer) : null;
    this.setState({ kind: 'ready' });
    this.applyGuideMute();
  }

  private async attach(file: File): Promise<void> {
    const { songId, arrangement } = this.props;
    this.setState({ kind: 'loading' });
    try {
      const link = await this.backing.attach(file, songId, arrangement);
      if (this.destroyed) return;
      this.ctx.ui.toast(`Attached “${link.fileName}”. Align it to the beat grid below.`, { kind: 'success' });
      await this.load(link);
    } catch (err) {
      this.ctx.ui.toast(errorMessage(err), { kind: 'error' });
      if (this.link) await this.load(this.link);
      else this.setState({ kind: 'empty' });
    }
  }

  private async remove(): Promise<void> {
    const ok = await this.ctx.ui.confirm('Remove the backing audio from this song? The guide synth will play instead.', {
      title: 'Remove backing audio',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    this.stopPreview();
    try {
      await this.backing.detach(this.props.songId, this.props.arrangement);
    } catch (err) {
      this.ctx.ui.toast(errorMessage(err), { kind: 'error' });
      return;
    }
    this.link = null;
    this.peaks = null;
    this.setState({ kind: 'empty' });
    this.applyGuideMute();
  }

  /** Persist new anchors (and apply them to playback). */
  private async setAnchors(anchors: WarpAnchor[]): Promise<void> {
    if (!this.link) return;
    const next = { ...this.link, anchors };
    this.link = next;
    this.redraw(true);
    try {
      await this.backing.update(next);
      this.link = this.backing.link ?? next;
    } catch (err) {
      this.ctx.ui.toast(errorMessage(err), { kind: 'error' });
    }
    this.renderSummary();
  }

  private async setGain(db: number): Promise<void> {
    if (!this.link) return;
    this.link = { ...this.link, gainDb: db };
    await this.backing.update(this.link).catch((err: unknown) => this.ctx.ui.toast(errorMessage(err), { kind: 'error' }));
  }

  private setEnabled(on: boolean): void {
    if (!this.link) return;
    this.link = { ...this.link, enabled: on };
    this.backing.setEnabled(on);
    this.applyGuideMute();
  }

  /** Mute the guide under enabled backing when the setting says so (always during previews). */
  private applyGuideMute(): void {
    const guide = this.ctx.services.peek('guide');
    if (!guide || this.mode !== 'idle') return;
    guide.setMuted(guideShouldMute(this.ctx.settings.get(), this.link));
  }

  // ---------------------------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------------------------

  private setState(state: State): void {
    this.state = state;
    if (this.destroyed) return;
    this.render();
  }

  private render(): void {
    this.root.dataset.state = this.state.kind;
    this.enabledToggle = null;
    this.barSelect = null;
    const pick = (label: string, variant: 'primary' | 'secondary' = 'primary'): HTMLButtonElement =>
      button({ label, variant, icon: 'music', onClick: () => this.fileInput.click() });
    switch (this.state.kind) {
      case 'loading':
        this.body.replaceChildren(h('p', { class: 'rw-backing__status', role: 'status' }, h('span', { class: 'rw-spinner', 'aria-hidden': 'true' }), 'Loading backing audio…'));
        return;
      case 'empty':
        this.body.replaceChildren(
          h('p', { class: 'rw-backing__lead' }, 'Play along with a recording you own (MP3, WAV or M4A, up to 200 MB). It is copied to Riffway’s data folder on this computer.'),
          h('p', { class: 'rw-backing__hint' }, 'Without backing audio, the guide synth plays the tab.'),
          pick('Attach audio file'),
        );
        return;
      case 'error':
        this.body.replaceChildren(
          h('p', { class: 'rw-backing__error', role: 'alert' }, this.state.message),
          h('div', { class: 'rw-backing__row' }, pick('Attach again'), this.link ? button({ label: 'Remove', variant: 'ghost', onClick: () => void this.remove() }) : null),
        );
        return;
      case 'ready':
        this.renderReady();
    }
  }

  private renderReady(): void {
    const link = this.link!;
    const settings = this.ctx.settings.get();
    this.enabledToggle = toggle({
      label: 'Play backing audio',
      checked: link.enabled,
      onChange: (on) => this.setEnabled(on),
    });
    const guideToggle = toggle({
      label: 'Mute guide while backing plays',
      checked: settings.game.muteGuideWithBacking,
      onChange: (on) => void this.ctx.settings.update({ game: { muteGuideWithBacking: on } }),
    });
    const gain = slider({
      label: 'Backing level',
      min: GAIN_MIN_DB,
      max: GAIN_MAX_DB,
      step: 1,
      value: Math.min(GAIN_MAX_DB, Math.max(GAIN_MIN_DB, link.gainDb)),
      format: (v) => `${v > 0 ? '+' : ''}${v} dB`,
      onChange: (v) => void this.setGain(v),
    });
    const bars = this.props.song.timing.bars;
    this.barSelect = select({
      label: 'View from bar',
      options: bars.map((b, i) => ({ value: String(i), label: `Bar ${i + 1}` })),
      value: String(this.viewBar),
      onChange: (v) => {
        this.viewBar = Number(v);
        this.redraw(true);
      },
    });
    const zoom = select({
      label: 'Zoom',
      options: ZOOM_BARS.map((n) => ({ value: String(n), label: n === 1 ? '1 bar' : `${n} bars` })),
      value: String(this.zoomBars),
      onChange: (v) => {
        this.zoomBars = Number(v);
        this.redraw(true);
      },
    });
    const nudge = (laterMs: number, label: string, title: string): HTMLButtonElement =>
      button({ label, title, size: 'sm', onClick: () => this.nudge(laterMs) });
    const speed = select({
      label: 'Check speed',
      options: CHECK_SPEEDS.map((s) => ({ value: String(s), label: `${Math.round(s * 100)} %` })),
      value: String(this.checkSpeed),
      onChange: (v) => {
        this.checkSpeed = Number(v);
      },
    });

    this.body.replaceChildren(
      h(
        'div',
        { class: 'rw-backing__file-row' },
        badge('Recording'),
        h('span', { class: 'rw-backing__file-name', title: link.fileName }, link.fileName),
        button({ label: 'Replace…', variant: 'ghost', size: 'sm', onClick: () => this.fileInput.click() }),
        button({ label: 'Remove', variant: 'ghost', size: 'sm', onClick: () => void this.remove() }),
      ),
      h('div', { class: 'rw-backing__toggles' }, this.enabledToggle.el, guideToggle.el, gain.el),
      h(
        'section',
        { class: 'rw-backing__align', 'aria-label': 'Alignment' },
        h('div', { class: 'rw-backing__view' }, this.barSelect.el, zoom.el),
        this.canvas,
        this.summary,
        h(
          'div',
          { class: 'rw-backing__row', role: 'group', 'aria-label': 'Nudge the backing' },
          nudge(-10, '−10 ms', 'Backing 10 ms earlier'),
          nudge(-1, '−1 ms', 'Backing 1 ms earlier'),
          nudge(1, '+1 ms', 'Backing 1 ms later'),
          nudge(10, '+10 ms', 'Backing 10 ms later'),
          button({ label: 'Offset only', variant: 'ghost', size: 'sm', title: 'Drop the tempo fit, keep where the view’s first downbeat lands', onClick: () => void this.resetTempo() }),
        ),
        this.renderTap(),
        h('div', { class: 'rw-backing__row rw-backing__check' }, speed.el, this.previewButton('check')),
      ),
    );
    this.renderSummary();
    this.redraw(true);
  }

  private renderTap(): HTMLElement {
    const box = h('div', { class: 'rw-backing__tap', dataset: { mode: this.mode } });
    if (this.mode !== 'tap') {
      box.append(
        h('p', { class: 'rw-backing__hint' }, 'Tap along: the backing plays alone from one bar before the bar in view. Tap Space or T on every beat, starting on that bar’s first beat. More taps over a longer stretch also fit the tempo.'),
        this.previewButton('tap'),
      );
      return box;
    }
    this.tapCount.textContent = this.tapLabel();
    const tap = button({ label: 'Tap', variant: 'primary', size: 'lg', onClick: () => undefined });
    tap.classList.add('rw-backing__tap-pad');
    tap.addEventListener('pointerdown', (ev) => this.recordTap(ev.timeStamp));
    box.append(
      h('p', { class: 'rw-backing__hint' }, `Start on the first beat of bar ${this.tapBar + 1}.`),
      h('div', { class: 'rw-backing__row' }, tap, this.tapCount),
      h(
        'div',
        { class: 'rw-backing__row' },
        button({ label: 'Apply', variant: 'primary', onClick: () => void this.applyTaps() }),
        button({ label: 'Clear taps', variant: 'ghost', onClick: () => this.clearTaps() }),
        button({ label: 'Cancel', variant: 'ghost', onClick: () => this.stopPreview() }),
      ),
    );
    return box;
  }

  private previewButton(kind: 'check' | 'tap'): HTMLButtonElement {
    const playing = this.mode === kind;
    const label = kind === 'check' ? (playing ? 'Stop check' : 'Play check') : 'Tap along';
    return button({
      label,
      variant: kind === 'tap' ? 'primary' : 'secondary',
      icon: playing ? 'pause' : 'play',
      onClick: () => (playing ? this.stopPreview() : void this.startPreview(kind)),
    });
  }

  private renderSummary(): void {
    if (!this.link) return;
    const s = summarizeWarp(this.link.anchors);
    const tempo = s.anchors > 1 ? ` · recording tempo ${formatTempo(s.tempoPercent)} of the tab` : '';
    this.summary.textContent = `Song start at ${formatOffset(s.offsetMs)} in the recording${tempo} · ${s.anchors} anchor${s.anchors === 1 ? '' : 's'}`;
  }

  private tapLabel(): string {
    return `${this.taps.length} tap${this.taps.length === 1 ? '' : 's'}`;
  }

  // ---------------------------------------------------------------------------------------------
  // Waveform
  // ---------------------------------------------------------------------------------------------

  private view(): ViewWindow {
    return viewForBar(this.props.song.timing.bars, this.viewBar, this.zoomBars);
  }

  /** Redraw the waveform; `recompute` refreshes the cached columns (view, anchors or size changed). */
  private redraw(recompute = false): void {
    if (this.state.kind !== 'ready' || !this.link) return;
    const cssWidth = this.canvas.clientWidth || 640;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(cssWidth * dpr);
    const height = Math.round(WAVE_HEIGHT * dpr);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      recompute = true;
    }
    const view = this.view();
    if (recompute || !this.columns) {
      this.columns = this.peaks ? waveformColumns(this.peaks, this.link.anchors, view, width) : new Float32Array(width);
    }
    const g = this.canvas.getContext('2d');
    if (!g) return;
    const css = getComputedStyle(this.root);
    const color = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
    g.clearRect(0, 0, width, height);
    const mid = height / 2;
    g.fillStyle = color('--color-text-muted', '#a3adbd');
    const cols = this.columns;
    for (let x = 0; x < cols.length; x++) {
      const amp = Math.min(1, cols[x]!) * (mid - 2 * dpr);
      if (amp > 0.5) g.fillRect(x, mid - amp, 1, 2 * amp);
    }
    for (const line of beatLines(this.props.song.timing.bars, view)) {
      const x = Math.round(songToX(line.time, width, view));
      g.fillStyle = line.bar !== null ? color('--color-accent', '#ff8a2b') : color('--color-border-strong', '#364255');
      g.fillRect(x, 0, line.bar !== null ? 2 * dpr : dpr, height);
      if (line.bar !== null) {
        g.font = `${11 * dpr}px ${color('--font-mono', 'monospace')}`;
        g.fillText(String(line.bar), x + 4 * dpr, 12 * dpr);
      }
    }
    if (this.mode !== 'idle') {
      const t = this.engine.clock.heardSongTime();
      if (Number.isFinite(t)) {
        g.fillStyle = color('--color-success', '#4cf5a6');
        g.fillRect(Math.round(songToX(t, width, view)), 0, 2 * dpr, height);
      }
    }
  }

  private bindCanvas(): void {
    this.canvas.style.height = `${WAVE_HEIGHT}px`;
    this.canvas.addEventListener('pointerdown', (ev) => {
      if (!this.link) return;
      this.drag = { x: ev.clientX, anchors: this.link.anchors };
      this.canvas.setPointerCapture?.(ev.pointerId);
    });
    this.canvas.addEventListener('pointermove', (ev) => {
      if (!this.drag || !this.link) return;
      this.link = { ...this.link, anchors: this.dragAnchors(ev.clientX) };
      this.renderSummary();
      this.redraw(true);
    });
    const end = (ev: PointerEvent): void => {
      if (!this.drag) return;
      const anchors = this.dragAnchors(ev.clientX);
      const moved = ev.clientX !== this.drag.x;
      this.drag = null;
      if (moved) void this.setAnchors(anchors);
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      const step = ev.shiftKey ? 1 : 10;
      this.nudge(ev.key === 'ArrowRight' ? step : -step);
    });
  }

  /** Anchors after dragging from the drag start to `clientX`: right = backing later. */
  private dragAnchors(clientX: number): WarpAnchor[] {
    const drag = this.drag!;
    const view = this.view();
    const cssWidth = this.canvas.clientWidth || 640;
    const dSong = ((clientX - drag.x) / cssWidth) * (view.end - view.start);
    return shiftAnchors(drag.anchors, -dSong * slopeAt(drag.anchors, (view.start + view.end) / 2));
  }

  private nudge(laterMs: number): void {
    if (!this.link) return;
    void this.setAnchors(nudgeAnchors(this.link.anchors, laterMs));
  }

  private async resetTempo(): Promise<void> {
    if (!this.link) return;
    const bar = this.props.song.timing.bars[this.viewBar];
    const t = bar?.time ?? 0;
    await this.setAnchors([{ songTime: t, audioTime: audioTimeAt(this.link.anchors, t) }]);
  }

  // ---------------------------------------------------------------------------------------------
  // Previews: play check and tap-along
  // ---------------------------------------------------------------------------------------------

  private async startPreview(kind: 'check' | 'tap'): Promise<void> {
    if (this.mode !== 'idle') this.stopPreview();
    try {
      await this.ctx.ui.requireAudioGesture();
    } catch {
      return; // "Not now": nothing to play
    }
    if (this.destroyed || !this.link) return;
    const { song } = this.props;
    const bars = song.timing.bars;
    const bar = bars[this.viewBar];
    const t = this.engine.transport;
    t.stop();
    t.load({ durationSec: song.meta.durationSec, bars });
    if (kind === 'tap') {
      this.tapBar = this.viewBar;
      this.taps = [];
      t.setMetronome(false);
      t.setSpeed(1);
    } else {
      t.setMetronome(true);
      t.setSpeed(this.checkSpeed);
    }
    const guide = this.ctx.services.peek('guide');
    this.guideMutedBefore = guide ? guide.muted : null;
    guide?.setMuted(true);
    if (!this.link.enabled) {
      this.enabledToggle?.set(true);
      this.setEnabled(true);
    }
    this.mode = kind;
    const lead = kind === 'tap' ? (bar?.dur ?? 2) : (bar?.dur ?? 2) / 4;
    t.play({ from: Math.max(-lead, (bar?.time ?? 0) - lead), countInBars: 0 });
    this.renderReady();
    this.tick();
  }

  private stopPreview(): void {
    if (this.mode === 'idle') return;
    this.mode = 'idle';
    cancelAnimationFrame(this.raf);
    const t = this.engine.transport;
    t.stop();
    t.setSpeed(1);
    t.setMetronome(this.ctx.settings.get().practice.metronome);
    const guide = this.ctx.services.peek('guide');
    if (guide && this.guideMutedBefore !== null) guide.setMuted(this.guideMutedBefore);
    this.guideMutedBefore = null;
    this.applyGuideMute();
    if (!this.destroyed && this.state.kind === 'ready') this.renderReady();
  }

  /** Follow the playhead while previewing. */
  private tick(): void {
    cancelAnimationFrame(this.raf);
    const frame = (): void => {
      if (this.mode === 'idle' || this.destroyed) return;
      const t = this.engine.clock.heardSongTime();
      const view = this.view();
      if (Number.isFinite(t) && t > view.end) {
        const bars = this.props.song.timing.bars;
        const next = Math.min(bars.length - 1, this.viewBar + this.zoomBars);
        if (next !== this.viewBar) {
          this.viewBar = next;
          this.barSelect?.set(String(next));
          this.redraw(true);
        }
      }
      this.redraw();
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private onTapKey(ev: KeyboardEvent): void {
    if (this.mode !== 'tap' || ev.repeat) return;
    if (ev.code !== 'Space' && ev.key !== 't' && ev.key !== 'T') return;
    const target = ev.target as HTMLElement | null;
    if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.recordTap(ev.timeStamp);
  }

  /** A tap at `perfMs` (event timestamp) → the audio-file time being heard, minus the keyboard offset. */
  private recordTap(perfMs: number): void {
    if (this.mode !== 'tap' || !this.link) return;
    const offset = this.ctx.settings.get().calibration.keyboardOffsetMs / 1000;
    const song = this.engine.clock.songTimeAt(this.engine.perfToCtxTime(perfMs) - offset);
    if (!Number.isFinite(song)) return;
    this.taps.push(audioTimeAt(this.link.anchors, song));
    this.tapCount.textContent = this.tapLabel();
  }

  private clearTaps(): void {
    this.taps = [];
    this.tapCount.textContent = this.tapLabel();
  }

  private async applyTaps(): Promise<void> {
    if (!this.link) return;
    const bars = this.props.song.timing.bars;
    const beats = bars.flatMap((b) => b.beats);
    const result = alignFromTaps(this.link.anchors, this.taps, beats, downbeatIndex(bars, this.tapBar));
    this.stopPreview();
    if (!result) {
      this.ctx.ui.toast('No taps to apply. Tap on the beat, starting at the bar’s first beat.', { kind: 'warning' });
      return;
    }
    const { fit } = result;
    const what = fit.kind === 'tempo' ? 'Offset and tempo' : 'Offset';
    const extra = fit.kind === 'offset' && this.taps.length > 1 ? ' Tap longer (≥ 4 taps over 2 s) to fit the tempo too.' : '';
    this.ctx.ui.toast(`${what} set from ${fit.used.length} tap${fit.used.length === 1 ? '' : 's'} (±${Math.round(fit.residualMs)} ms).${extra}`, {
      kind: 'success',
    });
    await this.setAnchors(result.anchors);
  }
}

