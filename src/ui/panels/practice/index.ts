/**
 * Practice panel (T-032): drives a running {@link GameSession} mid-song.
 * Exports `mount: PanelMount<PanelPropsMap['practice']>` (contract in `@shared/ui`); registered in
 * `src/ui/panels/index.ts` and mounted by the game screen (T-031) with `mountPanel('practice', …)`.
 *
 * - **Speed** 40–100% in 5% steps (110% with the overspeed opt-in once the looped sections are
 *   mastered), −/+ buttons, presets and a slider. No pitch change: the session re-renders the
 *   guide and time-stretches the backing; while playing the change lands on the next bar.
 * - **Speed trainer** (D8): toggle, "now → goal 100%" ladder, clean runs to go, live messages
 *   ("Clean run! +5% → 80%", "Slow down a notch → 75%").
 * - **A/B loop**: section/bar strip (drag, edge drag, click a section), Set A / Set B at the heard
 *   position, ±1-bar nudges, "Loop a section" list; loops snap to sections then bars, with a 1-bar
 *   pre-roll (2 below 60%; docs/timing.md § Count-in, loops and pre-roll).
 * - **Count-in** 0–2 bars, **metronome** on/off and volume (persisted in settings).
 *
 * Keyboard shortcuts and focus rules: see `./shortcuts.ts` (lane keys always win).
 * @module
 */
import type { Unsubscribe } from '@shared/clock';
import type { BarLoop, PracticeMessage } from '@shared/judge';
import type { GameSession } from '@shared/services';
import type { DeepPartial, Settings } from '@shared/settings';
import type { SectionProgress } from '@shared/storage';
import type { AppContext, PanelHandle, PanelMount, PanelPropsMap } from '@shared/ui';
import { toTransportLoop } from '@core/practice';
import { badge, button, h, icon, slider, toggle, uid, type Slider, type Toggle } from '../../components';
import {
  type LoopDraft,
  type MessageTone,
  adjacentSectionLoop,
  barIndexAt,
  clampSpeed,
  cleanRunsToGoal,
  describeLoop,
  formatSpeed,
  isCleanRunMessage,
  loopToBars,
  maxSpeed,
  messageTone,
  nudgeLoop,
  overspeedAllowed,
  prerollText,
  roundSpeed,
  sectionIndexAtBar,
  sectionIndexOfLoop,
  sectionLoop,
  setLoopEnd,
  setLoopStart,
  speedPresets,
  stepSpeed,
  trainerLadder,
  trainerProgress,
  SPEED,
} from './model';
import { PRACTICE_SHORTCUTS, activeShortcuts, bindShortcuts, releasePointerFocus, type ShortcutAction } from './shortcuts';
import { loopStrip, type LoopStrip } from './strip';
import './practice.css';

type Props = PanelPropsMap['practice'];

/** Quiet time before a burst of −/+ presses is sent to the session (each send re-renders the guide). */
export const SPEED_COMMIT_DELAY_MS = 250;
/** How long a practice message stays highlighted. */
export const MESSAGE_HIGHLIGHT_MS = 6000;
/** Count-in choices (bars). */
const COUNT_IN_CHOICES = [0, 1, 2] as const;

/** Mount the practice panel for `props.session`. */
export const mount: PanelMount<Props> = (el, ctx, props): PanelHandle<Props> => {
  let panel = new PracticePanel(el, ctx, props.session);
  return {
    update(next) {
      if (next.session && next.session !== panel.session) {
        panel.destroy();
        panel = new PracticePanel(el, ctx, next.session);
      }
    },
    unmount() {
      panel.destroy();
    },
  };
};

class PracticePanel {
  readonly root: HTMLElement;
  private readonly cleanups: Unsubscribe[] = [];
  private destroyed = false;
  private raf = 0;
  private settings: Settings;
  private progress: SectionProgress[] = [];

