/**
 * Hit feedback effects with fixed-size pools (no allocation while drawing): lane flashes at the hit
 * line, particle bursts, outcome text (with early/late or "played G3"), and faint stray ticks.
 *
 * Effects are timestamped lazily: an effect created between frames starts at the next drawn frame's
 * `perfNow`, so every animation is driven only by the times passed to `drawFrame` (deterministic in
 * tests, and nothing ever reads the wall clock behind the caller's back).
 * @module
 */
import type { GemAtlas } from './atlas';
import type { HighwayLayout } from './layout';
import { FONT_DISPLAY, FONT_TEXT, HW_COLORS, OUTCOME_COLORS, OUTCOME_WORDS } from './theme';

/** Particle pool capacity. */
export const PARTICLE_CAP = 512;
/** Stray tick pool capacity. */
export const STRAY_CAP = 12;
/** Particles per lane burst by outcome code (index 0 unused; Miss has none). */
const BURST: readonly number[] = [0, 22, 15, 10, 9, 0];
/** Lane flash duration (ms; `--dur-hit`). */
const FLASH_MS = 260;
/** Outcome text lifetime (ms). */
const POPUP_MS = 720;
const STRAY_MS = 450;
const PARTICLE_MIN_MS = 260;
const PARTICLE_MAX_MS = 560;
/** Particle gravity (CSS px / ms²). */
const GRAVITY = 0.0009;

/** Fonts used by the effects (built on resize). */
export interface FxFonts {
  popup: string;
  popupSub: string;
}

/** Build effect fonts for a gem size. */
export function fxFonts(gemR: number): FxFonts {
  return {
    popup: `900 italic ${Math.round(Math.min(18, Math.max(13, gemR * 0.76)))}px ${FONT_DISPLAY}`,
    popupSub: `700 ${Math.round(Math.max(10, gemR * 0.5))}px ${FONT_TEXT}`,
  };
}

/** Pooled hit-feedback effects. */
export class FeedbackFx {
  reducedMotion = false;

  // Lane flashes and outcome text: one slot per string (a newer judgement replaces the older one).
  private readonly flashBorn = new Float64Array(7).fill(-Infinity);
  private readonly flashCode = new Uint8Array(7);
  private readonly popupBorn = new Float64Array(7).fill(-Infinity);
  private readonly popupCode = new Uint8Array(7);
  private readonly popupSub: string[] = ['', '', '', '', '', '', ''];
  private readonly popupSubColor: string[] = ['', '', '', '', '', '', ''];

  // Particles (struct of arrays, ring allocation).
  private readonly px = new Float32Array(PARTICLE_CAP);
  private readonly py = new Float32Array(PARTICLE_CAP);
  private readonly vx = new Float32Array(PARTICLE_CAP);
  private readonly vy = new Float32Array(PARTICLE_CAP);
  private readonly size = new Float32Array(PARTICLE_CAP);
  private readonly life = new Float32Array(PARTICLE_CAP);
  private readonly born = new Float64Array(PARTICLE_CAP).fill(-Infinity);
  private readonly pcode = new Uint8Array(PARTICLE_CAP);
  private nextParticle = 0;

  private readonly strayBorn = new Float64Array(STRAY_CAP).fill(-Infinity);
  private nextStray = 0;

  /** Time of the most recent hit (drives the hit-line pulse); NaN = pending first frame. */
  lastHitBorn = -Infinity;
  lastHitCode = 0;

  /**
   * Trigger a lane flash + particle burst on `string` for outcome `code` at (x, y) CSS px. Miss shows
   * no flash or burst (the gem greys instead).
   */
  burst(string: number, code: number, x: number, y: number, share = 1): void {
    if (code === 5) return;
    this.flashBorn[string] = NaN;
    this.flashCode[string] = code;
    if (code <= 3) {
      this.lastHitBorn = NaN;
      this.lastHitCode = code;
    }
    if (this.reducedMotion) return;
    const count = Math.max(3, Math.round(BURST[code]! * share));
    for (let k = 0; k < count; k++) {
      const i = this.nextParticle;
      this.nextParticle = (i + 1) % PARTICLE_CAP;
      // Spray up and to the right of the hit line (away from the gutter text), plus a few backward.
      const angle = -Math.PI * (0.05 + Math.random() * 0.9) + (Math.random() < 0.2 ? Math.PI * 0.25 : 0);
      const speed = 0.08 + Math.random() * (code === 1 ? 0.32 : 0.24);
      this.px[i] = x + (Math.random() - 0.5) * 6;
      this.py[i] = y + (Math.random() - 0.5) * 6;
      this.vx[i] = Math.cos(angle) * speed;
      this.vy[i] = Math.sin(angle) * speed;
      this.size[i] = 3 + Math.random() * (code === 1 ? 5 : 3.5);
      this.life[i] = PARTICLE_MIN_MS + Math.random() * (PARTICLE_MAX_MS - PARTICLE_MIN_MS);
      this.born[i] = NaN;
      this.pcode[i] = code === 1 && Math.random() < 0.35 ? 0 : code;
    }
  }

  /** Show outcome text on `string`'s lane; `sub` is the small second line (`'LATE'`, `'played G3'`). */
  popup(string: number, code: number, sub: string, subColor: string): void {
    this.popupBorn[string] = NaN;
    this.popupCode[string] = code;
    this.popupSub[string] = sub;
    this.popupSubColor[string] = subColor;
  }

  /** Faint tick at the hit line for a stray onset. */
  stray(): void {
    this.strayBorn[this.nextStray] = NaN;
    this.nextStray = (this.nextStray + 1) % STRAY_CAP;
  }

