// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/api';
import { partitionFiles, summarizeImport } from '../../src/ui/screens/library/drop-import';
import { formatDuration, songCount } from '../../src/ui/screens/library/labels';
import { importDestination, validateLibraryPath } from '../../src/ui/screens/library/library-folder';
import { tuningFacets } from '../../src/ui/screens/library';
import { trackDetails } from '../../src/ui/screens/library/arrangement-picker';
import { result } from './fake-server';

const file = (name: string, size = 10): File => {
  const f = new File(['x'], name);
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

describe('import helpers', () => {
  it('accepts song files and paired MIDI, rejects other types, empty and oversized files locally', () => {
    const { accepted, rejected } = partitionFiles([
      file('a.gp'),
      file('B.GP5'),
      file('c.musicxml'),
      file('d.mid'),
      file('e.txt'),
      file('notes.pdf'),
      file('README'),
      file('empty.gp', 0),
      file('huge.gp', LIMITS.importBytes + 1),
    ]);
    expect(accepted.map((f) => f.name)).toEqual(['a.gp', 'B.GP5', 'c.musicxml', 'd.mid', 'e.txt']);
    expect(rejected).toEqual([
      { name: 'notes.pdf', reason: ".pdf files aren't song files" },
      { name: 'README', reason: 'Not a song file' },
      { name: 'empty.gp', reason: 'The file is empty' },
      { name: 'huge.gp', reason: 'Larger than 20 MB' },
    ]);
  });

  it('summarises an import as toasts', () => {
    expect(
      summarizeImport(
        {
          files: [
            { name: 'a.gp', status: 'imported', path: 'a.gp' },
            { name: 'b.gp', status: 'imported', path: 'b (2).gp' },
            { name: 'c.gp', status: 'duplicate', path: 'c.gp' },
            { name: '../x.gp', status: 'rejected', reason: 'Names with a path are not allowed' },
          ],
        },
        [{ name: 'notes.pdf', reason: 'Not a song file' }],
      ),
    ).toEqual([
      { kind: 'success', message: 'Added 2 files to your library. They appear below once indexed.' },
      { kind: 'info', message: 'Already in your library: c.gp.' },
      {
        kind: 'error',
        message:
          "Couldn't add 2 files: ../x.gp (Names with a path are not allowed), notes.pdf (Not a song file). Riffway reads Guitar Pro, MusicXML, alphaTex and ASCII tab files.",
      },
    ]);
    expect(summarizeImport(null, [{ name: 'x.pdf', reason: 'Nope' }])).toEqual([{ kind: 'error', message: "Couldn't add x.pdf: Nope." }]);
    expect(summarizeImport({ files: [{ name: 'a.gp', status: 'imported', path: 'a.gp' }] }, [])[0]?.message).toBe(
      'Added 1 file to your library. It appears below once indexed.',
    );
  });
});

describe('library folder helpers', () => {
  it.each([
    ['', 'Enter the folder path.'],
    ['   ', 'Enter the folder path.'],
    ['Music/Tabs', 'Use a full path, starting with / or ~ (for example ~/Music/Tabs).'],
    ['./tabs', 'Use a full path, starting with / or ~ (for example ~/Music/Tabs).'],
    ['/Users/me/Tabs\u0000', 'The path contains invalid characters.'],
    ['/Users/me/Music/Tabs', null],
    ['~/Music/Tabs', null],
    ['~', null],
    ['C:\\Users\\me\\Tabs', null],
    ['\\\\nas\\tabs', null],
  ])('validateLibraryPath(%j) → %j', (path, expected) => {
    expect(validateLibraryPath(path)).toBe(expected);
  });

  it('shows where imports land', () => {
    expect(importDestination({ libraryDir: '/m/Tabs', importSubfolder: '' })).toBe('/m/Tabs');
    expect(importDestination({ libraryDir: '/m/Tabs/', importSubfolder: 'Imported/' })).toBe('/m/Tabs/Imported');
  });
});

describe('display helpers', () => {
  it('formats durations and counts', () => {
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
    expect(formatDuration(65.4)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(songCount(1)).toBe('1 song');
    expect(songCount(1234)).toBe('1,234 songs');
  });

  it('builds tuning facets: Standard first, one Custom entry, then by label', () => {
    const rows = [
      result('a', 'A', { tuningId: 'open-g', tuningLabel: 'Open G' }),
      result('b', 'B', { tuningId: 'custom', tuningLabel: 'C G C F A D' }),
      result('c', 'C'),
      result('d', 'D', { tuningId: 'drop-d', tuningLabel: 'Drop D' }),
      result('e', 'E', { tuningId: 'custom', tuningLabel: 'D G D G B D' }),
    ];
    expect(tuningFacets(rows)).toEqual([
      { id: 'standard', label: 'Standard' },
      { id: 'drop-d', label: 'Drop D' },
      { id: 'open-g', label: 'Open G' },
      { id: 'custom', label: 'Custom' },
    ]);
  });

  it('describes an arrangement track', () => {
    expect(trackDetails({ index: 0, name: 'Lead', strings: 6, tuning: [64, 59, 55, 50, 45, 38], capo: 2, playable: true, noteCount: 1200 })).toBe(
      'Drop D · capo 2 · 1,200 notes',
    );
  });
});