  // Speed
  private shownSpeed: number;
  private speedMax: number = SPEED.max;
  private pendingSpeed: number | null = null;
  private speedTimer: ReturnType<typeof setTimeout> | null = null;
  private speedSeq = 0;
  private speedSlider!: Slider;
  private readonly speedField = h('div', { class: 'rw-practice__speed-slider' });
  private readonly speedValue = h('span', { class: 'rw-practice__speed-value rw-num' });
  private readonly speedStatus = h('span', { class: 'rw-practice__speed-status', 'aria-live': 'polite' });
  private readonly presetRow = h('div', { class: 'rw-practice__presets', role: 'group', 'aria-label': 'Speed presets' });
  private readonly overspeedHint = h('p', { class: 'rw-field__hint rw-practice__hint' });

  // Trainer
  private trainerToggle!: Toggle;
  private readonly trainerBox = h('div', { class: 'rw-practice__trainer' });
  private cleanRuns = 0;

  // Loop
  private draft: LoopDraft = { loop: null, pendingA: null };
  private strip: LoopStrip;
  private readonly loopSummary = h('p', { class: 'rw-practice__loop-summary', 'aria-live': 'polite' });
  private readonly sectionList = h('div', { class: 'rw-practice__sections', role: 'group', 'aria-label': 'Loop a section' });
  private readonly loopButtons: Record<'clear' | 'aMinus' | 'aPlus' | 'bMinus' | 'bPlus', HTMLButtonElement>;

  // Count-in / metronome
  private readonly countInGroup = h('div', { class: 'rw-practice__seg', role: 'radiogroup' });
  private metronomeToggle!: Toggle;
  private metronomeVolume!: Slider;

  // Messages
  private readonly message = h('p', { class: 'rw-practice__message', role: 'status', 'aria-live': 'polite' });
  private messageTimer: ReturnType<typeof setTimeout> | null = null;

  // Last synced session values (so the rAF poll only touches the DOM on change)
  private seen = { speed: Number.NaN, loopKey: '', trainer: false as boolean | null };

  constructor(
    host: HTMLElement,
    private readonly ctx: AppContext,
    readonly session: GameSession,
  ) {
    this.settings = ctx.settings.get();
    this.shownSpeed = roundSpeed(session.speed);
    this.strip = loopStrip({ song: session.song, onSelect: (l) => this.applyLoop(l) });
    this.loopButtons = {
      clear: button({ label: 'Clear loop', size: 'sm', variant: 'ghost', icon: 'close', onClick: () => this.clearLoop() }),
      aMinus: button({ label: 'A ◂', size: 'sm', variant: 'ghost', title: 'Move loop start one bar earlier', onClick: () => this.nudge('start', -1) }),
      aPlus: button({ label: 'A ▸', size: 'sm', variant: 'ghost', title: 'Move loop start one bar later', onClick: () => this.nudge('start', 1) }),
      bMinus: button({ label: 'B ◂', size: 'sm', variant: 'ghost', title: 'Move loop end one bar earlier', onClick: () => this.nudge('end', -1) }),
      bPlus: button({ label: 'B ▸', size: 'sm', variant: 'ghost', title: 'Move loop end one bar later', onClick: () => this.nudge('end', 1) }),
    };
    this.loopButtons.aMinus.setAttribute('aria-label', 'Loop start one bar earlier');
    this.loopButtons.aPlus.setAttribute('aria-label', 'Loop start one bar later');
    this.loopButtons.bMinus.setAttribute('aria-label', 'Loop end one bar earlier');
    this.loopButtons.bPlus.setAttribute('aria-label', 'Loop end one bar later');
    this.root = h('section', { class: 'rw-practice', 'aria-label': 'Practice' });
    this.render();
    host.append(this.root);
    this.subscribe();
    this.sync(true);
    this.tick();
    void this.loadProgress();
  }

  // ---- Rendering ------------------------------------------------------------------------------

