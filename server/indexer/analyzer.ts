/**
 * Song analysis used by the indexer (T-017): `loadSong` (T-011) + `analyzeDifficulty` (T-013) →
 * the metadata stored in an `IndexEntry` ({@link SongAnalyzer} contract in `../types`). Injectable through
 * `createApp({analyzer})` so server tests do not depend on the real importers (T-029 wires the real ones
 * end to end).
 * @module
 */
import type { DifficultyReport, SongTags } from '@shared/song';
import { analyzeDifficulty } from '@core/difficulty';
import { ImportError, detectFormat, isImportError, listTracks, loadSong } from '@core/import/load-song';
import { describeTuning } from '@core/model';
import type { SongAnalysis, SongAnalyzer } from '../types';

/** True when an analysis error means "this file is not a song" rather than "this song is broken". */
export function isSkippableImportError(err: unknown, fileName: string): boolean {
  if (!isImportError(err)) return false;
  if (err.code === 'unsupported') return true;
  return err.code === 'empty' && /\.(txt|tab)$/i.test(fileName);
}

/** Merge tag sets without duplicates (order of first appearance). */
export function mergeTags(...sets: (Partial<SongTags> | undefined)[]): SongTags {
  const out: SongTags = { style: [], genre: [], skills: [] };
  for (const set of sets) {
    if (!set) continue;
    for (const s of set.style ?? []) if (!out.style.includes(s)) out.style.push(s);
    for (const g of set.genre ?? []) if (!out.genre.includes(g)) out.genre.push(g);
    for (const k of set.skills ?? []) if (!out.skills.includes(k)) out.skills.push(k);
  }
  return out;
}

/** Run `analyzeDifficulty`, returning null instead of throwing (indexing must not fail on it). */
function safeDifficulty(run: () => DifficultyReport): DifficultyReport | null {
  try {
    return run();
  } catch {
    return null;
  }
}

/** The production analyzer: real `loadSong` + `analyzeDifficulty` + `describeTuning`. */
export const defaultAnalyzer: SongAnalyzer = {
  analyze(bundle) {
    const format = detectFormat(bundle.fileName, bundle.data);
    if (!format) throw new ImportError('unsupported', `Unsupported file: ${bundle.fileName}`);
    try {
      const song = loadSong(bundle);
      const difficulty = safeDifficulty(() => analyzeDifficulty(song));
      const tuning = describeTuning(song.meta.tuning);
      const analysis: SongAnalysis = {
        format,
        title: song.meta.title,
        tracks: song.meta.tracks,
        defaultArrangement: song.arrangement,
        tuning: song.meta.tuning,
        tuningId: tuning.id,
        tuningLabel: tuning.label,
        capo: song.meta.capo,
        bpm: song.timing.tempos[0]?.bpm ?? null,
        durationSec: song.meta.durationSec,
        rhythm: song.meta.rhythm,
        difficulty,
        tags: mergeTags(song.meta.tags, bundle.tags, { skills: difficulty?.skills ?? [] }),
      };
      if (song.meta.artist) analysis.artist = song.meta.artist;
      if (song.meta.composer) analysis.composer = song.meta.composer;
      return analysis;
    } catch (err) {
      if (!isImportError(err) || err.code !== 'no-playable-track') throw err;
      // List the tracks so the entry explains why nothing is playable.
      const tracks = listTracks(bundle);
      const tuning = tracks[0]?.tuning ?? [];
      const described = describeTuning(tuning);
      return {
        format,
        title: bundle.fileName.replace(/\.[^.]+$/, ''),
        tracks,
        defaultArrangement: -1,
        tuning,
        tuningId: described.id,
        tuningLabel: described.label,
        capo: tracks[0]?.capo ?? 0,
        bpm: null,
        durationSec: 0,
        rhythm: 'exact',
        difficulty: null,
        tags: mergeTags(bundle.tags),
        error: err.message,
      };
    }
  },
  difficulty(bundle, arrangement) {
    return analyzeDifficulty(loadSong(bundle, { arrangement }));
  },
};
