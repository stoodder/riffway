// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
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
  judgementTag,
  meter,
  select,
  setBusy,
  slider,
  starRating,
  toggle,
} from '../../src/ui/components';

describe('h()', () => {
  it('sets attributes, classes, data, listeners and flattens children', () => {
    const click = vi.fn();
    const el = h('button', { class: 'x', type: 'button', disabled: false, hidden: true, dataset: { id: '7' }, on: { click } }, 'a', [1, null, h('b')], false);
    expect(el.className).toBe('x');
    expect(el.hasAttribute('disabled')).toBe(false);
    expect(el.hasAttribute('hidden')).toBe(true);
    expect(el.dataset.id).toBe('7');
    expect(el.textContent).toBe('a1');
    el.click();
    expect(click).toHaveBeenCalledOnce();
  });
});

describe('buttons and static blocks', () => {
  it('icon-only buttons are named; busy buttons are disabled and aria-busy', () => {
    const b = button({ label: 'Settings', icon: 'settings', iconOnly: true });
    expect(b.getAttribute('aria-label')).toBe('Settings');
    expect(b.textContent).toBe('');
    expect(b.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    const p = button({ label: 'Save', variant: 'primary' });
    expect(p.className).toContain('rw-btn--primary');
    setBusy(p, true);
    expect([p.disabled, p.getAttribute('aria-busy')]).toEqual([true, 'true']);
    setBusy(p, false);
    expect([p.disabled, p.hasAttribute('aria-busy')]).toEqual([false, false]);
  });

  it('labelled icons are images', () => {
    expect(icon('star', { label: 'Star' }).getAttribute('role')).toBe('img');
  });

  it('card renders header, body, footer and accent', () => {
    const c = card({ title: 'Ode to Joy', eyebrow: 'Beethoven', body: 'Body', footer: [button({ label: 'Play' })], accent: 'var(--tier-2)', headingLevel: 2 });
    expect(c.querySelector('h2')?.textContent).toBe('Ode to Joy');
    expect(c.querySelector('.rw-eyebrow')?.textContent).toBe('Beethoven');
    expect(c.querySelector('.rw-card__footer button')?.textContent).toBe('Play');
    expect(c.getAttribute('style')).toContain('--card-accent: var(--tier-2)');
  });

  it('badge and empty state', () => {
    expect(badge('New best', { tone: 'neon' }).className).toBe('rw-badge rw-badge--neon');
    const onClick = vi.fn();
    const e = emptyState({ title: 'Nothing yet', message: 'Add songs', action: { label: 'Import', onClick } });
    expect(e.querySelector('h2')?.textContent).toBe('Nothing yet');
    e.querySelector('button')?.click();
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('feedback components', () => {
  it('difficulty pill: tier from rating, colour token, band meter and accessible name', () => {
    const pill = difficultyPill({ rating: 4.1 });
    expect(pill.getAttribute('aria-label')).toBe('Difficulty 4.1, tier 4, Developing');
    expect(pill.dataset.tier).toBe('4');
    expect(pill.getAttribute('style')).toContain('var(--tier-4)');
    expect(pill.querySelectorAll('.rw-diff__bar.is-on')).toHaveLength(2);
    const top = difficultyPill({ tier: 10, showName: false });
    expect(top.textContent).toBe('10');
    expect(top.querySelectorAll('.rw-diff__bar.is-on')).toHaveLength(5);
  });

  it('star rating clamps and names itself', () => {
    const s = starRating({ stars: 3, suffix: 'at 70% speed' });
    expect(s.getAttribute('aria-label')).toBe('3 of 5 stars at 70% speed');
    expect(s.querySelectorAll('.rw-star.is-earned')).toHaveLength(3);
    expect(starRating({ stars: 8 }).querySelectorAll('.is-earned')).toHaveLength(5);
  });

  it('judgement tag and combo badge expose outcome and multiplier', () => {
    const tag = judgementTag('WrongNote', { detail: 'played G3' });
    expect(tag.dataset.outcome).toBe('wrong');
    expect(tag.textContent).toBe('Wrong noteplayed G3');
    expect(judgementTag('Good', { timing: 'early' }).querySelector('.rw-judge__timing')?.textContent).toBe('early');
    flash(tag);
    expect(tag.classList.contains('is-flashing')).toBe(true);
    const combo = comboBadge(3, 27);
    expect([combo.dataset.mult, combo.getAttribute('aria-label')]).toEqual(['3', 'Combo 27, multiplier ×3']);
  });
});

describe('form controls', () => {
  it('slider: label, formatted readout, fill and callbacks', () => {
    const onInput = vi.fn();
    const onChange = vi.fn();
    const s = slider({ label: 'Speed', min: 40, max: 110, step: 5, value: 70, format: (v) => `${v}%`, onInput, onChange });
    document.body.append(s.el);
    expect(s.el.querySelector('label')?.getAttribute('for')).toBe(s.input.id);
    expect(s.input.getAttribute('aria-valuetext')).toBe('70%');
    expect(s.el.querySelector('output')?.textContent).toBe('70%');
    s.input.value = '110';
    s.input.dispatchEvent(new Event('input'));
    s.input.dispatchEvent(new Event('change'));
    expect(onInput).toHaveBeenCalledWith(110);
    expect(onChange).toHaveBeenCalledWith(110);
    expect(s.input.style.getPropertyValue('--fill')).toBe('100%');
    s.set(10);
    expect(s.value).toBe(40);
  });

  it('toggle is a switch that flips on click and label click', () => {
    const onChange = vi.fn();
    const t = toggle({ label: 'Metronome', checked: false, onChange });
    document.body.append(t.el);
    expect(t.button.getAttribute('role')).toBe('switch');
    expect(t.button.getAttribute('aria-checked')).toBe('false');
    t.button.click();
    expect([t.checked, t.button.getAttribute('aria-checked')]).toEqual([true, 'true']);
    (t.el.querySelector('.rw-field__label') as HTMLElement).click();
    expect(onChange.mock.calls).toEqual([[true], [false]]);
    t.set(true);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('select keeps its value across option changes when possible', () => {
    const onChange = vi.fn();
    const s = select({ label: 'Preset', value: 'drive', onChange, options: [{ value: 'clean', label: 'Clean' }, { value: 'drive', label: 'Drive' }] });
    expect(s.value).toBe('drive');
    s.setOptions([{ value: 'drive', label: 'Drive' }, { value: 'lead', label: 'Lead' }]);
    expect(s.value).toBe('drive');
    s.select.value = 'lead';
    s.select.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith('lead');
  });

  it('meter reports value, text and clipping', () => {
    const m = meter({ label: 'Input level', kind: 'level' });
    const track = m.el.querySelector('[role="meter"]') as HTMLElement;
    m.set(0.5, 0.6);
    expect(track.getAttribute('aria-valuenow')).toBe('0.5');
    expect(track.getAttribute('aria-valuetext')).toBe('50%');
    expect(m.el.classList.contains('is-clipping')).toBe(false);
    m.set(0.95);
    expect(m.el.classList.contains('is-clipping')).toBe(true);
    const p = meter({ label: 'Goal', value: 9, max: 15, format: (v) => `${v} / 15` });
    expect(p.el.querySelector('.rw-meter__value')?.textContent).toBe('9 / 15');
  });
});