  private render(): void {
    const shortcutsId = uid('shortcuts');
    const shortcutsList = h('dl', { class: 'rw-practice__shortcuts', id: shortcutsId, hidden: true });
    const helpBtn = button({ label: 'Shortcuts', size: 'sm', variant: 'ghost', icon: 'info' });
    helpBtn.setAttribute('aria-expanded', 'false');
    helpBtn.setAttribute('aria-controls', shortcutsId);
    helpBtn.addEventListener('click', () => {
      const open = shortcutsList.hidden;
      shortcutsList.hidden = !open;
      helpBtn.setAttribute('aria-expanded', String(open));
      if (open) this.renderShortcuts(shortcutsList);
    });

    this.speedSlider = this.buildSpeedSlider();
    this.speedField.append(this.speedSlider.el);
    const speedRow = h(
      'div',
      { class: 'rw-practice__speed-row' },
      button({ label: 'Slower (−5%)', iconOnly: true, size: 'md', onClick: () => this.nudgeSpeed(-1) }),
      h('div', { class: 'rw-practice__speed-readout' }, this.speedValue, this.speedStatus),
      button({ label: 'Faster (+5%)', iconOnly: true, icon: 'plus', size: 'md', onClick: () => this.nudgeSpeed(1) }),
    );
    // The kit has no minus icon: draw the bar with text.
    const slowerBtn = speedRow.firstElementChild as HTMLButtonElement;
    slowerBtn.append(h('span', { class: 'rw-practice__minus', 'aria-hidden': 'true' }, '−'));

    this.trainerToggle = toggle({
      label: 'Speed trainer',
      description: 'Clean run (≥ 90%) → +5% · two runs under 70% → −5% · up to 100%',
      checked: this.session.speedTrainer,
      onChange: (on) => this.setTrainer(on),
    });

    this.countInGroup.setAttribute('aria-label', 'Count-in');
    for (const n of COUNT_IN_CHOICES) {
      const b = h('button', { type: 'button', class: 'rw-practice__seg-btn', role: 'radio', dataset: { bars: String(n) } }, n === 0 ? 'Off' : `${n} bar${n > 1 ? 's' : ''}`);
      b.addEventListener('click', () => this.setCountIn(n));
      this.countInGroup.append(b);
    }
    this.countInGroup.addEventListener('keydown', (ev) => this.onRadioKey(ev));
    this.metronomeToggle = toggle({
      label: 'Metronome',
      description: 'Accented downbeats. Count-in and pre-roll always click.',
      checked: this.settings.practice.metronome,
      onChange: (on) => this.setMetronome(on),
    });
    this.metronomeVolume = slider({
      label: 'Metronome volume',
      min: 0,
      max: 100,
      step: 5,
      value: Math.round(this.settings.mixer.metronome * 100),
      format: (v) => `${v}%`,
      onInput: (v) => this.ctx.services.peek('engine')?.setLevel('metronome', v / 100),
      onChange: (v) => this.persist({ mixer: { metronome: v / 100 } }),
    });

    const setA = button({ label: 'Set A', size: 'sm', title: 'Loop start at the current position (A)', onClick: () => this.setA() });
    const setB = button({ label: 'Set B', size: 'sm', title: 'Loop end at the current position (B)', onClick: () => this.setB() });

    this.root.append(
      h(
        'header',
        { class: 'rw-practice__header' },
        h('h2', { class: 'rw-practice__title' }, 'Practice'),
        helpBtn,
      ),
      shortcutsList,
      this.message,
      group(
        'Speed',
        speedRow,
        this.speedField,
        this.presetRow,
        h('p', { class: 'rw-field__hint rw-practice__hint' }, 'Pitch stays the same. While playing, a change lands on the next bar.'),
        this.overspeedHint,
      ),
      group('Speed trainer', this.trainerToggle.el, this.trainerBox),
      group(
        'Loop',
        this.loopSummary,
        this.strip.el,
        h('p', { class: 'rw-field__hint rw-practice__hint' }, 'Drag on the strip to loop bars, drag A or B to adjust, or click a section.'),
        h(
          'div',
          { class: 'rw-practice__loop-actions' },
          setA,
          setB,
          this.loopButtons.clear,
          h('span', { class: 'rw-practice__nudges', role: 'group', 'aria-label': 'Fine-tune by one bar' }, this.loopButtons.aMinus, this.loopButtons.aPlus, this.loopButtons.bMinus, this.loopButtons.bPlus),
        ),
        this.sectionList,
      ),
      group(
        'Count-in & metronome',
        h('div', { class: 'rw-field' }, h('span', { class: 'rw-field__label' }, 'Count-in'), this.countInGroup),
        this.metronomeToggle.el,
        this.metronomeVolume.el,
      ),
    );
    this.renderSections();
    this.renderPresets();
    this.renderCountIn();
  }

