/** T-103: composer fallback from ClassTab's `composer_title` file names, and file-name titles. */
import { describe, expect, it } from 'vitest';
import { asciiToSong, classTabComposer, namesFromFile, parseAsciiTab } from '@core/import/ascii';
import { bytes } from './song-checks';

const STAFF = ['e|-0-|', 'B|---|', 'G|---|', 'D|---|', 'A|---|', 'E|---|'].join('\n');

describe('classTabComposer', () => {
  it('uses the file name when the header names no composer', () => {
    expect(classTabComposer('fictional_op12_no3_study_in_a.txt', undefined)).toBe('Fictional');
    expect(classTabComposer('castelnuovo-tedesco_op99_fictive.txt', undefined)).toBe('Castelnuovo-Tedesco');
    expect(classTabComposer("o'fictive_air.txt", undefined)).toBe("O'Fictive");
    expect(classTabComposer('anon_a_fictive_air.txt', undefined)).toBe('Anonymous');
    expect(classTabComposer('trad_a_fictive_reel.txt', undefined)).toBe('Traditional');
  });

  it('keeps a header composer that names the same person (accents and case ignored)', () => {
    expect(classTabComposer('tarrega_fictive_prelude.txt', 'Francisco Tárrega')).toBe('Francisco Tárrega');
    expect(classTabComposer('anon_fictive_air.txt', 'Traditional (Ireland)')).toBe('Traditional (Ireland)');
    expect(classTabComposer('giuliani-guglielmi_fictive.txt', 'Emilia Giuliani-Guglielmi')).toBe('Emilia Giuliani-Guglielmi');
  });

  it('replaces a title part misread as the composer, unless the header confirms it', () => {
    expect(classTabComposer('fictional_suite_fictive_2_menuet.txt', 'II. Menuet')).toBe('Fictional');
    expect(classTabComposer('riffway_study.txt', 'Ada Fictional', true)).toBe('Ada Fictional');
  });

  it('leaves names that do not start with a composer alone', () => {
    expect(classTabComposer('the_fictive_saga_01_kondo_theme.txt', 'Koji Fictive')).toBe('Koji Fictive');
    expect(classTabComposer('the_fictive_saga_01_theme.txt', undefined)).toBeUndefined();
    expect(classTabComposer('1812_fictive.txt', undefined)).toBeUndefined();
  });
});

describe('namesFromFile', () => {
  it('splits `Artist - Title` and humanises other stems', () => {
    expect(namesFromFile('Some Band - Big Riff.txt')).toEqual({ artist: 'Some Band', title: 'Big Riff' });
    expect(namesFromFile('dir/fictional_study_no1.txt')).toEqual({ title: 'fictional study no1' });
  });
});

describe('composer in imported ClassTab songs', () => {
  const song = (fileName: string, header: string) =>
    asciiToSong({ fileName, data: bytes(`${header}\n\n${STAFF}`), source: { source: 'classtab', path: fileName } });

  it('falls back to the file name and becomes the artist', () => {
    const s = song('fictional_op01_no1.txt', 'Study No 1');
    expect(s.meta).toMatchObject({ title: 'Study No 1', composer: 'Fictional', artist: 'Fictional' });
  });

  it('keeps a dated or labelled composer', () => {
    expect(song('fictional_op01_no1.txt', 'Study No 1 - Ada Exemple (1801-1870)').meta.composer).toBe('Ada Exemple');
    expect(song('fictional_op01_no1.txt', 'Title: Study No 1\nComposer: Ada Exemple').meta.composer).toBe('Ada Exemple');
    expect(song('fictional_suite_2_menuet.txt', 'Suite Fictive - II. Menuet').meta.composer).toBe('Fictional');
  });

  it('applies only to ClassTab: local files keep the header', () => {
    const s = asciiToSong({ fileName: 'fictional_op01.txt', data: bytes(`Suite Fictive - II. Menuet\n\n${STAFF}`), source: { source: 'local', path: 'fictional_op01.txt' } });
    expect(s.meta.composer).toBe('II. Menuet');
  });

  it('the header records whether the composer was confirmed', () => {
    expect(parseAsciiTab(`Air - Ada Exemple (1801-1870)\n${STAFF}`).header.composerConfirmed).toBe(true);
    expect(parseAsciiTab(`Composer: Ada Exemple\n${STAFF}`).header.composerConfirmed).toBe(true);
    expect(parseAsciiTab(`Air - Ada Exemple\n${STAFF}`).header.composerConfirmed).toBeUndefined();
  });
});
