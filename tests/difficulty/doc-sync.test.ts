import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DifficultyFactorId } from '@shared/song';
import { analyzeDifficulty } from '@core/difficulty';
import { WEIGHTS } from '@core/difficulty/constants';
import { powerChordDrive } from './song-builder';

// Guards docs/difficulty.md against drifting from the code.
const doc = readFileSync(new URL('../../docs/difficulty.md', import.meta.url), 'utf8');
const ROWS: Record<string, DifficultyFactorId> = {
  Density: 'density', Tempo: 'tempo', Shifts: 'shifts', Span: 'span',
  Skipping: 'skipping', Techniques: 'techniques', Chords: 'chords',
};

describe('docs/difficulty.md', () => {
  it('states the weights used by the code', () => {
    const formula = doc.match(/^raw\s+=(.*)$/m)![1]!;
    const stated = [...formula.matchAll(/([\d.]+) c_(\w+)/g)].map(([, w, id]) => [id, Number(w)]);
    const ids = { den: 'density', tempo: 'tempo', shift: 'shifts', span: 'span', skip: 'skipping', tech: 'techniques', chord: 'chords' } as const;
    expect(stated).toHaveLength(7);
    for (const [id, w] of stated) expect(WEIGHTS[ids[id as keyof typeof ids]]).toBe(w);
  });

  it('worked-example table matches analyzeDifficulty', () => {
    const report = analyzeDifficulty(powerChordDrive());
    const factors = report.sections[0]!.factors;
    const section = doc.slice(doc.indexOf('## Worked example'), doc.indexOf('## Known limits'));
    let rows = 0;
    for (const m of section.matchAll(/^\| (\w+) \| .* \| ([\d.]+) \| ([\d.]+) \|$/gm)) {
      const id = ROWS[m[1]!]!;
      expect(Number(m[2]), id).toBeCloseTo(factors[id].c, 3);
      expect(Number(m[3]), id).toBeCloseTo(factors[id].c * factors[id].weight, 3);
      rows++;
    }
    expect(rows).toBe(7);
    expect(section).toContain(`raw = ${report.sections[0]!.raw.toFixed(3)}`);
    expect(section).toContain(`**${report.rating.toFixed(1)}**, tier ${report.tier} (${report.tierName})`);
  });
});
