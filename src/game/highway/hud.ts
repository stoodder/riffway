/**
 * Combo cluster in the gutter: multiplier badge with a progress ring to the next multiplier, a flame
 * that grows with the multiplier (Guitar-Hero punch), the streak count underneath (Rocksmith clarity),
 * and short flair animations: multiplier-up punch, streak milestones, streak-lost shake.
 * @module
 */
import type { HighwayLayout } from './layout';
import { FLAME_COLORS, FONT_DISPLAY, FONT_TEXT, HW_COLORS, MULTIPLIER_COLORS, OUTCOME_COLORS, rgba } from './theme';

/** Combo per multiplier step (docs/game-mechanics.md: 0–9 ×1, 10–19 ×2, …). */
const COMBO_STEP = 10;
const MULT_UP_MS = 420;
const BREAK_MS = 420;
const MILESTONE_MS = 1500;
/** Streaks that earn a banner. */
const MILESTONES: readonly number[] = [25, 50, 100, 150, 200, 300, 400, 500, 750, 1000];

const MULT_TEXT: readonly string[] = ['×1', '×1', '×2', '×3', '×4'];
const MULT_GLOW: readonly string[] = MULTIPLIER_COLORS.map((c) => rgba(c, 0.35));

/** Fonts used by the cluster (built on resize). */
export interface HudFonts {
  mult: string;
  combo: string;
  label: string;
  banner: string;
}

/** Build HUD fonts for a badge radius. */
export function hudFonts(badgeR: number): HudFonts {
  return {
    mult: `900 italic ${Math.round(badgeR * 0.82)}px ${FONT_DISPLAY}`,
    combo: `800 ${Math.round(badgeR * 0.72)}px ${FONT_DISPLAY}`,
    label: `700 ${Math.max(9, Math.round(badgeR * 0.3))}px ${FONT_TEXT}`,
    banner: `900 italic ${Math.max(12, Math.round(badgeR * 0.44))}px ${FONT_DISPLAY}`,
  };
}

/** Combo / multiplier display state. */
export class ComboHud {
  reducedMotion = false;
  combo = 0;
  multiplier = 1;
  private comboText = '0';
  private multUpBorn = -Infinity;
  private breakBorn = -Infinity;
  private milestoneBorn = -Infinity;
  private milestoneText = '';

  /** Update from the judge state; detects multiplier-ups, milestones and broken streaks. */
  set(combo: number, multiplier: number): void {
    const c = Math.max(0, Math.floor(Number.isFinite(combo) ? combo : 0));
    const m = Math.min(4, Math.max(1, Math.floor(Number.isFinite(multiplier) ? multiplier : 1)));
    if (m > this.multiplier) this.multUpBorn = NaN;
    if (c === 0 && this.combo >= COMBO_STEP) this.breakBorn = NaN;
    for (let k = 0; k < MILESTONES.length; k++) {
      const ms = MILESTONES[k]!;
      if (this.combo < ms && c >= ms) {
        this.milestoneBorn = NaN;
        this.milestoneText = `${ms} STREAK!`;
      }
    }
    if (c !== this.combo) this.comboText = String(c);
    this.combo = c;
    this.multiplier = m;
  }

