/**
 * Canvas theme for the highway: colours come from the design tokens (`src/ui/design/tokens.ts`), plus
 * the few renderer-only values (fonts, alphas, multiplier colours) the canvas needs as literals.
 * Everything here is computed once at module load; the draw loop only reads it.
 * @module
 */
import type { Outcome } from '@shared/judge';
import type { StringNumber } from '@shared/song';
import { JUDGEMENT_COLORS, NEON, STRING_COLORS, SURFACE_COLORS, TIMING_COLORS } from '../../ui/design/tokens';

/** String numbers top → bottom (1 = high e on top). */
export const STRINGS: readonly StringNumber[] = [1, 2, 3, 4, 5, 6];

/** Outcome codes stored per note (typed arrays) and used to index colour tables. 0 = not judged. */
export const OUTCOME_CODE: Readonly<Record<Outcome, number>> = {
  Perfect: 1,
  Great: 2,
  Good: 3,
  WrongNote: 4,
  Miss: 5,
};

/** Outcome by code (index 0 unused). */
export const OUTCOME_BY_CODE: readonly (Outcome | null)[] = [null, 'Perfect', 'Great', 'Good', 'WrongNote', 'Miss'];

/** True for the three hit outcomes (Perfect / Great / Good). */
export function isHitCode(code: number): boolean {
  return code >= 1 && code <= 3;
}

/** Display font stacks (system fonts only; nothing is fetched). */
export const FONT_DISPLAY =
  "'SF Pro Display', system-ui, -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
export const FONT_TEXT =
  "'SF Pro Text', system-ui, -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/** Parse `#rrggbb` into `[r, g, b]`. */
export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** `#rrggbb` + alpha → `rgba(r, g, b, a)` (build-time helper; never called per frame). */
export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Mix two `#rrggbb` colours (`t` = 0 → a, 1 → b), returned as `#rrggbb`. */
export function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const out = ca.map((v, i) => Math.round(v + (cb[i]! - v) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Colour of each multiplier (index = multiplier; ×1 calm white, ×2 blue, ×3 green, ×4 flame gold). */
export const MULTIPLIER_COLORS: readonly string[] = ['#e9edf3', '#e9edf3', '#52bfff', '#4cf5a6', NEON.flameHot];

/** All canvas colours, keyed by role. */
export const HW_COLORS = {
  bg: SURFACE_COLORS.bg,
  laneA: '#0b0f15',
  laneB: '#0d1219',
  strip: SURFACE_COLORS.surface1,
  border: SURFACE_COLORS.border,
  text: SURFACE_COLORS.text,
  textMuted: SURFACE_COLORS.textMuted,
  textSubtle: SURFACE_COLORS.textSubtle,
  accent: SURFACE_COLORS.accent,
  accentStrong: SURFACE_COLORS.accentStrong,
  ink: '#0a0d12',
  beat: 'rgba(233, 237, 243, 0.07)',
  bar: 'rgba(233, 237, 243, 0.24)',
  section: 'rgba(255, 164, 92, 0.75)',
  connector: 'rgba(240, 244, 250, 0.92)',
  connectorShadow: 'rgba(7, 9, 13, 0.85)',
  wave: 'rgba(240, 244, 250, 0.8)',
  chordFill: 'rgba(233, 237, 243, 0.06)',
  chordStroke: 'rgba(233, 237, 243, 0.42)',
  cue: SURFACE_COLORS.accent,
  cueBand: 'rgba(255, 138, 43, 0.2)',
  cueBandEnd: 'rgba(255, 138, 43, 0)',
  loopTint: 'rgba(255, 138, 43, 0.045)',
  loopDim: 'rgba(7, 9, 13, 0.6)',
  loopMarker: SURFACE_COLORS.accentStrong,
  stray: 'rgba(233, 237, 243, 0.55)',
  missFill: '#4a5262',
  missEdge: '#7d889b',
  wrongFill: JUDGEMENT_COLORS.WrongNote,
} as const;

/** Lane colour per string, indexed by string number (index 0 unused). */
export const LANE_COLORS: readonly string[] = ['', ...STRINGS.map((s) => STRING_COLORS[s])];

/** Translucent sustain fill per string (index 0 unused). */
export const TAIL_COLORS: readonly string[] = ['', ...STRINGS.map((s) => rgba(STRING_COLORS[s], 0.42))];

/** Faint lane string line per string (index 0 unused). */
export const STRING_LINE_COLORS: readonly string[] = ['', ...STRINGS.map((s) => rgba(STRING_COLORS[s], 0.34))];

/** Feedback colour per outcome code (index 0 unused). */
export const OUTCOME_COLORS: readonly string[] = ['', ...OUTCOME_BY_CODE.slice(1).map((o) => JUDGEMENT_COLORS[o!])];

/** Early / late hint colours (tokens `--judge-early` / `--judge-late`). */
export const EARLY_COLOR = TIMING_COLORS.early;
export const LATE_COLOR = TIMING_COLORS.late;

/** Flame colours, outer → inner. */
export const FLAME_COLORS: readonly string[] = [NEON.flameCool, NEON.flameMid, NEON.flameHot];

/** Tail colour for missed / wrong notes. */
export const TAIL_MISS = 'rgba(125, 136, 155, 0.32)';
export const TAIL_WRONG = rgba(JUDGEMENT_COLORS.WrongNote, 0.42);