  private buildSpeedSlider(): Slider {
    return slider({
      label: 'Speed',
      min: Math.round(SPEED.min * 100),
      max: Math.round(this.speedMax * 100),
      step: Math.round(SPEED.step * 100),
      value: Math.round(Math.min(this.shownSpeed, this.speedMax) * 100),
      format: (v) => `${v}%`,
      onInput: (v) => this.showSpeed(v / 100),
      onChange: (v) => this.requestSpeed(v / 100, 0),
    });
  }

  private renderShortcuts(list: HTMLElement): void {
    const lanes = this.settings.keyboard.lanes;
    const defs = activeShortcuts(PRACTICE_SHORTCUTS, lanes);
    list.replaceChildren(
      ...defs.flatMap((d) => [h('dt', null, h('kbd', null, d.keyLabel)), h('dd', null, d.description)]),
      h('dt', null, h('kbd', null, '1–6')),
      h('dd', null, 'Always go to the game (strings)'),
    );
  }

  private renderPresets(): void {
    this.presetRow.replaceChildren(
      ...speedPresets(this.speedMax).map((s) => {
        const b = h('button', { type: 'button', class: 'rw-practice__chip', 'aria-pressed': 'false', dataset: { speed: String(s) } }, formatSpeed(s));
        b.addEventListener('click', () => this.requestSpeed(s, 0));
        return b;
      }),
    );
    this.syncPresetPressed();
  }

  private syncPresetPressed(): void {
    for (const b of this.presetRow.querySelectorAll<HTMLButtonElement>('button')) {
      b.setAttribute('aria-pressed', String(Math.abs(Number(b.dataset.speed) - this.shownSpeed) < 1e-9));
    }
  }

  private renderSections(): void {
    const { song } = this.session;
    const doneIdx = new Set(this.progress.filter((p) => p.masteredAt !== undefined).map((p) => p.sectionIdx));
    const active = sectionIndexOfLoop(song.sections, this.draft.loop);
    this.sectionList.replaceChildren(
      ...song.sections.map((s, i) => {
        const b = h(
          'button',
          {
            type: 'button',
            class: 'rw-practice__section',
            'aria-pressed': String(i === active),
            title: `Loop ${s.name} (bars ${s.startBar + 1}–${s.endBar})`,
            dataset: { section: String(i) },
          },
          icon('loop'),
          h('span', { class: 'rw-practice__section-name' }, s.name),
          h('span', { class: 'rw-practice__section-bars rw-num' }, `${s.startBar + 1}–${s.endBar}`),
          doneIdx.has(i) ? h('span', { class: 'rw-practice__mastered', title: 'Mastered' }, icon('check', { label: 'Mastered' })) : null,
        );
        b.addEventListener('click', () => this.loopSection(i));
        return b;
      }),
    );
  }

