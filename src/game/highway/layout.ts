/**
 * Highway geometry (pure; CSS pixels). The highway is horizontal: notes scroll right → left toward a
 * fixed hit line near the left edge; six lanes, high e on top. Left of the hit line is the *gutter*
 * (combo cluster, outcome text, lane letters) where passed gems fade out.
 *
 * Position rule (docs/game-mechanics.md § Highway): `x = hitX + (t − heardSongTime) / speed × pxPerSec`,
 * so gems move at a constant visual velocity in real time whatever the practice speed.
 * @module
 */

/** Scroll velocity at note speed 1, CSS px per real second. */
export const BASE_PX_PER_SEC = 320;
/** Clamp for the `noteSpeed` multiplier (settings range 0.5–2). */
export const NOTE_SPEED_MIN = 0.5;
export const NOTE_SPEED_MAX = 2;
/** Height of the strip above the lanes (section names, bar numbers, cue labels, loop flags). */
export const TOP_STRIP = 30;
/** Height of the strip below the lanes (palm-mute brackets). */
export const BOTTOM_STRIP = 26;

/** Mutable layout record; {@link computeLayout} fills one in place on every resize. */
export interface HighwayLayout {
  /** Canvas size in CSS px. */
  width: number;
  height: number;
  /** Device pixel ratio the backing store uses. */
  dpr: number;
  /** x of the hit line. */
  hitX: number;
  /** Lanes area: top / bottom y and per-lane height. */
  lanesTop: number;
  lanesBottom: number;
  laneH: number;
  /** Centre y per string (index = string number 1–6; index 0 unused). */
  laneY: Float64Array;
  /** Gem half-size. */
  gemR: number;
  /** Real-time scroll velocity (CSS px per real second) = BASE × noteSpeed. */
  pxPerSec: number;
  /** Width of the fade-out zone left of the hit line. */
  fadeW: number;
  /** Right edge of the outcome-text column in the gutter. */
  popupRight: number;
  /** Centre of the combo cluster. */
  comboX: number;
  comboY: number;
  /** Radius of the multiplier badge. */
  badgeR: number;
}

/** A fresh, zeroed layout record. */
export function createLayout(): HighwayLayout {
  return {
    width: 0,
    height: 0,
    dpr: 1,
    hitX: 0,
    lanesTop: 0,
    lanesBottom: 0,
    laneH: 0,
    laneY: new Float64Array(7),
    gemR: 0,
    pxPerSec: BASE_PX_PER_SEC,
    fadeW: 0,
    popupRight: 0,
    comboX: 0,
    comboY: 0,
    badgeR: 0,
  };
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Compute the geometry for a `width × height` CSS-px canvas at `dpr`, writing into `out`.
 * `noteSpeed` is clamped to 0.5–2.
 */
export function computeLayout(width: number, height: number, dpr: number, noteSpeed: number, out: HighwayLayout = createLayout()): HighwayLayout {
  const w = Math.max(1, width);
  const h = Math.max(TOP_STRIP + BOTTOM_STRIP + 60, height);
  out.width = w;
  out.height = h;
  out.dpr = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  out.lanesTop = TOP_STRIP;
  out.lanesBottom = h - BOTTOM_STRIP;
  out.laneH = (out.lanesBottom - out.lanesTop) / 6;
  for (let s = 1; s <= 6; s++) out.laneY[s] = out.lanesTop + (s - 0.5) * out.laneH;
  out.gemR = Math.round(clamp(out.laneH * 0.36, 9, 24));
  out.hitX = Math.round(clamp(w * 0.24, 220, 340));
  const ns = clamp(Number.isFinite(noteSpeed) ? noteSpeed : 1, NOTE_SPEED_MIN, NOTE_SPEED_MAX);
  out.pxPerSec = BASE_PX_PER_SEC * ns;
  out.fadeW = Math.round(out.gemR * 4.5);
  out.popupRight = out.hitX - out.gemR - 12;
  out.badgeR = Math.round(clamp(out.laneH * 0.62, 22, 36));
  out.comboX = out.badgeR + 18;
  out.comboY = Math.round((out.lanesTop + out.lanesBottom) / 2 - out.badgeR * 0.35);
  return out;
}

/** Safe speed factor for the x mapping (a paused clock reports the requested speed; guard 0/NaN). */
export function safeSpeed(speed: number): number {
  return speed > 0.01 && Number.isFinite(speed) ? speed : 1;
}

/** x of song time `t` when `now` is the heard song time (docs/game-mechanics.md). */
export function timeToX(layout: HighwayLayout, t: number, now: number, speed: number): number {
  return layout.hitX + ((t - now) / safeSpeed(speed)) * layout.pxPerSec;
}

/** Song time at x (inverse of {@link timeToX}). */
export function xToTime(layout: HighwayLayout, x: number, now: number, speed: number): number {
  return now + ((x - layout.hitX) / layout.pxPerSec) * safeSpeed(speed);
}

/** Visible song-time window `[from, to]`. */
export interface TimeWindow {
  from: number;
  to: number;
}

/**
 * Fill `out` with the visible song-time window (no allocation): from the far end of the gutter's
 * fade-out zone to the right edge, padded by a few gem sizes (connectors and glyphs reach past a gem).
 */
export function visibleWindow(layout: HighwayLayout, now: number, speed: number, out: TimeWindow): TimeWindow {
  const pad = layout.gemR * 3;
  out.from = xToTime(layout, layout.hitX - layout.fadeW - pad, now, speed);
  out.to = xToTime(layout, layout.width + pad, now, speed);
  return out;
}
