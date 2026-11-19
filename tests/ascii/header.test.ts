import { describe, expect, it } from 'vitest';
import { parseAsciiTab } from '@core/import/ascii';
import { parseCapo, parseKey, parseTempo, parseTimeSig, parseTuningLine } from '@core/import/ascii/header';

const STANDARD = [64, 59, 55, 50, 45, 40];
const DROP_D = [64, 59, 55, 50, 45, 38];
const STAFF = ['e|---0---|', 'B|---1---|', 'G|---0---|', 'D|---2---|', 'A|---3---|', 'E|-------|'].join('\n');

const header = (text: string) => parseAsciiTab(`${text}\n\n${STAFF}\n`).header;

describe('header: title and composer', () => {
  it('reads ClassTab "Title - Composer (dates)"', () => {
    const h = header('Op 99 - No 3, Andante in C - Ada Fictional (1801-1870)\nMIDI: http://www.classtab.org/x.mid');
    expect(h.title).toBe('Op 99 - No 3, Andante in C');
    expect(h.composer).toBe('Ada Fictional');
  });

  it('reads "Composer - Title" when the last part is not a name', () => {
    const h = header('Ada Fictional - Op 21, Waltzes - No 1 in A');
    expect(h.composer).toBe('Ada Fictional');
    expect(h.title).toBe('Op 21, Waltzes - No 1 in A');
  });

  it('takes the next plain line as title after a "Composer (dates)" line', () => {
    const h = header('Bérénice Exemple (1790–1850)\nPassepied in A, Op 5');
    expect(h.composer).toBe('Bérénice Exemple');
    expect(h.title).toBe('Passepied in A, Op 5');
  });

  it('prefers labelled fields', () => {
    const h = header('Song: Riff Study\nArtist: The Testers\nComposer: Ada Fictional (1801-1870)');
    expect(h).toMatchObject({ title: 'Riff Study', artist: 'The Testers', composer: 'Ada Fictional' });
  });

  it('reads the MIDI URL', () => {
    expect(header('A Piece\nMIDI: http://www.classtab.org/some_piece_01.mid').midiUrl).toBe('http://www.classtab.org/some_piece_01.mid');
  });
});

describe('header: tuning', () => {
  it.each([
    ['tuning: E A D G B E          key: G major', STANDARD],
    ['Tuning: Standard (EADGBE)', STANDARD],
    ['tuning: EADGBe    key: A    time: 4/4', STANDARD],
    ['tuning - D A D G B E', DROP_D],
    ['Tuning : E A D F# B E - Time Signature: 2/4', [64, 59, 54, 50, 45, 40]],
    ['Tuning: D A D G A D (low to high)', [62, 57, 55, 50, 45, 38]],
    ['Tuning: Eb Ab Db Gb Bb Eb', [63, 58, 54, 49, 44, 39]],
    ['Tuning: Drop D', DROP_D],
    ['Tuning: half step down', [63, 58, 54, 49, 44, 39]],
  ])('%s', (line, expected) => {
    expect(header(line).tuning).toEqual(expected);
  });

  it.each(['6th string = D', '6=D', 'Tune 6th to D', '6th string to D', '(6) = D'])('per-string prose: %s', (line) => {
    expect(header(`A Piece\n${line}`).tuning).toEqual(DROP_D);
  });

  it('combines a tuning line with a string override', () => {
    expect(header('tuning: E A D G B E - 6th string to D, 5th to G').tuning).toEqual([64, 59, 55, 50, 43, 38]);
  });

  it('ignores lower-case prose that is not a tuning', () => {
    expect(header('A Piece\nplay bars 1 to a fine finish').tuning).toBeUndefined();
  });

  it('parses a tuning line alone', () => {
    expect(parseTuningLine('no tuning words here')).toBeNull();
    expect(parseTuningLine('tuned to open G: D G D G B D')).toEqual([62, 59, 55, 50, 43, 38]);
  });
});

describe('header: key, time, tempo, capo', () => {
  it('reads the combined ClassTab line', () => {
    expect(header('tuning: E A D G B E    key: E minor    time: 6/8')).toMatchObject({ key: 'E minor', timeSig: [6, 8] });
  });

  it.each([
    ['key - C    time - 4/4', 'C'],
    ['Key: F# minor', 'F# minor'],
    ['in the key of Bb major', 'Bb major'],
  ])('key %s', (line, key) => {
    expect(parseKey(line)).toBe(key);
  });

  it.each([
    ['time: 3/8', [3, 8]],
    ['Time Signature: 2/4', [2, 4]],
    ['in 12/8 time', [12, 8]],
    ['Played 3/4 as a waltz at 80 beats per minute.', [3, 4]],
    ['dated 26/12/2016', undefined],
    ['time: 5/7', undefined],
  ])('time %s', (line, expected) => {
    expect(parseTimeSig(line)).toEqual(expected);
  });

  it.each([
    ['tempo: Q=100', 100],
    ['Tempo: 120 bpm', 120],
    ['speed: (quarter note) 126 bpm', 126],
    ['Played 3/4 as a waltz at 80 beats per minute.', 80],
    ['tempo: 168 bpm (eighth notes)', 84],
    ['tempo (dotted quarter) 60', 90],
    ['♩ = 72', 72],
    ['tempo: (see the Notes)', undefined],
  ])('tempo %s', (line, expected) => {
    expect(parseTempo(line)).toBe(expected);
  });

  it.each([
    ['capo 2', 2],
    ['Capo: 3rd fret', 3],
    ['capo on fret 5', 5],
    ['capo VII', 7],
    ['no capo', 0],
    ['capodastro', undefined],
  ])('capo %s', (line, expected) => {
    expect(parseCapo(line)).toBe(expected);
  });

  it('collects every field from a full header', () => {
    const h = header('My Song\nTuning: E A D G B E\nKey: A\nTime: 3/4\ntempo: Q=90\nCapo 1');
    expect(h).toMatchObject({ title: 'My Song', tuning: STANDARD, key: 'A', timeSig: [3, 4], tempo: 90, capo: 1 });
  });
});
