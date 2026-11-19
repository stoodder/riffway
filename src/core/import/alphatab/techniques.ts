/**
 * alphaTab note effects → {@link Tech} flags (docs/song-formats.md § alphaTab import).
 * @module
 */
import { model } from '@coderline/alphatab';
import type { HarmonicType, SlideType, Tech } from '@shared/song';

const SLIDE_IN: ReadonlyMap<model.SlideInType, SlideType> = new Map([
  [model.SlideInType.IntoFromBelow, 'in-below'],
  [model.SlideInType.IntoFromAbove, 'in-above'],
]);

/** Pick slides are drawn and judged like the matching slide-out. */
const SLIDE_OUT: ReadonlyMap<model.SlideOutType, SlideType> = new Map([
  [model.SlideOutType.Shift, 'shift'],
  [model.SlideOutType.Legato, 'legato'],
  [model.SlideOutType.OutUp, 'out-up'],
  [model.SlideOutType.OutDown, 'out-down'],
  [model.SlideOutType.PickSlideUp, 'out-up'],
  [model.SlideOutType.PickSlideDown, 'out-down'],
]);

const HARMONICS: ReadonlyMap<model.HarmonicType, HarmonicType> = new Map([
  [model.HarmonicType.Natural, 'natural'],
  [model.HarmonicType.Artificial, 'artificial'],
  [model.HarmonicType.Pinch, 'pinch'],
  [model.HarmonicType.Tap, 'tap'],
  [model.HarmonicType.Semi, 'semi'],
  [model.HarmonicType.Feedback, 'feedback'],
]);

/**
 * Technique flags of one alphaTab note.
 * - Hammer-on vs pull-off is decided by the destination's fret (higher = hammer-on).
 * - `legatoDest` marks hammer/pull destinations and the target of a legato slide.
 * - A note carries one `slide`: a slide-out (connects to the next note) wins over a slide-in.
 * - Bend values are quarter-tones: `semitones = max / 2`; `release` when the curve ends below its peak.
 */
export function noteTech(n: model.Note): Tech {
  const tech: Tech = {};
  if (n.isHammerPullOrigin && n.hammerPullDestination) {
    if (n.hammerPullDestination.fret >= n.fret) tech.hammerOn = true;
    else tech.pullOff = true;
  }
  if (n.isHammerPullDestination || n.slideOrigin?.slideOutType === model.SlideOutType.Legato) tech.legatoDest = true;

  const slide = SLIDE_OUT.get(n.slideOutType) ?? SLIDE_IN.get(n.slideInType);
  if (slide) tech.slide = slide;

  const points = n.hasBend ? (n.bendPoints ?? []) : [];
  if (points.length > 0) {
    const peak = Math.max(...points.map((p) => p.value));
    const last = points[points.length - 1]?.value ?? peak;
    if (peak > 0) tech.bend = last < peak ? { semitones: peak / 2, release: true } : { semitones: peak / 2 };
  }

  if (n.isPalmMute) tech.palmMute = true;
  if (n.isLetRing) tech.letRing = true;
  if (n.vibrato !== model.VibratoType.None) tech.vibrato = true;
  const harmonic = HARMONICS.get(n.harmonicType);
  if (harmonic) tech.harmonic = harmonic;
  if (n.isDead) tech.dead = true;
  if (n.isGhost) tech.ghost = true;
  return tech;
}
