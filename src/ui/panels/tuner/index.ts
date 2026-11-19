/**
 * Tuner panel (T-022): a big, glanceable tuner for use while holding the guitar — note name, cents,
 * an eased needle with a ±3-cent green zone, a strobe band that drifts with the error and stops when
 * in tune, the target string of the current tuning (Drop D etc.) with "tune up/down" guidance, and
 * an adjustable A4 reference. Each string's first in-tune reading dispatches
 * {@link TUNER_IN_TUNE_EVENT} on the panel root. Exports `mount: PanelMount<PanelPropsMap['tuner']>` (contract in
 * `@shared/ui`); registered in `src/ui/panels/index.ts`. See docs/audio-input.md § Tuner.
 * @module
 */
import { createTunerSmoother, type PitchEstimate, type TunerSmoother } from '@core/dsp';
import { STANDARD_TUNING, describeTuning } from '@core/model';
import type { Unsubscribe } from '@shared/clock';
import type { AudioEngine, InputService, TimedAnalysisEvent } from '@shared/services';
import type { AppContext, PanelHandle, PanelMount, PanelPropsMap } from '@shared/ui';
import { badge, button, card, h, setBusy } from '../../components';
import { audioPanelServices, connectInput, describeOpenError, isGestureDismissed, unavailablePanel } from '../input/connect';
import {
  A4_MAX,
  A4_MIN,
  clampA4,
  formatCents,
  instruction,
  stringTargets,
  TUNER_IN_TUNE_EVENT,
  tunerView,
  type StringTarget,
  type TunerView,
} from './model';
import './tuner.css';

type Props = PanelPropsMap['tuner'];

/** Needle swing at ±50 cents, degrees. */
const NEEDLE_MAX_DEG = 60;
/** Needle easing time constant, s. */
const NEEDLE_TAU_SEC = 0.08;
/** Strobe drift per cent of error, px/s (capped). */
const STROBE_PX_PER_CENT = 3;
const STROBE_MAX_PX = 160;
/** Stripe period of the strobe band, px (matches tuner.css). */
const STROBE_PERIOD_PX = 24;
/** Without tuner frames for this long the display goes idle, ms. */
const IDLE_AFTER_MS = 1500;

export const mount: PanelMount<Props> = async (el, ctx, props) => {
  const services = await audioPanelServices(ctx);
  if ('error' in services) return unavailablePanel<Props>(el, { title: 'Tuner', panel: 'tuner', message: services.error });
  const panel = new TunerPanel(el, ctx, services.engine, services.input, props.tuning ?? [...STANDARD_TUNING]);
  panel.start();
  const handle: PanelHandle<Props> = {
    unmount: () => panel.destroy(),
    update: (next) => {
      if (next.tuning !== undefined) panel.setTuning(next.tuning ?? [...STANDARD_TUNING]);
    },
  };
  return handle;
};

class TunerPanel {
  private readonly root: HTMLElement;
  private readonly stage = h('div', { class: 'rw-tuner__stage', dataset: { state: 'idle' } });
  private readonly noteName = h('span', { class: 'rw-tuner__name' }, '–');
  private readonly noteOct = h('span', { class: 'rw-tuner__oct' });
  private readonly centsText = h('span', { class: 'rw-tuner__cents rw-num' }, ' ');
  private readonly freqText = h('span', { class: 'rw-tuner__freq rw-num' }, ' ');
  private readonly gaugeSvg: SVGSVGElement;
  private readonly needle: SVGGElement;
  private readonly a4Down: HTMLButtonElement;
  private readonly a4Up: HTMLButtonElement;
  private readonly strobe = h('div', { class: 'rw-tuner__strobe-band' });
  private readonly hint = h('p', { class: 'rw-tuner__hint', 'aria-live': 'polite' }, 'Play an open string');
  private readonly strings = h('ol', { class: 'rw-tuner__strings', 'aria-label': 'Strings' });
  private readonly tuningBadge = h('span');
  private readonly a4Value = h('output', { class: 'rw-tuner__a4-value rw-num' });
  private readonly connectBox: HTMLElement;
  private readonly connectBtn: HTMLButtonElement;
  private readonly unsubs: Unsubscribe[] = [];
  private readonly estimate: PitchEstimate = { freq: 0, midi: 0, cents: 0, clarity: 0 };
  private targets: StringTarget[] = [];
  private tuned = new Set<number>();
  private a4: number;
  private smoother: TunerSmoother;
  private view: TunerView | null = null;
  private lastFrameAt = -Infinity;
  private needleDeg = 0;
  private strobeX = 0;
  private lastTick = performance.now();
  private raf = 0;
  private destroyed = false;

