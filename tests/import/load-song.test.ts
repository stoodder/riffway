import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Song, SongBundle } from '@shared/song';
import { detectFormat, type ImportError, isImportError, listTracks, loadSong } from '@core/import/load-song';
import { asciiToSong, parseAsciiTab, type AsciiTab } from '@core/import/ascii';
import { fixture } from './helpers';

// The ASCII parser belongs to T-012; loadSong only has to dispatch to it.
vi.mock('@core/import/ascii', () => ({
  decodeText: vi.fn((data: Uint8Array) => new TextDecoder().decode(data)),
  parseAsciiTab: vi.fn(),
  asciiToSong: vi.fn(),
}));

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

function importError(fn: () => unknown): ImportError {
  try {
    fn();
  } catch (err) {
    if (isImportError(err)) return err;
    throw err;
  }
  throw new Error('expected an ImportError');
}

describe('detectFormat', () => {
  it.each([
    ['song.gp', 'gp'],
    ['song.gpx', 'gpx'],
    ['song.gp5', 'gp5'],
    ['song.gp4', 'gp4'],
    ['song.GP3', 'gp3'],
    ['song.musicxml', 'musicxml'],
    ['song.mxl', 'mxl'],
    ['Song.ATEX', 'alphatex'],
    ['tab.txt', 'ascii'],
    ['tab.tab', 'ascii'],
    ['dir.with.dots/song.xml', 'musicxml'],
  ])('%s → %s', (name, format) => {
    expect(detectFormat(name)).toBe(format);
  });

  it.each(['song.mid', 'song.pdf', 'README', 'song.gp.bak'])('%s → null', (name) => {
    expect(detectFormat(name)).toBeNull();
  });

  it('sniffs .xml content for a MusicXML root', () => {
    expect(detectFormat('a.xml', fixture('tab-dropd.musicxml').data)).toBe('musicxml'); // declaration, DOCTYPE, comment
    expect(detectFormat('a.xml', text('﻿<score-timewise version="4.0"></score-timewise>'))).toBe('musicxml');
    expect(detectFormat('a.xml', text('<?xml version="1.0"?>\n<html><body/></html>'))).toBeNull();
    expect(detectFormat('a.xml', text('<score-partwiseX/>'))).toBeNull();
    // .musicxml is trusted by extension.
    expect(detectFormat('a.musicxml', text('<html/>'))).toBe('musicxml');
  });
});

