/**
 * alphaTab importer (T-011): GP3–7/GPX, MusicXML and alphaTex → `Song`, via `importer.ScoreLoader`
 * and `midi.MidiFileGenerator` (verified recipe in docs/research/libraries.md). The alphaTab player
 * is never used (D3). Signatures frozen by T-010.
 * @module
 */
import type { Settings as AlphaTabSettings, model } from '@coderline/alphatab';
import type { Song, SongBundle, TrackInfo } from '@shared/song';
import { notImplemented } from '@shared/errors';

/** A parsed alphaTab score plus the settings it was loaded with (guide synth reuses both, T-021). */
export interface AlphaTabScore {
  score: model.Score;
  settings: AlphaTabSettings;
}

/** Load the alphaTab `Score` (bytes via `loadScoreFromBytes`, `.atex` text via `loadAlphaTex`). Throws `ImportError`. */
export function loadAlphaTabScore(bundle: SongBundle): AlphaTabScore {
  return notImplemented('loadAlphaTabScore', 'T-011');
}

/** Track listing for a loaded score. */
export function alphaTabTracks(score: AlphaTabScore): TrackInfo[] {
  return notImplemented('alphaTabTracks', 'T-011');
}

/** Convert one track of a loaded score to a `Song` (string flip, repeats expanded, techniques). */
export function alphaTabToSong(score: AlphaTabScore, arrangement: number, bundle: SongBundle): Song {
  return notImplemented('alphaTabToSong', 'T-011');
}
