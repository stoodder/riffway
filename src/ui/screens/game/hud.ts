/**
 * Game HUD (T-031): the top bar (song, section, score, combo/multiplier, accuracy, star meter,
 * speed) and the stage overlays that react to judgements (central outcome pop, multiplier-up burst,
 * chord-leniency note, coach messages, count-in). Plain DOM; every update writes only what changed.
 * @module
 */
import type { Judgement, JudgeState, PracticeMessage } from '@shared/judge';
import type { FeedbackDetail } from '@shared/settings';
import { starsFor } from '@core/judge';
import { STAR_THRESHOLDS } from '@core/judge/constants';
import { midiToName } from '@core/model';
import { comboBadge, flash, h, icon, judgementTag } from '../../components';

/** Text of the chord-leniency note (docs/game-mechanics.md § Chord leniency). */
export const CHORD_NOTE = 'Chords: judged on timing + any chord tone';

const pct = (s: number): string => `${Math.round(s * 100)}%`;

/** Second line under an outcome, per the feedback-detail setting (bandwidth rule for early/late). */
export function outcomeDetail(j: Judgement, detail: FeedbackDetail): string {
  if (detail === 'minimal') return '';
  if (j.outcome === 'WrongNote') return j.playedMidi !== undefined ? `played ${midiToName(j.playedMidi)}` : 'wrong note';
  if (j.outcome === 'Miss') return '';
  const parts: string[] = [];
  if (j.timing) parts.push(j.timing);
  if (detail === 'detailed' && j.deltaMs !== null) parts.push(`${j.deltaMs > 0 ? '+' : ''}${Math.round(j.deltaMs)} ms`);
  return parts.join(' · ');
}

/** The judgement the highway should draw for a feedback-detail level (minimal: no sub-labels). */
export function highwayJudgement(j: Judgement, detail: FeedbackDetail): Judgement {
  if (detail !== 'minimal') return j;
  const { playedMidi: _played, ...rest } = j;
  return { ...rest, timing: null };
}

