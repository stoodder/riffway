/**
 * Game screen cards (T-031): loading, the start card (mode, speed, input and key legend), the pause
 * menu and the error card. Each returns its element plus the button to focus.
 * @module
 */
import type { KeyboardSettings } from '@shared/settings';
import { STRING_COLORS } from '../../design/tokens';
import { keyLabel } from '../../../game/input';
import { button, h, icon } from '../../components';

/** Key legend: one coloured key per lane (high e on top, like the highway) + modifiers. */
export function keyLegend(keys: KeyboardSettings, compact = false): HTMLElement {
  const names = ['e', 'B', 'G', 'D', 'A', 'E'];
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
  notice?: string;
}

/** The pre-run card: what is about to play, how to play it, and the Play button. */
export function startCard(info: StartInfo, onPlay: () => void, onBack: () => void): { el: HTMLElement; focus: HTMLButtonElement } {
  const play = button({ label: 'Play', icon: 'play', variant: 'primary', size: 'lg', onClick: onPlay });
  const facts = [
    info.mode === 'practice' ? 'Practice' : 'Play',
    `${Math.round(info.speed * 100)}% speed`,
    info.loopLabel ? `Loop: ${info.loopLabel}` : null,
  ].filter(Boolean) as string[];
  const input = info.guitarLabel
    ? h('p', { class: 'gm-card__input' }, icon('audio', { size: '16px' }), `Guitar: ${info.guitarLabel} — keys work too`)
    : h('p', { class: 'gm-card__input' }, icon('music', { size: '16px' }), 'Keyboard mode — keys 1–6 play the strings');
  const el = h(
    'div',
    { class: 'gm-card gm-card--start', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Ready to play' },
    h('p', { class: 'gm-card__eyebrow' }, facts.join(' · ')),
    h('h2', { class: 'gm-card__title' }, info.title),
    info.artist ? h('p', { class: 'gm-card__artist' }, info.artist) : null,
    input,
    keyLegend(info.keys),
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

/** The pause menu. */
export function pauseMenu(actions: PauseActions, keys: KeyboardSettings): { el: HTMLElement; focus: HTMLButtonElement } {
  const resume = button({ label: 'Resume', icon: 'play', variant: 'primary', size: 'lg', onClick: actions.resume });
  const el = h(
    'div',
    { class: 'gm-card gm-card--pause', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gm-pause-title' },
    h('h2', { class: 'gm-card__title', id: 'gm-pause-title' }, 'Paused'),
    h(
      'div',
      { class: 'gm-menu' },
      resume,
      button({ label: 'Restart', icon: 'loop', variant: 'secondary', onClick: actions.restart }),
      button({ label: 'Practice tools', icon: 'settings', variant: 'secondary', onClick: actions.tools }),
      actions.finish ? button({ label: 'End run & see results', icon: 'check', variant: 'secondary', onClick: actions.finish }) : null,
      button({ label: 'Quit to song', icon: 'close', variant: 'ghost', onClick: actions.quit }),
    ),
    keyLegend(keys, true),
  );
  return { el, focus: resume };
}

/** Error card. */
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
