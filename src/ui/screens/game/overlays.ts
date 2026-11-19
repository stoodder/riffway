/**
 * Game screen cards (T-031): loading, the start card (mode, speed, input, tuning reminder and key
 * legend), the pause menu (with the reason when the game paused itself) and the error card. Each
 * returns its element plus the button to focus.
 * @module
 */
import type { KeyboardSettings } from '@shared/settings';
import { describeTuning, midiToName, STANDARD_TUNING } from '@core/model';
import { STRING_COLORS } from '../../design/tokens';
import { laneNames } from '../../../game/highway';
import { keyLabel } from '../../../game/input';
import { button, h, icon } from '../../components';

/**
 * The retune reminder for a non-standard tuning, e.g. "Drop D — tune string 6 down to D", or null
 * for standard tuning (R2-U-06).
 */
export function tuningReminder(tuning: readonly number[]): string | null {
  const changed: { string: number; dir: 'up' | 'down'; to: string }[] = [];
  for (let i = 0; i < 6; i++) {
    const want = tuning[i];
    const std = STANDARD_TUNING[i];
    if (want === undefined || std === undefined || want === std) continue;
    changed.push({ string: i + 1, dir: want > std ? 'up' : 'down', to: midiToName(want).replace(/-?\d+$/, '') });
  }
  if (changed.length === 0) return null;
  const { id, label } = describeTuning(tuning);
  const name = id === 'custom' ? 'Custom tuning' : label;
  if (changed.length <= 2) return `${name} — tune ${changed.map((c) => `string ${c.string} ${c.dir} to ${c.to}`).join(', ')}`;
  const lowToHigh = [...tuning].reverse().map((m) => midiToName(m).replace(/-?\d+$/, ''));
  return `${name} — retune ${changed.length} strings (low → high: ${lowToHigh.join(' ')})`;
}

/**
 * Key legend: one coloured key per lane (high e on top, like the highway) + modifiers. `tuning`
 * names the lanes (default standard).
 */
export function keyLegend(keys: KeyboardSettings, compact = false, tuning: readonly number[] = STANDARD_TUNING): HTMLElement {
  const names = laneNames(tuning).slice(1);
  return h(
    'div',
    { class: `gm-keys${compact ? ' gm-keys--compact' : ''}`, 'aria-label': 'Keyboard controls' },
    h(
      'div',
      { class: 'gm-keys__lanes' },
      keys.lanes.map((code, i) =>
        h(
          'span',
          { class: 'gm-key', style: `--lane-color: ${STRING_COLORS[(i + 1) as 1 | 2 | 3 | 4 | 5 | 6]}` },
          h('kbd', null, keyLabel(code)),
          h('span', { class: 'gm-key__string' }, names[i]),
        ),
      ),
    ),
    h(
      'div',
      { class: 'gm-keys__mods' },
      h('span', null, h('kbd', null, keys.wrongPitchModifier), ' + key = wrong note'),
      h('span', null, h('kbd', null, 'Esc'), ' pause'),
      compact ? null : h('span', null, h('kbd', null, 'Space'), ' start'),
    ),
  );
}

/** Loading card with a label and optional progress. */
export function loadingCard(): { el: HTMLElement; set(label: string, fraction: number | null): void } {
  const label = h('p', { class: 'gm-card__text' }, 'Loading song…');
  const bar = h('span', { class: 'gm-loading__fill' });
  const track = h('span', { class: 'gm-loading__track', hidden: true }, bar);
  const el = h(
    'div',
    { class: 'gm-card gm-card--loading', role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'rw-spinner', 'aria-hidden': 'true' }),
    label,
    track,
  );
  return {
    el,
    set(text, fraction) {
      label.textContent = `${text}…`;
      track.hidden = fraction === null;
      if (fraction !== null) bar.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
    },
  };
}

/** Facts shown on the start card. */
export interface StartInfo {
  title: string;
  artist: string | null;
  mode: 'play' | 'practice';
  speed: number;
  loopLabel: string | null;
  guitarLabel: string | null;
  keys: KeyboardSettings;
  /** The song's tuning (high → low), for the key legend and the retune reminder. */
  tuning: readonly number[];
  notice?: string;
}

/**
 * The pre-run card: what is about to play, how to play it, and the Play button. A non-standard
 * tuning gets a retune reminder with "Open tuner" (`onTuner`).
 */
