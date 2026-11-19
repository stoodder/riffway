/**
 * Design tokens that code needs as values (canvas renderers, inline SVG, tests). The CSS custom
 * properties in `./tokens.css` are the styling source; this module mirrors the colour palettes 1:1
 * (a unit test in `tests/ui-shell/tokens.test.ts` keeps them in sync).
 *
 * Visual direction: calm, dark Rocksmith-like surfaces and typography; punchy Guitar-Hero-style neon
 * only for feedback (hit flashes, combo, stars).
 * @module
 */
import type { Outcome, Stars } from '@shared/judge';
import type { StringNumber, Tier, TierName } from '@shared/song';

/** Surface and text colours (`--color-*`). */
export const SURFACE_COLORS = {
  bg: '#07090d',
  surface1: '#0e1218',
  surface2: '#151a23',
  surface3: '#1d2430',
  border: '#262f3d',
  borderStrong: '#364255',
  text: '#e9edf3',
  textMuted: '#a3adbd',
  textSubtle: '#7c8799',
  accent: '#ff8a2b',
  accentStrong: '#ffa45c',
  focus: '#ffc27a',
} as const;

/**
 * Lane colour per string (`--string-1` … `--string-6`), 1 = high e. Rocksmith convention:
 * low E red, A yellow, D blue, G orange, B green, high e purple. All ≥ 4.5:1 on `bg`.
 */
export const STRING_COLORS: Readonly<Record<StringNumber, string>> = {
  1: '#c58bff',
  2: '#3ee283',
  3: '#ff9a3c',
  4: '#45adff',
  5: '#ffd84a',
  6: '#ff5a64',
};

/** Feedback colour per judge outcome (`--judge-perfect` …). Neon; use with a glow on dark. */
export const JUDGEMENT_COLORS: Readonly<Record<Outcome, string>> = {
  Perfect: '#ffd84a',
  Great: '#4cf5a6',
  Good: '#52bfff',
  WrongNote: '#ff4f73',
  Miss: '#7d889b',
};

/** CSS custom-property suffix per outcome (`--judge-<suffix>`, `data-outcome="<suffix>"`). */
export const OUTCOME_SLUG: Readonly<Record<Outcome, string>> = {
  Perfect: 'perfect',
  Great: 'great',
  Good: 'good',
  WrongNote: 'wrong',
  Miss: 'miss',
};

/** Short display label per outcome (HUD text). */
export const OUTCOME_LABEL: Readonly<Record<Outcome, string>> = {
  Perfect: 'Perfect',
  Great: 'Great',
  Good: 'Good',
  WrongNote: 'Wrong note',
  Miss: 'Miss',
};

/** Colour per difficulty tier (`--tier-1` … `--tier-10`): green → cyan → yellow → orange → red. */
export const TIER_COLORS: Readonly<Record<Tier, string>> = {
  1: '#3ee283',
  2: '#2fd6a8',
  3: '#2cc8dc',
  4: '#4fb2ff',
  5: '#ffd84a',
  6: '#ffbf3d',
  7: '#ff9a3c',
  8: '#ff7a45',
  9: '#ff5a64',
  10: '#ff4fa0',
};

/** Star / combo neon colours. */
export const NEON = {
  star: '#ffd84a',
  flameHot: '#ffd23f',
  flameMid: '#ff7a1a',
  flameCool: '#ff3d5e',
} as const;

/** Tier band names (docs/difficulty.md): 1–2 Beginner … 9–10 Expert. */
const TIER_BAND_NAMES: readonly TierName[] = ['Beginner', 'Developing', 'Intermediate', 'Advanced', 'Expert'];

/** Band name for a tier, as in docs/difficulty.md (display helper for the difficulty pill). */
export function tierBandName(tier: Tier): TierName {
  return TIER_BAND_NAMES[Math.floor((tier - 1) / 2)] as TierName;
}

/** Clamp any number to a valid tier (rounded; 1–10). */
export function clampTier(value: number): Tier {
  const t = Math.round(Number.isFinite(value) ? value : 1);
  return Math.min(10, Math.max(1, t)) as Tier;
}

/** Clamp any number to a valid star count (0–5, rounded down). */
export function clampStars(value: number): Stars {
  const s = Math.floor(Number.isFinite(value) ? value : 0);
  return Math.min(5, Math.max(0, s)) as Stars;
}

/** Motion durations in ms (`--dur-*`); all collapse to 0 under reduced motion. */
export const DURATIONS_MS = {
  instant: 70,
  fast: 120,
  base: 200,
  slow: 340,
  hit: 260,
  celebrate: 600,
} as const;

/** True when the user (OS setting) or the app (`data-motion="reduced"`, e2e) asks for reduced motion. */
export function prefersReducedMotion(doc: Document = document): boolean {
  if (doc.documentElement.dataset.motion === 'reduced') return true;
  const mq = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)');
  return Boolean(mq?.matches);
}