/** Star meter: earned stars plus progress toward the next threshold. */
function starMeter(): { el: HTMLElement; set(accuracy: number, judged: boolean): void } {
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
    set(accuracy, judged) {
      const earned = judged ? starsFor(accuracy) : 0;
      if (earned !== last) {
        last = earned;
        stars.forEach((s, i) => s.classList.toggle('is-earned', i < earned));
        el.setAttribute('aria-label', `${earned} of 5 stars`);
      }
      // Progress from the current threshold to the next one (full at 5 stars).
      const lo = earned === 0 ? 0 : (STAR_THRESHOLDS[earned - 1] ?? 100);
      const hi = STAR_THRESHOLDS[earned] ?? 100;
      const f = judged ? (earned >= 5 ? 1 : Math.min(1, Math.max(0, (accuracy - lo) / (hi - lo)))) : 0;
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
  private readonly comboSlot = h('div', { class: 'gm-combo' });
  private readonly comboCount = h('output', { class: 'gm-stat__value rw-num' }, '0');
  private readonly accuracy = h('output', { class: 'gm-stat__value rw-num' }, '—');
  private readonly speedOut = h('output', { class: 'gm-speed rw-num' }, '100%');
  private readonly section = h('span', { class: 'gm-song__section' }, '');
  private readonly stars = starMeter();
  private readonly pop = h('div', { class: 'gm-pop', 'aria-live': 'off' });
  private readonly multPop = h('div', { class: 'gm-mult-pop', 'aria-hidden': 'true' });
  private readonly chordNote = h('div', { class: 'gm-chord-note', hidden: true }, icon('info', { size: '1em' }), CHORD_NOTE);
  private readonly coach = h('div', { class: 'gm-coach', role: 'status', 'aria-live': 'polite' });
  private readonly countIn = h('div', { class: 'gm-countin', 'aria-hidden': 'true', hidden: true });
  private multiplier = 1;
  private comboShown = -1;
  private lastScore = -1;
  private lastAcc = '';
  private sectionShown = '';
  private speedShown = -1;
  private countShown = -1;
  private coachTimer = 0;
  private popTimer = 0;
  /** Keys of judgements already popped (a provisional WrongNote is emitted again when final). */
  private readonly popped = new Set<string>();

  constructor(
    info: { title: string; artist: string | null; mode: 'play' | 'practice' },
    actions: HTMLElement,
    private readonly getDetail: () => FeedbackDetail,
  ) {
    const modeChip = h('span', { class: `gm-mode gm-mode--${info.mode}` }, info.mode === 'practice' ? 'Practice' : 'Play');
    this.bar = h(
      'header',
      { class: 'gm-hud' },
      h(
        'div',
        { class: 'gm-song' },
        h('h1', { class: 'gm-song__title', tabindex: '-1' }, info.title),
        h('div', { class: 'gm-song__meta' }, modeChip, info.artist ? h('span', { class: 'gm-song__artist' }, info.artist) : null, this.section),
      ),
      h(
        'div',
        { class: 'gm-stats' },
        h('div', { class: 'gm-stat gm-stat--score' }, h('span', { class: 'gm-stat__label' }, 'Score'), this.score),
        h(
          'div',
          { class: 'gm-stat gm-stat--combo' },
          h('span', { class: 'gm-stat__label' }, 'Combo'),
          h('div', { class: 'gm-stat__row' }, this.comboCount, this.comboSlot),
        ),
        h('div', { class: 'gm-stat' }, h('span', { class: 'gm-stat__label' }, 'Accuracy'), this.accuracy),
        h('div', { class: 'gm-stat gm-stat--stars' }, h('span', { class: 'gm-stat__label' }, 'Stars'), this.stars.el),
        h('div', { class: 'gm-stat' }, h('span', { class: 'gm-stat__label' }, 'Speed'), this.speedOut),
      ),
      actions,
    );
    this.comboSlot.append(comboBadge(1));
    this.overlays = h('div', { class: 'gm-overlays' }, this.pop, this.multPop, this.countIn, this.coach, this.chordNote);
  }

  /** Live judge state → score, combo, multiplier, accuracy, stars. */
  setState(s: JudgeState): void {
    if (s.score !== this.lastScore) {
      this.lastScore = s.score;
      this.score.textContent = s.score.toLocaleString('en-US');
    }
    if (s.combo !== this.comboShown) {
      this.comboShown = s.combo;
      this.comboCount.textContent = String(s.combo);
    }
    if (s.multiplier !== this.multiplier) {
      const up = s.multiplier > this.multiplier;
      this.multiplier = s.multiplier;
      this.comboSlot.replaceChildren(comboBadge(s.multiplier));
      if (up) this.multiplierUp(s.multiplier);
    }
    const acc = s.judgedNotes > 0 ? `${s.accuracy.toFixed(1)}%` : '—';
    if (acc !== this.lastAcc) {
      this.lastAcc = acc;
      this.accuracy.textContent = acc;
    }
    this.stars.set(s.accuracy, s.judgedNotes > 0);
  }

  /** Central outcome pop for a judgement (final hits/misses and the first WrongNote emission). */
  judgement(j: Judgement): void {
    const key = `${j.pass}:${j.noteIds[0] ?? -1}`;
    if (!j.final && j.outcome !== 'WrongNote') return;
    if (this.popped.has(key) && j.outcome === 'WrongNote') return;
    this.popped.add(key);
    if (this.popped.size > 512) this.popped.clear();
    const detail = outcomeDetail(j, this.getDetail());
    const tag = judgementTag(j.outcome, { size: 'lg', ...(detail ? { detail } : {}) });
    this.pop.replaceChildren(tag);
    this.pop.dataset.outcome = j.outcome;
    this.pop.classList.remove('is-out');
    flash(tag);
    window.clearTimeout(this.popTimer);
    this.popTimer = window.setTimeout(() => this.pop.classList.add('is-out'), j.outcome === 'Miss' ? 450 : 650);
  }

  /** Big "×N" burst when the multiplier steps up. */
  private multiplierUp(mult: number): void {
    this.multPop.textContent = `×${mult}`;
    this.multPop.dataset.mult = String(mult);
    flash(this.multPop);
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

  /** Count-in number (0 hides it). */
  setCountIn(n: number): void {
    if (n === this.countShown) return;
    this.countShown = n;
    this.countIn.hidden = n <= 0;
    if (n > 0) {
      this.countIn.textContent = String(n);
      flash(this.countIn);
    }
  }

  /** A coach line (speed trainer, loop result, mastery, notices) for a few seconds. */
  message(m: PracticeMessage): void {
    const line = h('div', { class: `gm-coach__line gm-coach__line--${m.kind}` }, m.text);
    this.coach.replaceChildren(line);
    window.clearTimeout(this.coachTimer);
    this.coachTimer = window.setTimeout(() => line.classList.add('is-out'), m.kind === 'loop' ? 2500 : 4500);
  }

  /** Clear transient overlays (restart). */
  reset(): void {
    this.pop.replaceChildren();
    this.popped.clear();
    this.setCountIn(0);
  }

  dispose(): void {
    window.clearTimeout(this.coachTimer);
    window.clearTimeout(this.popTimer);
  }
}
