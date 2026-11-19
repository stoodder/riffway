/**
 * Rhythm strip (T-028): a small canvas "highway" of the aligned song for the import screen. Six
 * lanes (string 1 = high e on top), notes as fret chips at their aligned times, bar lines and beat
 * ticks from the song's grid, a playhead that follows playback, and a highlighted onset (the next
 * one to tap in tap-along). A range input scrolls it when not following playback.
 * @module
 */
import type { Song } from '@shared/song';
import { h } from '../../components';

/** Lane height and ruler height (CSS px). */
const LANE_H = 22;
const RULER_H = 18;
const HEIGHT = RULER_H + LANE_H * 6 + 8;
/** Left margin so notes at time 0 are not clipped (CSS px). */
const PAD_LEFT = 16;
/** Playhead position while following, as a fraction of the width. */
const FOLLOW_AT = 0.3;

/** Options for {@link RhythmStrip}. */
export interface RhythmStripOptions {
  /** Click on the strip: song time under the pointer (e.g. "play from here"). */
  onPick?: (songTime: number) => void;
}

/** Canvas preview of an aligned song. */
export class RhythmStrip {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly scroller: HTMLInputElement;
  private song: Song | null = null;
  private pxPerSec = 140;
  private viewStart = 0;
  private playhead: number | null = null;
  private highlight: number | null = null;
  private follow = false;
  private width = 0;
  private resizeObs: ResizeObserver | null = null;

