/**
 * The highway renderer: owns layout, static layers, sprite atlas, per-note judgement state and the
 * effect pools, and draws one frame for a given heard song time. It never advances time: each frame
 * reads `clock.heardSongTime(perfNow)` and `clock.speed`, nothing else.
 *
 * Hot-loop rules (60 fps on long, dense songs): the visible window is found by binary search over the
 * prepared typed arrays; static layers and sprites are blitted; no objects, arrays, closures or strings
 * are created while drawing (labels are prepared up front).
 * @module
 */
import type { SongClock } from '@shared/clock';
import type { Judgement, StrayEvent } from '@shared/judge';
import type { HighwayOptions } from '@shared/services';
import type { Song } from '@shared/song';
import { computePositions, cueShowAt } from '@core/handpos';
import { midiToName } from '@core/model';
import {
  GemAtlas,
  SHAPE_DEAD,
  SHAPE_DIAMOND,
  SHAPE_ROUND,
  STATE_MISS,
  STATE_NORMAL,
  STATE_WRONG,
  context2d,
  roundRectPath,
  type Surface,
} from './atlas';
import { FeedbackFx, fxFonts, type FxFonts } from './fx';
import { ComboHud, hudFonts, type HudFonts } from './hud';
import { buildBackground, buildForeground, type Foreground } from './layers';
import { computeLayout, createLayout, safeSpeed, visibleWindow, type HighwayLayout, type TimeWindow } from './layout';
import {
  F_BEND_RELEASE,
  F_DEAD,
  F_GHOST,
  F_HAMMER,
  F_HARMONIC,
  F_LET_RING,
  F_PULL,
  F_TIED_DEST,
  F_VIBRATO,
  laneNames,
  lastAtOrBefore,
  longScanStart,
  lowerBound,
  noteScanStart,
  prepareHandPositions,
  prepareSong,
  type PreparedSong,
} from './prepare';
import {
  FONT_DISPLAY,
  FONT_TEXT,
  HW_COLORS,
  LANE_COLORS,
  MULTIPLIER_COLORS,
  OUTCOME_CODE,
  TAIL_COLORS,
  TAIL_MISS,
  TAIL_WRONG,
  isHitCode,
  rgba,
} from './theme';

const DASH_LET_RING: number[] = [7, 6];
const DASH_BRACKET: number[] = [4, 4];
const NO_DASH: number[] = [];
/** Ghost notes are drawn at this scale. */
const GHOST_SCALE = 0.74;
/** A cue bracket fades in over this many song seconds after `showAt`. */
const CUE_FADE_SEC = 0.25;
const SUB_EARLY = 'EARLY';
const SUB_LATE = 'LATE';
const CHORD_NOTE = 'Chords: any chord tone counts';
const LOOP_A = 'A';
const LOOP_B = 'B';
const PM_TEXT = 'PM';
/** Colour of the early/late hint under a Good. */
const TIMING_COLOR = '#ffb46b';

/** Text fonts used by the world pass (built on resize). */
interface WorldFonts {
  bar: string;
  section: string;
  chord: string;
  glyph: string;
  bend: string;
  cue: string;
  strip: string;
}

/** Options with defaults applied. */
export type ResolvedOptions = Required<Pick<HighwayOptions, 'noteSpeed' | 'handCues'>> & Pick<HighwayOptions, 'positions' | 'loop'>;

/** Draws the highway into a canvas; see the module docs. */
export class HighwayRenderer {
  readonly layout: HighwayLayout = createLayout();
  readonly prep: PreparedSong;
  readonly fx = new FeedbackFx();
  readonly hud = new ComboHud();
  private readonly ctx: CanvasRenderingContext2D;
  private readonly win: TimeWindow = { from: 0, to: 0 };
  private readonly lanes: string[];
  private opts: ResolvedOptions;
  private atlas: GemAtlas | null = null;
  private bg: Surface | null = null;
  private fg: Foreground | null = null;
  private worldFonts: WorldFonts | null = null;
  private fxFont: FxFonts = fxFonts(16);
  private hudFont: HudFonts = hudFonts(28);
  private sectionW = new Float32Array(0);
  private chordNameW = new Float32Array(0);
  private cueW = new Float32Array(0);
  private chordNoteW = 0;
  private positionW = new Float32Array(0);
  /** Reused argument for `cueShowAt` (no per-frame allocation). */
  private readonly cueArg = { showAt: 0, time: 0 };