  constructor(
    host: HTMLElement,
    private readonly ctx: AppContext,
    private readonly engine: AudioEngine,
    private readonly input: InputService,
    tuning: readonly number[],
  ) {
    this.a4 = clampA4(ctx.settings.get().tuner.a4);
    this.smoother = createTunerSmoother({ a4: this.a4 });
    ({ svg: this.gaugeSvg, needle: this.needle } = gauge());
    this.connectBtn = button({ label: 'Connect guitar input', variant: 'primary', size: 'lg', icon: 'audio', onClick: () => void this.connect() });
    this.connectBox = h(
      'div',
      { class: 'rw-tuner__connect' },
      h('p', null, 'Connect your guitar input to tune.'),
      this.connectBtn,
    );
    const display = h(
      'div',
      { class: 'rw-tuner__display' },
      h('div', { class: 'rw-tuner__readout' }, h('div', { class: 'rw-tuner__note' }, this.noteName, this.noteOct), h('div', { class: 'rw-tuner__numbers' }, this.centsText, this.freqText)),
      this.gaugeSvg,
      h('div', { class: 'rw-tuner__strobe', 'aria-hidden': 'true' }, this.strobe),
      this.hint,
    );
    this.stage.append(display, this.connectBox);
    this.a4Down = stepButton('\u2212', 'Lower the A4 reference by 1 Hz', () => void this.setA4(this.a4 - 1));
    this.a4Up = stepButton('+', 'Raise the A4 reference by 1 Hz', () => void this.setA4(this.a4 + 1));
    const a4Controls = h(
      'div',
      { class: 'rw-tuner__a4', role: 'group', 'aria-label': 'A4 reference' },
      h('span', { class: 'rw-field__label' }, 'A4'),
      this.a4Down,
      this.a4Value,
      this.a4Up,
    );
    this.root = card({
      title: 'Tuner',
      aside: this.tuningBadge,
      class: 'rw-tuner',
      body: [this.stage, this.strings],
      footer: [h('p', { class: 'rw-muted rw-tuner__note-text' }, 'In tune = within ±3 cents for half a second.'), a4Controls],
    });
    this.root.dataset.panel = 'tuner';
    host.append(this.root);
    this.setTuning(tuning);
    this.renderA4();
  }

  start(): void {
    this.input.setTunerMode(true);
    this.unsubs.push(
      this.input.onAnalysis((ev) => this.onAnalysis(ev)),
      this.input.onDevicesChanged(() => this.renderConnect()),
      this.ctx.settings.subscribe((s) => {
        const a4 = clampA4(s.tuner.a4);
        if (a4 !== this.a4) this.applyA4(a4);
      }),
    );
    this.renderConnect();
    this.raf = requestAnimationFrame(this.tick);
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    for (const u of this.unsubs.splice(0)) u();
    this.input.setTunerMode(false);
    this.root.remove();
  }

