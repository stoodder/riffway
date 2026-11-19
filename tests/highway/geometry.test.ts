/**
 * Highway geometry (T-024): lane order, hit line, constant real-time scroll velocity and the visible
 * window used for culling.
 */
import { describe, expect, it } from 'vitest';
import {
  BASE_PX_PER_SEC,
  BOTTOM_STRIP,
  TOP_STRIP,
  computeLayout,
  safeSpeed,
  timeToX,
  visibleWindow,
  xToTime,
} from '../../src/game/highway/layout';

describe('computeLayout', () => {
  it('stacks six lanes with high e on top inside the strips', () => {
    const L = computeLayout(1280, 420, 2, 1);
    expect(L.lanesTop).toBe(TOP_STRIP);
    expect(L.lanesBottom).toBe(420 - BOTTOM_STRIP);
    for (let s = 1; s < 6; s++) expect(L.laneY[s]!).toBeLessThan(L.laneY[s + 1]!);
    expect(L.laneY[1]! - L.laneH / 2).toBeCloseTo(L.lanesTop);
    expect(L.laneY[6]! + L.laneH / 2).toBeCloseTo(L.lanesBottom);
    expect(L.dpr).toBe(2);
    // Gems fit their lane.
    expect(L.gemR * 2).toBeLessThan(L.laneH);
  });

  it('places the hit line near the left edge, clamped for narrow and wide canvases', () => {
    expect(computeLayout(1280, 420, 1, 1).hitX).toBe(307);
    expect(computeLayout(600, 420, 1, 1).hitX).toBe(220);
    expect(computeLayout(3000, 420, 1, 1).hitX).toBe(340);
  });

  it('scales the scroll velocity with note speed (clamped to 0.5–2)', () => {
    expect(computeLayout(1280, 420, 1, 1).pxPerSec).toBe(BASE_PX_PER_SEC);
    expect(computeLayout(1280, 420, 1, 1.5).pxPerSec).toBe(BASE_PX_PER_SEC * 1.5);
    expect(computeLayout(1280, 420, 1, 9).pxPerSec).toBe(BASE_PX_PER_SEC * 2);
    expect(computeLayout(1280, 420, 1, 0.1).pxPerSec).toBe(BASE_PX_PER_SEC * 0.5);
    expect(computeLayout(1280, 420, 1, Number.NaN).pxPerSec).toBe(BASE_PX_PER_SEC);
  });

  it('guards a bad DPR and tiny sizes', () => {
    const L = computeLayout(0, 0, Number.NaN, 1);
    expect(L.dpr).toBe(1);
    expect(L.width).toBeGreaterThan(0);
    expect(L.laneH).toBeGreaterThan(0);
  });
});

describe('x mapping (docs/game-mechanics.md)', () => {
  const L = computeLayout(1280, 420, 1, 1);

  it('puts a note at the hit line when its time is heard', () => {
    expect(timeToX(L, 12.5, 12.5, 1)).toBe(L.hitX);
    expect(timeToX(L, 12.5, 12.5, 0.6)).toBe(L.hitX);
  });

  it('moves at a constant real-time velocity whatever the practice speed', () => {
    // One real second ahead = pxPerSec, at any speed: at 50% one real second is half a song second.
    expect(timeToX(L, 11, 10, 1) - L.hitX).toBeCloseTo(L.pxPerSec);
    expect(timeToX(L, 10.5, 10, 0.5) - L.hitX).toBeCloseTo(L.pxPerSec);
    expect(timeToX(L, 11, 10, 0.5) - L.hitX).toBeCloseTo(2 * L.pxPerSec);
    expect(timeToX(L, 9, 10, 1)).toBeLessThan(L.hitX);
  });

  it('inverts with xToTime', () => {
    for (const speed of [0.4, 0.75, 1, 1.1]) {
      const x = timeToX(L, 33.3, 30, speed);
      expect(xToTime(L, x, 30, speed)).toBeCloseTo(33.3, 9);
    }
  });

  it('treats a zero or invalid speed as 1 (never divides by zero)', () => {
    expect(safeSpeed(0)).toBe(1);
    expect(safeSpeed(Number.NaN)).toBe(1);
    expect(safeSpeed(0.4)).toBe(0.4);
    expect(Number.isFinite(timeToX(L, 5, 4, 0))).toBe(true);
  });

  it('visible window spans the gutter fade to past the right edge', () => {
    const win = visibleWindow(L, 100, 1, { from: 0, to: 0 });
    expect(timeToX(L, win.from, 100, 1)).toBeLessThanOrEqual(L.hitX - L.fadeW);
    expect(timeToX(L, win.to, 100, 1)).toBeGreaterThanOrEqual(L.width);
    const slow = visibleWindow(L, 100, 0.5, { from: 0, to: 0 });
    expect(slow.to - 100).toBeCloseTo((win.to - 100) * 0.5);
  });
});
