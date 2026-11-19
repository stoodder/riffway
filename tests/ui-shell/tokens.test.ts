import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OUTCOMES } from '@shared/judge';
import {
  clampStars,
  clampTier,
  DURATIONS_MS,
  JUDGEMENT_COLORS,
  NEON,
  OUTCOME_SLUG,
  STRING_COLORS,
  SURFACE_COLORS,
  TIER_COLORS,
  TIMING_COLORS,
  tierBandName,
} from '../../src/ui/design/tokens';

const css = readFileSync(new URL('../../src/ui/design/tokens.css', import.meta.url), 'utf8');

/** Custom properties declared in the first `:root { … }` block. */
function rootVars(): Map<string, string> {
  const block = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  const vars = new Map<string, string>();
  for (const m of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars.set(m[1] as string, (m[2] as string).trim());
  return vars;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (ch[0] as number) + 0.7152 * (ch[1] as number) + 0.0722 * (ch[2] as number);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** CIE L*a*b* (D65) of a hex colour. */
function lab(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

describe('design tokens', () => {
  const vars = rootVars();

  it('mirrors the TS palettes exactly in tokens.css', () => {
    for (const [s, c] of Object.entries(STRING_COLORS)) expect(vars.get(`--string-${s}`)).toBe(c);
    for (const o of OUTCOMES) expect(vars.get(`--judge-${OUTCOME_SLUG[o]}`)).toBe(JUDGEMENT_COLORS[o]);
    expect([vars.get('--judge-early'), vars.get('--judge-late')]).toEqual([TIMING_COLORS.early, TIMING_COLORS.late]);
    for (const [t, c] of Object.entries(TIER_COLORS)) expect(vars.get(`--tier-${t}`)).toBe(c);
    const surfaceVar: Record<keyof typeof SURFACE_COLORS, string> = {
      bg: '--color-bg',
      surface1: '--color-surface-1',
      surface2: '--color-surface-2',
      surface3: '--color-surface-3',
      border: '--color-border',
      borderStrong: '--color-border-strong',
      text: '--color-text',
      textMuted: '--color-text-muted',
      textSubtle: '--color-text-subtle',
      accent: '--color-accent',
      accentStrong: '--color-accent-strong',
      focus: '--color-focus',
    };
    for (const [k, v] of Object.entries(surfaceVar)) expect(vars.get(v), v).toBe(SURFACE_COLORS[k as keyof typeof SURFACE_COLORS]);
    expect([vars.get('--neon-star'), vars.get('--neon-flame-hot'), vars.get('--neon-flame-mid'), vars.get('--neon-flame-cool')]).toEqual([
      NEON.star,
      NEON.flameHot,
      NEON.flameMid,
      NEON.flameCool,
    ]);
    for (const [k, ms] of Object.entries(DURATIONS_MS)) expect(vars.get(`--dur-${k}`)).toBe(`${ms}ms`);
  });

  it('keeps text, string and judgement colours readable (≥ 4.5:1) on every surface', () => {
    const surfaces = [SURFACE_COLORS.bg, SURFACE_COLORS.surface1, SURFACE_COLORS.surface2];
    const fg = [
      SURFACE_COLORS.text,
      SURFACE_COLORS.textMuted,
      ...Object.values(STRING_COLORS),
      ...Object.values(JUDGEMENT_COLORS),
      ...Object.values(TIMING_COLORS),
      ...Object.values(TIER_COLORS),
    ];
    for (const bg of surfaces) for (const c of fg) expect(contrast(c, bg), `${c} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    for (const bg of surfaces) expect(contrast(SURFACE_COLORS.textSubtle, bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(SURFACE_COLORS.focus, SURFACE_COLORS.bg)).toBeGreaterThanOrEqual(3);
  });

  it('has six clearly distinct string colours (CIE76 ΔE ≥ 30 for every pair)', () => {
    const labs = Object.values(STRING_COLORS).map(lab);
    for (let i = 0; i < labs.length; i++) {
      for (let j = i + 1; j < labs.length; j++) {
        const d = Math.hypot(...(labs[i] as number[]).map((v, k) => v - ((labs[j] as number[])[k] as number)));
        expect(d).toBeGreaterThanOrEqual(30);
      }
    }
  });

  it('keeps outcome and early/late colours apart from every lane colour, and early from late (R2-U-02)', () => {
    const dE = (a: string, b: string): number => Math.hypot(...lab(a).map((v, k) => v - (lab(b)[k] as number)));
    const feedback = { ...JUDGEMENT_COLORS, early: TIMING_COLORS.early, late: TIMING_COLORS.late };
    for (const [name, c] of Object.entries(feedback)) {
      for (const [s, lane] of Object.entries(STRING_COLORS)) expect(dE(c, lane), `${name} vs string ${s}`).toBeGreaterThanOrEqual(30);
    }
    expect(dE(TIMING_COLORS.early, TIMING_COLORS.late)).toBeGreaterThanOrEqual(30);
    // Hits, wrong notes and misses are told apart by colour too.
    for (const hit of [JUDGEMENT_COLORS.Perfect, JUDGEMENT_COLORS.Great, JUDGEMENT_COLORS.Good]) {
      expect(dE(hit, JUDGEMENT_COLORS.WrongNote)).toBeGreaterThanOrEqual(30);
      expect(dE(hit, JUDGEMENT_COLORS.Miss)).toBeGreaterThanOrEqual(30);
    }
  });

  it('collapses every motion duration under reduced motion (OS and data-motion)', () => {
    const blocks = [/@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{([\s\S]*?)\}/, /:root\[data-motion='reduced'\]\s*\{([\s\S]*?)\}/];
    for (const re of blocks) {
      const body = re.exec(css)?.[1] ?? '';
      for (const k of Object.keys(DURATIONS_MS)) expect(body).toContain(`--dur-${k}: 0ms;`);
    }
  });

  it('uses no external font sources', () => {
    expect(css).not.toMatch(/@import|url\(|@font-face/);
  });

  it('maps tiers to band names and clamps values', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((t) => tierBandName(clampTier(t)))).toEqual([
      'Beginner', 'Beginner', 'Developing', 'Developing', 'Intermediate', 'Intermediate', 'Advanced', 'Advanced', 'Expert', 'Expert',
    ]);
    expect(clampTier(4.4)).toBe(4);
    expect(clampTier(0)).toBe(1);
    expect(clampTier(12)).toBe(10);
    expect(clampTier(Number.NaN)).toBe(1);
    expect(clampStars(3.9)).toBe(3);
    expect(clampStars(-1)).toBe(0);
    expect(clampStars(9)).toBe(5);
  });
});
