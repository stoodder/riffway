/**
 * Component gallery (`#/dev/components`, T-018): every token and component of the design system on one
 * page, for visual review and screenshots. Dev builds and `?e2e=1` only (the shell gates `dev` screens).
 * Overlay demos use `ctx.ui` (the real shell implementation) and a fake audio target.
 * @module
 */
import type { Outcome } from '@shared/judge';
import type { ScreenMount, ToastKind } from '@shared/ui';
import type { StringNumber, Tier } from '@shared/song';
import {
  badge,
  button,
  card,
  comboBadge,
  difficultyPill,
  emptyState,
  flash,
  h,
  icon,
  ICON_NAMES,
  judgementTag,
  menuButton,
  meter,
  openModal,
  rovingFocus,
  select,
  setBusy,
  slider,
  starRating,
  tabs,
  toggle,
  type Child,
} from '../../components';
import { DURATIONS_MS, prefersReducedMotion } from '../../design/tokens';
import { promptAudioGesture } from '../../shell/audio-gesture';
import './gallery.css';

const STRING_NAMES: Record<StringNumber, string> = { 1: 'e', 2: 'B', 3: 'G', 4: 'D', 5: 'A', 6: 'E' };

/** A titled specimen block. */
function specimen(title: string, lead: string, ...content: Child[]): HTMLElement {
  return h(
    'section',
    { class: 'gal-section', 'aria-label': title },
    h('header', { class: 'gal-section__head' }, h('h2', null, title), h('p', { class: 'rw-muted' }, lead)),
    h('div', { class: 'gal-section__body' }, ...content),
  );
}

function swatch(name: string, cssVar: string): HTMLElement {
  return h(
    'div',
    { class: 'gal-swatch' },
    h('span', { class: 'gal-swatch__chip', style: `background: var(${cssVar})` }),
    h('span', { class: 'gal-swatch__name' }, name),
    h('code', { class: 'gal-swatch__var' }, cssVar),
  );
}

/** A miniature highway: six lanes in string colours with a few gems approaching the hit line. */
function miniHighway(): HTMLElement {
  const gems: Array<[StringNumber, number, string]> = [
    [6, 12, '0'],
    [5, 22, '2'],
    [4, 33, '2'],
    [3, 46, '1'],
    [2, 58, '0'],
    [1, 70, '3'],
    [3, 80, '2'],
    [4, 90, '4'],
  ];
  const lanes = ([1, 2, 3, 4, 5, 6] as StringNumber[]).map((s) =>
    h(
      'div',
      { class: 'gal-lane', style: `--lane: var(--string-${s})` },
      h('span', { class: 'gal-lane__name' }, STRING_NAMES[s]),
      h(
        'span',
        { class: 'gal-lane__track' },
        ...gems.filter(([gs]) => gs === s).map(([, x, fret]) => h('span', { class: 'gal-gem', style: `left: ${x}%` }, fret)),
      ),
    ),
  );
  return h('div', { class: 'gal-highway', role: 'img', 'aria-label': 'String colors on a miniature highway' }, h('span', { class: 'gal-highway__hit' }), ...lanes);
}

function songCard(title: string, artist: string, rating: number, tags: string[], stars: number, accentTier: Tier): HTMLElement {
  const el = card({
    as: 'li',
    interactive: true,
    accent: `var(--tier-${accentTier})`,
    eyebrow: artist,
    title,
    aside: difficultyPill({ rating, size: 'sm' }),
    body: h('div', { class: 'rw-row', style: '--gap: 6px' }, ...tags.map((t) => badge(t))),
    footer: [starRating({ stars, size: 'sm' }), h('span', { class: 'gal-spacer' }), button({ label: 'Play', icon: 'play', size: 'sm', variant: 'primary' })],
  });
  el.tabIndex = -1;
  el.setAttribute('aria-label', `${title} by ${artist}`);
  return el;
}