describe('loadSong', () => {
  beforeEach(() => vi.mocked(asciiToSong).mockReset());

  it('loads every alphaTab format with exact rhythm and validates', () => {
    for (const rel of ['riff.atex', 'gp/riff.gp', 'tab-dropd.musicxml', 'tab-dropd.mxl']) {
      const song = loadSong(fixture(rel));
      expect(song.schema).toBe(1);
      expect(song.meta.rhythm).toBe('exact');
      expect(song.notes.length).toBeGreaterThan(0);
    }
  });

  it('stamps the id (option over bundle), source and merged tags', () => {
    const bundle = fixture('riff.atex', { id: 'local:bundle', source: { source: 'starter', path: 'riff.atex' }, tags: { genre: ['rock'] } });
    expect(loadSong(bundle).id).toBe('local:bundle');
    const song = loadSong(bundle, { id: 'starter:riff' });
    expect(song.id).toBe('starter:riff');
    expect(song.meta.source).toEqual({ source: 'starter', path: 'riff.atex' });
    expect(song.meta.tags).toEqual({ style: [], genre: ['rock'], skills: [] });
    expect(loadSong(fixture('riff.atex')).id).toBe('');
  });

  it('reads a `// riffway: tags=` comment in alphaTex', () => {
    const tex = '// riffway: tags=pick, Metal\n\\title "T"\n:4 0.6 0.6 0.6 0.6';
    const song = loadSong({ fileName: 't.atex', data: text(tex), tags: { genre: ['metal', 'recognizable'] } });
    expect(song.meta.tags).toEqual({ style: ['pick'], genre: ['metal', 'recognizable'], skills: [] });
  });

  it('uses the requested arrangement or the first playable track', () => {
    expect(loadSong(fixture('tracks.atex')).arrangement).toBe(1);
    expect(loadSong(fixture('tracks.atex'), { arrangement: 1 }).arrangement).toBe(1);
    expect(importError(() => loadSong(fixture('tracks.atex'), { arrangement: 0 })).code).toBe('bad-arrangement');
    expect(importError(() => loadSong(fixture('tracks.atex'), { arrangement: 42 })).code).toBe('bad-arrangement');
  });

  it('throws no-playable-track when only bass/drums/7-string tracks exist', () => {
    const tex = '\\track "Bass" \\staff {tabs} \\tuning (G2 D2 A1 E1)\n:4 0.4 0.4 0.4 0.4';
    const err = importError(() => loadSong({ fileName: 'b.atex', data: text(tex) }));
    expect(err.code).toBe('no-playable-track');
    expect(err.message).toContain('Bass (bass)');
  });

  it('throws empty when the file has no notes at all', () => {
    for (const tex of ['', '\\title "Rests"\n:4 r r r r']) {
      expect(importError(() => loadSong({ fileName: 'e.atex', data: text(tex) })).code).toBe('empty');
    }
  });

  it('throws unsupported for unknown extensions and unreadable bytes', () => {
    expect(importError(() => loadSong({ fileName: 'x.pdf', data: text('%PDF') })).code).toBe('unsupported');
    expect(importError(() => loadSong({ fileName: 'x.xml', data: text('<html/>') })).code).toBe('unsupported');
    expect(importError(() => loadSong({ fileName: 'x.gp', data: new Uint8Array([0, 1, 2, 3, 4]) })).code).toBe('unsupported');
  });

  it('keeps alphaTab quiet on corrupt files (the ImportError is the only report)', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      for (const fileName of ['x.gp5', 'x.gp', 'x.gpx']) {
        expect(importError(() => loadSong({ fileName, data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) })).code).toBe('unsupported');
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('throws syntax errors with alphaTex diagnostics (code, line, column)', () => {
    const err = importError(() => loadSong({ fileName: 'bad.atex', data: text('\\title "Bad"\n:4 3.3 x.9.k r') }));
    expect(err.code).toBe('syntax');
    expect(err.message).toMatch(/^bad\.atex:2:\d+ AT\d{3} /);
    expect(err.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'AT202', line: 2, column: 12 })]);
  });

  it('dispatches .txt/.tab to asciiToSong with the id', () => {
    const sentinel = { id: 'ascii' } as Song;
    vi.mocked(asciiToSong).mockReturnValue(sentinel);
    const bundle: SongBundle = { fileName: 'tab.txt', data: text('e|---0---|'), id: 'local:x' };
    expect(loadSong(bundle)).toBe(sentinel);
    expect(asciiToSong).toHaveBeenLastCalledWith(bundle, { id: 'local:x' });
    loadSong({ fileName: 'tab.tab', data: text('') }, { id: 'opt' });
    expect(asciiToSong).toHaveBeenLastCalledWith(expect.objectContaining({ fileName: 'tab.tab' }), { id: 'opt' });
    loadSong({ fileName: 'multi.txt', data: text('') }, { version: 2 });
    expect(asciiToSong).toHaveBeenLastCalledWith(expect.objectContaining({ fileName: 'multi.txt' }), { version: 2 });
  });
});

describe('listTracks', () => {
  it('lists alphaTab tracks', () => {
    expect(listTracks(fixture('tracks.atex')).map((t) => t.playable)).toEqual([false, true, false, false, false, false]);
  });

  it('lists one guitar track for ASCII tabs', () => {
    vi.mocked(parseAsciiTab).mockReturnValue({
      header: { capo: 3 },
      tuning: [64, 59, 55, 50, 45, 38],
      groups: [{ notes: [{}, {}] }, { notes: [{}] }],
    } as unknown as AsciiTab);
    expect(listTracks({ fileName: 'a.txt', data: text('x') })).toEqual([
      { index: 0, name: 'Guitar', strings: 6, tuning: [64, 59, 55, 50, 45, 38], capo: 3, playable: true, noteCount: 3 },
    ]);
    vi.mocked(parseAsciiTab).mockReturnValue({ header: {}, tuning: [64, 59, 55, 50, 45, 40], groups: [] } as unknown as AsciiTab);
    expect(listTracks({ fileName: 'a.txt', data: text('x') })[0]).toMatchObject({ playable: false, unsupportedReason: 'no-notes' });
  });
});
