/**
 * Section/bar strip for A/B loop editing (T-032). Sections are drawn as labelled blocks over bar
 * ticks, proportional to time. Pointer gestures:
 * - drag across the strip → a loop over that range, snapped to sections then bars (`snapLoop`);
 * - drag an existing A or B edge → move that edge (snapped);
 * - click → loop the section (or bar) under the pointer.
 * The loop, its pre-roll, a pending A marker and the heard playhead are drawn on top.
 *
 * The strip never takes keyboard focus (pointer only; the panel offers keyboard equivalents).
 * @module
 */
import type { BarLoop } from '@shared/judge';
import type { Song } from '@shared/song';
import { snapLoop } from '@core/practice';
import { h } from '../../components';
import { barIndexAt, barLineTime, barTickEvery, describeLoop, fractionToTime, sectionIndexAtBar, sectionLoop, timeToFraction } from './model';

/** Pixels the pointer must move before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 4;
/** Pixels around an A/B edge that grab the edge instead of starting a new range. */
const EDGE_GRAB_PX = 8;

/** Options for {@link loopStrip}. */
export interface LoopStripOptions {
  song: Song;
  /** A new loop chosen on the strip (already snapped). */
  onSelect: (loop: BarLoop) => void;
}

/** The strip and its setters. */
export interface LoopStrip {
  el: HTMLElement;
  /** Show the applied loop and its pre-roll (song seconds); null hides it. */
  setLoop(loop: BarLoop | null, prerollSec: number): void;
  setPendingA(bar: number | null): void;
  /** Move the playhead (song seconds; heard time). */
  setPlayhead(songTime: number): void;
  destroy(): void;
}

type DragMode = 'range' | 'start' | 'end';