  setTuning(tuning: readonly number[]): void {
    this.targets = stringTargets(tuning);
    this.tuned = new Set();
    const name = describeTuning(tuning);
    this.tuningBadge.replaceChildren(badge(name.label, { tone: name.id === 'standard' ? 'neutral' : 'accent' }));
    // Strings read low → high, the way guitarists name a tuning.
    this.strings.replaceChildren(
      ...[...this.targets].reverse().map((t) =>
        h(
          'li',
          { class: 'rw-tuner__string', style: `--string-color: var(--string-${t.string})`, dataset: { string: String(t.string) } },
          h('span', { class: 'rw-tuner__string-num' }, String(t.string)),
          h('span', { class: 'rw-tuner__string-note' }, t.name, h('small', null, String(t.octave))),
        ),
      ),
    );
    this.view = null;
    this.smoother.reset();
  }

  // ---------------------------------------------------------------------------------------------

  private async connect(): Promise<void> {
    setBusy(this.connectBtn, true);
    try {
      await connectInput(this.ctx, this.engine, this.input);
    } catch (err) {
      if (!isGestureDismissed(err)) this.ctx.ui.toast(describeOpenError(err), { kind: 'error' });
    } finally {
      setBusy(this.connectBtn, false);
    }
    this.renderConnect();
  }

  private renderConnect(): void {
    this.connectBox.hidden = this.input.current !== null;
    this.stage.classList.toggle('is-offline', this.input.current === null);
  }

  private async setA4(a4: number): Promise<void> {
    const next = clampA4(a4);
    if (next === this.a4) return;
    this.applyA4(next);
    await this.ctx.settings.update({ tuner: { a4: next } });
  }

  private applyA4(a4: number): void {
    this.a4 = a4;
    this.smoother = createTunerSmoother({ a4 });
    this.view = null;
    this.renderA4();
  }

  private renderA4(): void {
    this.a4Value.textContent = `${this.a4} Hz`;
    this.a4Down.disabled = this.a4 <= A4_MIN;
    this.a4Up.disabled = this.a4 >= A4_MAX;
  }

  private onAnalysis(ev: TimedAnalysisEvent): void {
    if (ev.type !== 'tuner') return;
    this.lastFrameAt = performance.now();
    const est = this.estimate;
    est.freq = ev.freq;
    est.clarity = ev.clarity;
    const reading = this.smoother.push(ev.freq > 0 ? est : null, ev.ctxTime);
    this.view = reading ? tunerView(reading, this.targets, this.a4) : null;
    this.render();
  }

  private render(): void {
    const v = this.view;
    const idle = !v || performance.now() - this.lastFrameAt > IDLE_AFTER_MS;
    const state = idle ? 'idle' : v.inTune ? 'in-tune' : v.live ? 'live' : 'held';
    this.stage.dataset.state = state;
    if (idle || !v) {
      this.noteName.textContent = '–';
      this.noteOct.textContent = '';
      this.centsText.textContent = ' ';
      this.freqText.textContent = ' ';
      setText(this.hint, this.input.current ? 'Play an open string' : 'Waiting for input');
      this.highlight(null);
      return;
    }
    this.noteName.textContent = v.note.name;
    this.noteOct.textContent = String(v.note.octave);
    this.centsText.textContent = `${formatCents(v.cents)} ¢`;
    this.freqText.textContent = `${v.freq.toFixed(1)} Hz`;
    setText(this.hint, instruction(v));
    if (v.inTune && !this.tuned.has(v.target.string)) {
      this.tuned.add(v.target.string);
      this.root.dispatchEvent(new CustomEvent(TUNER_IN_TUNE_EVENT, { bubbles: true, detail: { string: v.target.string } }));
    }
    this.highlight(v);
  }

  private highlight(v: TunerView | null): void {
    for (const li of Array.from(this.strings.children) as HTMLElement[]) {
      const n = Number(li.dataset.string);
      li.classList.toggle('is-target', v !== null && v.target.string === n);
      li.classList.toggle('is-done', this.tuned.has(n));
      if (v && v.target.string === n) li.dataset.direction = v.direction;
      else delete li.dataset.direction;
    }
  }

