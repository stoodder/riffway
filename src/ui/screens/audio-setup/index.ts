/**
 * Audio setup screen (T-035): a guided flow over the reusable panels — guitar input + level and
 * output device (T-022 `input`), tuner (T-022 `tuner`), monitoring + amp preset with the headphone
 * recommendation (T-023 `monitor`), latency calibration (T-033 `calibration`) — and a summary.
 * Only the current step's panel is mounted (the tuner switches the analysis worklet into tuner mode
 * while it is open). The step is the `step` route param (`#/audio-setup?step=tuner`; the calibration
 * step also takes `mode=guitar|keyboard|visual`); statuses come from settings and update live. Exports `mount: ScreenMount` (contract in `@shared/ui`).
 * @module
 */
import type { Settings } from '@shared/settings';
import type { AppContext, PanelHandle, PanelPropsMap, RouteParams, ScreenHandle, ScreenMount } from '@shared/ui';
import { button, emptyState, h, icon, type IconName } from '../../components';
import { mountPanel } from '../../panels';
import { STEPS, neighbour, stepFromParam, stepStatuses, summaryRows, type StepDef, type StepId, type StepTone } from './steps';
import './audio-setup.css';

/** Calibration panel modes; the `mode` route param picks the panel's first tab (`#/audio-setup?step=calibration&mode=keyboard`). */
export const CALIBRATION_MODES: readonly CalibrationMode[] = ['guitar', 'keyboard', 'visual'];
type CalibrationMode = NonNullable<PanelPropsMap['calibration']['mode']>;

const TONE_ICON: Record<StepTone, IconName | null> = { done: 'check', todo: null, optional: null, warning: 'warning' };
const NUMBERED = STEPS.filter((s) => s.panel !== null).length;

/** What the screen needs from the context (panels also use `services`). */
const REQUIRED = ['settings', 'services', 'router', 'ui'] as const;

/**
 * The page shown when the app context lacks what audio setup needs (a shell that failed to start):
 * the title and an explanation instead of a thrown mount.
 */
function unavailableView(el: HTMLElement, missing: readonly string[]): ScreenHandle {
  const root = h(
    'div',
    { class: 'as', dataset: { state: 'unavailable' } },
    h('header', { class: 'as-head' }, h('h1', null, 'Audio setup')),
    emptyState({
      title: 'Audio setup unavailable',
      message: `The app didn't finish starting (missing: ${missing.join(', ')}). Reload the page to try again.`,
      icon: 'warning',
    }),
  );
  el.append(root);
  return { unmount: () => root.remove() };
}