/** Build the loop strip. */
export function loopStrip(opts: LoopStripOptions): LoopStrip {
  const { song } = opts;
  const bars = song.timing.bars;
  const pct = (t: number): string => `${(timeToFraction(song, t) * 100).toFixed(3)}%`;
  const spanStyle = (a: number, b: number): string => `left:${pct(a)};width:calc(${pct(b)} - ${pct(a)})`;

  const sectionsRow = h(
    'div',
    { class: 'rw-loopstrip__sections' },
    song.sections.map((s, i) =>
      h(
        'div',
        { class: `rw-loopstrip__section${i % 2 ? ' rw-loopstrip__section--alt' : ''}`, style: spanStyle(s.start, s.end), title: s.name, dataset: { section: String(i) } },
        h('span', { class: 'rw-loopstrip__section-name' }, s.name),
      ),
    ),
  );
  const every = barTickEvery(bars.length);
  const labelEvery = Math.max(every, barTickEvery(bars.length * 4));
  const ticks = h(
    'div',
    { class: 'rw-loopstrip__bars' },
    bars
      .filter((_, i) => i % every === 0)
      .map((b) =>
        h(
          'span',
          { class: `rw-loopstrip__tick${b.index % labelEvery === 0 ? ' rw-loopstrip__tick--label' : ''}`, style: `left:${pct(b.time)}` },
          b.index % labelEvery === 0 ? String(b.index + 1) : null,
        ),
      ),
  );
  const preroll = h('div', { class: 'rw-loopstrip__preroll', hidden: true });
  const region = h(
    'div',
    { class: 'rw-loopstrip__loop', hidden: true },
    h('span', { class: 'rw-loopstrip__edge rw-loopstrip__edge--a' }, 'A'),
    h('span', { class: 'rw-loopstrip__edge rw-loopstrip__edge--b' }, 'B'),
  );
  const preview = h('div', { class: 'rw-loopstrip__preview', hidden: true });
  const pending = h('div', { class: 'rw-loopstrip__pending', hidden: true }, h('span', { class: 'rw-loopstrip__edge rw-loopstrip__edge--a' }, 'A'));
  const playhead = h('div', { class: 'rw-loopstrip__playhead' });
  const el = h(
    'div',
    { class: 'rw-loopstrip', role: 'img', 'aria-label': 'Loop strip: no loop' },
    sectionsRow,
    ticks,
    preroll,
    region,
    pending,
    preview,
    playhead,
  );

  let loop: BarLoop | null = null;
  let drag: { mode: DragMode; pointerId: number; x0: number; t0: number; moved: boolean } | null = null;

  const timeAtClientX = (clientX: number): { t: number; px: number; width: number } => {
    const rect = el.getBoundingClientRect();
    const px = clientX - rect.left;
    return { t: fractionToTime(song, rect.width > 0 ? px / rect.width : 0), px, width: rect.width };
  };

  const edgeAt = (px: number, width: number): DragMode | null => {
    if (!loop || width <= 0) return null;
    const ax = timeToFraction(song, barLineTime(bars, loop.startBar)) * width;
    const bx = timeToFraction(song, barLineTime(bars, loop.endBar)) * width;
    const da = Math.abs(px - ax);
    const db = Math.abs(px - bx);
    if (Math.min(da, db) > EDGE_GRAB_PX) return null;
    return da <= db ? 'start' : 'end';
  };

  const showPreview = (l: BarLoop | null): void => {
    preview.hidden = !l;
    if (l) preview.setAttribute('style', spanStyle(barLineTime(bars, l.startBar), barLineTime(bars, l.endBar)));
  };

  const resolve = (mode: DragMode, t0: number, t: number): BarLoop => {
    if (mode === 'range' || !loop) return snapLoop(song, t0, t);
    const aTime = barLineTime(bars, loop.startBar);
    const bTime = barLineTime(bars, loop.endBar);
    if (mode === 'start') {
      const startBar = t >= bTime ? loop.endBar - 1 : Math.min(snapLoop(song, t, bTime).startBar, loop.endBar - 1);
      return { startBar, endBar: loop.endBar };
    }
    const endBar = t <= aTime ? loop.startBar + 1 : Math.max(loop.startBar + 1, snapLoop(song, aTime, t).endBar);
    return { startBar: loop.startBar, endBar };
  };

  const onDown = (ev: PointerEvent): void => {
    if (ev.button !== 0 || bars.length === 0) return;
    ev.preventDefault(); // no focus, no text selection
    const { t, px, width } = timeAtClientX(ev.clientX);
    drag = { mode: edgeAt(px, width) ?? 'range', pointerId: ev.pointerId, x0: ev.clientX, t0: t, moved: false };
    el.setPointerCapture?.(ev.pointerId);
    el.classList.add('rw-loopstrip--active');
  };

  const onMove = (ev: PointerEvent): void => {
    if (!drag || ev.pointerId !== drag.pointerId) {
      if (!drag) {
        const { px, width } = timeAtClientX(ev.clientX);
        el.classList.toggle('rw-loopstrip--edge-hover', edgeAt(px, width) !== null);
      }
      return;
    }
    if (!drag.moved && Math.abs(ev.clientX - drag.x0) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    showPreview(resolve(drag.mode, drag.t0, timeAtClientX(ev.clientX).t));
  };

  const onUp = (ev: PointerEvent): void => {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    el.releasePointerCapture?.(ev.pointerId);
    el.classList.remove('rw-loopstrip--active');
    showPreview(null);
    if (!d.moved && Math.abs(ev.clientX - d.x0) >= DRAG_THRESHOLD_PX) d.moved = true;
    if (d.moved) {
      opts.onSelect(resolve(d.mode, d.t0, timeAtClientX(ev.clientX).t));
      return;
    }
    // A click: loop the section (or the bar) under the pointer.
    const bar = barIndexAt(bars, d.t0);
    const idx = sectionIndexAtBar(song.sections, bar);
    const l = sectionLoop(song, idx, bar);
    if (l) opts.onSelect(l);
  };

  const onCancel = (ev: PointerEvent): void => {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    drag = null;
    el.classList.remove('rw-loopstrip--active');
    showPreview(null);
  };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);

  return {
    el,
    setLoop(next, prerollSec) {
      loop = next;
      region.hidden = !next;
      preroll.hidden = !next || prerollSec <= 0;
      if (!next) {
        el.setAttribute('aria-label', 'Loop strip: no loop');
        return;
      }
      const a = barLineTime(bars, next.startBar);
      const b = barLineTime(bars, next.endBar);
      region.setAttribute('style', spanStyle(a, b));
      preroll.setAttribute('style', spanStyle(Math.max(0, a - prerollSec), a));
      el.setAttribute('aria-label', `Loop strip: ${describeLoop(next).label} looped`);
    },
    setPendingA(bar) {
      pending.hidden = bar === null;
      if (bar !== null) pending.setAttribute('style', `left:${pct(barLineTime(bars, bar))}`);
    },
    setPlayhead(songTime) {
      const f = Number.isFinite(songTime) ? timeToFraction(song, songTime) : 0;
      playhead.style.left = `${(f * 100).toFixed(3)}%`;
    },
    destroy() {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.remove();
    },
  };
}