  private tick = (now: number): void => {
    if (this.destroyed) return;
    const dt = Math.min(0.1, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;
    if (now - this.lastFrameAt > IDLE_AFTER_MS && this.stage.dataset.state !== 'idle') this.render();
    const v = this.view;
    const active = v !== null && this.stage.dataset.state !== 'idle';
    const cents = active ? clampCents(v.cents) : 0;
    const target = (cents / 50) * NEEDLE_MAX_DEG;
    this.needleDeg += (target - this.needleDeg) * (1 - Math.exp(-dt / NEEDLE_TAU_SEC));
    this.needle.setAttribute('transform', `rotate(${this.needleDeg.toFixed(2)} 100 100)`);
    if (active && v.live && Math.abs(v.cents) > 0.5) {
      const speed = Math.max(-STROBE_MAX_PX, Math.min(STROBE_MAX_PX, v.cents * STROBE_PX_PER_CENT));
      this.strobeX = (((this.strobeX + speed * dt) % STROBE_PERIOD_PX) + STROBE_PERIOD_PX) % STROBE_PERIOD_PX;
      this.strobe.style.transform = `translateX(${(this.strobeX - STROBE_PERIOD_PX).toFixed(1)}px)`;
    }
    this.raf = requestAnimationFrame(this.tick);
  };
}

function clampCents(c: number): number {
  return Math.max(-50, Math.min(50, c));
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** A small ghost button with a text glyph and an accessible name. */
function stepButton(glyph: string, label: string, onClick: () => void): HTMLButtonElement {
  return h('button', { type: 'button', class: 'rw-btn rw-btn--ghost rw-btn--sm rw-btn--icon rw-tuner__step', 'aria-label': label, title: label, on: { click: onClick } }, glyph);
}

/** The needle gauge (−50…+50 cents over ±60°) and its needle group (rotated by the panel). */
function gauge(): { svg: SVGSVGElement; needle: SVGGElement } {
  const root = svg('svg', { class: 'rw-tuner__gauge', viewBox: '0 0 200 112', 'aria-hidden': 'true' });
  const cx = 100;
  const cy = 100;
  const r = 86;
  const point = (deg: number, radius: number): [number, number] => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [cx + radius * Math.cos(a), cy + radius * Math.sin(a)];
  };
  const arc = (from: number, to: number, radius: number): string => {
    const [x1, y1] = point(from, radius);
    const [x2, y2] = point(to, radius);
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  };
  root.append(svg('path', { class: 'rw-tuner__arc', d: arc(-NEEDLE_MAX_DEG, NEEDLE_MAX_DEG, r) }));
  const zone = (3 / 50) * NEEDLE_MAX_DEG;
  root.append(svg('path', { class: 'rw-tuner__zone', d: arc(-zone, zone, r) }));
  for (let c = -50; c <= 50; c += 10) {
    const deg = (c / 50) * NEEDLE_MAX_DEG;
    const major = c === 0 || Math.abs(c) === 50;
    const [x1, y1] = point(deg, r - (major ? 14 : 8));
    const [x2, y2] = point(deg, r + 2);
    root.append(svg('line', { class: major ? 'rw-tuner__tick is-major' : 'rw-tuner__tick', x1, y1, x2, y2 }));
  }
  const [lx, ly] = point(-NEEDLE_MAX_DEG, r + 12);
  const [rx, ry] = point(NEEDLE_MAX_DEG, r + 12);
  root.append(
    Object.assign(svg('text', { class: 'rw-tuner__flat', x: lx - 6, y: ly + 4 }), { textContent: '♭' }),
    Object.assign(svg('text', { class: 'rw-tuner__sharp', x: rx + 2, y: ry + 4 }), { textContent: '♯' }),
  );
  const needle = svg('g', { class: 'rw-tuner__needle' });
  needle.append(svg('line', { x1: cx, y1: cy, x2: cx, y2: cy - r + 4 }), svg('circle', { cx, cy, r: 6 }));
  root.append(needle);
  return { svg: root, needle };
}
