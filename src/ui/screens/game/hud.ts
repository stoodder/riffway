/**
 * Game HUD (T-031): the top bar (song, section, score, accuracy, star meter, speed) and the stage
 * overlays (count-in / loop pre-roll countdown, coach messages, the chord-leniency note). Outcome
 * feedback and the combo live on the highway canvas only — the gutter text and the combo cluster
 * left of the hit line — so nothing covers the notes still to come and the combo shows once
 * (R2-U-01, T-041 note 2). Plain DOM; every update writes only what changed.
 * @module
 */
import type { Judgement, JudgeState, PracticeMessage } from '@shared/judge';
import { starsFor } from '@core/judge';
import { STAR_THRESHOLDS } from '@core/judge/constants';
import { flash, h, icon } from '../../components';

/** Text of the chord-leniency note (docs/game-mechanics.md § Chord leniency). */
export const CHORD_NOTE = 'Chords: judged on timing + any chord tone';

/** Live accuracy and stars show "—" until this many notes are judged (one early slip isn't "0%"). */
export const MIN_NOTES_FOR_ACCURACY = 5;

const pct = (s: number): string => `${Math.round(s * 100)}%`;

/**
 * Provisional wrong notes (a WrongNote is emitted provisional first and only counts in the judge
 * state once final): tracked so the live accuracy drops the moment the player hears it (R2-U-16).
 */
export class ProvisionalWrongs {
  private readonly notes = new Map<string, number>();

  /** Track a judgement: a provisional WrongNote adds its notes; any final judgement settles them. */
  judgement(j: Judgement): void {
    const key = `${j.pass}:${j.noteIds[0] ?? -1}`;
    if (j.final) this.notes.delete(key);
    else if (j.outcome === 'WrongNote') this.notes.set(key, j.noteIds.length);
  }

  /** Notes currently provisional WrongNotes. */
  get count(): number {
    let n = 0;
    for (const v of this.notes.values()) n += v;
    return n;
  }

  reset(): void {
    this.notes.clear();
  }
}

/**
 * Live accuracy % for the HUD: final hits / (final + provisionally wrong notes), or null while
 * fewer than {@link MIN_NOTES_FOR_ACCURACY} notes are judged.
 */
export function liveAccuracy(s: Pick<JudgeState, 'accuracy' | 'judgedNotes'>, provisionalWrongNotes: number): number | null {
  const judged = s.judgedNotes + provisionalWrongNotes;
  if (judged < MIN_NOTES_FOR_ACCURACY) return null;
  return ((s.accuracy / 100) * s.judgedNotes * 100) / judged;
}

/**
 * A starter original credited to Riffway itself is shown without an artist (it otherwise reads as
 * a band called "Riffway"; T-041 note 6).
 */
export function displayArtist(artist: string | null | undefined): string | null {
  const a = artist?.trim();
  return a && a.toLowerCase() !== 'riffway' ? a : null;
}

/** Star meter: earned stars plus progress toward the next threshold. */
function starMeter(): { el: HTMLElement; set(accuracy: number | null): void } {
  const stars = Array.from({ length: 5 }, () => h('span', { class: 'gm-stars__star' }, icon('star', { size: '1em' })));
  const fill = h('span', { class: 'gm-stars__fill' });
  const el = h(
    'div',
    { class: 'gm-stars', role: 'img', 'aria-label': '0 of 5 stars' },
    h('span', { class: 'gm-stars__row' }, stars),
    h('span', { class: 'gm-stars__track' }, fill),
  );
  let last = -1;
  let lastFill = -1;
  return {
    el,
    set(accuracy) {
      const earned = accuracy !== null ? starsFor(accuracy) : 0;
      if (earned !== last) {
        last = earned;
        stars.forEach((s, i) => s.classList.toggle('is-earned', i < earned));
        el.setAttribute('aria-label', `${earned} of 5 stars`);
      }
      // Progress from the current threshold to the next one (full at 5 stars).
      const lo = earned === 0 ? 0 : (STAR_THRESHOLDS[earned - 1] ?? 100);
      const hi = STAR_THRESHOLDS[earned] ?? 100;
      const f = accuracy !== null ? (earned >= 5 ? 1 : Math.min(1, Math.max(0, (accuracy - lo) / (hi - lo)))) : 0;
      const q = Math.round(f * 100);
      if (q !== lastFill) {
        lastFill = q;
        fill.style.width = `${q}%`;
      }
    },
  };
}

