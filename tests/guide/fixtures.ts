/**
 * Guide test fixtures (authored for Riffway; see tests/fixtures/classtab-synthetic/README.md for
 * the ClassTab-style files). Node-only helpers live in `node-helpers.ts`.
 */
import type { SongBundle } from '@shared/song';

/**
 * Monophonic notes separated by rests, a tempo change (90 → 140 BPM) and a two-octave range, so
 * each onset and pitch can be measured on its own.
 */
export const ISOLATED_TEX = `\\title "Guide Onsets"
\\tempo 90
.
\\track "Guitar"
\\staff {tabs}
:8 0.6 r r r 3.5 r r r | 5.4 r r r 7.3 r r r | \\tempo 140 2.2 r r r 1.1 r r r | 12.1 r 5.6 r 0.2 r r r`;

/** A guitar track plus a bass track: the guide renders only the guitar (arrangement 0). */
export const TWO_TRACK_TEX = `\\title "Two Tracks"
\\tempo 120
.
\\track "Guitar"
\\staff {tabs}
\\tuning (E4 B3 G3 D3 A2 E2)
:4 0.6 3.6 5.6 7.6 |
\\track "Bass"
\\staff {tabs}
\\tuning (G2 D2 A1 E1)
\\instrument electricbassfinger
:4 0.4 0.4 0.4 0.4 |`;

export function texBundle(tex: string, fileName = 'guide-test.atex'): SongBundle {
  return { fileName, data: new TextEncoder().encode(tex) };
}

/**
 * About `minutes` of 120 BPM 4/4 sixteenths cycling over the six strings (the "3-minute song"
 * of the render-speed target): 90 bars per 3 minutes.
 */
export function longTex(minutes: number): string {
  const bars = Math.round(minutes * 30);
  const frets = ['0.6', '2.5', '2.4', '1.3', '0.2', '0.1', '3.1', '0.2', '1.3', '2.4', '2.5', '0.6', '3.6', '2.5', '0.4', '0.3'];
  const bar = `:16 ${frets.join(' ')} |`;
  return `\\title "Long Study"\n\\tempo 120\n.\n\\track "Guitar"\n\\staff {tabs}\n${Array.from({ length: bars }, () => bar).join('\n')}`;
}
