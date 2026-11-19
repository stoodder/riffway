import { cpSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanClassTab } from '../../server/sources/classtab/scan';
import { SYNTHETIC_DIR, tempDir } from './helpers';

describe('scanClassTab', () => {
  let tmp: ReturnType<typeof tempDir>;
  let files: string;
  let pairsFile: string;

  beforeEach(() => {
    tmp = tempDir();
    files = join(tmp.dir, 'files');
    pairsFile = join(tmp.dir, 'pairs.json');
    cpSync(SYNTHETIC_DIR, files, { recursive: true, filter: (src) => src === SYNTHETIC_DIR || /\.(txt|mid)$/.test(src) });
    writeFileSync(join(files, '0_readme.txt'), 'About this archive\r\n');
  });
  afterEach(() => tmp.cleanup());

  it('pairs tabs with MIDI via the T-012 rules and builds tagged candidates', async () => {
    const scan = await scanClassTab(files, pairsFile);
    expect(scan).toMatchObject({ tabs: 5, midis: 6, paired: 4, multiVersion: 1 });
    const midiOf = Object.fromEntries(scan.candidates.map((c) => [c.relPath, c.midiPath?.slice(files.length + 1) ?? null]));
    expect(midiOf).toEqual({
      'riffway_lament_unpaired.txt': null,
      'riffway_march_in_c.txt': 'riffway_marche_elegante.mid', // header URL (windows-1252 text)
      'riffway_study_no1_in_e.txt': 'riffway_study_no1_in_e.mid', // basename
      'riffway_two_preludes.txt': 'riffway_two_preludes_01.mid', // version 1
      'riffway_waltz_in_a.txt': 'riffway_waltz_in_a_1.mid', // suffix
    });
    for (const c of scan.candidates) {
      expect(c.tags).toEqual({ style: ['fingerstyle'], genre: ['classical'] });
      expect(c.url).toBe(`https://www.classtab.org/${c.relPath}`);
      expect(c.absPath).toBe(join(files, c.relPath));
    }
  });

  it('caches the pairing by folder fingerprint and recomputes when a file changes', async () => {
    await scanClassTab(files, pairsFile);
    const cache = JSON.parse(readFileSync(pairsFile, 'utf8')) as { pairs: { tab: string; midi: string | null }[] };
    // Tamper with the cache: an unchanged folder must reuse it as is.
    for (const p of cache.pairs) if (p.tab === 'riffway_lament_unpaired.txt') p.midi = 'riffway_orphan_am.mid';
    writeFileSync(pairsFile, JSON.stringify(cache));
    const cached = await scanClassTab(files, pairsFile);
    expect(cached.candidates.find((c) => c.relPath === 'riffway_lament_unpaired.txt')?.midiPath).toBe(join(files, 'riffway_orphan_am.mid'));

    utimesSync(join(files, 'riffway_lament_unpaired.txt'), new Date(), new Date(Date.now() + 10_000));
    const fresh = await scanClassTab(files, pairsFile);
    expect(fresh.candidates.find((c) => c.relPath === 'riffway_lament_unpaired.txt')?.midiPath).toBeUndefined();
  });

  it('returns nothing for a missing folder', async () => {
    expect(await scanClassTab(join(tmp.dir, 'nope'), pairsFile)).toEqual({ candidates: [], tabs: 0, midis: 0, paired: 0, multiVersion: 0 });
  });
});