/** Top bar + stage overlays of the game screen. */
export class GameHud {
  readonly bar: HTMLElement;
  readonly overlays: HTMLElement;
  private readonly score = h('output', { class: 'gm-stat__value gm-score rw-num', 'aria-label': 'Score' }, '0');
  private readonly accuracy = h('output', { class: 'gm-stat__value rw-num' }, '—');
  private readonly speedOut = h('output', { class: 'gm-speed rw-num' }, '100%');
  private readonly section = h('span', { class: 'gm-song__section' }, '');
  private readonly stars = starMeter();
  private readonly chordNote = h('div', { class: 'gm-chord-note', hidden: true, title: CHORD_NOTE }, icon('info', { size: '1em' }), CHORD_NOTE);
  private readonly coach = h('div', { class: 'gm-coach', role: 'status', 'aria-live': 'polite' });
  private readonly countNumber = h('span', { class: 'gm-countin__n' });
  private readonly countCaption = h('span', { class: 'gm-countin__caption' });
  private readonly countIn = h('div', { class: 'gm-countin', 'aria-hidden': 'true', hidden: true }, this.countNumber, this.countCaption);
  private readonly provisional = new ProvisionalWrongs();
  private lastState: Pick<JudgeState, 'accuracy' | 'judgedNotes'> = { accuracy: 0, judgedNotes: 0 };
  private lastScore = -1;
  private lastAcc = '';
  private sectionShown = '';
  private speedShown = -1;
  private countShown = '';
  private coachTimer = 0;

  constructor(info: { title: string; artist: string | null; mode: 'play' | 'practice' }, actions: HTMLElement) {
    const modeChip = h('span', { class: `gm-mode gm-mode--${info.mode}` }, info.mode === 'practice' ? 'Practice' : 'Play');
    const artist = displayArtist(info.artist);
    this.bar = h(
      'header',
      { class: 'gm-hud' },
      h(
        'div',
        { class: 'gm-song' },
        h('h1', { class: 'gm-song__title', tabindex: '-1' }, info.title),
        h('div', { class: 'gm-song__meta' }, modeChip, artist ? h('span', { class: 'gm-song__artist' }, artist) : null, this.section),
      ),
      h(
        'div',
        { class: 'gm-stats' },
        h('div', { class: 'gm-stat gm-stat--score' }, h('span', { class: 'gm-stat__label' }, 'Score'), this.score),
        h('div', { class: 'gm-stat' }, h('span', { class: 'gm-stat__label' }, 'Accuracy'), this.accuracy),
        h('div', { class: 'gm-stat gm-stat--stars' }, h('span', { class: 'gm-stat__label' }, 'Stars'), this.stars.el),
        h('div', { class: 'gm-stat' }, h('span', { class: 'gm-stat__label' }, 'Speed'), this.speedOut),
      ),
      actions,
    );
    this.overlays = h('div', { class: 'gm-overlays' }, this.countIn, this.coach, this.chordNote);
  }

  /** Live judge state → score, accuracy, stars. */
  setState(s: JudgeState): void {
    if (s.score !== this.lastScore) {
      this.lastScore = s.score;
      this.score.textContent = s.score.toLocaleString('en-US');
    }
    this.lastState = s;
    this.renderAccuracy();
  }

  /** Track a judgement (provisional wrong notes count in the live accuracy at once). */
  judgement(j: Judgement): void {
    this.provisional.judgement(j);
    this.renderAccuracy();
  }

  private renderAccuracy(): void {
    const acc = liveAccuracy(this.lastState, this.provisional.count);
    const text = acc === null ? '—' : `${acc.toFixed(1)}%`;
    if (text !== this.lastAcc) {
      this.lastAcc = text;
      this.accuracy.textContent = text;
    }
    this.stars.set(acc);
  }

  setSection(name: string): void {
    if (name === this.sectionShown) return;
    this.sectionShown = name;
    this.section.textContent = name;
    this.section.hidden = name === '';
  }

  setSpeed(speed: number): void {
    const q = Math.round(speed * 100);
    if (q === this.speedShown) return;
    this.speedShown = q;
    this.speedOut.textContent = pct(speed);
    this.speedOut.classList.toggle('is-slow', q < 100);
  }

  setChordNote(visible: boolean): void {
    if (this.chordNote.hidden === !visible) return;
    this.chordNote.hidden = !visible;
  }

  /**
   * Countdown in beats (0 hides it) over the gutter: the count-in, or a loop pass's pre-roll with
   * `caption` ("Loop") so a pass never starts on an empty highway (R2-U-21).
   */
  setCountIn(n: number, caption = ''): void {
    const key = n > 0 ? `${n}|${caption}` : '';
    if (key === this.countShown) return;
    this.countShown = key;
    this.countIn.hidden = n <= 0;
    if (n > 0) {
      this.countNumber.textContent = String(n);
      this.countCaption.textContent = caption;
      this.countIn.dataset.kind = caption ? 'preroll' : 'count-in';
      flash(this.countNumber);
    }
  }

  /** A coach line (speed trainer, loop result, mastery, notices) for a few seconds. */
  message(m: PracticeMessage): void {
    const line = h('div', { class: `gm-coach__line gm-coach__line--${m.kind}` }, m.text);
    this.coach.replaceChildren(line);
    window.clearTimeout(this.coachTimer);
    this.coachTimer = window.setTimeout(() => line.classList.add('is-out'), m.kind === 'loop' ? 2500 : 4500);
  }

  /** Clear transient overlays and live counters (restart, new run). */
  reset(): void {
    this.provisional.reset();
    this.lastState = { accuracy: 0, judgedNotes: 0 };
    this.renderAccuracy();
    this.setCountIn(0);
  }

  dispose(): void {
    window.clearTimeout(this.coachTimer);
  }
}