export const mount: ScreenMount = (el: HTMLElement, ctx: AppContext, params: RouteParams) => {
  // The context type promises these, but a broken or partial shell must not crash the screen.
  const missing = REQUIRED.filter((key) => !(ctx as Partial<AppContext>)[key]);
  if (missing.length) return unavailableView(el, missing);
  let current: StepId = stepFromParam(params.step);
  let calMode: CalibrationMode = calibrationMode(params.mode);
  let panel: PanelHandle<unknown> | null = null;
  /** The mounted calibration panel (it switches tabs on `update({mode})`). */
  let calibration: PanelHandle<PanelPropsMap['calibration']> | null = null;
  let seq = 0;
  let destroyed = false;

  // ---- Step rail --------------------------------------------------------------------------------
  const railItems = STEPS.map((def, i) => {
    const num = h('span', { class: 'as-rail__num rw-num', 'aria-hidden': 'true' });
    const status = h('span', { class: 'as-rail__status' });
    const btn = h(
      'button',
      { type: 'button', class: 'as-rail__step', dataset: { step: def.id }, on: { click: () => go(def.id, true) } },
      num,
      h('span', { class: 'as-rail__text' }, h('span', { class: 'as-rail__label' }, def.label), status),
    );
    return { def, index: i, num, status, btn, li: h('li', { class: 'as-rail__item' }, btn) };
  });
  const rail = h('nav', { class: 'as-rail', 'aria-label': 'Setup steps' }, h('ol', { class: 'as-rail__list' }, railItems.map((r) => r.li)));

  // ---- Current step -------------------------------------------------------------------------------
  const eyebrow = h('p', { class: 'rw-eyebrow' });
  const title = h('h2', { class: 'as-step__title', tabindex: '-1' });
  const lead = h('p', { class: 'as-step__lead' });
  const extra = h('div', { class: 'as-step__extra' });
  const body = h('div', { class: 'as-step__body', 'aria-live': 'polite', 'aria-busy': 'false' });
  const back = button({ label: 'Back', variant: 'ghost', icon: 'chevronRight', onClick: () => step(-1) });
  back.querySelector('svg')?.classList.add('as-flip');
  const next = button({ label: 'Next', variant: 'primary', trailingIcon: 'chevronRight', onClick: () => step(1) });
  const stepEl = h(
    'section',
    { class: 'as-step', 'aria-labelledby': 'as-step-title' },
    h('header', { class: 'as-step__head' }, eyebrow, title, lead),
    extra,
    body,
    h('footer', { class: 'as-step__foot' }, back, next),
  );
  title.id = 'as-step-title';

  const root = h(
    'div',
    { class: 'as' },
    h(
      'header',
      { class: 'as-head' },
      h('h1', null, 'Audio setup'),
      h('p', { class: 'rw-muted' }, 'A few minutes, once: connect the guitar, tune, hear yourself and measure latency. Every choice is saved.'),
    ),
    h('div', { class: 'as-layout' }, rail, stepEl),
  );
  el.append(root);

  const unsubSettings = ctx.settings.subscribe((s) => {
    renderRail(s);
    if (current === 'done') renderSummary(s);
  });

  function renderRail(s: Settings): void {
    const statuses = stepStatuses(s);
    for (const r of railItems) {
      const st = statuses[r.def.id];
      const active = r.def.id === current;
      r.btn.toggleAttribute('aria-current', false);
      if (active) r.btn.setAttribute('aria-current', 'step');
      r.btn.dataset.tone = st.tone;
      const glyph = TONE_ICON[st.tone];
      r.num.replaceChildren(glyph && !active ? icon(glyph, { size: '14px' }) : r.def.panel ? String(r.index + 1) : icon('star', { size: '14px' }));
      r.status.textContent = st.text;
    }
  }

  function renderHead(def: StepDef): void {
    const idx = STEPS.indexOf(def);
    eyebrow.textContent = def.panel ? `Step ${idx + 1} of ${NUMBERED}` : 'Summary';
    title.textContent = def.title;
    lead.textContent = def.lead;
    const prev = neighbour(def.id, -1);
    const following = neighbour(def.id, 1);
    back.hidden = prev === null;
    const nextDef = following ? STEPS.find((s) => s.id === following) : null;
    next.hidden = nextDef === null;
    if (nextDef) (next.querySelector('.rw-btn__label') as HTMLElement).textContent = nextDef.panel ? `Next: ${nextDef.label}` : 'Finish';
    extra.replaceChildren(...(def.id === 'monitor' ? [headphoneTip()] : []));
  }

  function headphoneTip(): HTMLElement {
    return h(
      'p',
      { class: 'as-tip' },
      icon('headphones', { size: '18px' }),
      h('span', null, h('strong', null, 'Headphones recommended. '), 'Wired headphones keep the delay lowest and stop the guitar feeding back through laptop speakers.'),
    );
  }

  function renderSummary(s: Settings): void {
    const rows = summaryRows(s);
    body.replaceChildren(
      h(
        'dl',
        { class: 'as-summary' },
        rows.map((r) =>
          h(
            'div',
            { class: 'as-summary__row', dataset: { tone: r.tone } },
            h('dt', null, r.label),
            h('dd', null, h('span', { class: 'as-summary__value' }, r.value), button({ label: 'Change', size: 'sm', variant: 'ghost', onClick: () => go(r.step, true) })),
          ),
        ),
      ),
      h(
        'div',
        { class: 'as-summary__actions' },
        h('a', { class: 'rw-btn rw-btn--primary rw-btn--md', href: ctx.router.href('library') }, h('span', { class: 'rw-btn__label' }, 'Find a song to play')),
        h('a', { class: 'rw-btn rw-btn--ghost rw-btn--md', href: ctx.router.href('settings', { tab: 'input' }) }, h('span', { class: 'rw-btn__label' }, 'Keyboard keys and more settings')),
      ),
    );
  }

  async function showPanel(def: StepDef): Promise<void> {
    const my = ++seq;
    panel?.unmount();
    panel = null;
    calibration = null;
    if (!def.panel) {
      body.setAttribute('aria-busy', 'false');
      renderSummary(ctx.settings.get());
      return;
    }
    const slot = h('div', { class: 'as-step__panel', dataset: { panel: def.panel } });
    const loading = h('p', { class: 'as-step__loading rw-muted' }, 'Loading…');
    body.replaceChildren(loading, slot);
    body.setAttribute('aria-busy', 'true');
    try {
      const handle = await mountStepPanel(def.panel, slot);
      if (my !== seq || destroyed) {
        if (calibration === handle) calibration = null;
        handle.unmount();
        return;
      }
      panel = handle;
      loading.remove();
    } catch (err) {
      if (my !== seq || destroyed) return;
      body.replaceChildren(
        h(
          'div',
          { class: 'as-step__error', role: 'alert' },
          icon('error'),
          h('span', null, `This step couldn’t load: ${err instanceof Error ? err.message : String(err)}`),
          button({ label: 'Try again', size: 'sm', onClick: () => void showPanel(def) }),
        ),
      );
    } finally {
      if (my === seq) body.setAttribute('aria-busy', 'false');
    }
  }

  function mountStepPanel(id: NonNullable<StepDef['panel']>, slot: HTMLElement): Promise<PanelHandle<unknown>> {
    switch (id) {
      case 'input':
        return mountPanel('input', slot, ctx, {});
      case 'tuner':
        return mountPanel('tuner', slot, ctx, {});
      case 'monitor':
        return mountPanel('monitor', slot, ctx, {});
      case 'calibration':
        return mountPanel('calibration', slot, ctx, { mode: calMode }).then((handle) => {
          calibration = handle;
          return handle;
        });
      default:
        throw new Error(`The ${id} panel is not part of audio setup`);
    }
  }

  function show(id: StepId, focus: boolean): void {
    current = id;
    const def = STEPS.find((s) => s.id === id) as StepDef;
    renderHead(def);
    renderRail(ctx.settings.get());
    void showPanel(def);
    if (focus) title.focus({ preventScroll: false });
  }

  function go(id: StepId, focus: boolean): void {
    if (id === current) {
      if (focus) title.focus();
      return;
    }
    show(id, focus);
    ctx.router.navigate(`/audio-setup?step=${id}`, { replace: true });
  }

  function step(dir: -1 | 1): void {
    const target = neighbour(current, dir);
    if (target) go(target, true);
  }

  show(current, false);

  return {
    update(nextParams) {
      const id = stepFromParam(nextParams.step);
      const mode = calibrationMode(nextParams.mode);
      if (id === current) {
        if (id === 'calibration' && nextParams.mode !== undefined && mode !== calMode) {
          calMode = mode;
          calibration?.update?.({ mode });
        }
        return;
      }
      calMode = mode;
      show(id, false);
    },
    unmount() {
      destroyed = true;
      seq++;
      unsubSettings();
      panel?.unmount();
      panel = null;
      root.remove();
    },
  };
};

function calibrationMode(param: string | undefined): CalibrationMode {
  return CALIBRATION_MODES.includes(param as CalibrationMode) ? (param as CalibrationMode) : 'guitar';
}
