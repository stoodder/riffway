import { describe, expect, it } from 'vitest';
import type { IndexEntry } from '@shared/sources';
import { matchLocalEntries, normalizeTitle } from '../../server/sources/linkout/match';

function entry(id: string, title: string, extra: Partial<IndexEntry> = {}): IndexEntry {
  return {
    id,
    source: 'local',
    path: `${id}.gp`,
    fileName: `${id}.gp`,
    format: 'gp',
    mtimeMs: 0,
    size: 1,
    sha1: id,
    title,
    tracks: [],
    defaultArrangement: 0,
    tuning: [64, 59, 55, 50, 45, 40],
    tuningId: 'standard',
    tuningLabel: 'Standard',
    capo: 0,
    bpm: 120,
    durationSec: 60,
    rhythm: 'exact',
    difficulty: null,
    tags: { style: [], genre: [], skills: [] },
    hasMidi: false,
    hasSidecar: false,
    ...extra,
  };
}

describe('normalizeTitle', () => {
  it.each([
    ['Enter Sandman', 'enter sandman'],
    ['The Trooper', 'trooper'],
    ['The Trooper (2015 Remaster)', 'trooper'],
    ['Paranoid - Remastered 2009', 'paranoid'],
    ['Wish You Were Here – Live at Knebworth', 'wish you were here'],
    ['Smoke on the Water [Live]', 'smoke on water'],
    ['Señorita (feat. Someone)', 'senorita'],
    ['Song ft. Guest Artist', 'song'],
    ['Song featuring Guest', 'song'],
    ["Don't Stop Believin'", 'dont stop believin'],
    ['Guns N’ Roses', 'guns n roses'],
    ['Simon & Garfunkel', 'simon and garfunkel'],
    ['Motörhead', 'motorhead'],
    ['AC/DC', 'ac dc'],
    ['Song (Part 2)', 'song part 2'],
    ['Back - In Black', 'back in black'],
    ['  ', ''],
    ['The', ''],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeTitle(raw)).toBe(expected);
  });

  it('is idempotent', () => {
    for (const raw of ['The Trooper (Live)', 'Señorita feat. X', 'AC/DC – Back in Black (Remastered)']) {
      const once = normalizeTitle(raw);
      expect(normalizeTitle(once)).toBe(once);
    }
  });
});

describe('matchLocalEntries', () => {
  const entries = [
    entry('a', 'In the Hall of the Mountain King', { composer: 'Edvard Grieg', source: 'starter' }),
    entry('b', 'Enter Sandman (Remastered)', { artist: 'Metallica' }),
    entry('c', 'Für Elise', { composer: 'Beethoven' }),
    entry('d', 'Sandman Blues'),
  ];

  it('matches title words in any order, ignoring case, "the" and punctuation', () => {
    expect(matchLocalEntries('mountain king', entries)).toEqual(['a']);
    expect(matchLocalEntries('THE HALL OF THE MOUNTAIN KING', entries)).toEqual(['a']);
    expect(matchLocalEntries('king, mountain!', entries)).toEqual(['a']);
  });

  it('matches across title and artist/composer', () => {
    expect(matchLocalEntries('metallica enter sandman', entries)).toEqual(['b']);
    expect(matchLocalEntries('Enter Sandman - Metallica (Live)', entries)).toEqual(['b']);
    expect(matchLocalEntries('grieg', entries)).toEqual(['a']);
  });

  it('strips diacritics on both sides', () => {
    expect(matchLocalEntries('fur elise', entries)).toEqual(['c']);
    expect(matchLocalEntries('Für Élise beethoven', entries)).toEqual(['c']);
  });

  it('returns every entry containing all words', () => {
    expect(matchLocalEntries('sandman', entries)).toEqual(['b', 'd']);
  });

  it('needs whole words and every word', () => {
    expect(matchLocalEntries('sand', entries)).toEqual([]);
    expect(matchLocalEntries('sandman metallica blues', entries)).toEqual([]);
  });

  it('matches nothing for an empty or stop-word-only query', () => {
    expect(matchLocalEntries('', entries)).toEqual([]);
    expect(matchLocalEntries('  the ', entries)).toEqual([]);
    expect(matchLocalEntries('!!!', entries)).toEqual([]);
  });
});
