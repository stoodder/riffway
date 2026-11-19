/**
 * Canvas highway renderer (T-024): six lanes (high e on top), fret gems, sustains, bar/section lines,
 * technique glyphs, hand-position cue brackets, A/B loop markers, pooled hit feedback and the combo
 * cluster. Reads `clock.heardSongTime()` only; x = hitX + (note.time − heardSongTime) / speed × pxPerSec
 * (docs/game-mechanics.md). Signature frozen by T-010.
 *
 * Structure: `prepare.ts` flattens the song into typed arrays (binary-searched per frame), `layout.ts`
 * holds the geometry, `atlas.ts` / `layers.ts` pre-render sprites and static layers per resize,
 * `fx.ts` / `hud.ts` hold the pooled effects and combo display, `renderer.ts` draws a frame.
 * @module
 */
import type { SongClock } from '@shared/clock';
import type { Highway, HighwayOptions } from '@shared/services';
import type { Song } from '@shared/song';
import { prefersReducedMotion } from '../../ui/design/tokens';
import { HighwayRenderer } from './renderer';

export { HighwayRenderer } from './renderer';
export { BASE_PX_PER_SEC, computeLayout, timeToX, xToTime, type HighwayLayout } from './layout';
export { bendLabel, prepareSong, type PreparedSong } from './prepare';

/** CSS size of the canvas: its laid-out box, else its attributes (detached canvases in tests). */
function cssSize(canvas: HTMLCanvasElement, dpr: number): { w: number; h: number } {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w > 0 && h > 0) return { w, h };
  return { w: canvas.width / dpr || 300, h: canvas.height / dpr || 150 };
}

/**
 * Create a highway on `canvas` for `song`. The renderer never advances time: each frame reads
 * `clock.heardSongTime(perfNow)` (and `clock.speed` for the x mapping). Call `start()` for the rAF
 * loop or `drawFrame(perfNow)` to step manually. Resizes are picked up automatically
 * (`ResizeObserver`) and on `resize()`.
 */
export function createHighway(canvas: HTMLCanvasElement, song: Song, clock: SongClock, opts: HighwayOptions): Highway {
  const renderer = new HighwayRenderer(canvas, song, clock, opts);
  const win = canvas.ownerDocument.defaultView ?? window;
  let rafId = 0;
  let running = false;
  let disposed = false;

  const resize = (): void => {
    const dpr = win.devicePixelRatio || 1;
    const { w, h } = cssSize(canvas, dpr);
    renderer.resize(w, h, dpr);
    renderer.setReducedMotion(prefersReducedMotion(canvas.ownerDocument));
  };
  resize();

  const unsubscribe = clock.onChange((change) => renderer.onClockChange(change.reason, change.anchor.anchorSongTime, change.pass));
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  observer?.observe(canvas);

  const tick = (ts: number): void => {
    if (!running) return;
    renderer.draw(ts);
    rafId = win.requestAnimationFrame(tick);
  };

  return {
    start(): void {
      if (running || disposed) return;
      running = true;
      rafId = win.requestAnimationFrame(tick);
    },
    stop(): void {
      running = false;
      if (rafId) win.cancelAnimationFrame(rafId);
      rafId = 0;
    },
    drawFrame(perfNow: number): number {
      const t0 = performance.now();
      renderer.draw(perfNow);
      return performance.now() - t0;
    },
    feedback: (j) => renderer.feedback(j),
    stray: (s) => renderer.stray(s),
    setCombo: (combo, multiplier) => renderer.setCombo(combo, multiplier),
    setOptions: (patch) => renderer.setOptions(patch),
    resize,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      this.stop();
      unsubscribe();
      observer?.disconnect();
    },
  };
}
