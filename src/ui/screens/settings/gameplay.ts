/**
 * Gameplay and practice settings: feedback detail, assists (hand cues, guide synth), strict octave,
 * note speed, the (fixed) timing windows, practice defaults, goals and playing preferences.
 * Every control saves on change through the settings store.
 * @module
 */
import { WINDOWS } from '@core/judge/constants';
import type { FeedbackDetail, Settings } from '@shared/settings';
import { h, select, slider, toggle } from '../../components';
import { choiceGroup, group, section, type Binder, type Choice } from './controls';

/** Feedback-detail choices (learning research rows 7–8: bandwidth feedback, learner control). */
export const FEEDBACK_CHOICES: readonly Choice<FeedbackDetail>[] = [
  { value: 'minimal', label: 'Minimal', description: 'Notes flash on a hit and grey out on a miss. No outcome words or early/late labels.' },
  {
    value: 'standard',
    label: 'Standard',
    tag: 'Recommended',
    description: 'Outcome words (Perfect, Great, Good). Early/late only when you’re outside the Great window.',
  },
  { value: 'detailed', label: 'Detailed', description: 'Every hit labelled early or late, and the note you played on a wrong note.' },
];

/** Daily goal options in minutes (docs/progress.md § Streaks). */
export const DAILY_MINUTES: readonly number[] = [5, 10, 15, 30, 45];

/** Genres offered as preferences; stored ones outside this list are kept and shown too. */
export const GENRES: readonly string[] = ['rock', 'metal', 'recognizable', 'blues', 'classical', 'folk'];

const GENRE_LABELS: Readonly<Record<string, string>> = { recognizable: 'Recognisable tunes' };

/** Format a note-speed multiplier (`1` → `1.00×`). */
export function formatNoteSpeed(v: number): string {
  return `${v.toFixed(2)}×`;
}

/** Display a genre tag (`'recognizable'` → `Recognisable tunes`, `'rock'` → `Rock`). */
export function genreLabel(tag: string): string {
  return GENRE_LABELS[tag] ?? tag.charAt(0).toUpperCase() + tag.slice(1);
}

/** Toggle `tag` in a genre list (order: {@link GENRES} first, then extras as stored). */
export function toggleGenre(genres: readonly string[], tag: string, on: boolean): string[] {
  const set = new Set(genres);
  if (on) set.add(tag);
  else set.delete(tag);
  const known = GENRES.filter((g) => set.has(g));
  return [...known, ...[...set].filter((g) => !GENRES.includes(g))];
}

const ms = (s: number): string => `±${Math.round(s * 1000)} ms`;

/** The Gameplay tab. */
export function gameplayTab(b: Binder): HTMLElement {
  const feedback = choiceGroup({
    label: 'Feedback detail',
    choices: FEEDBACK_CHOICES,
    value: 'standard',
    onChange: (v) => void b.save({ game: { feedbackDetail: v } }),
  });
  b.bind((s) => feedback.set(s.game.feedbackDetail));

  const handCues = toggle({
    label: 'Hand-position cues',
    description: 'Brackets on the highway show where your fretting hand should be and when it moves.',
    checked: true,
    onChange: (v) => void b.save({ game: { handCues: v } }),
  });
  const guide = toggle({
    label: 'Guide synth',
    description: 'Hear the part played along with you. You can also mute it from the mixer while playing.',
    checked: true,
    onChange: (v) => void b.save({ game: { guide: v } }),
  });
  const muteGuide = toggle({
    label: 'Mute the guide while backing audio plays',
    description: 'When a song has its own recording attached, you hear that instead.',
    checked: true,
    onChange: (v) => void b.save({ game: { muteGuideWithBacking: v } }),
  });
  const strict = toggle({
    label: 'Strict octave',
    description: 'Off: a note played an octave off still counts (pitch trackers sometimes hear the octave). On: it’s a wrong note.',
    checked: false,
    onChange: (v) => void b.save({ game: { strictOctave: v } }),
  });
  const noteSpeed = slider({
    label: 'Note speed',
    min: 0.5,
    max: 2,
    step: 0.05,
    value: 1,
    format: formatNoteSpeed,
    hint: 'How fast notes scroll toward the hit line. Faster spreads them out; it doesn’t change the song’s tempo.',
    onChange: (v) => void b.save({ game: { noteSpeed: v } }),
  });
  b.bind((s) => {
    handCues.set(s.game.handCues);
    guide.set(s.game.guide);
    muteGuide.set(s.game.muteGuideWithBacking);
    strict.set(s.game.strictOctave);
    noteSpeed.set(s.game.noteSpeed);
  });

  const windows = h(
    'dl',
    { class: 'set-windows' },
    windowRow('Perfect', WINDOWS.perfect, 'perfect'),
    windowRow('Great', WINDOWS.great, 'great'),
    windowRow('Good', WINDOWS.good, 'good'),
  );

  return h(
    'div',
    { class: 'set-tab' },
    section(
      'Feedback',
      'How much the highway tells you while you play. Less detail during play tends to stick better; the results screen always has the full timing breakdown.',
      feedback.el,
    ),
    section('Assists', 'Every assist can be switched off as you get more confident.', group(null, handCues.el, guide.el, muteGuide.el)),
    section('Judging', null, group(null, strict.el, noteSpeed.el), group('Timing windows', windows, h('p', { class: 'rw-field__hint' }, 'Windows are in real time, so they stay the same at any practice speed. Calibrate latency in Audio setup if hits feel consistently early or late.'))),
  );
}

