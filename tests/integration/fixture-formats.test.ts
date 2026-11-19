/**
 * T-029 end to end over every importer: authored fixtures (Guitar Pro, MusicXML/MXL, ASCII with and
 * without a paired MIDI, alphaTex) dropped into a library folder, indexed by the real server with the
 * real `loadSong` + `analyzeDifficulty`, then searched and re-loaded from `GET /api/songs/:id/file`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SongMeta } from '@shared/api';
import type { SongBundle, SongFormat } from '@shared/song';
import type { IndexEntry } from '@shared/sources';
import { analyzeDifficulty, tierOf } from '@core/difficulty';
import { loadSong } from '@core/import/load-song';
import { fetchSongBundle, search, startRealApp, type RealApp } from './real-app';

/** Fixture → what the index must say about it. */
interface Expected {
  file: string;
  format: SongFormat;
  title: string;
  tuningId: string;
  capo: number;
  rhythm: IndexEntry['rhythm'];
  /** Playable arrangement indices; [] for a file without one. */
  arrangements: number[];
}

const FIXTURES: Expected[] = [
  { file: 'import/riff.atex', format: 'alphatex', title: 'Riff Test', tuningId: 'drop-d', capo: 0, rhythm: 'exact', arrangements: [0] },
  { file: 'import/gp/riff.gp', format: 'gp', title: 'Riff Test', tuningId: 'drop-d', capo: 0, rhythm: 'exact', arrangements: [0] },
  { file: 'import/gp/capo.gp', format: 'gp', title: 'Capo Two', tuningId: 'standard', capo: 2, rhythm: 'exact', arrangements: [0] },
  { file: 'import/gp/tracks.gp', format: 'gp', title: 'Band', tuningId: 'standard', capo: 0, rhythm: 'exact', arrangements: [1] },
  { file: 'import/tab-dropd.musicxml', format: 'musicxml', title: 'Drop D Tab', tuningId: 'drop-d', capo: 0, rhythm: 'exact', arrangements: [0] },
  { file: 'import/tab-dropd.mxl', format: 'mxl', title: 'Drop D Tab', tuningId: 'drop-d', capo: 0, rhythm: 'exact', arrangements: [0] },
  { file: 'import/melody-notab.musicxml', format: 'musicxml', title: 'Plain Melody', tuningId: 'standard', capo: 0, rhythm: 'exact', arrangements: [0] },
  { file: 'ascii/ug-style-riff.txt', format: 'ascii', title: 'Synthetic Riff Study', tuningId: 'drop-d', capo: 0, rhythm: 'needs-alignment', arrangements: [0] },
  { file: 'classtab-synthetic/riffway_study_no1_in_e.txt', format: 'ascii', title: 'Study No 1 in E minor', tuningId: 'standard', capo: 0, rhythm: 'midi', arrangements: [0] },
  { file: 'ascii/bass-4-string.txt', format: 'ascii', title: 'bass-4-string', tuningId: 'standard', capo: 0, rhythm: 'exact', arrangements: [] },
];
const EXTRA_FILES = ['classtab-synthetic/riffway_study_no1_in_e.mid'];
const baseName = (file: string): string => file.slice(file.lastIndexOf('/') + 1);

let real: RealApp;
const byFile = (file: string): IndexEntry => {
  const entry = real.ctx.library.all().find((e) => e.source === 'local' && e.fileName === baseName(file));
  if (!entry) throw new Error(`not indexed: ${file}`);
  return entry;
};

/** The served bundle, with the paired MIDI when the entry has one (as the browser worker gets it). */
async function servedBundle(entry: IndexEntry): Promise<SongBundle> {
  const bundle = await fetchSongBundle(real.app, entry);
  if (!entry.hasMidi) return bundle;
  const res = await real.app.inject({ method: 'GET', url: `/api/songs/${encodeURIComponent(entry.id)}/rhythm`, headers: { host: '127.0.0.1' } });
  expect(res.statusCode).toBe(200);
  return { ...bundle, midi: { fileName: entry.fileName.replace(/\.txt$/i, '.mid'), data: new Uint8Array(res.rawPayload) } };
}

beforeAll(async () => {
  real = await startRealApp([...FIXTURES.map((f) => f.file), ...EXTRA_FILES]);
});
afterAll(async () => {
  await real.close();
});

