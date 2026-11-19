/**
 * Rhythm derivation for ASCII tabs (T-012): ClassTab tab↔MIDI pairing, beat-ruler timing,
 * snap-to-grid and tap-along helpers for the alignment UI (T-028), sidecar application.
 * Pure functions; signatures frozen by T-010.
 * @module
 */
export { pairClassTab, MIDI_SUFFIXES, type ClassTabFile, type ClassTabPair, type PairRule } from './pair';
export { snapToGrid, mapTapsToOnsets, proportionalTimes, barFractions, gridStep, type Subdivision, type ColumnInfo } from './grid';
export { applySidecar } from './sidecar';
export { rulerRhythm, type RulerRhythm } from './ruler';
export { DEFAULT_BPM, DEFAULT_TIME_SIG, AUTO_SECTION_BARS } from './timing';