  private renderCountIn(): void {
    const bars = this.settings.practice.countInBars;
    for (const b of this.countInGroup.querySelectorAll<HTMLButtonElement>('button')) {
      const on = Number(b.dataset.bars) === bars;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }

  private renderTrainer(): void {
    const on = this.session.speedTrainer;
    this.trainerToggle.set(on);
    this.trainerBox.hidden = !on;
    if (!on) return;
    const speed = this.shownSpeed;
    const toGo = cleanRunsToGoal(speed);
    const ladder = trainerLadder(speed);
    this.trainerBox.replaceChildren(
      h(
        'div',
        { class: 'rw-practice__trainer-top' },
        h('span', { class: 'rw-practice__trainer-now' }, h('span', { class: 'rw-practice__k' }, 'Now'), h('strong', { class: 'rw-num' }, formatSpeed(speed))),
        h('span', { class: 'rw-practice__trainer-arrow', 'aria-hidden': 'true' }, '→'),
        h('span', { class: 'rw-practice__trainer-goal' }, h('span', { class: 'rw-practice__k' }, 'Goal'), h('strong', { class: 'rw-num' }, formatSpeed(1))),
        badge(toGo === 0 ? 'At full speed' : `${toGo} clean run${toGo === 1 ? '' : 's'} to go`, { tone: toGo === 0 ? 'success' : 'accent' }),
      ),
      h(
        'ol',
        {
          class: 'rw-practice__ladder',
          role: 'meter',
          'aria-label': 'Speed trainer progress',
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'aria-valuenow': String(Math.round(trainerProgress(speed) * 100)),
          'aria-valuetext': `${formatSpeed(speed)} of 100%`,
        },
        ladder.map((r) => h('li', { class: `rw-practice__rung rw-practice__rung--${r.state}`, title: formatSpeed(r.speed) }, h('span', { class: 'rw-num' }, String(Math.round(r.speed * 100))))),
      ),
      h('p', { class: 'rw-field__hint rw-practice__hint' }, this.cleanRuns > 0 ? `Clean runs this session: ${this.cleanRuns}` : 'Play the loop through; each run counts.'),
    );
  }

  private renderLoop(): void {
    const { song } = this.session;
    const loop = this.draft.loop;
    const speed = this.shownSpeed;
    const preroll = loop ? toTransportLoop(song, loop, speed).preroll : 0;
    this.strip.setLoop(loop, preroll);
    this.strip.setPendingA(this.draft.pendingA);
    if (loop) {
      const idx = sectionIndexOfLoop(song.sections, loop);
      const { label, bars } = describeLoop(loop);
      const name = idx >= 0 ? (song.sections[idx]?.name ?? '') : null;
      const parts = [name ? label : null, `${bars} bar${bars === 1 ? '' : 's'}`, prerollText(speed)].filter((p): p is string => p !== null);
      this.loopSummary.replaceChildren(
        icon('loop'),
        h('strong', null, name ? `Looping ${name}` : `Looping ${label}`),
        ...parts.flatMap((p) => [h('span', { class: 'rw-practice__muted' }, ' · '), h('span', { class: 'rw-practice__muted rw-practice__nowrap' }, p)]),
      );
    } else if (this.draft.pendingA !== null) {
      this.loopSummary.replaceChildren(h('strong', null, `A at bar ${this.draft.pendingA + 1}`), h('span', { class: 'rw-practice__muted' }, ' · press B (or Set B) to close the loop'));
    } else {
      this.loopSummary.replaceChildren(h('span', { class: 'rw-practice__muted' }, 'No loop · playing straight through'));
    }
    const has = loop !== null;
    for (const b of Object.values(this.loopButtons)) b.disabled = !has;
    if (loop) {
      const n = song.timing.bars.length;
      this.loopButtons.aMinus.disabled = loop.startBar <= 0;
      this.loopButtons.aPlus.disabled = loop.endBar - loop.startBar <= 1;
      this.loopButtons.bMinus.disabled = loop.endBar - loop.startBar <= 1;
      this.loopButtons.bPlus.disabled = loop.endBar >= n;
      this.loopButtons.clear.disabled = false;
    }
    const active = sectionIndexOfLoop(song.sections, loop);
    for (const b of this.sectionList.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.section) === active));
  }

  private renderSpeed(): void {
    this.speedValue.textContent = formatSpeed(this.shownSpeed);
    this.speedSlider.set(Math.round(this.shownSpeed * 100));
    if (this.pendingSpeed !== null) {
      this.speedStatus.textContent = this.session.state === 'playing' ? `→ ${formatSpeed(this.pendingSpeed)} at the next bar` : `Preparing ${formatSpeed(this.pendingSpeed)}…`;
      this.root.classList.add('rw-practice--speed-pending');
    } else {
      this.speedStatus.textContent = '';
      this.root.classList.remove('rw-practice--speed-pending');
    }
    this.syncPresetPressed();
    // The pre-roll depends on the speed (2 bars below 60%).
    this.renderLoop();
    const optIn = this.settings.practice.overspeed;
    this.overspeedHint.textContent =
      this.speedMax > SPEED.max
        ? 'Overspeed unlocked: up to 110%.'
        : optIn
          ? '110% unlocks once the looped sections are mastered.'
          : '';
    this.overspeedHint.hidden = this.overspeedHint.textContent === '';
  }

  // ---- Session sync ---------------------------------------------------------------------------

  private subscribe(): void {
    const s = this.session;
    this.cleanups.push(
      s.onMessage((m) => this.onMessage(m)),
      s.onStateChange(() => this.sync()),
      s.clock.onChange(() => this.sync()),
      this.ctx.settings.subscribe((next) => this.onSettings(next)),
      bindShortcuts(PRACTICE_SHORTCUTS, this.shortcutHandlers(), { laneCodes: () => this.settings.keyboard.lanes }),
      releasePointerFocus(this.root),
    );
  }

  /** Pull speed / loop / trainer from the session (it may change them itself: trainer, "Loop this"). */
  private sync(force = false): void {
    if (this.destroyed) return;
    const s = this.session;
    const speed = roundSpeed(s.speed);
    if (force || (this.pendingSpeed === null && speed !== this.seen.speed)) {
      this.seen.speed = speed;
      if (this.pendingSpeed === null) this.shownSpeed = speed;
      this.renderSpeed();
      this.renderTrainer();
    }
    const loop = loopToBars(s.song, s.loop);
    const key = loop ? `${loop.startBar}:${loop.endBar}` : '';
    if (force || key !== this.seen.loopKey) {
      this.seen.loopKey = key;
      this.draft = { loop, pendingA: loop ? null : this.draft.pendingA };
      this.renderLoop();
      this.refreshOverspeed();
    }
    if (force || s.speedTrainer !== this.seen.trainer) {
      this.seen.trainer = s.speedTrainer;
      this.renderTrainer();
    }
  }

  private tick = (): void => {
    if (this.destroyed) return;
    this.sync();
    let t = Number.NaN;
    try {
      t = this.session.clock.heardSongTime();
    } catch {
      // Clock not ready (engine suspended); keep the playhead where it is.
    }
    if (Number.isFinite(t)) this.strip.setPlayhead(t);
    this.raf = requestAnimationFrame(this.tick);
  };

  private onSettings(next: Settings): void {
    const prev = this.settings;
    this.settings = next;
    if (next.practice.countInBars !== prev.practice.countInBars) this.renderCountIn();
    if (next.practice.metronome !== prev.practice.metronome) this.metronomeToggle.set(next.practice.metronome);
    if (next.mixer.metronome !== prev.mixer.metronome && document.activeElement !== this.metronomeVolume.input) {
      this.metronomeVolume.set(Math.round(next.mixer.metronome * 100));
    }
    if (next.practice.overspeed !== prev.practice.overspeed) this.refreshOverspeed();
  }

  private onMessage(m: PracticeMessage): void {
    const tone: MessageTone = messageTone(m);
    if (isCleanRunMessage(m)) this.cleanRuns += 1;
    this.message.textContent = m.text;
    this.message.dataset.tone = tone;
    this.message.classList.remove('rw-practice__message--fresh');
    // Restart the highlight animation.
    void this.message.offsetWidth;
    this.message.classList.add('rw-practice__message--fresh');
    if (this.messageTimer) clearTimeout(this.messageTimer);
    this.messageTimer = setTimeout(() => this.message.classList.remove('rw-practice__message--fresh'), MESSAGE_HIGHLIGHT_MS);
    if (m.kind === 'trainer') this.renderTrainer();
    this.sync();
  }

  // ---- Speed ----------------------------------------------------------------------------------

  private showSpeed(s: number): void {
    this.shownSpeed = clampSpeed(s, this.speedMax);
    this.speedValue.textContent = formatSpeed(this.shownSpeed);
    this.syncPresetPressed();
  }

  private nudgeSpeed(dir: 1 | -1): void {
    this.requestSpeed(stepSpeed(this.pendingSpeed ?? this.shownSpeed, dir, this.speedMax), SPEED_COMMIT_DELAY_MS);
  }

  /** Show `s` now and send it to the session after `delayMs` of quiet (0 = now). */
  private requestSpeed(s: number, delayMs: number): void {
    const target = clampSpeed(s, this.speedMax);
    this.shownSpeed = target;
    this.pendingSpeed = target;
    this.renderSpeed();
    this.renderTrainer();
    if (this.speedTimer) clearTimeout(this.speedTimer);
    const send = (): void => {
      this.speedTimer = null;
      const seq = ++this.speedSeq;
      this.session.setSpeed(target).then(
        () => {
          if (this.destroyed || seq !== this.speedSeq) return;
          this.pendingSpeed = null;
          this.seen.speed = Number.NaN; // re-read the session's speed
          this.sync();
        },
        (err: unknown) => {
          if (this.destroyed || seq !== this.speedSeq) return;
          this.pendingSpeed = null;
          this.shownSpeed = roundSpeed(this.session.speed);
          this.renderSpeed();
          this.renderTrainer();
          this.ctx.ui.toast(`Couldn't change speed: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
        },
      );
    };
    if (delayMs > 0) this.speedTimer = setTimeout(send, delayMs);
    else send();
  }

  private async loadProgress(): Promise<void> {
    const { song } = this.session;
    try {
      this.progress = await this.ctx.storage.getSectionProgress(song.id, song.arrangement);
    } catch {
      this.progress = [];
    }
    if (this.destroyed) return;
    this.renderSections();
    this.refreshOverspeed();
  }

  private refreshOverspeed(): void {
    const allowed = overspeedAllowed(this.settings.practice.overspeed, this.session.song, this.progress, this.draft.loop);
    const max = maxSpeed(allowed);
    if (max === this.speedMax) {
      this.renderSpeed();
      return;
    }
    this.speedMax = max;
    const next = this.buildSpeedSlider();
    this.speedSlider.el.replaceWith(next.el);
    this.speedSlider = next;
    this.renderPresets();
    this.renderSpeed();
  }

  // ---- Trainer, count-in, metronome -----------------------------------------------------------

  private setTrainer(on: boolean): void {
    this.session.setSpeedTrainer(on);
    this.seen.trainer = null;
    this.sync();
    this.persist({ practice: { speedTrainer: on } });
  }

  private setCountIn(bars: number): void {
    this.session.setCountInBars(bars);
    this.settings = { ...this.settings, practice: { ...this.settings.practice, countInBars: bars } };
    this.renderCountIn();
    this.persist({ practice: { countInBars: bars } });
  }

  private setMetronome(on: boolean): void {
    this.session.setMetronome(on);
    this.metronomeToggle.set(on);
    this.persist({ practice: { metronome: on } });
  }

  private onRadioKey(ev: KeyboardEvent): void {
    const dir = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    ev.preventDefault();
    const i = COUNT_IN_CHOICES.indexOf(this.settings.practice.countInBars as 0 | 1 | 2);
    const next = COUNT_IN_CHOICES[(Math.max(0, i) + dir + COUNT_IN_CHOICES.length) % COUNT_IN_CHOICES.length] as number;
    this.setCountIn(next);
    this.countInGroup.querySelector<HTMLButtonElement>(`[data-bars="${next}"]`)?.focus();
  }

  private persist(patch: DeepPartial<Settings>): void {
    this.ctx.settings.update(patch).catch((err: unknown) => {
      this.ctx.ui.toast(`Couldn't save the setting: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
    });
  }

  // ---- Loops ----------------------------------------------------------------------------------

  private heardTime(): number {
    try {
      const t = this.session.clock.heardSongTime();
      return Number.isFinite(t) ? Math.max(0, t) : 0;
    } catch {
      return 0;
    }
  }

  private applyLoop(loop: BarLoop | null): void {
    if (loop) this.session.setLoopBars(loop.startBar, loop.endBar);
    else this.session.clearLoop();
    this.draft = { loop, pendingA: null };
    this.seen.loopKey = '\u0000'; // force a re-read from the session
    this.sync();
  }

  private clearLoop(): void {
    this.draft = { loop: this.draft.loop, pendingA: null };
    this.applyLoop(null);
  }

  private loopSection(idx: number): void {
    const loop = sectionLoop(this.session.song, idx, barIndexAt(this.session.song.timing.bars, this.heardTime()));
    if (loop) this.applyLoop(loop);
  }

  private setA(): void {
    const next = setLoopStart(this.session.song, this.draft, this.heardTime());
    if (next.loop && next.loop !== this.draft.loop) this.applyLoop(next.loop);
    else {
      this.draft = next;
      this.renderLoop();
    }
  }

  private setB(): void {
    const next = setLoopEnd(this.session.song, this.draft, this.heardTime());
    if (next.loop) this.applyLoop(next.loop);
  }

  private nudge(edge: 'start' | 'end', delta: number): void {
    if (this.draft.loop) this.applyLoop(nudgeLoop(this.session.song, this.draft.loop, edge, delta));
  }

  private toggleLoop(): void {
    if (this.draft.loop) {
      this.clearLoop();
      return;
    }
    const { song } = this.session;
    const bar = barIndexAt(song.timing.bars, this.heardTime());
    this.applyLoop(sectionLoop(song, sectionIndexAtBar(song.sections, bar), bar));
  }

  private adjacentSection(dir: 1 | -1): void {
    const loop = adjacentSectionLoop(this.session.song, this.draft.loop, this.heardTime(), dir);
    if (loop) this.applyLoop(loop);
  }

  private shortcutHandlers(): Partial<Record<ShortcutAction, () => void>> {
    return {
      slower: () => this.nudgeSpeed(-1),
      faster: () => this.nudgeSpeed(1),
      setA: () => this.setA(),
      setB: () => this.setB(),
      toggleLoop: () => this.toggleLoop(),
      prevSection: () => this.adjacentSection(-1),
      nextSection: () => this.adjacentSection(1),
      toggleTrainer: () => this.setTrainer(!this.session.speedTrainer),
      toggleMetronome: () => this.setMetronome(!this.settings.practice.metronome),
      cycleCountIn: () => this.setCountIn((this.settings.practice.countInBars + 1) % COUNT_IN_CHOICES.length),
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    if (this.speedTimer) clearTimeout(this.speedTimer);
    if (this.messageTimer) clearTimeout(this.messageTimer);
    for (const c of this.cleanups.splice(0)) c();
    this.strip.destroy();
    this.root.remove();
  }
}

/** A titled group inside the panel. */
function group(title: string, ...children: Node[]): HTMLElement {
  const id = uid('practice-h');
  return h('section', { class: 'rw-practice__group', 'aria-labelledby': id }, h('h3', { class: 'rw-practice__h', id }, title), ...children);
}