export const mount: ScreenMount = (el, ctx) => {
  const cleanups: Array<() => void> = [];

  // ---- Feedback ----------------------------------------------------------------------------------
  const judgements: Array<[Outcome, Parameters<typeof judgementTag>[1]]> = [
    ['Perfect', {}],
    ['Great', {}],
    ['Good', { timing: 'late' }],
    ['WrongNote', { detail: 'played G3' }],
    ['Miss', {}],
  ];
  const tags = judgements.map(([o, opts]) => judgementTag(o, { size: 'lg', ...opts }));
  const replay = button({ label: 'Replay hit flash', icon: 'play', size: 'sm', onClick: () => tags.forEach(flash) });

  // ---- Controls ----------------------------------------------------------------------------------
  const speed = slider({ label: 'Speed', min: 40, max: 110, step: 5, value: 70, format: (v) => `${v}%`, hint: 'Speed trainer starts at 70% and adds 5% after a clean run.' });
  const guide = slider({ label: 'Guide synth', min: 0, max: 100, value: 60, format: (v) => `${v}%` });
  const metronome = toggle({ label: 'Metronome', checked: true, description: 'Click on every beat during count-in and play.' });
  const handCues = toggle({ label: 'Hand-position cues', checked: false });
  const preset = select({
    label: 'Amp preset',
    value: 'drive',
    options: [
      { value: 'clean', label: 'Clean' },
      { value: 'drive', label: 'Overdrive' },
      { value: 'lead', label: 'Lead (coming later)', disabled: true },
    ],
  });
  const level = meter({ label: 'Input level', kind: 'level', format: (v) => `${(20 * Math.log10(Math.max(v, 1e-4))).toFixed(1)} dB` });
  level.set(0.62, 0.78);
  const hot = meter({ label: 'Input level (clipping)', kind: 'level', format: () => 'Clipping' });
  hot.set(0.97, 1);
  const accuracy = meter({ label: 'Accuracy', value: 0.87, color: 'var(--judge-great)' });
  const goal = meter({ label: 'Daily goal', value: 9, max: 15, format: (v) => `${v} / 15 min` });

  // ---- Tabs & menu -------------------------------------------------------------------------------
  const pageTabs = tabs({
    label: 'Song sections',
    tabs: [
      { id: 'overview', label: 'Overview', render: () => h('p', { class: 'rw-muted' }, 'Arrangement, tuning, tempo and your best runs.') },
      { id: 'sections', label: 'Sections', count: 6, render: () => h('p', { class: 'rw-muted' }, 'Intro · Verse · Chorus · Verse · Bridge · Outro') },
      { id: 'history', label: 'History', count: 12, render: () => h('p', { class: 'rw-muted' }, 'Twelve runs this month.') },
      { id: 'notes', label: 'Notes', disabled: true, render: () => h('p', null, '') },
    ],
  });
  const modeTabs = tabs({
    label: 'Mode',
    variant: 'segmented',
    tabs: [
      { id: 'play', label: 'Play', render: () => h('span') },
      { id: 'practice', label: 'Practice', render: () => h('span') },
    ],
  });
  const toastKinds: ToastKind[] = ['info', 'success', 'warning', 'error'];
  const menu = menuButton({
    trigger: { label: 'Song actions' },
    items: [
      { id: 'play', label: 'Play', icon: 'play', hint: 'Enter', onSelect: () => ctx.ui.toast('Play') },
      { id: 'loop', label: 'Loop hardest section', icon: 'loop', onSelect: () => ctx.ui.toast('Loop') },
      { id: 'audio', label: 'Attach backing audio…', icon: 'music', onSelect: () => ctx.ui.toast('Attach') },
      { id: 'export', label: 'Export (coming later)', icon: 'import', disabled: true, onSelect: () => undefined },
      { id: 'remove', label: 'Remove from library', icon: 'close', danger: true, onSelect: () => ctx.ui.toast('Removed', { kind: 'warning' }) },
    ],
  });
  cleanups.push(() => pageTabs.destroy(), () => modeTabs.destroy(), () => menu.destroy());

  // ---- Cards (arrow-key grid) --------------------------------------------------------------------
  const cardList = h(
    'ul',
    { class: 'gal-cards', 'aria-label': 'Example songs (arrow keys move)' },
    songCard('Ode to Joy', 'L. v. Beethoven · trad.', 1.6, ['Melody', 'Pick'], 5, 2),
    songCard('In the Hall of the Mountain King', 'E. Grieg · arr. Riffway', 4.6, ['Palm mute', 'Metal'], 3, 5),
    songCard('Bourrée in E minor', 'J. S. Bach · BWV 996', 6.2, ['Fingerstyle'], 0, 6),
  );
  const cardNav = rovingFocus(cardList, { items: () => Array.from(cardList.children) as HTMLElement[], orientation: 'both', activate: false });
  cleanups.push(() => cardNav.destroy());

  // ---- Overlays ----------------------------------------------------------------------------------
  let toastIndex = 0;
  const overlays = h(
    'div',
    { class: 'rw-row' },
    button({
      label: 'Show toast',
      icon: 'info',
      onClick: () => {
        const kind = toastKinds[toastIndex++ % toastKinds.length] as ToastKind;
        ctx.ui.toast(`Example ${kind} notification.`, { kind });
      },
    }),
    button({
      label: 'Open modal',
      onClick: () =>
        openModal({
          title: 'Section complete',
          content: ['You played the chorus at 85% speed with 94% accuracy.', starRating({ stars: 4, size: 'lg', animate: true })],
          actions: [
            { label: 'Back', value: 'back', variant: 'ghost' },
            { label: 'Next section', value: 'next', variant: 'primary', icon: 'chevronRight' },
          ],
        }),
    }),
    button({
      label: 'Confirm (danger)',
      variant: 'danger',
      onClick: async () => {
        const ok = await ctx.ui.confirm('Your progress for this song is kept; only the file is removed.', { title: 'Remove song?', confirmLabel: 'Remove', danger: true });
        ctx.ui.toast(ok ? 'Removed.' : 'Kept.', { kind: ok ? 'success' : 'info' });
      },
    }),
    button({
      label: 'Audio gesture overlay',
      icon: 'power',
      onClick: () => {
        const fake = { running: false, resume: () => new Promise<void>((r) => setTimeout(r, 400)) };
        promptAudioGesture(document.body, fake).then(
          () => ctx.ui.toast('Audio enabled (preview).', { kind: 'success' }),
          () => ctx.ui.toast('Dismissed.'),
        );
      },
    }),
  );

  // ---- Buttons -----------------------------------------------------------------------------------
  const busy = button({ label: 'Saving', variant: 'primary' });
  setBusy(busy, true);

  const typeSamples: Array<[string, string, string]> = [
    ['--text-display', 'Riffway', 'gal-type--display'],
    ['--text-3xl', 'Play it right', 'gal-type--3xl'],
    ['--text-2xl', 'Screen title', 'gal-type--2xl'],
    ['--text-xl', 'Section heading', 'gal-type--xl'],
    ['--text-lg', 'Card heading', 'gal-type--lg'],
    ['--text-md', 'Emphasized body copy', 'gal-type--md'],
    ['--text-base', 'Body copy for descriptions and settings.', 'gal-type--base'],
    ['--text-sm', 'Secondary text, labels and controls.', 'gal-type--sm'],
    ['--text-xs', 'Captions and hints.', 'gal-type--xs'],
  ];

  const root = h(
    'div',
    { class: 'gal' },
    h(
      'header',
      { class: 'gal-hero' },
      h('p', { class: 'rw-eyebrow' }, 'Design system'),
      h('h1', null, 'Components'),
      h(
        'p',
        { class: 'gal-hero__lead' },
        'Calm, dark surfaces and clear type for reading at a glance; neon is reserved for feedback — hits, combos and stars.',
      ),
    ),
    h(
      'div',
      { class: 'gal-grid' },
      specimen(
        'Strings',
        'Lane colors, 1 = high e (top) to 6 = low E. Rocksmith order; each ≥ 4.5:1 on the background.',
        miniHighway(),
      ),
      specimen(
        'Feedback',
        'Judgments, combo multiplier and stars. Neon glow only here.',
        h('div', { class: 'gal-judges' }, ...tags),
        h('div', { class: 'rw-row' }, comboBadge(1, 4), comboBadge(2, 12), comboBadge(3, 27), comboBadge(4, 48), h('span', { class: 'gal-spacer' }), replay),
        h(
          'div',
          { class: 'gal-stars' },
          ...[0, 1, 2, 3, 4, 5].map((n) => starRating({ stars: n, size: 'sm' })),
          starRating({ stars: 4, size: 'lg', animate: true, suffix: 'at 100% speed' }),
        ),
      ),
      specimen(
        'Difficulty',
        'Ratings 1.0–10.0; color per tier, band meter per name (Beginner … Expert).',
        h('div', { class: 'gal-pills' }, ...[1.0, 2.3, 3.4, 4.1, 5.0, 6.2, 7.4, 8.1, 9.3, 10.0].map((rating) => difficultyPill({ rating }))),
        h('div', { class: 'gal-pills' }, ...([2, 4, 6, 8, 10] as Tier[]).map((t) => difficultyPill({ tier: t, size: 'sm' }))),
      ),
      specimen(
        'Badges',
        'Status labels. The neon badge is for personal bests only.',
        h(
          'div',
          { class: 'rw-row' },
          badge('Starter'),
          badge('Playable', { tone: 'success', icon: 'check' }),
          badge('Needs rhythm', { tone: 'warning' }),
          badge('Drop D', { tone: 'info' }),
          badge('Import failed', { tone: 'danger' }),
          badge('Practice', { tone: 'accent' }),
          badge('New best', { tone: 'neon', icon: 'star' }),
        ),
      ),
      specimen(
        'Buttons',
        'One primary action per view. Sizes sm / md / lg; icon-only buttons carry a label.',
        h(
          'div',
          { class: 'rw-row' },
          button({ label: 'Play', variant: 'primary', icon: 'play', size: 'lg' }),
          button({ label: 'Practice', variant: 'secondary', icon: 'loop', size: 'lg' }),
        ),
        h(
          'div',
          { class: 'rw-row' },
          button({ label: 'Primary', variant: 'primary' }),
          button({ label: 'Secondary' }),
          button({ label: 'Ghost', variant: 'ghost' }),
          button({ label: 'Delete', variant: 'danger' }),
          button({ label: 'Settings', icon: 'settings', iconOnly: true }),
          button({ label: 'More', icon: 'more', iconOnly: true, variant: 'ghost' }),
        ),
        h(
          'div',
          { class: 'rw-row' },
          button({ label: 'Small', size: 'sm' }),
          button({ label: 'Small primary', size: 'sm', variant: 'primary' }),
          button({ label: 'Disabled', disabled: true }),
          busy,
        ),
      ),
      specimen(
        'Controls',
        'Sliders, switches and selects, labeled and keyboard-operable.',
        h('div', { class: 'gal-two' }, h('div', { class: 'rw-stack' }, speed.el, guide.el), h('div', { class: 'rw-stack' }, metronome.el, handCues.el, preset.el)),
      ),
      specimen('Meters', 'Level meter with zones and peak hold; progress meters take any color.', h('div', { class: 'gal-two' }, h('div', { class: 'rw-stack' }, level.el, hot.el), h('div', { class: 'rw-stack' }, accuracy.el, goal.el))),
      specimen(
        'Tabs and menus',
        'Arrow keys move between tabs and menu items; Enter chooses; Esc closes.',
        pageTabs.el,
        h('div', { class: 'rw-row' }, modeTabs.el, h('span', { class: 'gal-spacer' }), menu.el),
      ),
      specimen('Overlays', 'Toasts, modal and confirm dialogs, and the audio-gesture overlay (preview).', overlays),
      specimen(
        'Empty state',
        'Friendly, specific and with a way forward.',
        emptyState({
          title: 'No songs here yet',
          message: 'Drop Guitar Pro or MusicXML files into your library folder, or paste an ASCII tab.',
          icon: 'library',
          action: { label: 'Import a song', icon: 'import' },
          secondary: { label: 'Browse starter songs' },
          headingLevel: 3,
        }),
      ),
    ),
    specimen('Cards', 'Interactive cards in a list: Tab enters, arrow keys move between cards.', cardList),
    h(
      'div',
      { class: 'gal-grid' },
      specimen(
        'Color',
        'Surfaces step up in lightness; text has three emphasis levels.',
        h(
          'div',
          { class: 'gal-swatches' },
          swatch('Background', '--color-bg'),
          swatch('Surface 1', '--color-surface-1'),
          swatch('Surface 2', '--color-surface-2'),
          swatch('Surface 3', '--color-surface-3'),
          swatch('Border', '--color-border-strong'),
          swatch('Text', '--color-text'),
          swatch('Muted', '--color-text-muted'),
          swatch('Subtle', '--color-text-subtle'),
          swatch('Accent', '--color-accent'),
          swatch('Focus', '--color-focus'),
          swatch('Success', '--color-success'),
          swatch('Danger', '--color-danger'),
        ),
      ),
      specimen(
        'Typography',
        'System fonts only (SF Pro on macOS); tabular numbers for scores.',
        h(
          'div',
          { class: 'gal-type' },
          ...typeSamples.map(([v, text, cls]) => h('div', { class: 'gal-type__row' }, h('code', null, v), h('span', { class: cls }, text))),
          h('div', { class: 'gal-type__row' }, h('code', null, '.rw-eyebrow'), h('span', { class: 'rw-eyebrow' }, 'Now playing')),
          h('div', { class: 'gal-type__row' }, h('code', null, '.rw-num'), h('span', { class: 'rw-num gal-type--lg' }, '1,284,560')),
        ),
      ),
      specimen(
        'Space, radius, motion',
        `4 px grid. Motion collapses to 0 ms under reduced motion (now: ${prefersReducedMotion() ? 'reduced' : 'full'}).`,
        h(
          'div',
          { class: 'gal-scale' },
          ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => h('div', { class: 'gal-scale__row' }, h('code', null, `--space-${n}`), h('span', { class: 'gal-scale__bar', style: `width: var(--space-${n})` }))),
        ),
        h('div', { class: 'rw-row' }, ...['xs', 'sm', 'md', 'lg', 'xl'].map((r) => h('span', { class: 'gal-radius', style: `border-radius: var(--radius-${r})` }, r))),
        h('p', { class: 'rw-muted gal-motion' }, Object.entries(DURATIONS_MS).map(([k, v]) => `${k} ${v} ms`).join(' · ')),
      ),
      specimen('Icons', 'Inline SVG, 2 px stroke, currentColor.', h('div', { class: 'gal-icons' }, ...ICON_NAMES.map((n) => h('span', { class: 'gal-icon', title: n }, icon(n, { size: '22px' }))))),
    ),
  );

  el.append(root);
  return {
    unmount() {
      cleanups.forEach((fn) => fn());
      root.remove();
    },
  };
};
