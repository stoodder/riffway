/**
 * Rhythm derivation for ASCII tabs (T-012): ClassTab tab↔MIDI pairing, beat-ruler timing,
 * snap-to-grid and tap-along helpers for the alignment UI (T-028), sidecar application.
 * Pure functions; signatures frozen by T-010.
 * @module
 */
import type { RhythmSidecar, Song } from '@shared/song';
import { notImplemented } from '@shared/errors';
import type { AsciiOnsetGroup } from '../ascii';

/** A file in the ClassTab data dir (name only; `text` when header URLs should be read). */
export interface ClassTabFile {
  name: string;
  text?: string;
}

/** How a tab got its MIDI. */
export type PairRule = 'basename' | 'suffix' | 'header-url' | 'version';

/** One pairing result per tab (multi-version tabs yield one row per version). */
export interface ClassTabPair {
  tab: string;
  midi: string | null;
  rule: PairRule | null;
  /** 1-based version number inside a multi-version tab. */
  version?: number;
}

/** Snap grid as note value: 8 = eighths, 12 = eighth triplets, 16 = sixteenths. */
export type Subdivision = 8 | 12 | 16;

/** Pair ClassTab `.txt` files with `.mid` files (basename, suffixes, header URL, versions). */
export function pairClassTab(files: readonly ClassTabFile[]): ClassTabPair[] {
  return notImplemented('pairClassTab', 'T-012');
}

/**
 * Snap-to-grid: inside each bar, column spacing is the duration ratio; quantise to `subdivision`
 * at `bpm` in `timeSig`. Returns one onset time (song s) per group; chords stay together.
 */
export function snapToGrid(
  columns: readonly Pick<AsciiOnsetGroup, 'bar' | 'column' | 'barStartColumn' | 'barEndColumn'>[],
  bpm: number,
  timeSig: [number, number],
  subdivision: Subdivision,
): number[] {
  return notImplemented('snapToGrid', 'T-012');
}

/**
 * Tap-along: map taps (song seconds, in order) to onset groups (chord = one tap). Extra taps are
 * dropped; missing taps are interpolated. Optional quantise to a grid.
 */
export function mapTapsToOnsets(
  taps: readonly number[],
  groups: readonly AsciiOnsetGroup[],
  quantize?: { bpm: number; timeSig: [number, number]; subdivision: Subdivision },
): number[] {
  return notImplemented('mapTapsToOnsets', 'T-012');
}

/** Apply a saved sidecar to an ASCII-derived song → `rhythm: 'aligned'`. */
export function applySidecar(song: Song, sidecar: RhythmSidecar): Song {
  return notImplemented('applySidecar', 'T-012');
}