  /** Drop every running effect. */
  clear(): void {
    this.flashBorn.fill(-Infinity);
    this.popupBorn.fill(-Infinity);
    this.born.fill(-Infinity);
    this.strayBorn.fill(-Infinity);
    this.lastHitBorn = -Infinity;
  }

  /** Age in ms of the latest hit (Infinity when none). Stamps a pending hit with `perfNow`. */
  hitAge(perfNow: number): number {
    if (Number.isNaN(this.lastHitBorn)) this.lastHitBorn = perfNow;
    return perfNow - this.lastHitBorn;
  }

  /** Number of live particles at `perfNow` (diagnostics / tests). */
  liveParticles(perfNow: number): number {
    let live = 0;
    for (let i = 0; i < PARTICLE_CAP; i++) {
      const b = this.born[i]!;
      if (Number.isNaN(b) || perfNow - b < this.life[i]!) live++;
    }
    return live;
  }

  /** Draw lane flashes (under the outcome text) and particles. Call after the foreground layer. */
  drawFlashes(ctx: CanvasRenderingContext2D, layout: HighwayLayout, atlas: GemAtlas, perfNow: number): void {
    const { hitX, gemR } = layout;
    ctx.globalCompositeOperation = 'lighter';
    for (let s = 1; s <= 6; s++) {
      let b = this.flashBorn[s]!;
      if (Number.isNaN(b)) b = this.flashBorn[s] = perfNow;
      const age = perfNow - b;
      if (age < 0 || age >= FLASH_MS) continue;
      const k = age / FLASH_MS;
      const code = this.flashCode[s]!;
      const grow = this.reducedMotion ? 1 : 0.85 + 0.55 * k;
      ctx.globalAlpha = (1 - k) * (code === 4 ? 0.8 : 1);
      atlas.drawGlow(ctx, code, hitX, layout.laneY[s]!, gemR * 5.2 * grow);
      if (code === 1 && !this.reducedMotion) {
        // Perfect: an extra white core punch.
        ctx.globalAlpha = (1 - k) * 0.7;
        atlas.drawGlow(ctx, 0, hitX, layout.laneY[s]!, gemR * 2.6 * grow);
      }
    }

    for (let i = 0; i < PARTICLE_CAP; i++) {
      let b = this.born[i]!;
      if (b === -Infinity) continue;
      if (Number.isNaN(b)) b = this.born[i] = perfNow;
      const age = perfNow - b;
      const life = this.life[i]!;
      if (age >= life) {
        this.born[i] = -Infinity;
        continue;
      }
      const k = age / life;
      const x = this.px[i]! + this.vx[i]! * age;
      const y = this.py[i]! + this.vy[i]! * age + 0.5 * GRAVITY * age * age;
      ctx.globalAlpha = 1 - k * k;
      atlas.drawDot(ctx, this.pcode[i]!, x, y, this.size[i]! * (1.4 - 0.8 * k));
    }

    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < STRAY_CAP; i++) {
      let b = this.strayBorn[i]!;
      if (b === -Infinity) continue;
      if (Number.isNaN(b)) b = this.strayBorn[i] = perfNow;
      const age = perfNow - b;
      if (age >= STRAY_MS) {
        this.strayBorn[i] = -Infinity;
        continue;
      }
      ctx.globalAlpha = 1 - age / STRAY_MS;
      ctx.fillStyle = HW_COLORS.stray;
      ctx.fillRect(hitX - 1, layout.lanesTop - 12, 2, 9);
      ctx.fillRect(hitX - 1, layout.lanesBottom + 3, 2, 9);
    }
    ctx.globalAlpha = 1;
  }

  /** Draw outcome text in the gutter, right-aligned next to each lane's target. */
  drawPopups(ctx: CanvasRenderingContext2D, layout: HighwayLayout, fonts: FxFonts, perfNow: number): void {
    const { dpr, popupRight, gemR } = layout;
    ctx.textAlign = 'right';
    ctx.lineJoin = 'round';
    for (let s = 1; s <= 6; s++) {
      let b = this.popupBorn[s]!;
      if (b === -Infinity) continue;
      if (Number.isNaN(b)) b = this.popupBorn[s] = perfNow;
      const age = perfNow - b;
      if (age >= POPUP_MS) {
        this.popupBorn[s] = -Infinity;
        continue;
      }
      const code = this.popupCode[s]!;
      const k = age / POPUP_MS;
      const punch = this.reducedMotion || age >= 110 ? 1 : 1.4 - 0.4 * (age / 110);
      const rise = this.reducedMotion ? 0 : -gemR * 0.55 * k;
      ctx.globalAlpha = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
      const sub = this.popupSub[s]!;
      const y = layout.laneY[s]! + rise - (sub ? gemR * 0.22 : 0);
      ctx.setTransform(dpr * punch, 0, 0, dpr * punch, dpr * popupRight, dpr * y);
      ctx.font = fonts.popup;
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4;
      ctx.strokeStyle = HW_COLORS.bg;
      ctx.strokeText(OUTCOME_WORDS[code]!, 0, 0);
      ctx.fillStyle = OUTCOME_COLORS[code]!;
      ctx.fillText(OUTCOME_WORDS[code]!, 0, 0);
      if (sub) {
        ctx.setTransform(dpr, 0, 0, dpr, dpr * popupRight, dpr * (y + gemR * 0.72));
        ctx.font = fonts.popupSub;
        ctx.lineWidth = 3;
        ctx.strokeText(sub, 0, 0);
        ctx.fillStyle = this.popupSubColor[s]!;
        ctx.fillText(sub, 0, 0);
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
  }
}
