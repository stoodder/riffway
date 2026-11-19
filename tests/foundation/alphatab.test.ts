import { describe, expect, it } from 'vitest';
import { importer, Settings } from '@coderline/alphatab';

// Smoke test: alphaTab 1.9.0 parses alphaTex in plain Node (docs/research/libraries.md).
const TEX = `\\title "Riff Test"
\\tempo 120
\\track "Guitar"
\\staff {tabs}
\\tuning (E4 B3 G3 D3 A2 D2)
\\section "Intro"
\\ro 0.6.4 3.6{h}.4 5.6.4 3.6.4 |
\\tempo 90 \\rc 2 5.5{sl}.4 7.5.4 7.3{b (0 4)}.4 0.6{pm}.4 |
\\section "Verse"
(0.6 2.5 2.4).2 (3.5 2.4).2`;

describe('alphaTab in Node', () => {
  it('loadAlphaTex parses title, tuning and bars', () => {
    const score = importer.ScoreLoader.loadAlphaTex(TEX, new Settings());
    expect(score.title).toBe('Riff Test');
    const staff = score.tracks[0]?.staves[0];
    expect(staff?.tuning).toEqual([64, 59, 55, 50, 45, 38]);
    expect(score.masterBars.length).toBe(3);
    expect(score.masterBars[0]?.section?.text).toBe('Intro');
  });
});
