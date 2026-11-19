/**
 * Canvas highway renderer (T-024): six lanes (high e on top), fret gems, sustains, bar/section lines,
 * technique glyphs, hand-position cues, pooled hit feedback. Reads `clock.heardSongTime()` only;
 * x = hitX + (note.time − heardSongTime) / speed × pxPerSec (docs/game-mechanics.md).
 * Signature frozen by T-010.
 * @module
 */
import type { SongClock } from '@shared/clock';
import type { Highway, HighwayOptions } from '@shared/services';
import type { Song } from '@shared/song';
import { notImplemented } from '@shared/errors';

export function createHighway(canvas: HTMLCanvasElement, song: Song, clock: SongClock, opts: HighwayOptions): Highway {
  return notImplemented('createHighway', 'T-024');
}