  /** Draw the cluster. */
  draw(ctx: CanvasRenderingContext2D, layout: HighwayLayout, fonts: HudFonts, perfNow: number): void {
    const { comboX: cx, comboY: cy, badgeR: r } = layout;
    const m = this.multiplier;
    const color = MULTIPLIER_COLORS[m]!;
    if (Number.isNaN(this.multUpBorn)) this.multUpBorn = perfNow;
    if (Number.isNaN(this.breakBorn)) this.breakBorn = perfNow;
    if (Number.isNaN(this.milestoneBorn)) this.milestoneBorn = perfNow;
    const upAge = perfNow - this.multUpBorn;
    const breakAge = perfNow - this.breakBorn;
    const motion = !this.reducedMotion;

    // Streak-lost shake.
    let bx = cx;
    if (motion && breakAge >= 0 && breakAge < BREAK_MS) bx += Math.sin(breakAge * 0.09) * 5 * (1 - breakAge / BREAK_MS);

    if (m >= 2) this.drawFlame(ctx, bx, cy, r, m, perfNow, motion);

    // Badge punch on multiplier-up.
    let scale = 1;
    if (upAge >= 0 && upAge < MULT_UP_MS) {
      const k = upAge / MULT_UP_MS;
      if (motion) scale = 1 + 0.32 * (1 - k) * (1 - k);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(bx, cy, r * (1.05 + (motion ? 0.9 * k : 0.2)), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    const rr = r * scale;

    // Badge disc + glow.
    ctx.fillStyle = MULT_GLOW[m]!;
    ctx.beginPath();
    ctx.arc(bx, cy, rr + 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = HW_COLORS.strip;
    ctx.beginPath();
    ctx.arc(bx, cy, rr, 0, Math.PI * 2);
    ctx.fill();

    // Progress ring toward the next multiplier (full at ×4).
    ctx.lineWidth = Math.max(3, r * 0.14);
    ctx.lineCap = 'round';
    ctx.strokeStyle = HW_COLORS.border;
    ctx.beginPath();
    ctx.arc(bx, cy, rr - ctx.lineWidth / 2 - 1, 0, Math.PI * 2);
    ctx.stroke();
    const progress = m >= 4 ? 1 : (this.combo % COMBO_STEP) / COMBO_STEP;
    if (progress > 0) {
      ctx.strokeStyle = breakAge >= 0 && breakAge < BREAK_MS ? OUTCOME_COLORS[4]! : color;
      ctx.beginPath();
      ctx.arc(bx, cy, rr - ctx.lineWidth / 2 - 1, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = fonts.mult;
    ctx.fillStyle = color;
    ctx.fillText(MULT_TEXT[m]!, bx - r * 0.04, cy + r * 0.04);

    // Streak count.
    const countY = cy + r + r * 0.62;
    ctx.font = fonts.combo;
    ctx.fillStyle = this.combo > 0 ? HW_COLORS.text : HW_COLORS.textSubtle;
    ctx.fillText(this.comboText, bx, countY);
    ctx.font = fonts.label;
    ctx.fillStyle = HW_COLORS.textSubtle;
    ctx.letterSpacing = '1.5px';
    ctx.fillText('STREAK', bx, countY + r * 0.58);
    ctx.letterSpacing = '0px';

    // Milestone banner.
    const msAge = perfNow - this.milestoneBorn;
    if (msAge >= 0 && msAge < MILESTONE_MS) {
      const k = msAge / MILESTONE_MS;
      const pop = motion && msAge < 140 ? 1.35 - 0.35 * (msAge / 140) : 1;
      const top = countY + r * 1.35;
      ctx.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      ctx.setTransform(layout.dpr * pop, 0, 0, layout.dpr * pop, layout.dpr * 14, layout.dpr * top);
      ctx.textAlign = 'left';
      ctx.font = fonts.banner;
      ctx.lineWidth = 4;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = HW_COLORS.bg;
      ctx.strokeText(this.milestoneText, 0, 0);
      ctx.fillStyle = MULTIPLIER_COLORS[4]!;
      ctx.fillText(this.milestoneText, 0, 0);
      ctx.setTransform(layout.dpr, 0, 0, layout.dpr, 0, 0);
      ctx.globalAlpha = 1;
    }
  }

  /** Layered three-tongue flame behind the badge; taller and hotter with the multiplier. */
  private drawFlame(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, m: number, perfNow: number, motion: boolean): void {
    const height = r * (1.95 + 0.55 * (m - 2));
    const width = r * 2.25;
    const t = motion ? perfNow * 0.001 : 0;
    ctx.globalCompositeOperation = 'lighter';
    for (let layer = 0; layer < 3; layer++) {
      const s = 1 - layer * 0.24;
      const w = width * s;
      const h = height * (1 - layer * 0.18);
      const f0 = motion ? Math.sin(t * 9.3 + layer * 1.9) * w * 0.06 : 0;
      const f1 = motion ? Math.sin(t * 12.7 + layer * 0.7) * w * 0.07 + Math.sin(t * 19.1) * w * 0.03 : 0;
      const f2 = motion ? Math.sin(t * 10.9 + layer * 2.6) * w * 0.06 : 0;
      const hl = motion ? 1 + 0.1 * Math.sin(t * 14.2 + layer) : 1;
      const hc = motion ? 1 + 0.07 * Math.sin(t * 11.5 + layer * 2.1) : 1;
      const hr = motion ? 1 + 0.1 * Math.sin(t * 13.3 + layer * 1.3) : 1;
      ctx.globalAlpha = m >= 4 ? 0.92 : 0.78;
      ctx.fillStyle = FLAME_COLORS[layer]!;
      ctx.beginPath();
      ctx.moveTo(cx - w / 2, cy);
      ctx.quadraticCurveTo(cx - w * 0.56, cy - h * 0.4, cx - w * 0.3 + f0, cy - h * 0.66 * hl);
      ctx.quadraticCurveTo(cx - w * 0.2, cy - h * 0.46, cx - w * 0.1, cy - h * 0.5);
      ctx.quadraticCurveTo(cx - w * 0.12 + f1 * 0.5, cy - h * 0.82, cx + f1, cy - h * hc);
      ctx.quadraticCurveTo(cx + w * 0.14 + f1 * 0.5, cy - h * 0.8, cx + w * 0.1, cy - h * 0.5);
      ctx.quadraticCurveTo(cx + w * 0.2, cy - h * 0.46, cx + w * 0.3 + f2, cy - h * 0.66 * hr);
      ctx.quadraticCurveTo(cx + w * 0.56, cy - h * 0.4, cx + w / 2, cy);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
