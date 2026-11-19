/**
 * Hit feedback effects with fixed-size pools (no allocation while drawing): lane flashes at the hit
 * line, particle bursts, outcome marks on the target well (✕ wrong note, hollow ring miss, an
 * early/late tick on that side of the hit line), outcome text in the gutter (the game's single
 * outcome display: never over the notes still to come, R2-U-01) and faint stray ticks.
 *
 * Effects are timestamped lazily: an effect created between frames starts at the next drawn frame's
 * `perfNow`, so every animation is driven only by the times passed to `drawFrame` (deterministic in
 * tests, and nothing ever reads the wall clock behind the caller's back).
 * @module
 */
import type { GemAtlas } from './atlas';
import type { HighwayLayout } from './layout';
import { FONT_DISPLAY, FONT_TEXT, HW_COLORS, OUTCOME_COLORS } from './theme';

/** Particle pool capacity. */
export const PARTICLE_CAP = 512;
/** Stray tick pool capacity. */
export const STRAY_CAP = 12;
/** Particles per lane burst by outcome code (index 0 unused; Miss has none). */
const BURST: readonly number[] = [0, 22, 15, 10, 9, 0];
/** Lane flash duration (ms; `--dur-hit`). */
const FLASH_MS = 260;
/** Outcome text lifetime (ms). */
const POPUP_MS = 760;
/** Well mark (✕, miss ring, timing tick) lifetime (ms). */
const MARK_MS = 420;
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
    popup: `900 italic ${Math.round(Math.min(24, Math.max(15, gemR * 0.95)))}px ${FONT_DISPLAY}`,
    popupSub: `800 ${Math.round(Math.min(15, Math.max(11, gemR * 0.56)))}px ${FONT_TEXT}`,
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
  private readonly popupWord: string[] = ['', '', '', '', '', '', ''];
  private readonly popupSub: string[] = ['', '', '', '', '', '', ''];
  private readonly popupSubColor: string[] = ['', '', '', '', '', '', ''];
  /** Well marks per string: outcome code and timing side (−1 late, 0 none, +1 early). */
  private readonly markBorn = new Float64Array(7).fill(-Infinity);
  private readonly markCode = new Uint8Array(7);
  private readonly markSide = new Int8Array(7);
  private readonly markColor: string[] = ['', '', '', '', '', '', ''];

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
      // Spray up in a narrow cone over the hit line: not over the notes still to come (right) nor
      // over the outcome text (left).
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 0.9;
      const speed = 0.06 + Math.random() * (code === 1 ? 0.2 : 0.15);
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

  /**
   * Show outcome text in the gutter on `string`'s lane: `word` in the outcome colour and `sub`, the
   * small second line (`'◂ LATE'`, `'1 fret high'`), in `subColor`.
   */
  popup(string: number, code: number, word: string, sub: string, subColor: string): void {
    this.popupBorn[string] = NaN;
    this.popupCode[string] = code;
    this.popupWord[string] = word;
    this.popupSub[string] = sub;
    this.popupSubColor[string] = subColor;
  }

  /**
   * Mark `string`'s target well: a ✕ for a wrong note, a hollow ring for a miss, and for an early or
   * late hit (`side` +1 / −1) a tick on that side of the hit line in `color`.
   */
  mark(string: number, code: number, side: number, color: string): void {
    if (code !== 4 && code !== 5 && side === 0) return;
    this.markBorn[string] = NaN;
    this.markCode[string] = code;
    this.markSide[string] = side;
    this.markColor[string] = color;
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
    this.markBorn.fill(-Infinity);
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
      atlas.drawGlow(ctx, code, hitX, layout.laneY[s]!, gemR * 4.2 * grow);
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

  /** Draw the well marks (✕, miss ring, early/late tick). Call after the flashes. */
  drawMarks(ctx: CanvasRenderingContext2D, layout: HighwayLayout, perfNow: number): void {
    const { hitX, gemR } = layout;
    ctx.lineCap = 'round';
    for (let s = 1; s <= 6; s++) {
      let b = this.markBorn[s]!;
      if (b === -Infinity) continue;
      if (Number.isNaN(b)) b = this.markBorn[s] = perfNow;
      const age = perfNow - b;
      if (age >= MARK_MS) {
        this.markBorn[s] = -Infinity;
        continue;
      }
      const y = layout.laneY[s]!;
      const k = age / MARK_MS;
      ctx.globalAlpha = k < 0.5 ? 1 : 1 - (k - 0.5) / 0.5;
      const code = this.markCode[s]!;
      if (code === 4) {
        // Wrong note: a magenta ✕ over the well.
        const d = gemR * 0.62;
        ctx.strokeStyle = HW_COLORS.bg;
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.moveTo(hitX - d, y - d);
        ctx.lineTo(hitX + d, y + d);
        ctx.moveTo(hitX + d, y - d);
        ctx.lineTo(hitX - d, y + d);
        ctx.stroke();
        ctx.strokeStyle = OUTCOME_COLORS[4]!;
        ctx.lineWidth = 3.5;
        ctx.stroke();
      } else if (code === 5) {
        // Miss: a hollow grey ring around the well.
        ctx.strokeStyle = OUTCOME_COLORS[5]!;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(hitX, y, gemR * (1.12 + (this.reducedMotion ? 0 : 0.12 * k)), 0, Math.PI * 2);
        ctx.stroke();
      }
      const side = this.markSide[s]!;
      if (side !== 0) {
        // Early: a tick just right of the well (the note was still coming); late: just left.
        const x = hitX + side * (gemR + 7);
        ctx.strokeStyle = HW_COLORS.bg;
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(x, y - gemR * 0.7);
        ctx.lineTo(x + side * 5, y);
        ctx.lineTo(x, y + gemR * 0.7);
        ctx.stroke();
        ctx.strokeStyle = this.markColor[s]!;
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';
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
      const word = this.popupWord[s]!;
      const y = layout.laneY[s]! + rise - (sub ? gemR * 0.3 : 0);
      ctx.setTransform(dpr * punch, 0, 0, dpr * punch, dpr * popupRight, dpr * y);
      ctx.font = fonts.popup;
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 5;
      ctx.strokeStyle = HW_COLORS.bg;
      ctx.strokeText(word, 0, 0);
      ctx.fillStyle = OUTCOME_COLORS[code]!;
      ctx.fillText(word, 0, 0);
      if (sub) {
        ctx.setTransform(dpr, 0, 0, dpr, dpr * popupRight, dpr * (y + gemR * 0.85));
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