  constructor(opts: RhythmStripOptions = {}) {
    this.canvas = h('canvas', { class: 'imp-strip__canvas', height: HEIGHT, 'aria-hidden': 'true' });
    this.scroller = h('input', {
      class: 'imp-strip__scroll',
      type: 'range',
      min: 0,
      max: 0,
      step: 0.01,
      value: 0,
      'aria-label': 'Scroll the rhythm preview',
    });
    this.scroller.addEventListener('input', () => {
      this.follow = false;
      this.viewStart = Number(this.scroller.value);
      this.draw();
    });
    this.canvas.addEventListener('wheel', (ev) => {
      if (!this.song) return;
      const delta = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
      if (!delta) return;
      ev.preventDefault();
      this.follow = false;
      this.setView(this.viewStart + delta / this.pxPerSec);
    });
    this.canvas.addEventListener('click', (ev) => {
      if (!this.song || !opts.onPick) return;
      const rect = this.canvas.getBoundingClientRect();
      opts.onPick(Math.max(0, this.viewStart + (ev.clientX - rect.left - PAD_LEFT) / this.pxPerSec));
    });
    this.el = h('div', { class: 'imp-strip' }, this.canvas, this.scroller);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.draw());
      this.resizeObs.observe(this.el);
    }
  }

  /** Show a song (null clears). Zoom adapts so the closest onsets stay readable. */
  setSong(song: Song | null): void {
    this.song = song;
    if (song) {
      const times = [...new Set(song.notes.map((n) => n.time))];
      let minGap = Infinity;
      for (let i = 1; i < times.length; i++) minGap = Math.min(minGap, times[i] - times[i - 1]);
      this.pxPerSec = Number.isFinite(minGap) ? Math.min(320, Math.max(60, 26 / minGap)) : 140;
    }
    this.setView(this.viewStart);
  }

  /** Playhead at a song time (null hides it). `follow` scrolls so the playhead stays in view. */
  setPlayhead(time: number | null, follow = false): void {
    this.playhead = time;
    this.follow = follow;
    if (follow && time !== null) this.setView(time - (this.visibleSec() * FOLLOW_AT));
    else this.draw();
  }

  /** Outline the onset at `time` (null clears) and scroll it into view. */
  setHighlight(time: number | null): void {
    this.highlight = time;
    if (time !== null && !this.follow && (time < this.viewStart || time > this.viewStart + this.visibleSec())) {
      this.setView(time - this.visibleSec() * FOLLOW_AT);
    } else this.draw();
  }

  /** Scroll to the start. */
  rewind(): void {
    this.follow = false;
    this.setView(0);
  }

  destroy(): void {
    this.resizeObs?.disconnect();
    this.el.remove();
  }

  private visibleSec(): number {
    return ((this.width || this.contentWidth()) - PAD_LEFT) / this.pxPerSec;
  }

  private setView(start: number): void {
    const dur = this.song?.meta.durationSec ?? 0;
    const max = Math.max(0, dur - this.visibleSec() * 0.8);
    this.viewStart = Math.min(Math.max(0, start), max);
    this.scroller.max = String(max);
    this.scroller.value = String(this.viewStart);
    this.scroller.disabled = max <= 0;
    this.draw();
  }

  /** The strip's inner width (CSS px, padding excluded): the canvas never pokes past the frame. */
  private contentWidth(): number {
    const width = this.el.clientWidth;
    if (!width) return 600;
    const css = getComputedStyle(this.el);
    return Math.max(1, Math.floor(width - (parseFloat(css.paddingLeft) || 0) - (parseFloat(css.paddingRight) || 0)));
  }

  /** Redraw (cheap; called per animation frame during playback). */
  draw(): void {
    const g = this.canvas.getContext('2d');
    if (!g) return;
    const cssW = this.contentWidth();
    const dpr = globalThis.devicePixelRatio || 1;
    if (this.width !== cssW || this.canvas.width !== Math.round(cssW * dpr)) {
      this.width = cssW;
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(HEIGHT * dpr);
      this.canvas.style.width = `${cssW}px`;
      this.canvas.style.height = `${HEIGHT}px`;
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(this.el);
    const color = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
    const text = color('--color-text', '#eee');
    const muted = color('--color-text-subtle', '#888');
    const border = color('--color-border', '#333');
    const strong = color('--color-border-strong', '#555');
    const accent = color('--color-accent', '#ff8a2b');
    g.clearRect(0, 0, cssW, HEIGHT);

    for (let s = 0; s < 6; s++) {
      const y = RULER_H + LANE_H * s + LANE_H / 2;
      g.strokeStyle = border;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, y + 0.5);
      g.lineTo(cssW, y + 0.5);
      g.stroke();
    }
    const song = this.song;
    if (!song) return;
    const t0 = this.viewStart;
    const t1 = t0 + (cssW - PAD_LEFT) / this.pxPerSec;
    const x = (t: number): number => PAD_LEFT + (t - t0) * this.pxPerSec;
    const bottom = RULER_H + LANE_H * 6;

    g.font = '600 10px ui-monospace, monospace';
    g.textBaseline = 'middle';
    for (const bar of song.timing.bars) {
      if (bar.time > t1) break;
      if (bar.time + bar.dur < t0) continue;
      for (const [k, beat] of bar.beats.entries()) {
        g.strokeStyle = k === 0 ? strong : border;
        g.lineWidth = k === 0 ? 1.5 : 1;
        g.beginPath();
        g.moveTo(x(beat), k === 0 ? 2 : RULER_H - 6);
        g.lineTo(x(beat), k === 0 ? bottom : RULER_H);
        g.stroke();
      }
      g.fillStyle = muted;
      g.textAlign = 'left';
      g.fillText(String(bar.index + 1), x(bar.time) + 4, 8);
    }

    g.textAlign = 'center';
    for (const n of song.notes) {
      if (n.time < t0 - 0.5) continue;
      if (n.time > t1) break;
      const cx = x(n.time);
      const cy = RULER_H + LANE_H * (n.string - 1) + LANE_H / 2;
      const label = n.tech.dead ? 'x' : String(n.fret);
      const w = Math.max(18, 8 + label.length * 7);
      g.fillStyle = color(`--string-${n.string}`, accent);
      g.globalAlpha = n.tiedFrom !== undefined ? 0.35 : 1;
      roundRect(g, cx - w / 2, cy - 8, w, 16, 5);
      g.fill();
      g.globalAlpha = 1;
      g.fillStyle = '#0b0b10';
      g.fillText(label, cx, cy + 0.5);
    }

    if (this.highlight !== null && this.highlight >= t0 && this.highlight <= t1) {
      g.strokeStyle = accent;
      g.lineWidth = 2;
      g.setLineDash([4, 3]);
      roundRect(g, x(this.highlight) - 14, RULER_H + 1, 28, LANE_H * 6 - 2, 8);
      g.stroke();
      g.setLineDash([]);
    }

    if (this.playhead !== null && this.playhead >= t0 && this.playhead <= t1) {
      g.strokeStyle = text;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x(this.playhead), 0);
      g.lineTo(x(this.playhead), bottom + 4);
      g.stroke();
    }
  }
}

/** Rounded-rectangle path (Canvas `roundRect` is not in every test DOM). */
function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
