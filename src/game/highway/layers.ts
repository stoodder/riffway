/**
 * Static layers, rendered once per resize and blitted each frame:
 * - **background**: lane bands, string lines, hit-target wells, top/bottom strips;
 * - **foreground**: the gutter fade (passed gems dissolve left of the hit line), the right-edge fade,
 *   the hit line, target rings and lane letters.
 * @module
 */
import { createSurface, context2d, roundRectPath, type Surface } from './atlas';
import type { HighwayLayout } from './layout';
import { FONT_DISPLAY, HW_COLORS, LANE_COLORS, STRING_LINE_COLORS, rgba } from './theme';

/**
 * Draw the background layer for `layout`. `laneNames[s]` labels string `s` inside its target well
 * (index 0 unused); arriving gems cover the letter.
 */
export function buildBackground(layout: HighwayLayout, laneNames: readonly string[]): Surface {
  const { width: w, height: h, dpr, lanesTop, lanesBottom, laneH, gemR, hitX } = layout;
  const surf = createSurface(w * dpr, h * dpr);
  const g = context2d(surf);
  g.scale(dpr, dpr);

  g.fillStyle = HW_COLORS.bg;
  g.fillRect(0, 0, w, h);

  // Lane bands with a subtle vertical sheen toward the hit line.
  for (let s = 1; s <= 6; s++) {
    const top = lanesTop + (s - 1) * laneH;
    g.fillStyle = s % 2 === 0 ? HW_COLORS.laneB : HW_COLORS.laneA;
    g.fillRect(0, top, w, laneH);
  }
  const sheen = g.createLinearGradient(hitX, 0, w, 0);
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.035)');
  sheen.addColorStop(0.5, 'rgba(255, 255, 255, 0.012)');
  sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
  g.fillStyle = sheen;
  g.fillRect(hitX, lanesTop, w - hitX, lanesBottom - lanesTop);

  // Strings: thicker toward the low E, like the real thing.
  for (let s = 1; s <= 6; s++) {
    const y = layout.laneY[s]!;
    g.strokeStyle = STRING_LINE_COLORS[s]!;
    g.lineWidth = 1 + (s - 1) * 0.4;
    g.beginPath();
    g.moveTo(hitX, y);
    g.lineTo(w, y);
    g.stroke();
  }

  // Strips.
  g.fillStyle = HW_COLORS.strip;
  g.fillRect(0, 0, w, lanesTop);
  g.fillRect(0, lanesBottom, w, h - lanesBottom);
  g.fillStyle = HW_COLORS.border;
  g.fillRect(0, lanesTop - 1, w, 1);
  g.fillRect(0, lanesBottom, w, 1);

  // Target wells under the hit line (gems slide into them), labelled with the string name.
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `800 ${Math.round(Math.max(11, gemR * 0.72))}px ${FONT_DISPLAY}`;
  for (let s = 1; s <= 6; s++) {
    const y = layout.laneY[s]!;
    roundRectPath(g, hitX - gemR - 3, y - gemR - 3, gemR * 2 + 6, gemR * 2 + 6, gemR * 0.5);
    g.fillStyle = rgba(LANE_COLORS[s]!, 0.12);
    g.fill();
    // In the right half of the well, clear of the hit line and its pulse (T-041 note 2).
    g.fillStyle = rgba(LANE_COLORS[s]!, 0.8);
    g.fillText(laneNames[s] ?? '', hitX + gemR * 0.6, y + 0.5);
  }
  return surf;
}

/**
 * Foreground layers, blitted over the notes. Kept as two narrow surfaces (the gutter up to just past
 * the hit line, and the right-edge fade) so a frame does not composite a mostly transparent
 * full-canvas image.
 */
export interface Foreground {
  /** Gutter fade, hit line and target rings; covers x ∈ [0, gutterW). */
  gutter: Surface;
  gutterW: number;
  /** Right-edge fade; covers x ∈ [width − edgeW, width). */
  edge: Surface;
  edgeW: number;
}

/** Draw the foreground layers for `layout`. */
export function buildForeground(layout: HighwayLayout): Foreground {
  const { width: w, height: h, dpr, lanesTop, lanesBottom, gemR, hitX, fadeW } = layout;
  const gutterW = Math.min(w, Math.ceil(hitX + gemR + 16));
  const gutter = createSurface(gutterW * dpr, h * dpr);
  const g = context2d(gutter);
  g.scale(dpr, dpr);

  // Gutter: solid left of the fade zone, then fading out toward the hit line.
  const fadeStart = hitX - fadeW;
  g.fillStyle = HW_COLORS.bg;
  g.fillRect(0, lanesTop, Math.max(0, fadeStart), lanesBottom - lanesTop);
  const fade = g.createLinearGradient(fadeStart, 0, hitX - gemR * 0.3, 0);
  fade.addColorStop(0, rgba(HW_COLORS.bg, 1));
  fade.addColorStop(1, rgba(HW_COLORS.bg, 0));
  g.fillStyle = fade;
  g.fillRect(fadeStart, lanesTop, hitX - gemR * 0.3 - fadeStart, lanesBottom - lanesTop);
  // Strips in the gutter stay strip-coloured.
  g.fillStyle = HW_COLORS.strip;
  g.fillRect(0, 0, hitX - gemR - 4, lanesTop - 1);
  g.fillRect(0, lanesBottom + 1, hitX - gemR - 4, h - lanesBottom - 1);

  // Hit line.
  g.save();
  g.shadowColor = 'rgba(233, 237, 243, 0.55)';
  g.shadowBlur = 10;
  g.fillStyle = 'rgba(233, 237, 243, 0.9)';
  g.fillRect(hitX - 1.5, lanesTop - 3, 3, lanesBottom - lanesTop + 6);
  g.restore();

  // Target rings (over the gems as they arrive).
  for (let s = 1; s <= 6; s++) {
    const y = layout.laneY[s]!;
    roundRectPath(g, hitX - gemR - 3, y - gemR - 3, gemR * 2 + 6, gemR * 2 + 6, gemR * 0.5);
    g.lineWidth = 2;
    g.strokeStyle = rgba(LANE_COLORS[s]!, 0.85);
    g.stroke();
  }

  // Right-edge fade: gems materialise rather than pop in.
  const edgeW = Math.ceil(Math.min(64, w * 0.06));
  const edge = createSurface(edgeW * dpr, h * dpr);
  const e = context2d(edge);
  e.scale(dpr, dpr);
  const right = e.createLinearGradient(0, 0, edgeW, 0);
  right.addColorStop(0, rgba(HW_COLORS.bg, 0));
  right.addColorStop(1, rgba(HW_COLORS.bg, 0.92));
  e.fillStyle = right;
  e.fillRect(0, lanesTop, edgeW, lanesBottom - lanesTop);
  return { gutter, gutterW, edge, edgeW };
}