describe('every importer through the real indexer', () => {
  it('indexes each fixture once (the paired MIDI is not a song)', () => {
    const local = real.ctx.library.all().filter((e) => e.source === 'local');
    expect(local.map((e) => e.fileName).sort()).toEqual(FIXTURES.map((f) => baseName(f.file)).sort());
  });

  it.each(FIXTURES.filter((f) => f.arrangements.length > 0).map((f) => [f.file, f] as const))(
    '%s: format, title, tuning, rhythm and a real difficulty',
    (file, expected) => {
      const entry = byFile(file);
      expect(entry.error).toBeUndefined();
      expect(entry.format).toBe(expected.format);
      expect(entry.title).toBe(expected.title);
      expect(entry.tuningId).toBe(expected.tuningId);
      expect(entry.capo).toBe(expected.capo);
      expect(entry.rhythm).toBe(expected.rhythm);
      expect(entry.hasMidi).toBe(expected.rhythm === 'midi');
      expect(entry.defaultArrangement).toBe(expected.arrangements[0]);
      expect(entry.tracks.filter((t) => t.playable).map((t) => t.index)).toEqual(expected.arrangements);
      const difficulty = entry.difficulty!;
      expect(difficulty).not.toBeNull();
      expect(difficulty.rating).toBeGreaterThanOrEqual(1);
      expect(difficulty.rating).toBeLessThanOrEqual(10);
      expect(difficulty.tier).toBe(tierOf(difficulty.rating));
      expect(difficulty.provisional).toBe(expected.rhythm === 'needs-alignment');
      expect(entry.tags.skills).toEqual(difficulty.skills);
    },
  );

  it('rates the same music identically whatever the container format', () => {
    const rating = (file: string) => byFile(file).difficulty;
    expect(rating('import/gp/riff.gp')).toEqual(rating('import/riff.atex'));
    expect(rating('import/tab-dropd.mxl')).toEqual(rating('import/tab-dropd.musicxml'));
  });

  it('keeps an unplayable file in the index with its reason and no difficulty', () => {
    const entry = byFile('ascii/bass-4-string.txt');
    expect(entry.title).toBe('bass-4-string');
    expect(entry.defaultArrangement).toBe(-1);
    expect(entry.difficulty).toBeNull();
    expect(entry.error).toMatch(/6-string/);
  });
});

describe('search results carry difficulty, tuning and tags', () => {
  it('finds both formats of "Riff Test" with the same tier and Drop D', async () => {
    const { results } = await search(real.app, { q: 'riff test', source: 'local' });
    const hits = results.filter((r) => r.title === 'Riff Test');
    expect(hits.map((r) => r.fileName).sort()).toEqual(['riff.atex', 'riff.gp']);
    for (const hit of hits) {
      expect(hit.tier).toBe(byFile('import/riff.atex').difficulty!.tier);
      expect(hit.tuningId).toBe('drop-d');
      expect(hit.tuningLabel).toBe('Drop D');
      expect(hit.availability).toBe('playable');
    }
  });

  it('marks the ASCII tab without rhythm as provisional and needing rhythm', async () => {
    const { results } = await search(real.app, { source: 'local', playable: 'false' });
    const ascii = results.find((r) => r.fileName === 'ug-style-riff.txt')!;
    expect(ascii.availability).toBe('needs-rhythm');
    expect(ascii.ratingProvisional).toBe(true);
    expect(ascii.tier).not.toBeNull();
    const bass = results.find((r) => r.fileName === 'bass-4-string.txt')!;
    expect(bass.availability).toBe('needs-import');
    expect(bass.tier).toBeNull();
    expect(results.every((r) => r.availability !== 'playable')).toBe(true);
  });

  it('filters by tuning and by difficulty skill tags', async () => {
    const files = async (params: Record<string, string>) =>
      (await search(real.app, { source: 'local', ...params })).results.map((r) => r.fileName).sort();
    expect(await files({ tuning: 'drop-d' })).toEqual(['riff.atex', 'riff.gp', 'tab-dropd.musicxml', 'tab-dropd.mxl', 'ug-style-riff.txt']);
    const withShifts = real.ctx.library
      .all()
      .filter((e) => e.source === 'local' && e.tags.skills.includes('position-shifts'))
      .map((e) => e.fileName)
      .sort();
    expect(withShifts.length).toBeGreaterThan(0);
    expect(await files({ tags: 'position-shifts' })).toEqual(withShifts);
  });
});

describe('GET /api/songs/:id(/file) → loadSong in Node', () => {
  it.each(FIXTURES.filter((f) => f.arrangements.length > 0).map((f) => f.file))('%s: reproduces the indexed difficulty', async (file) => {
    const entry = byFile(file);
    const bundle = await servedBundle(entry);
    const song = loadSong(bundle);
    expect(song.arrangement).toBe(entry.defaultArrangement);
    expect(song.meta.durationSec).toBeCloseTo(entry.durationSec, 6);
    expect(song.meta.rhythm).toBe(entry.rhythm);
    expect(analyzeDifficulty(song)).toEqual(entry.difficulty);
    // `noteCount` counts written notes; repeats expand the played song, so it is a lower bound.
    const judged = song.notes.filter((n) => n.tiedFrom === undefined).length;
    expect(judged).toBeGreaterThanOrEqual(entry.tracks[entry.defaultArrangement]!.noteCount!);

    const res = await real.app.inject({ method: 'GET', url: `/api/songs/${encodeURIComponent(entry.id)}`, headers: { host: '127.0.0.1' } });
    const meta = res.json<SongMeta>();
    expect(Object.keys(meta.difficulty).map(Number)).toEqual(entry.tracks.filter((t) => t.playable).map((t) => t.index));
    expect(meta.difficulty[entry.defaultArrangement]).toEqual(entry.difficulty);
  });
});
