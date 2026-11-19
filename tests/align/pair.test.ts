import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pairClassTab, type ClassTabFile } from '@core/import/align';
import { decodeText } from '@core/import/ascii';
import { CLASSTAB_DIR, classtab } from '../ascii/song-checks';

const names = (...n: string[]): ClassTabFile[] => n.map((name) => ({ name }));

describe('pairClassTab rules', () => {
  it('exact basename', () => {
    expect(pairClassTab(names('sor_op60_no10.txt', 'sor_op60_no10.mid'))).toEqual([{ tab: 'sor_op60_no10.txt', midi: 'sor_op60_no10.mid', rule: 'basename' }]);
  });

  it.each(['_1', '_01', '_a', '_duet'])('suffix %s', (suffix) => {
    expect(pairClassTab(names('x.txt', `x${suffix}.mid`))).toEqual([{ tab: 'x.txt', midi: `x${suffix}.mid`, rule: 'suffix' }]);
  });

  it('prefers the basename over suffixes, and suffixes in order', () => {
    expect(pairClassTab(names('x.txt', 'x_01.mid', 'x.mid'))[0]).toMatchObject({ midi: 'x.mid', rule: 'basename' });
    expect(pairClassTab(names('x.txt', 'x_duet.mid', 'x_01.mid', 'x_1.mid'))[0]).toMatchObject({ midi: 'x_1.mid', rule: 'suffix' });
  });

  it('header URL names a differently spelled MIDI', () => {
    const files: ClassTabFile[] = [
      { name: 'bach_js_0147_jesu.txt', text: 'Jesu\r\nMIDI: http://www.classtab.org/bach_js_bwv0147_jesu.mid\r\n' },
      { name: 'bach_js_bwv0147_jesu.mid' },
    ];
    expect(pairClassTab(files)).toEqual([{ tab: 'bach_js_0147_jesu.txt', midi: 'bach_js_bwv0147_jesu.mid', rule: 'header-url' }]);
  });

  it('compares names case-insensitively and skips non-tab files', () => {
    expect(pairClassTab(names('Piece.TXT', 'piece.mid', '0_readme.txt', 'index.htm', 'tabreader.js'))).toEqual([{ tab: 'Piece.TXT', midi: 'piece.mid', rule: 'basename' }]);
  });

  it('pairs each version of a multi-version tab with its numbered MIDI', () => {
    const text = decodeText(classtab('riffway_two_preludes.txt'));
    const files: ClassTabFile[] = [{ name: 'riffway_two_preludes.txt', text }, ...names('riffway_two_preludes_01.mid', 'riffway_two_preludes_02.mid')];
    expect(pairClassTab(files)).toEqual([
      { tab: 'riffway_two_preludes.txt', midi: 'riffway_two_preludes_01.mid', rule: 'version', version: 1 },
      { tab: 'riffway_two_preludes.txt', midi: 'riffway_two_preludes_02.mid', rule: 'version', version: 2 },
    ]);
  });

  it('multi-version fallbacks: header URL per version, basename for version 1, else unpaired', () => {
    const text = decodeText(classtab('riffway_two_preludes.txt')).replace('riffway_two_preludes_02.mid', 'renamed_second.mid');
    const files: ClassTabFile[] = [{ name: 'riffway_two_preludes.txt', text }, ...names('riffway_two_preludes.mid', 'renamed_second.mid')];
    expect(pairClassTab(files)).toEqual([
      { tab: 'riffway_two_preludes.txt', midi: 'riffway_two_preludes.mid', rule: 'basename', version: 1 },
      { tab: 'riffway_two_preludes.txt', midi: 'renamed_second.mid', rule: 'header-url', version: 2 },
    ]);
    const lonely = pairClassTab([{ name: 'riffway_two_preludes.txt', text }]);
    expect(lonely.map((p) => [p.version, p.midi, p.rule])).toEqual([[1, null, null], [2, null, null]]);
  });
});

describe('pairClassTab failures', () => {
  it('no MIDI at all', () => {
    expect(pairClassTab(names('handel_passepied.txt'))).toEqual([{ tab: 'handel_passepied.txt', midi: null, rule: null }]);
  });

  it('a header URL that does not resolve', () => {
    const files: ClassTabFile[] = [{ name: 'a.txt', text: 'MIDI: http://www.classtab.org/a_typo.mid' }, { name: 'b.mid' }];
    expect(pairClassTab(files)).toEqual([{ tab: 'a.txt', midi: null, rule: null }]);
  });

  it('never steals a MIDI that belongs to another tab by basename', () => {
    expect(pairClassTab(names('duo.txt', 'duo_1.txt', 'duo_1.mid'))).toEqual([
      { tab: 'duo.txt', midi: null, rule: null },
      { tab: 'duo_1.txt', midi: 'duo_1.mid', rule: 'basename' },
    ]);
  });

  it('a MIDI without a tab is never reported, and other suffixes do not pair', () => {
    expect(pairClassTab(names('satie_gymnopedie_1.txt', 'satie_gymnopedie_1_am.mid', 'satie_gymnopedie_1a.mid'))).toEqual([
      { tab: 'satie_gymnopedie_1.txt', midi: null, rule: null },
    ]);
  });
});

describe('pairClassTab on the synthetic fixture folder', () => {
  it('pairs paired, suffix-paired, header-URL, multi-version and unpaired tabs', () => {
    const files = readdirSync(CLASSTAB_DIR).map((name) => ({ name, text: name.endsWith('.txt') ? decodeText(classtab(name)) : undefined }));
    expect(pairClassTab(files).map((p) => [p.tab, p.midi, p.rule, p.version])).toEqual([
      ['riffway_lament_unpaired.txt', null, null, undefined],
      ['riffway_march_in_c.txt', 'riffway_marche_elegante.mid', 'header-url', undefined],
      ['riffway_study_no1_in_e.txt', 'riffway_study_no1_in_e.mid', 'basename', undefined],
      ['riffway_two_preludes.txt', 'riffway_two_preludes_01.mid', 'version', 1],
      ['riffway_two_preludes.txt', 'riffway_two_preludes_02.mid', 'version', 2],
      ['riffway_waltz_in_a.txt', 'riffway_waltz_in_a_1.mid', 'suffix', undefined],
    ]);
  });
});
