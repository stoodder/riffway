/**
 * Words shown for a judgement in the highway gutter (the game's single outcome display, R2-U-01),
 * per the *feedback detail* setting (docs/game-mechanics.md § Game screen):
 * - **minimal**: the outcome word only;
 * - **standard**: plus early/late outside the Great window (with a direction arrow) and, for a wrong
 *   note, how far off it was in frets ("1 fret high") — a tab reader thinks in frets (R2-U-17);
 * - **detailed**: plus the signed timing error in ms and the played pitch name.
 * Pure.
 * @module
 */
import type { Judgement, Outcome } from '@shared/judge';
import type { FeedbackDetail } from '@shared/settings';
import { midiToName } from '@core/model';

/** Big outcome word per outcome (Guitar-Hero punch, upper case). */
export const OUTCOME_WORD: Readonly<Record<Outcome, string>> = {
  Perfect: 'PERFECT',
  Great: 'GREAT',
  Good: 'GOOD',
  WrongNote: 'WRONG NOTE',
  Miss: 'MISS',
};

/** Early/late label with its direction: early points at the incoming notes, late behind the line. */
export const TIMING_LABEL: Readonly<Record<'early' | 'late', string>> = {
  early: 'EARLY ▸',
  late: '◂ LATE',
};

/** What the gutter shows for one judgement. */
export interface FeedbackText {
  word: string;
  /** Second line ('' = none). */
  sub: string;
  /** Early/late of the sub line (it takes the timing colour), else null. */
  timing: 'early' | 'late' | null;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * How far a wrong note was off, in the player's terms: "1 fret high", "2 frets low", "an octave
 * low"; "not a chord tone" for chords. `null` without a played pitch.
 */
export function wrongNoteOffset(j: Pick<Judgement, 'playedMidi' | 'expectedMidi' | 'chord'>): string | null {
  if (j.playedMidi === undefined) return null;
  if (j.chord) return 'not a chord tone';
  const diff = Math.round(j.playedMidi - j.expectedMidi);
  const dir = diff > 0 ? 'high' : 'low';
  const abs = Math.abs(diff);
  if (abs === 0) return 'out of tune';
  if (abs % 12 === 0) return abs === 12 ? `an octave ${dir}` : `${abs / 12} octaves ${dir}`;
  return `${plural(abs, 'fret', 'frets')} ${dir}`;
}

/** The gutter text for `j` at `detail`. */
export function feedbackText(j: Judgement, detail: FeedbackDetail): FeedbackText {
  const word = OUTCOME_WORD[j.outcome];
  if (detail === 'minimal' || j.outcome === 'Miss') return { word, sub: '', timing: null };
  if (j.outcome === 'WrongNote') {
    const offset = wrongNoteOffset(j);
    if (detail === 'detailed' && j.playedMidi !== undefined) {
      return { word, sub: `played ${midiToName(j.playedMidi)}${offset && !j.chord ? ` · ${offset}` : ''}`, timing: null };
    }
    return { word, sub: offset ?? '', timing: null };
  }
  const parts: string[] = [];
  if (j.timing) parts.push(TIMING_LABEL[j.timing]);
  if (detail === 'detailed' && j.deltaMs !== null) parts.push(`${j.deltaMs > 0 ? '+' : j.deltaMs < 0 ? '−' : ''}${Math.abs(Math.round(j.deltaMs))} ms`);
  return { word, sub: parts.join(' '), timing: j.timing };
}