  /** Per-note outcome code (0 = none) valid while `noteEpoch[i] === epoch`. */
  private readonly noteState: Uint8Array;
  private readonly noteEpoch: Int32Array;
  private epoch = 1;
  /** Latest loop pass seen (judgements of older passes no longer colour gems). */
  private pass = 0;
  /** Heard song time of the last frame (rewind detection). */
  private lastNow = -Infinity;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly song: Song,
    private readonly clock: SongClock,
    opts: HighwayOptions,
  ) {
    this.ctx = context2d(canvas);
    this.opts = { noteSpeed: opts.noteSpeed, handCues: opts.handCues, positions: opts.positions, loop: opts.loop ?? null };
    this.prep = prepareSong(song, this.handAnalysis());
    this.noteState = new Uint8Array(this.prep.n);
    this.noteEpoch = new Int32Array(this.prep.n);
    this.lanes = laneNames(song.meta.tuning);
  }

  /** Current options. */
  get options(): Readonly<ResolvedOptions> {
    return this.opts;
  }

  /** Merge option changes (note speed, hand cues, positions, loop). */
  setOptions(patch: Partial<HighwayOptions>): void {
    const positionsChanged = patch.positions !== undefined && patch.positions !== this.opts.positions;
    const cuesTurnedOn = patch.handCues === true && !this.opts.handCues;
    this.opts = {
      noteSpeed: patch.noteSpeed ?? this.opts.noteSpeed,
      handCues: patch.handCues ?? this.opts.handCues,
      positions: patch.positions ?? this.opts.positions,
      loop: patch.loop !== undefined ? patch.loop : this.opts.loop,
    };
    if (positionsChanged || (cuesTurnedOn && !this.prep.hand)) {
      const analysis = this.handAnalysis();
      this.prep.hand = analysis ? prepareHandPositions(analysis) : null;
      this.measureLabels();
    }
    if (patch.noteSpeed !== undefined) this.relayout(this.layout.width, this.layout.height, this.layout.dpr, false);
  }

  /** Hand positions: the supplied analysis, else computed when cues are on. */
  private handAnalysis(): HighwayOptions['positions'] | null {
    if (this.opts.positions) return this.opts.positions;
    return this.opts.handCues ? computePositions(this.song) : null;
  }

  /**
   * Size the backing store for `cssW × cssH` at `dpr` and rebuild layers and sprites when the
   * geometry changed. Returns true when anything was rebuilt.
   */
  resize(cssW: number, cssH: number, dpr: number): boolean {
    const w = Math.max(1, Math.round(cssW));
    const h = Math.max(1, Math.round(cssH));
    const L = this.layout;
    if (this.bg && w === L.width && h === L.height && dpr === L.dpr) return false;
    this.relayout(w, h, dpr, true);
    return true;
  }

  private relayout(w: number, h: number, dpr: number, rebuild: boolean): void {
    const L = computeLayout(w, h, dpr, this.opts.noteSpeed, this.layout);
    if (!rebuild) return;
    this.canvas.width = Math.max(1, Math.round(L.width * L.dpr));
    this.canvas.height = Math.max(1, Math.round(L.height * L.dpr));
    this.atlas = new GemAtlas(L.gemR, L.dpr);
    this.bg = buildBackground(L, this.lanes);
    this.fg = buildForeground(L);
    const small = Math.max(10, Math.round(L.gemR * 0.5));
    this.worldFonts = {
      bar: `600 ${Math.max(9, small - 1)}px ${FONT_TEXT}`,
      section: `800 ${Math.max(10, small)}px ${FONT_TEXT}`,
      chord: `800 ${Math.max(11, Math.round(L.gemR * 0.62))}px ${FONT_DISPLAY}`,
      glyph: `800 italic ${Math.max(11, Math.round(L.gemR * 0.66))}px ${FONT_DISPLAY}`,
      bend: `800 ${Math.max(10, Math.round(L.gemR * 0.58))}px ${FONT_DISPLAY}`,
      cue: `800 ${Math.max(10, small)}px ${FONT_DISPLAY}`,
      strip: `600 ${Math.max(10, small - 1)}px ${FONT_TEXT}`,
    };
    this.fxFont = fxFonts(L.gemR);
    this.hudFont = hudFonts(L.badgeR);
    this.measureLabels();
  }

  /** Measure label widths once (pills need them; measuring per frame would allocate). */
  private measureLabels(): void {
    const f = this.worldFonts;
    if (!f) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.letterSpacing = '1px';
    ctx.font = f.section;
    this.sectionW = Float32Array.from(this.prep.sections.label, (l) => ctx.measureText(l).width);
    ctx.letterSpacing = '0px';
    ctx.font = f.cue;
    const hand = this.prep.hand;
    this.cueW = Float32Array.from(hand ? hand.cues.label : [], (l) => ctx.measureText(l).width);
    this.positionW = Float32Array.from(hand ? hand.positions.label : [], (l) => ctx.measureText(l).width);
    ctx.font = f.strip;
    this.chordNoteW = ctx.measureText(CHORD_NOTE).width;
    ctx.font = f.chord;
    this.chordNameW = Float32Array.from(this.prep.chords.name, (l) => ctx.measureText(l).width);
    ctx.restore();
  }

  /** Outcome code of note `i` (0 when not judged in the current epoch). */
  stateOf(i: number): number {
    return this.noteEpoch[i] === this.epoch ? this.noteState[i]! : 0;
  }

  /**
   * Forget every gem judgement (seek / rewind / stop / new loop pass). `clearFx` also drops running
   * effects (a jump elsewhere); a loop wrap lets them finish.
   */
  resetJudgements(pass?: number, clearFx = false): void {
    this.epoch++;
    if (pass !== undefined) this.pass = pass;
    if (clearFx) this.fx.clear();
  }

  /** React to a clock re-anchor: rewinds and loop wraps clear gem judgements. */
  onClockChange(reason: string, anchorSongTime: number, pass: number): void {
    if (reason === 'stop') this.resetJudgements(pass, true);
    else if (reason === 'loop-wrap' || pass !== this.pass) this.resetJudgements(pass);
    else if (Number.isFinite(this.lastNow) && anchorSongTime < this.lastNow - 0.05) this.resetJudgements(undefined, true);
  }

  /**
   * Apply a judgement: colour the gems (current loop pass only) and trigger the flash / particles /
   * text. A judgement of the previous pass (a note just before B, judged after the wrap) still gets
   * its feedback but no longer colours the gems, which now belong to the new pass.
   */
  feedback(j: Judgement): void {
    if (j.pass > this.pass) this.resetJudgements(j.pass);
    const colour = j.pass === this.pass;
    const code = OUTCOME_CODE[j.outcome];
    const ids = j.noteIds;
    const p = this.prep;
    let top = 7;
    let strings = 0;
    let repeat = false;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k]!;
      if (id < 0 || id >= p.n) continue;
      if (colour) {
        if (this.stateOf(id) === code) repeat = true;
        this.noteState[id] = code;
        this.noteEpoch[id] = this.epoch;
      }
      const s = p.string[id]!;
      if (s < top) top = s;
      strings++;
    }
    // A provisional WrongNote is emitted again when fixed: colour only, no second burst.
    if (strings === 0 || (repeat && code === OUTCOME_CODE.WrongNote)) return;
    const L = this.layout;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k]!;
      if (id < 0 || id >= p.n) continue;
      const s = p.string[id]!;
      this.fx.burst(s, code, L.hitX, L.laneY[s]!, 1 / Math.sqrt(strings));
    }
    let sub = '';
    let subColor: string = HW_COLORS.textMuted;
    if (code === OUTCOME_CODE.WrongNote && j.playedMidi !== undefined) {
      sub = `played ${midiToName(j.playedMidi)}`;
      subColor = '#ffb3c2';
    } else if (isHitCode(code) && j.timing) {
      sub = j.timing === 'early' ? SUB_EARLY : SUB_LATE;
      subColor = TIMING_COLOR;
    }
    this.fx.popup(top, code, sub, subColor);
  }

  /** Faint tick for a stray onset. */
  stray(_s: StrayEvent): void {
    this.fx.stray();
  }

  /** Combo / multiplier for the flame and badge. */
  setCombo(combo: number, multiplier: number): void {
    this.hud.set(combo, multiplier);
  }

  /** Set reduced motion for effects. */
  setReducedMotion(on: boolean): void {
    this.fx.reducedMotion = on;
    this.hud.reducedMotion = on;
  }

  /** Draw one frame at `perfNow` (a `performance.now()` value). */
  draw(perfNow: number): void {
    const ctx = this.ctx;
    const L = this.layout;
    const atlas = this.atlas;
    if (!atlas || !this.bg || !this.fg) return;
    ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.bg, 0, 0, L.width, L.height);

    const now = this.clock.heardSongTime(perfNow);
    const speed = safeSpeed(this.clock.speed);
    const live = Number.isFinite(now);
    let chordsVisible = false;
    if (live) {
      this.lastNow = now;
      visibleWindow(L, now, speed, this.win);
      chordsVisible = this.drawWorld(ctx, atlas, now, speed);
    }

    const fg = this.fg;
    ctx.drawImage(fg.gutter, 0, 0, fg.gutterW, L.height);
    ctx.drawImage(fg.edge, L.width - fg.edgeW, 0, fg.edgeW, L.height);
    this.drawHitPulse(ctx, perfNow);
    this.fx.drawFlashes(ctx, L, atlas, perfNow);
    this.hud.draw(ctx, L, this.hudFont, perfNow);
    this.fx.drawPopups(ctx, L, this.fxFont, perfNow);
    if (live) this.drawStatus(ctx, now, chordsVisible);
  }

  /** Grid, sections, cues, notes, glyphs and the loop region. Returns true when a chord is on screen. */
  private drawWorld(ctx: CanvasRenderingContext2D, atlas: GemAtlas, now: number, speed: number): boolean {
    const L = this.layout;
    const p = this.prep;
    const f = this.worldFonts!;
    const { from, to } = this.win;
    const k = L.pxPerSec / speed;
    const hitX = L.hitX;
    const loop = this.opts.loop;

    // Loop region tint and A/B lines (under the notes).
    if (loop) {
      const xa = hitX + (loop.start - now) * k;
      const xb = hitX + (loop.end - now) * k;
      const x0 = Math.max(xa, hitX);
      if (xb > x0) {
        ctx.fillStyle = HW_COLORS.loopTint;
        ctx.fillRect(x0, L.lanesTop, Math.min(xb, L.width) - x0, L.lanesBottom - L.lanesTop);
      }
      ctx.fillStyle = HW_COLORS.loopMarker;
      if (xa > hitX - L.fadeW && xa < L.width + 2) ctx.fillRect(xa - 1.5, L.lanesTop - 4, 3, L.lanesBottom - L.lanesTop + 8);
      if (xb > hitX - L.fadeW && xb < L.width + 2) ctx.fillRect(xb - 1.5, L.lanesTop - 4, 3, L.lanesBottom - L.lanesTop + 8);
    }

    this.drawGrid(ctx, f, now, k, from, to);
    if (this.opts.handCues && p.hand) this.drawCues(ctx, f, now, speed, k, from, to);

    const s0 = noteScanStart(p, from);
    const s1 = lowerBound(p.time, to, s0);
    this.drawLongTails(ctx, now, k, from, to, s0);
    for (let i = s0; i < s1; i++) this.drawTailAndLinks(ctx, i, now, k, from);
    const chordsVisible = this.drawChords(ctx, f, now, k, from, to);
    const g0 = lowerBound(p.time, from, s0);
    for (let i = g0; i < s1; i++) this.drawGem(ctx, atlas, f, i, now, k);
    this.drawPalmMutes(ctx, f, now, k, from, to);
    if (loop) this.drawLoopBounds(ctx, f, loop.start, loop.end, now, k);
    return chordsVisible;
  }

  /** Beat and bar lines, bar numbers, section lines and (sticky) section labels. */
  private drawGrid(ctx: CanvasRenderingContext2D, f: WorldFonts, now: number, k: number, from: number, to: number): void {
    const L = this.layout;
    const b = this.prep.beats;
    const hitX = L.hitX;
    const b0 = lowerBound(b.time, from);
    const b1 = lowerBound(b.time, to, b0);

    ctx.lineWidth = 1;
    ctx.strokeStyle = HW_COLORS.beat;
    ctx.beginPath();
    for (let i = b0; i < b1; i++) {
      if (b.down[i]) continue;
      const x = Math.round(hitX + (b.time[i]! - now) * k) + 0.5;
      ctx.moveTo(x, L.lanesTop);
      ctx.lineTo(x, L.lanesBottom);
    }
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = HW_COLORS.bar;
    ctx.beginPath();
    for (let i = b0; i < b1; i++) {
      if (!b.down[i]) continue;
      const x = Math.round(hitX + (b.time[i]! - now) * k);
      ctx.moveTo(x, L.lanesTop - 6);
      ctx.lineTo(x, L.lanesBottom);
    }
    ctx.stroke();

    // Bar numbers (hidden under the sticky section label near the hit line).
    ctx.font = f.bar;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = HW_COLORS.textSubtle;
    const stripY = L.lanesTop / 2 + 1;
    for (let i = b0; i < b1; i++) {
      if (!b.down[i]) continue;
      const x = hitX + (b.time[i]! - now) * k;
      if (x < hitX + 2) continue;
      const chord = b.chordAt[i]!;
      ctx.fillText(b.label[i]!, x + (chord >= 0 ? this.chordNameW[chord]! / 2 + 7 : 5), stripY);
    }

    // Sections.
    const sec = this.prep.sections;
    if (sec.n === 0) return;
    const cur = lastAtOrBefore(sec.start, now);
    const first = Math.max(0, cur);
    ctx.strokeStyle = HW_COLORS.section;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = first; i < sec.n && sec.start[i]! < to; i++) {
      const x = Math.round(hitX + (sec.start[i]! - now) * k);
      if (x < hitX - L.fadeW) continue;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, L.lanesBottom);
    }
    ctx.stroke();

    // Upcoming section names ride their line until they reach the hit line; the current one is
    // pinned in the gutter (drawStatus).
    ctx.font = f.section;
    ctx.letterSpacing = '1px';
    for (let i = cur + 1; i < sec.n && sec.start[i]! < to; i++) {
      const chord = sec.chordAt[i]!;
      const x = hitX + (sec.start[i]! - now) * k + (chord >= 0 ? this.chordNameW[chord]! / 2 + 12 : 7);
      if (x < hitX + 26) continue;
      this.sectionPill(ctx, i, x, stripY, false);
    }
    ctx.letterSpacing = '0px';
  }

  /** A section name pill with its text left edge at `x`. */
  private sectionPill(ctx: CanvasRenderingContext2D, i: number, x: number, y: number, current: boolean): void {
    roundRectPath(ctx, x - 7, y - 9, this.sectionW[i]! + 14, 18, 9);
    ctx.fillStyle = current ? '#2a1d12' : HW_COLORS.strip;
    ctx.fill();
    ctx.strokeStyle = HW_COLORS.section;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = HW_COLORS.accentStrong;
    ctx.fillText(this.prep.sections.label[i]!, x, y + 0.5);
  }

  /**
   * Hand-position shift cues: a fret-labelled bracket ahead of the first note in the new position,
   * shown from `cueShowAt(cue, speed)` (≥ 0.75 real seconds ahead, also above 100% speed).
   */
  private drawCues(ctx: CanvasRenderingContext2D, f: WorldFonts, now: number, speed: number, k: number, from: number, to: number): void {
    const L = this.layout;
    const cues = this.prep.hand!.cues;
    const c0 = lowerBound(cues.time, from);
    const top = L.lanesTop + 3;
    const bottom = L.lanesBottom - 3;
    const stripY = L.lanesTop / 2 + 1;
    ctx.font = f.cue;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = c0; i < cues.n && cues.time[i]! < to; i++) {
      this.cueArg.showAt = cues.showAt[i]!;
      this.cueArg.time = cues.time[i]!;
      const shown = now - cueShowAt(this.cueArg, speed);
      if (shown < 0) continue;
      const x = Math.round(L.hitX + (cues.time[i]! - now) * k - L.gemR - 10);
      // Fade in after `showAt`. The label pill fades out before it reaches the position pill on the
      // hit line (which then shows the new position); the bracket rides on into the gutter fade.
      const alpha = Math.min(1, shown / CUE_FADE_SEC);
      const pillAlpha = Math.min(alpha, (x - L.hitX - 26) / 16);
      const bracketAlpha = Math.min(alpha, 1 + (x - (L.hitX - L.gemR - 10)) / (L.gemR * 1.5));
      if (bracketAlpha <= 0) continue;
      ctx.globalAlpha = bracketAlpha;
      // Bracket "[" spanning all lanes.
      ctx.strokeStyle = HW_COLORS.cue;
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x + 8, top);
      ctx.lineTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.lineTo(x + 8, bottom);
      ctx.stroke();
      if (pillAlpha <= 0) continue;
      ctx.globalAlpha = pillAlpha;
      // Label pill with a direction arrow.
      const w = this.cueW[i]! + 22;
      roundRectPath(ctx, x - 2, stripY - 10, w, 20, 10);
      ctx.fillStyle = HW_COLORS.cue;
      ctx.fill();
      const ax = x + 8;
      const up = cues.up[i] === 1;
      ctx.fillStyle = HW_COLORS.ink;
      ctx.beginPath();
      ctx.moveTo(ax - 4, up ? stripY + 3 : stripY - 3);
      ctx.lineTo(ax + 4, up ? stripY + 3 : stripY - 3);
      ctx.lineTo(ax, up ? stripY - 4 : stripY + 4);
      ctx.closePath();
      ctx.fill();
      ctx.fillText(cues.label[i]!, x + 15, stripY + 0.5);
    }
    ctx.globalAlpha = 1;
  }

  /** Tails of long sustains that started before the main scan window. */
  private drawLongTails(ctx: CanvasRenderingContext2D, now: number, k: number, from: number, to: number, s0: number): void {
    const p = this.prep;
    for (let j = longScanStart(p, from); j < p.longIdx.length; j++) {
      const i = p.longIdx[j]!;
      if (i >= s0 || p.time[i]! >= to) break;
      if (p.end[i]! >= from) this.drawTailAndLinks(ctx, i, now, k, from);
    }
  }

  /** Sustain tail (solid, dashed let-ring, vibrato wave) and connectors (h/p arcs, slides). */
  private drawTailAndLinks(ctx: CanvasRenderingContext2D, i: number, now: number, k: number, from: number): void {
    const p = this.prep;
    const L = this.layout;
    const t = p.time[i]!;
    const e = p.end[i]!;
    if (e < from) return;
    const fl = p.flags[i]!;
    const st = this.stateOf(i);
    const hit = isHitCode(st);
    const s = p.string[i]!;
    const y = L.laneY[s]!;
    const r = L.gemR;
    const x = L.hitX + (t - now) * k;
    const xe = L.hitX + (e - now) * k;

    // Tail.
    if (!(fl & F_DEAD) && xe - x > r * 1.4) {
      let x0 = fl & F_TIED_DEST ? x - r : x + r * 0.5;
      if (hit) x0 = Math.max(x0, L.hitX);
      if (xe > x0) {
        const th = r * 0.4;
        const color = st === 5 ? TAIL_MISS : st === 4 ? TAIL_WRONG : hit ? LANE_COLORS[s]! : TAIL_COLORS[s]!;
        if (fl & F_LET_RING) {
          ctx.strokeStyle = color;
          ctx.lineWidth = th * 0.55;
          ctx.setLineDash(DASH_LET_RING);
          ctx.lineDashOffset = -x;
          ctx.beginPath();
          ctx.moveTo(x0, y);
          ctx.lineTo(xe, y);
          ctx.stroke();
          ctx.setLineDash(NO_DASH);
        } else {
          ctx.fillStyle = color;
          ctx.fillRect(x0, y - th / 2, xe - x0, th);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
          ctx.fillRect(x0, y - th / 2, xe - x0, 1.5);
        }
        if (fl & F_VIBRATO) this.wave(ctx, x0, xe, y, x, th * 0.42);
      }
    }

    // Slide in/out stubs, then connectors to the next note on the same string.
    if (hit && x < L.hitX) return;
    const slide = p.slide[i]!;
    if (slide >= 1 && slide <= 4) {
      this.slideStub(ctx, slide, x, y, r);
      return;
    }
    const legato = fl & (F_HAMMER | F_PULL);
    const nx = p.next[i]!;
    if (nx < 0 || (!legato && slide === 0)) return;
    const x2 = L.hitX + (p.time[nx]! - now) * k;
    if (legato) {
      const peak = y - r - L.laneH * 0.3;
      const xa = x + r * 0.55;
      const xb = x2 - r * 0.55;
      const xm = (xa + xb) / 2;
      ctx.lineCap = 'round';
      ctx.strokeStyle = HW_COLORS.connectorShadow;
      ctx.lineWidth = 4.5;
      ctx.beginPath();
      ctx.moveTo(xa, y - r * 0.85);
      ctx.quadraticCurveTo(xm, peak, xb, y - r * 0.85);
      ctx.stroke();
      ctx.strokeStyle = HW_COLORS.connector;
      ctx.lineWidth = 2;
      ctx.stroke();
      const f = this.worldFonts!;
      ctx.font = f.glyph;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3.5;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = HW_COLORS.bg;
      const label = fl & F_HAMMER ? 'h' : 'p';
      const ly = (y - r * 0.85 + peak) / 2 + 1;
      ctx.strokeText(label, xm, ly);
      ctx.fillStyle = HW_COLORS.text;
      ctx.fillText(label, xm, ly);
      ctx.lineCap = 'butt';
    } else {
      // Shift / legato slide: a diagonal from this gem to the next ("/" up the neck, "\" down).
      const dir = p.fret[nx]! >= p.fret[i]! ? 1 : -1;
      const xa = x + r * 0.9;
      const xb = x2 - r * 0.9;
      if (xb <= xa) return;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(xa, y + dir * r * 0.6);
      ctx.lineTo(xb, y - dir * r * 0.6);
      ctx.strokeStyle = HW_COLORS.connectorShadow;
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.strokeStyle = LANE_COLORS[s]!;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.lineCap = 'butt';
    }
  }

  /** Slide into / out of a note: a short diagonal stroke before or after the gem. */
  private slideStub(ctx: CanvasRenderingContext2D, slide: number, x: number, y: number, r: number): void {
    let xa: number;
    let ya: number;
    let xb: number;
    let yb: number;
    if (slide === 1) {
      // in from below: "/"
      xa = x - r * 2.3;
      ya = y + r * 0.8;
      xb = x - r * 1.05;
      yb = y - r * 0.15;
    } else if (slide === 2) {
      // in from above: "\"
      xa = x - r * 2.3;
      ya = y - r * 0.8;
      xb = x - r * 1.05;
      yb = y + r * 0.15;
    } else if (slide === 3) {
      // out upward: "/"
      xa = x + r * 1.05;
      ya = y + r * 0.15;
      xb = x + r * 2.3;
      yb = y - r * 0.8;
    } else {
      // out downward: "\"
      xa = x + r * 1.05;
      ya = y - r * 0.15;
      xb = x + r * 2.3;
      yb = y + r * 0.8;
    }
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(xa, ya);
    ctx.lineTo(xb, yb);
    ctx.strokeStyle = HW_COLORS.connectorShadow;
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.strokeStyle = HW_COLORS.connector;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  /** Vibrato wave from `x0` to `x1` on lane centre `y`, phase-locked to the note at `xNote`. */
  private wave(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number, xNote: number, amp: number): void {
    ctx.beginPath();
    const step = 2.5;
    for (let x = x0; x <= x1; x += step) {
      const yy = y + Math.sin((x - xNote) * 0.33) * amp;
      if (x === x0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.strokeStyle = HW_COLORS.wave;
    ctx.lineWidth = 1.75;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  /** Chord frames (box over the struck strings + name). Returns true if any chord is visible. */
  private drawChords(ctx: CanvasRenderingContext2D, f: WorldFonts, now: number, k: number, from: number, to: number): boolean {
    const L = this.layout;
    const c = this.prep.chords;
    const c0 = lowerBound(c.time, from);
    const r = L.gemR;
    let any = false;
    ctx.font = f.chord;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (let i = c0; i < c.n && c.time[i]! < to; i++) {
      const st = this.stateOf(c.firstNote[i]!);
      const x = L.hitX + (c.time[i]! - now) * k;
      if (isHitCode(st) || x < L.hitX - L.fadeW) continue;
      if (x > L.hitX - r) any = true;
      const top = L.laneY[c.minS[i]!]! - r - 6;
      const bottom = L.laneY[c.maxS[i]!]! + r + 6;
      ctx.globalAlpha = st === 5 ? 0.45 : 1;
      roundRectPath(ctx, x - r - 6, top, r * 2 + 12, bottom - top, r * 0.6);
      ctx.fillStyle = HW_COLORS.chordFill;
      ctx.fill();
      ctx.strokeStyle = HW_COLORS.chordStroke;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Strum stem through the gems.
      ctx.fillStyle = 'rgba(233, 237, 243, 0.28)';
      ctx.fillRect(x - 1.5, top + 4, 3, bottom - top - 8);
      const name = c.name[i]!;
      // Top-strip names give way to the position pill once the chord reaches the hit line.
      if (name && (c.minS[i] !== 1 || x > L.hitX + r + 4)) {
        // Chords that include the top string carry their name in the top strip, like a chord chart.
        const ny = c.minS[i] === 1 ? L.lanesTop / 2 + 1 + L.gemR * 0.3 : top - 3;
        ctx.lineWidth = 4;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = c.minS[i] === 1 ? HW_COLORS.strip : HW_COLORS.bg;
        ctx.strokeText(name, x, ny);
        ctx.fillStyle = HW_COLORS.text;
        ctx.fillText(name, x, ny);
      }
    }
    ctx.globalAlpha = 1;
    return any;
  }

  /** One gem with its fret number and per-note glyphs (bend arrow, short vibrato). */
  private drawGem(ctx: CanvasRenderingContext2D, atlas: GemAtlas, f: WorldFonts, i: number, now: number, k: number): void {
    const p = this.prep;
    const fl = p.flags[i]!;
    if (fl & F_TIED_DEST) return;
    const st = this.stateOf(i);
    if (isHitCode(st)) return;
    const L = this.layout;
    const s = p.string[i]!;
    const x = L.hitX + (p.time[i]! - now) * k;
    const y = L.laneY[s]!;
    const r = L.gemR;
    const shape = fl & F_DEAD ? SHAPE_DEAD : fl & F_HARMONIC ? SHAPE_DIAMOND : SHAPE_ROUND;
    const state = st === 4 ? STATE_WRONG : st === 5 ? STATE_MISS : STATE_NORMAL;
    const scale = fl & F_GHOST ? GHOST_SCALE : 1;
    atlas.drawGem(ctx, shape, state, s, x, y, scale);
    if (!(fl & F_DEAD)) atlas.drawFret(ctx, p.fret[i]!, x, y, scale);

    // Short vibrato (no tail to carry it).
    if (fl & F_VIBRATO && (p.end[i]! - p.time[i]!) * k <= r * 1.4) this.wave(ctx, x + r + 3, x + r * 3, y, x, r * 0.25);

    const bend = p.bend[i]!;
    if (bend > 0) {
      // Curved arrow rising from the gem, labelled in tones.
      const ax = x + r * 1.75;
      const tipY = y - r - L.laneH * 0.3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x + r * 0.95, y - r * 0.1);
      ctx.quadraticCurveTo(ax, y - r * 0.1, ax, tipY + 6);
      ctx.strokeStyle = HW_COLORS.connectorShadow;
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.strokeStyle = HW_COLORS.connector;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.fillStyle = HW_COLORS.connector;
      ctx.beginPath();
      ctx.moveTo(ax - 5, tipY + 7);
      ctx.lineTo(ax + 5, tipY + 7);
      ctx.lineTo(ax, tipY - 1);
      ctx.closePath();
      ctx.fill();
      ctx.font = f.bend;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3.5;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = HW_COLORS.bg;
      ctx.strokeText(p.bendLabel[i]!, ax + 6, tipY + 4);
      ctx.fillStyle = HW_COLORS.text;
      ctx.fillText(p.bendLabel[i]!, ax + 6, tipY + 4);
      if (fl & F_BEND_RELEASE) {
        // Release: a downward arrow at the end of the sustain.
        const rx = Math.max(L.hitX + (p.end[i]! - now) * k - r * 0.4, ax + r * 1.6);
        ctx.beginPath();
        ctx.moveTo(ax + r * 0.4, tipY + 2);
        ctx.quadraticCurveTo(rx, tipY + 2, rx, y - r * 0.35 - 6);
        ctx.strokeStyle = HW_COLORS.connectorShadow;
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.strokeStyle = HW_COLORS.connector;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(rx - 5, y - r * 0.35 - 7);
        ctx.lineTo(rx + 5, y - r * 0.35 - 7);
        ctx.lineTo(rx, y - r * 0.35 + 1);
        ctx.closePath();
        ctx.fill();
      }
      ctx.lineCap = 'butt';
    }
  }

  /** `PM ---- |` brackets in the bottom strip. */
  private drawPalmMutes(ctx: CanvasRenderingContext2D, f: WorldFonts, now: number, k: number, from: number, to: number): void {
    const L = this.layout;
    const pm = this.prep.palmMute;
    if (pm.n === 0) return;
    const y = L.lanesBottom + (L.height - L.lanesBottom) / 2 + 0.5;
    let i = lowerBound(pm.end, from);
    // Runs are disjoint and in time order, so `end` is sorted too.
    ctx.font = f.strip;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (; i < pm.n && pm.start[i]! < to; i++) {
      // The label sticks by the hit line while the run is still being played.
      const xEnd = L.hitX + (pm.end[i]! - now) * k;
      if (xEnd < L.hitX - L.gemR) continue;
      const x1 = Math.max(L.hitX + (pm.start[i]! - now) * k - L.gemR * 0.6, L.hitX - L.gemR + 2);
      const x2 = Math.max(xEnd, x1 + 26);
      ctx.fillStyle = HW_COLORS.textMuted;
      ctx.fillText(PM_TEXT, x1, y);
      ctx.strokeStyle = HW_COLORS.textSubtle;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(DASH_BRACKET);
      ctx.beginPath();
      ctx.moveTo(x1 + 20, y);
      ctx.lineTo(x2, y);
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
      ctx.beginPath();
      ctx.moveTo(x2, y - 5);
      ctx.lineTo(x2, y + 5);
      ctx.stroke();
    }
  }

  /** Dim outside the A/B loop (over the notes: they are not judged) and draw the A / B flags. */
  private drawLoopBounds(ctx: CanvasRenderingContext2D, f: WorldFonts, a: number, b: number, now: number, k: number): void {
    const L = this.layout;
    const xa = L.hitX + (a - now) * k;
    const xb = L.hitX + (b - now) * k;
    const left = L.hitX - L.fadeW;
    ctx.fillStyle = HW_COLORS.loopDim;
    // Edges sit one gem before the line: a note on A is in the loop (bright), a note on B is not (dim).
    const pad = L.gemR + 7;
    if (xa - pad > left) ctx.fillRect(left, L.lanesTop, Math.min(xa - pad, L.width) - left, L.lanesBottom - L.lanesTop);
    if (xb - pad < L.width) {
      const x0 = Math.max(xb - pad, left);
      ctx.fillRect(x0, L.lanesTop, L.width - x0, L.lanesBottom - L.lanesTop);
    }
    ctx.font = f.section;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    this.loopMarker(ctx, xa, LOOP_A);
    this.loopMarker(ctx, xb, LOOP_B);
  }

  private loopMarker(ctx: CanvasRenderingContext2D, x: number, label: string): void {
    const L = this.layout;
    if (x < L.hitX - L.fadeW || x > L.width + 20) return;
    ctx.fillStyle = HW_COLORS.loopMarker;
    const y = L.lanesBottom + (L.height - L.lanesBottom) / 2;
    roundRectPath(ctx, x - 10, y - 9, 20, 18, 5);
    ctx.fill();
    ctx.fillStyle = HW_COLORS.ink;
    ctx.fillText(label, x, y + 0.5);
  }

  /** Hit line pulse in the multiplier colour after each hit. */
  private drawHitPulse(ctx: CanvasRenderingContext2D, perfNow: number): void {
    const L = this.layout;
    const age = this.fx.hitAge(perfNow);
    const m = this.hud.multiplier;
    const base = m >= 2 ? 0.18 + 0.08 * m : 0;
    const pulse = age >= 0 && age < 220 ? 1 - age / 220 : 0;
    const a = Math.min(1, base + pulse * 0.6);
    if (a <= 0) return;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = a;
    ctx.fillStyle = MULTIPLIER_COLORS[m]!;
    ctx.fillRect(L.hitX - 2.5, L.lanesTop - 3, 5, L.lanesBottom - L.lanesTop + 6);
    ctx.globalAlpha = a * 0.35;
    ctx.fillRect(L.hitX - 7, L.lanesTop - 3, 14, L.lanesBottom - L.lanesTop + 6);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Current section (gutter), current hand position (pill on the hit line) and the chord-leniency note. */
  private drawStatus(ctx: CanvasRenderingContext2D, now: number, chordsVisible: boolean): void {
    const L = this.layout;
    const f = this.worldFonts!;
    const sec = this.prep.sections;
    const cur = lastAtOrBefore(sec.start, now);
    if (cur >= 0 && now < sec.end[cur]!) {
      ctx.font = f.section;
      ctx.letterSpacing = '1px';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      this.sectionPill(ctx, cur, 19, L.lanesTop / 2 + 1, true);
      ctx.letterSpacing = '0px';
    }
    const hand = this.prep.hand;
    if (this.opts.handCues && hand && hand.positions.n > 0) {
      const i = lastAtOrBefore(hand.positions.start, now + 0.02);
      if (i >= 0) {
        const w = this.positionW[i]! + 14;
        const y = L.lanesTop / 2 + 1;
        roundRectPath(ctx, L.hitX - w / 2, y - 10, w, 20, 10);
        ctx.fillStyle = HW_COLORS.strip;
        ctx.fill();
        ctx.strokeStyle = rgba(HW_COLORS.accent, 0.7);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.font = f.cue;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = HW_COLORS.accentStrong;
        ctx.fillText(hand.positions.label[i]!, L.hitX, y + 0.5);
      }
    }
    if (chordsVisible) {
      const y = L.lanesBottom + (L.height - L.lanesBottom) / 2 + 0.5;
      const x = L.width - 14;
      roundRectPath(ctx, x - this.chordNoteW - 10, y - 9, this.chordNoteW + 20, 18, 9);
      ctx.fillStyle = HW_COLORS.strip;
      ctx.fill();
      ctx.font = f.strip;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = HW_COLORS.textMuted;
      ctx.fillText(CHORD_NOTE, x, y);
    }
  }
}
