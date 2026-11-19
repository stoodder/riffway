/**
 * Highway frame budget (T-024): a synthetic 20-minute song at 16 notes/s (19,200 notes, chords and
 * every technique) rendered in headless Chromium for 1,200 frames at 60 fps steps across the whole
 * song, with hit feedback, particles and combo changes firing throughout, at DPR 1 and 2. Draw time
 * (`drawFrame`) p95 must stay under 4 ms (a quarter of a 60 fps frame); at DPR 1 the whole frame
 * including the (software) rasterisation must stay under 8 ms p95.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SongClock } from '@shared/clock';
import type { Judgement } from '@shared/judge';
import type { Highway } from '@shared/services';
import { createHighway } from '../../src/game/highway';
import { denseSong } from '../../src/ui/screens/dev-highway/songs';

/** Draw-time budget for the 95th percentile, ms (TASKS.md T-024). */
const P95_BUDGET_MS = 4;
/** Budget for draw + rasterisation (headless Chromium rasterises in software), DPR 1. */
const P95_FRAME_BUDGET_MS = 8;
const FRAMES_PER_SEGMENT = 200;
const SEGMENTS = 6;
const WARMUP = 90;

function percentile(sorted: Float64Array, p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

const song = denseSong(20, 16);
const nativeDpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');

let highway: Highway | null = null;
afterEach(() => {
  highway?.dispose();
  highway = null;
  document.body.replaceChildren();
  if (nativeDpr) Object.defineProperty(window, 'devicePixelRatio', nativeDpr);
  else delete (window as { devicePixelRatio?: number }).devicePixelRatio;
});

describe('highway performance', () => {
  it.each([1, 2])(`draws a 20-min × 16 notes/s song with p95 < ${P95_BUDGET_MS} ms per frame at DPR %i`, (dpr) => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => dpr });
    expect(song.notes.length).toBeGreaterThanOrEqual(5000);
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:1280px;height:440px';
    document.body.append(canvas);

    let now = 0;
    const clock = {
      state: 'playing',
      speed: 1,
      heardSongTime: () => now,
      onChange: () => () => undefined,
    } as unknown as SongClock;
    highway = createHighway(canvas, song, clock, { noteSpeed: 1, handCues: true, loop: { start: 600, end: 640, preroll: 2 } });
    expect(canvas.width).toBe(1280 * dpr);

    const notes = song.notes;
    let next = 0;
    let combo = 0;
    const judge = (t: number, pass: number): void => {
      while (next < notes.length && notes[next]!.time <= t) {
        const n = notes[next]!;
        const ids = n.chordId !== undefined ? song.chords[n.chordId]!.noteIds : [n.id];
        const r = next % 17;
        const outcome = r === 0 ? 'Miss' : r === 9 ? 'WrongNote' : r % 3 === 0 ? 'Good' : 'Perfect';
        const j: Judgement = {
          noteIds: ids,
          outcome,
          deltaMs: 20,
          timing: outcome === 'Good' ? 'late' : null,
          expectedMidi: n.midi,
          playedMidi: n.midi + 1,
          chord: ids.length > 1,
          songTime: n.time,
          ctxTime: n.time,
          final: true,
          pass,
        };
        highway!.feedback(j);
        combo = outcome === 'Perfect' || outcome === 'Good' ? combo + 1 : 0;
        highway!.setCombo(combo, Math.min(4, 1 + Math.floor(combo / 10)));
        next += ids.length;
      }
    };

    // Without a rAF between frames Chrome never presents the canvas, so recorded draw commands pile
    // up and are rasterised in one stall inside a later frame. Flush after every frame (outside the
    // measured draw) the way presenting a frame would, and report that raster cost separately.
    const ctx = canvas.getContext('2d')!;
    const flush = (): number => {
      const t0 = performance.now();
      ctx.getImageData(0, 0, 1, 1);
      return performance.now() - t0;
    };
    const times = new Float64Array(SEGMENTS * FRAMES_PER_SEGMENT);
    const raster = new Float64Array(SEGMENTS * FRAMES_PER_SEGMENT);
    let perf = 1000;
    let k = 0;
    const duration = song.meta.durationSec;
    for (let seg = 0; seg < SEGMENTS; seg++) {
      // Segments spread over the whole song, including the very end.
      now = (seg / (SEGMENTS - 1)) * (duration - FRAMES_PER_SEGMENT / 60) - 1;
      next = notes.findIndex((n) => n.time >= now);
      for (let w = 0; w < (seg === 0 ? WARMUP : 0); w++) {
        highway.drawFrame((perf += 16.7));
        flush();
      }
      for (let f = 0; f < FRAMES_PER_SEGMENT; f++) {
        now += 1 / 60;
        judge(now, 0);
        times[k] = highway.drawFrame((perf += 16.7));
        raster[k++] = flush();
      }
    }

    const sorted = times.slice().sort();
    const p50 = percentile(sorted, 0.5);
    const p95 = percentile(sorted, 0.95);
    const max = sorted[sorted.length - 1]!;
    const rs = raster.slice().sort();
    const total = times.map((t, i) => t + raster[i]!).sort();
    console.info(
      `highway perf @DPR ${dpr}: ${song.notes.length} notes, ${times.length} frames, draw p50 ${p50.toFixed(2)} ms, ` +
        `p95 ${p95.toFixed(2)} ms, max ${max.toFixed(2)} ms; raster p50 ${percentile(rs, 0.5).toFixed(2)} ms, ` +
        `p95 ${percentile(rs, 0.95).toFixed(2)} ms; frame p95 ${percentile(total, 0.95).toFixed(2)} ms`,
    );
    expect(p95).toBeLessThan(P95_BUDGET_MS);
    if (dpr === 1) expect(percentile(total, 0.95)).toBeLessThan(P95_FRAME_BUDGET_MS);
  });
});
