/**
 * Shape of `tests/fixtures/audio/annotations.json`, written by `scripts/fetch-audio-fixtures.ts`
 * (T-036): the recorded-guitar clips, their reference notes in clip seconds, and provenance.
 */

/** One reference note of a clip. */
export interface AnnotatedNote {
  /** Onset, s from the start of the clip. */
  onsetSec: number;
  /** End of the note (annotated offset, or the end of its slot), s. */
  offsetSec: number;
  /** Expected MIDI note (rounded annotation). */
  midi: number;
  /** Annotated fractional MIDI (GuitarSet only; bends and intonation show here). */
  midiExact?: number;
  /** String, 1 = high e. */
  string: number;
  /** Iowa only: recorded dynamic. */
  dynamic?: 'pp' | 'mf';
  /** Iowa only: source file and onset time in it. */
  origin?: string;
}

/** One recorded clip (48 kHz mono 16-bit WAV). */
export interface ClipAnnotation {
  id: string;
  /** File name in `tests/fixtures/audio/`. */
  file: string;
  sampleRate: number;
  durationSec: number;
  dataset: string;
  license: string;
  homepage: string;
  /**
   * `annotated`: onsets from the dataset's human-verified annotations (GuitarSet). `derived`: the
   * fetch script's threshold onset on an isolated note (Iowa; no published onsets).
   */
  onsetReference: 'annotated' | 'derived';
  notes: AnnotatedNote[];
  /** Source files with SHA-256 of the downloaded bytes. */
  sources: { file: string; url: string; sha256: string }[];
}

/** The whole manifest. */
export interface FixtureManifest {
  schema: 1;
  generatedBy: string;
  attribution: string;
  clips: ClipAnnotation[];
}
