/**
 * Meters: `level` (input level with green → amber → red zones and peak hold, for the input panel)
 * and `progress` (accuracy, mastery, goal progress). Updates are cheap (one style write) so a level
 * meter can be driven from `requestAnimationFrame`.
 * @module
 */
import { h, uid } from './dom';

/** Options for {@link meter}. */
export interface MeterOptions {
  label: string;
  /** Hide the label visually (still the accessible name). */
  hideLabel?: boolean;
  kind?: 'level' | 'progress';
  min?: number;
  max?: number;
  value?: number;
  /** Readout text; omit the readout with `showValue: false`. */
  format?: (value: number) => string;
  showValue?: boolean;
  /** Progress colour (any CSS colour); level meters use the zone gradient. */
  color?: string;
  /** Level meters: fraction where the amber / red zones start (default 0.7 / 0.9). */
  zones?: { warn: number; hot: number };
}

/** A mounted meter. */
export interface Meter {
  el: HTMLElement;
  /** Set the value; level meters also take an optional peak (same units). */
  set(value: number, peak?: number): void;
}

/** Create a level or progress meter (`role="meter"`). */
export function meter(opts: MeterOptions): Meter {
  const kind = opts.kind ?? 'progress';
  const min = opts.min ?? 0;
  const max = opts.max ?? 1;
  const format = opts.format ?? ((v: number) => `${Math.round(((v - min) / (max - min)) * 100)}%`);
  const labelId = uid('meter');
  const fill = h('span', { class: 'rw-meter__fill' });
  const peak = h('span', { class: 'rw-meter__peak' });
  const track = h(
    'span',
    {
      class: 'rw-meter__track',
      role: 'meter',
      'aria-labelledby': labelId,
      'aria-valuemin': min,
      'aria-valuemax': max,
    },
    fill,
    kind === 'level' ? peak : null,
  );
  const readout = opts.showValue === false ? null : h('span', { class: 'rw-meter__value rw-num' });
  const zones = opts.zones ?? { warn: 0.7, hot: 0.9 };
  const el = h(
    'div',
    {
      class: `rw-meter rw-meter--${kind}`,
      style:
        `--warn: ${zones.warn * 100}%; --hot: ${zones.hot * 100}%` + (opts.color ? `; --meter-color: ${opts.color}` : ''),
    },
    h('div', { class: opts.hideLabel ? 'rw-meter__top rw-visually-hidden' : 'rw-meter__top' }, h('span', { class: 'rw-meter__label', id: labelId }, opts.label), readout),
    track,
  );
  const frac = (v: number): number => Math.min(1, Math.max(0, (v - min) / (max - min || 1)));
  const set = (value: number, peakValue?: number): void => {
    const f = frac(value);
    // Clip a full-width fill so level gradients keep their zones and rounded ends stay round.
    fill.style.clipPath = `inset(0 ${((1 - f) * 100).toFixed(2)}% 0 0 round var(--radius-pill))`;
    track.setAttribute('aria-valuenow', String(value));
    const text = format(value);
    track.setAttribute('aria-valuetext', text);
    if (readout) readout.textContent = text;
    if (kind === 'level') {
      const p = frac(peakValue ?? value);
      peak.style.left = `${p * 100}%`;
      peak.classList.toggle('is-hot', p >= zones.hot);
      el.classList.toggle('is-clipping', f >= zones.hot);
    }
  };
  set(opts.value ?? min);
  return { el, set };
}
