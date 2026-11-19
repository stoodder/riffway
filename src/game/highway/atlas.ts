/**
 * Sprite atlas for the highway: every gem (string × state × shape), fret number, hit glow and particle
 * dot is rendered once per resize (at the device pixel ratio) and blitted with `drawImage` in the draw
 * loop, which is far cheaper than paths, gradients, shadows and text per gem per frame.
 * @module
 */
import { FONT_DISPLAY, HW_COLORS, LANE_COLORS, OUTCOME_COLORS, mix, rgba } from './theme';
import { MAX_SPRITE_FRET } from './prepare';

/** Gem shapes (atlas columns). */
export const SHAPE_ROUND = 0;
export const SHAPE_DIAMOND = 1;
export const SHAPE_DEAD = 2;
/** Gem states (atlas columns). */
export const STATE_NORMAL = 0;
export const STATE_WRONG = 1;
export const STATE_MISS = 2;

/** A 2D canvas used as a sprite sheet or static layer. */
export type Surface = HTMLCanvasElement;

/** Create a canvas of `w × h` device pixels (at least 1×1). */
export function createSurface(w: number, h: number): Surface {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

/** 2D context of a surface (throws when the browser gives none, e.g. a DOM without canvas support). */
export function context2d(c: Surface): CanvasRenderingContext2D {
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  return ctx;
}

/** Rounded-rect path helper (build-time and per-frame; no allocation). */
export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Pre-rendered sprites for one gem size and DPR. */
export class GemAtlas {
  /** Gem half-size in CSS px. */
  readonly gemR: number;
  readonly dpr: number;
  /** Gem/fret cell size in device px and in CSS px. */
  readonly cell: number;
  readonly cellCss: number;
  /** Fret-number cell size (device / CSS px): tighter than a gem cell (no glow padding). */
  readonly fretCell: number;
  readonly fretCss: number;
  /** Glow cell size (device / CSS px). */
  readonly glowCell: number;
  readonly glowCss: number;
  /** Particle dot cell size (device / CSS px). */
  readonly dotCell: number;
  readonly dotCss: number;
  /** 9 columns (shape × state) × 6 rows (strings). */
  readonly gems: Surface;
  /** One row of fret numbers 0…MAX_SPRITE_FRET. */
  readonly frets: Surface;
  /** One glow per outcome code (columns 1–5; column 0 = white). */
  readonly glows: Surface;
  /** One particle dot per outcome code (columns 1–5; column 0 = white). */
  readonly dots: Surface;
  /** Font for frets beyond the sprite range (fallback text). */
  readonly fretFont: string;

  constructor(gemR: number, dpr: number) {
    this.gemR = gemR;
    this.dpr = dpr;
    const pad = Math.ceil(gemR * 0.6);
    this.cellCss = gemR * 2 + pad * 2;
    this.cell = Math.ceil(this.cellCss * dpr);
    this.glowCss = Math.ceil(gemR * 5.2);
    this.glowCell = Math.ceil(this.glowCss * dpr);
    this.dotCss = 10;
    this.dotCell = Math.ceil(this.dotCss * dpr);
    this.fretFont = `800 ${Math.round(gemR * 1.02)}px ${FONT_DISPLAY}`;

    this.gems = createSurface(this.cell * 9, this.cell * 6);
    const g = context2d(this.gems);
    g.scale(dpr, dpr);
    for (let s = 1; s <= 6; s++) {
      for (let shape = 0; shape < 3; shape++) {
        for (let state = 0; state < 3; state++) {
          // Cell centres on the device-pixel grid the blits read from (exact for fractional DPRs).
          const cx = ((shape * 3 + state + 0.5) * this.cell) / dpr;
          const cy = ((s - 1 + 0.5) * this.cell) / dpr;
          drawGem(g, cx, cy, gemR, LANE_COLORS[s]!, shape, state);
        }
      }
    }

    this.fretCss = Math.ceil(gemR * 1.9);
    this.fretCell = Math.ceil(this.fretCss * dpr);
    this.frets = createSurface(this.fretCell * (MAX_SPRITE_FRET + 1), this.fretCell);
    const f = context2d(this.frets);
    f.scale(dpr, dpr);
    f.textAlign = 'center';
    f.textBaseline = 'middle';
    for (let fret = 0; fret <= MAX_SPRITE_FRET; fret++) {
      const label = String(fret);
      const size = label.length > 1 ? gemR * 0.92 : gemR * 1.08;
      f.font = `800 ${size.toFixed(1)}px ${FONT_DISPLAY}`;
      f.fillStyle = HW_COLORS.ink;
      const cellCss = this.fretCell / dpr;
      f.fillText(label, (fret + 0.5) * cellCss, cellCss / 2 + gemR * 0.06);
    }

    this.glows = createSurface(this.glowCell * 6, this.glowCell);
    const gl = context2d(this.glows);
    gl.scale(dpr, dpr);
    this.dots = createSurface(this.dotCell * 6, this.dotCell);
    const d = context2d(this.dots);
    d.scale(dpr, dpr);
    for (let code = 0; code <= 5; code++) {
      const color = code === 0 ? '#ffffff' : OUTCOME_COLORS[code]!;
      const gx = ((code + 0.5) * this.glowCell) / dpr;
      const gy = this.glowCell / dpr / 2;
      const gr = this.glowCss / 2;
      const grad = gl.createRadialGradient(gx, gy, 0, gx, gy, gr);
      grad.addColorStop(0, rgba(mix(color, '#ffffff', 0.55), 0.95));
      grad.addColorStop(0.22, rgba(color, 0.7));
      grad.addColorStop(0.5, rgba(color, 0.22));
      grad.addColorStop(1, rgba(color, 0));
      gl.fillStyle = grad;
      gl.fillRect((code * this.glowCell) / dpr, 0, this.glowCss, this.glowCss);

      const dx = ((code + 0.5) * this.dotCell) / dpr;
      const dy = this.dotCell / dpr / 2;
      const dg = d.createRadialGradient(dx, dy, 0, dx, dy, this.dotCss / 2);
      dg.addColorStop(0, '#ffffff');
      dg.addColorStop(0.35, rgba(color, 0.95));
      dg.addColorStop(1, rgba(color, 0));
      d.fillStyle = dg;
      d.fillRect((code * this.dotCell) / dpr, 0, this.dotCss, this.dotCss);
    }
  }

  /** Blit a gem centred at (x, y) CSS px, scaled by `scale` (ghost notes are smaller). */
  drawGem(ctx: CanvasRenderingContext2D, shape: number, state: number, string: number, x: number, y: number, scale: number): void {
    const c = this.cell;
    const size = (c / this.dpr) * scale;
    ctx.drawImage(this.gems, (shape * 3 + state) * c, (string - 1) * c, c, c, this.snap(x - size / 2, scale), this.snap(y - size / 2, scale), size, size);
  }

  /**
   * Snap an unscaled sprite's corner to the device-pixel grid: a 1:1, pixel-aligned blit is a plain
   * copy for the rasteriser (no filtering), several times cheaper than a sub-pixel one.
   */
  private snap(v: number, scale: number): number {
    return scale === 1 ? Math.round(v * this.dpr) / this.dpr : v;
  }

  /** Draw a fret number centred at (x, y) (sprite; plain text beyond {@link MAX_SPRITE_FRET}). */
  drawFret(ctx: CanvasRenderingContext2D, fret: number, x: number, y: number, scale: number): void {
    if (fret >= 0 && fret <= MAX_SPRITE_FRET) {
      const c = this.fretCell;
      const size = (c / this.dpr) * scale;
      ctx.drawImage(this.frets, fret * c, 0, c, c, this.snap(x - size / 2, scale), this.snap(y - size / 2, scale), size, size);
      return;
    }
    ctx.font = this.fretFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = HW_COLORS.ink;
    ctx.fillText(String(fret), x, y);
  }

  /** Additive glow centred at (x, y) with diameter `size` CSS px. */
  drawGlow(ctx: CanvasRenderingContext2D, code: number, x: number, y: number, size: number): void {
    const c = this.glowCell;
    ctx.drawImage(this.glows, code * c, 0, c, c, x - size / 2, y - size / 2, size, size);
  }

  /** Particle dot centred at (x, y) with diameter `size` CSS px. */
  drawDot(ctx: CanvasRenderingContext2D, code: number, x: number, y: number, size: number): void {
    const c = this.dotCell;
    ctx.drawImage(this.dots, code * c, 0, c, c, x - size / 2, y - size / 2, size, size);
  }
}

/** Paint one gem body (build time). */
function drawGem(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, laneColor: string, shape: number, state: number): void {
  const base = state === STATE_WRONG ? HW_COLORS.wrongFill : state === STATE_MISS ? HW_COLORS.missFill : laneColor;
  g.save();
  const shapePath = (): void => {
    if (shape === SHAPE_DIAMOND) {
      const d = r * 1.2;
      g.beginPath();
      g.moveTo(cx, cy - d);
      g.lineTo(cx + d, cy);
      g.lineTo(cx, cy + d);
      g.lineTo(cx - d, cy);
      g.closePath();
    } else {
      roundRectPath(g, cx - r, cy - r, r * 2, r * 2, r * 0.42);
    }
  };

  // Glow + body.
  shapePath();
  if (state !== STATE_MISS) {
    g.shadowColor = rgba(base, shape === SHAPE_DEAD ? 0.35 : 0.6);
    g.shadowBlur = r * 0.75;
  }
  if (shape === SHAPE_DEAD) {
    g.fillStyle = state === STATE_MISS ? '#232832' : '#141a23';
  } else if (state === STATE_MISS) {
    g.fillStyle = base;
  } else {
    const grad = g.createLinearGradient(cx, cy - r, cx, cy + r);
    grad.addColorStop(0, mix(base, '#ffffff', 0.42));
    grad.addColorStop(0.45, base);
    grad.addColorStop(1, mix(base, '#000000', 0.28));
    g.fillStyle = grad;
  }
  g.fill();
  g.shadowBlur = 0;
  g.shadowColor = 'transparent';

  // Rim.
  shapePath();
  g.lineWidth = Math.max(1.5, r * 0.12);
  g.strokeStyle =
    state === STATE_MISS ? HW_COLORS.missEdge : shape === SHAPE_DEAD ? base : state === STATE_WRONG ? '#ffc8f4' : mix(base, '#ffffff', 0.6);
  g.stroke();

  if (shape === SHAPE_DEAD) {
    // × glyph instead of a fret number.
    const k = r * 0.45;
    g.beginPath();
    g.moveTo(cx - k, cy - k);
    g.lineTo(cx + k, cy + k);
    g.moveTo(cx + k, cy - k);
    g.lineTo(cx - k, cy + k);
    g.lineCap = 'round';
    g.lineWidth = Math.max(2.5, r * 0.22);
    g.strokeStyle = state === STATE_MISS ? HW_COLORS.missEdge : state === STATE_WRONG ? HW_COLORS.wrongFill : mix(base, '#ffffff', 0.25);
    g.stroke();
  } else if (state !== STATE_MISS) {
    // Specular highlight on the upper half.
    g.beginPath();
    g.ellipse(cx, cy - r * 0.5, r * 0.62, r * 0.26, 0, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255, 255, 255, 0.22)';
    g.fill();
  }
  g.restore();
}