export function startCard(info: StartInfo, onPlay: () => void, onBack: () => void, onTuner?: () => void): { el: HTMLElement; focus: HTMLButtonElement } {
  const play = button({ label: 'Play', icon: 'play', variant: 'primary', size: 'lg', onClick: onPlay });
  const facts = [
    info.mode === 'practice' ? 'Practice' : 'Play',
    `${Math.round(info.speed * 100)}% speed`,
    info.loopLabel ? `Loop: ${info.loopLabel}` : null,
  ].filter(Boolean) as string[];
  const input = info.guitarLabel
    ? h('p', { class: 'gm-card__input' }, icon('audio', { size: '16px' }), `Guitar: ${info.guitarLabel} — keys work too`)
    : h('p', { class: 'gm-card__input' }, icon('music', { size: '16px' }), 'Keyboard mode — keys 1–6 play the strings');
  const retune = tuningReminder(info.tuning);
  const el = h(
    'div',
    { class: 'gm-card gm-card--start', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Ready to play' },
    h('p', { class: 'gm-card__eyebrow' }, facts.join(' · ')),
    h('h2', { class: 'gm-card__title' }, info.title),
    info.artist ? h('p', { class: 'gm-card__artist' }, info.artist) : null,
    retune
      ? h(
          'div',
          { class: 'gm-card__tuning', role: 'note' },
          icon('warning', { size: '16px' }),
          h('span', null, retune),
          onTuner ? button({ label: 'Open tuner', icon: 'audio', variant: 'secondary', size: 'sm', onClick: onTuner }) : null,
        )
      : null,
    input,
    keyLegend(info.keys, false, info.tuning),
    info.notice ? h('p', { class: 'gm-card__notice', role: 'note' }, icon('info', { size: '16px' }), info.notice) : null,
    h('div', { class: 'gm-card__actions' }, play, button({ label: 'Back', variant: 'ghost', onClick: onBack })),
  );
  return { el, focus: play };
}

/** Pause-menu actions. */
export interface PauseActions {
  resume(): void;
  restart(): void;
  tools(): void;
  /** End the run and show results (null hides the item). */
  finish: (() => void) | null;
  quit(): void;
}

/**
 * The pause menu. `notice` says why the game paused itself (guitar unplugged, audio stopped);
 * `tuning` names the legend's lanes.
 */
export function pauseMenu(
  actions: PauseActions,
  keys: KeyboardSettings,
  opts: { notice?: string | null; tuning?: readonly number[] } = {},
): { el: HTMLElement; focus: HTMLButtonElement; setNotice(text: string | null): void } {
  const resume = button({ label: 'Resume', icon: 'play', variant: 'primary', size: 'lg', onClick: actions.resume });
  const notice = h('p', { class: 'gm-card__notice', role: 'alert', hidden: !opts.notice }, icon('warning', { size: '16px' }), h('span', null, opts.notice ?? ''));
  const el = h(
    'div',
    { class: 'gm-card gm-card--pause', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gm-pause-title' },
    h('h2', { class: 'gm-card__title', id: 'gm-pause-title' }, 'Paused'),
    notice,
    h(
      'div',
      { class: 'gm-menu' },
      resume,
      button({ label: 'Restart', icon: 'loop', variant: 'secondary', onClick: actions.restart }),
      button({ label: 'Practice tools', icon: 'settings', variant: 'secondary', onClick: actions.tools }),
      actions.finish ? button({ label: 'End run & see results', icon: 'check', variant: 'secondary', onClick: actions.finish }) : null,
      button({ label: 'Quit to song', icon: 'close', variant: 'ghost', onClick: actions.quit }),
    ),
    keyLegend(keys, true, opts.tuning),
  );
  return {
    el,
    focus: resume,
    setNotice(text) {
      notice.hidden = !text;
      (notice.lastElementChild as HTMLElement).textContent = text ?? '';
    },
  };
}

/** Error card for a load that failed (retry may help). */
export function errorCard(message: string, onBack: () => void, onRetry: () => void): HTMLElement {
  return h(
    'div',
    { class: 'gm-card gm-card--error', role: 'alert' },
    h('div', { class: 'gm-card__icon' }, icon('warning', { size: '28px' })),
    h('h2', { class: 'gm-card__title' }, "This song couldn't be loaded"),
    h('p', { class: 'gm-card__text' }, message),
    h('div', { class: 'gm-card__actions' }, button({ label: 'Try again', variant: 'primary', onClick: onRetry }), button({ label: 'Back', variant: 'ghost', onClick: onBack })),
  );
}

/**
 * The song is not in the library (404): no raw id and no "Try again" that cannot help; offer the
 * library and a rescan instead (R2-U-30).
 */
export function notFoundCard(onLibrary: () => void, onRescan: () => Promise<void>): { el: HTMLElement; focus: HTMLButtonElement } {
  const library = button({ label: 'Back to library', icon: 'library', variant: 'primary', onClick: onLibrary });
  const status = h('p', { class: 'gm-card__text', role: 'status' });
  const rescan = button({
    label: 'Rescan library',
    icon: 'loop',
    variant: 'secondary',
    onClick: () => {
      rescan.disabled = true;
      status.textContent = 'Rescanning your library folder…';
      onRescan().catch((err: unknown) => {
        rescan.disabled = false;
        status.textContent = `The rescan failed: ${err instanceof Error ? err.message : String(err)}`;
      });
    },
  });
  const el = h(
    'div',
    { class: 'gm-card gm-card--error', role: 'alert' },
    h('div', { class: 'gm-card__icon' }, icon('warning', { size: '28px' })),
    h('h2', { class: 'gm-card__title' }, "This song isn't in your library"),
    h('p', { class: 'gm-card__text' }, 'It may have been moved, renamed or deleted. If you just added or moved it, rescan your library folder.'),
    status,
    h('div', { class: 'gm-card__actions' }, library, rescan),
  );
  return { el, focus: library };
}