function windowRow(label: string, sec: number, tone: 'perfect' | 'great' | 'good'): HTMLElement {
  return h('div', { class: `set-windows__row set-windows__row--${tone}` }, h('dt', null, label), h('dd', { class: 'rw-num' }, ms(sec)));
}

/** The Practice & goals tab. */
export function practiceTab(b: Binder): HTMLElement {
  const countIn = select({
    label: 'Count-in',
    options: [
      { value: '0', label: 'None' },
      { value: '1', label: '1 bar' },
      { value: '2', label: '2 bars' },
    ],
    hint: 'Clicks before the notes start.',
    onChange: (v) => void b.save({ practice: { countInBars: Number(v) } }),
  });
  const metronome = toggle({ label: 'Metronome', description: 'Click along with the song by default.', checked: true, onChange: (v) => void b.save({ practice: { metronome: v } }) });
  const trainer = toggle({
    label: 'Speed trainer',
    description: 'Practice starts sections at 70% and speeds up 5% after each clean run (90%+).',
    checked: true,
    onChange: (v) => void b.save({ practice: { speedTrainer: v } }),
  });
  const overspeed = toggle({
    label: 'Overspeed after mastery',
    description: 'Let the trainer go to 110% once a section is mastered.',
    checked: false,
    onChange: (v) => void b.save({ practice: { overspeed: v } }),
  });
  const daily = select({
    label: 'Daily goal',
    options: DAILY_MINUTES.map((m) => ({ value: String(m), label: `${m} minutes` })),
    hint: 'A practice day counts from 5 minutes of playing.',
    onChange: (v) => void b.save({ goals: { dailyMinutes: Number(v) } }),
  });
  const weekly = slider({
    label: 'Practice days per week',
    min: 2,
    max: 7,
    step: 1,
    value: 4,
    format: (v) => `${v} days`,
    hint: 'Your streak counts weeks that reach this. Missed weeks are forgiven with freezes you earn.',
    onChange: (v) => void b.save({ goals: { weeklyDays: v } }),
  });
  const style = choiceGroup<'pick' | 'fingerstyle'>({
    label: 'Playing style',
    layout: 'inline',
    choices: [
      { value: 'pick', label: 'Pick' },
      { value: 'fingerstyle', label: 'Fingerstyle' },
    ],
    value: 'pick',
    hint: 'Recommendations favour songs in your style.',
    onChange: (v) => void b.save({ preferences: { style: v } }),
  });
  const fingerstyle = toggle({
    label: 'Fingerstyle in session goals',
    description: 'Suggest fingerstyle pieces (ClassTab and the like) as goals too.',
    checked: false,
    onChange: (v) => void b.save({ preferences: { fingerstyle: v } }),
  });
  const genreBox = h('div', { class: 'set-genres', role: 'group', 'aria-label': 'Favourite genres' });
  let genres: string[] = [];
  const renderGenres = (): void => {
    const all = [...GENRES, ...genres.filter((g) => !GENRES.includes(g))];
    genreBox.replaceChildren(
      ...all.map((tag) =>
        h(
          'button',
          {
            type: 'button',
            class: 'set-genre',
            'aria-pressed': String(genres.includes(tag)),
            dataset: { genre: tag },
            on: { click: () => void b.save({ preferences: { genres: toggleGenre(genres, tag, !genres.includes(tag)) } }) },
          },
          genreLabel(tag),
        ),
      ),
    );
  };
  b.bind((s: Settings) => {
    countIn.set(String(s.practice.countInBars));
    metronome.set(s.practice.metronome);
    trainer.set(s.practice.speedTrainer);
    overspeed.set(s.practice.overspeed);
    daily.set(String(s.goals.dailyMinutes));
    weekly.set(s.goals.weeklyDays);
    style.set(s.preferences.style);
    fingerstyle.set(s.preferences.fingerstyle);
    genres = [...s.preferences.genres];
    renderGenres();
  });

  return h(
    'div',
    { class: 'set-tab' },
    section('Practice defaults', 'Starting values for practice runs; you can change them on the fly in the practice panel.', group(null, countIn.el, metronome.el, trainer.el, overspeed.el)),
    section('Goals', 'Streaks are weekly and forgiving: no reminders, no “streak lost” messages.', group(null, daily.el, weekly.el)),
    section(
      'Preferences',
      'Used to pick recommendations on the home screen.',
      group(null, style.el, fingerstyle.el),
      group('Favourite genres', genreBox, h('p', { class: 'rw-field__hint' }, 'Songs tagged with these get a small boost.')),
    ),
  );
}
