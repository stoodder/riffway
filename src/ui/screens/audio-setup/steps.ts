/**
 * Audio setup steps and their status, derived from settings only (pure, Node-testable). The order is
 * the guided flow: input + level → tuner → monitoring + amp → latency calibration → summary.
 * @module
 */
import { AMP_PRESETS } from '@core/dsp/amp';
import type { PanelId } from '@shared/ui';
import type { Settings } from '@shared/settings';

/** Step ids (the `step` route param). */
export const STEP_IDS = ['input', 'tuner', 'monitor', 'calibration', 'done'] as const;
export type StepId = (typeof STEP_IDS)[number];

/** One step of the flow. */
export interface StepDef {
  id: StepId;
  /** Short label for the step list. */
  label: string;
  title: string;
  /** What to do, shown above the panel. */
  lead: string;
  /** Panel mounted for this step (none for the summary). */
  panel: PanelId | null;
}

/** The steps, in order. */
export const STEPS: readonly StepDef[] = [
  {
    id: 'input',
    label: 'Input & level',
    title: 'Connect your guitar',
    lead: 'Pick the USB guitar input, then strum hard: peaks around −12 dB are ideal. Choose the output (headphones) here too.',
    panel: 'input',
  },
  {
    id: 'tuner',
    label: 'Tune',
    title: 'Tune up',
    lead: 'Play one open string at a time and tune until the needle settles in the green.',
    panel: 'tuner',
  },
  {
    id: 'monitor',
    label: 'Monitoring',
    title: 'Hear your guitar',
    lead: 'With no amp in the chain, Riffway can play your guitar through an amp sim. Pick a sound and check the delay.',
    panel: 'monitor',
  },
  {
    id: 'calibration',
    label: 'Latency',
    title: 'Calibrate latency',
    lead: 'Play along to a few clicks so Riffway can measure the delay between your pick and its ears. It makes timing judgements fair.',
    panel: 'calibration',
  },
  {
    id: 'done',
    label: 'Summary',
    title: 'You’re set up',
    lead: 'Here’s what Riffway will use. You can come back to any step at any time.',
    panel: null,
  },
];

/** Status tone of a step in the list. */
export type StepTone = 'done' | 'todo' | 'optional' | 'warning';

/** Status of one step: a short line under its label. */
export interface StepStatus {
  tone: StepTone;
  text: string;
}

/** The step named by route params (default `input`). */
export function stepFromParam(param: string | undefined): StepId {
  return (STEP_IDS as readonly string[]).includes(param ?? '') ? (param as StepId) : 'input';
}

/** The step before / after `id`, or null at the ends. */
export function neighbour(id: StepId, dir: -1 | 1): StepId | null {
  const i = STEP_IDS.indexOf(id) + dir;
  return i >= 0 && i < STEP_IDS.length ? (STEP_IDS[i] as StepId) : null;
}

/** What the screen knows beyond settings (nothing about tuning is persisted). */
export interface SetupSession {
  /** The tuner step was opened in this browser session. */
  tunerVisited: boolean;
}

/** Which offsets have been measured, from the calibration settings. */
export function calibrationState(s: Pick<Settings, 'calibration'>): { guitar: boolean; keyboard: boolean; estimated: boolean } {
  const cal = s.calibration;
  const profile = cal.deviceKey ? cal.profiles[cal.deviceKey] : undefined;
  return {
    guitar: cal.method === 'play-to-click' || cal.method === 'loopback',
    keyboard: cal.method === 'tap-to-click' || (profile?.keyboardMeasuredAt ?? null) !== null || Math.round(cal.keyboardOffsetMs) !== 0,
    estimated: cal.method === 'estimated',
  };
}

/** True when games use the keyboard only (`game.inputMode: 'keyboard'`): the guitar steps are optional. */
function keyboardOnly(s: Settings): boolean {
  return s.game.inputMode === 'keyboard';
}

/**
 * Status lines for every step, from settings (and the session). The tuner has nothing persisted:
 * it is "done" once opened this session. Monitoring counts as set up only after the player has been
 * through its step (`headphonesCardSeen`), whatever the default switch says. Calibration is done when
 * the input that games use is calibrated: the guitar, or the keyboard in keyboard-only mode; a
 * keyboard-only calibration leaves the guitar step amber ("Guitar not calibrated").
 */
export function stepStatuses(s: Settings, session: SetupSession = { tunerVisited: false }): Record<StepId, StepStatus> {
  const input: StepStatus = s.input.label
    ? { tone: 'done', text: s.input.label }
    : keyboardOnly(s)
      ? { tone: 'optional', text: 'Keyboard mode: optional' }
      : { tone: 'todo', text: 'Not connected yet' };
  const monitor: StepStatus = !s.monitor.headphonesCardSeen
    ? { tone: 'todo', text: 'Not set up yet' }
    : s.monitor.enabled
      ? { tone: 'done', text: `On · ${AMP_PRESETS[s.monitor.preset].label}` }
      : { tone: 'optional', text: 'Off' };
  const cal = s.calibration;
  const measured = calibrationState(s);
  const calibration: StepStatus = keyboardOnly(s)
    ? measured.keyboard
      ? { tone: 'done', text: `Keyboard ${formatOffset(cal.keyboardOffsetMs)} offset` }
      : { tone: 'todo', text: 'Keyboard not calibrated' }
    : measured.guitar
      ? { tone: 'done', text: `${formatOffset(cal.inputOffsetMs)} offset` }
      : measured.estimated
        ? { tone: 'warning', text: 'Estimated only' }
        : measured.keyboard
          ? { tone: 'warning', text: 'Guitar not calibrated' }
          : { tone: 'todo', text: 'Not calibrated' };
  const ready = (input.tone === 'done' || keyboardOnly(s)) && calibration.tone === 'done';
  return {
    input,
    tuner: session.tunerVisited ? { tone: 'done', text: 'Checked this session' } : { tone: 'optional', text: 'Every session' },
    monitor,
    calibration,
    done: ready ? { tone: 'done', text: 'Ready to play' } : { tone: 'todo', text: 'A step needs attention' },
  };
}

/** Signed whole milliseconds (`+42 ms`, `−3 ms`, `0 ms`). */
export function formatOffset(ms: number): string {
  const r = Math.round(ms);
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)} ms`;
}

/** One row of the summary step. */
export interface SummaryRow {
  label: string;
  value: string;
  tone: StepTone;
  /** Step to revisit to change it. */
  step: StepId;
  /** Button text for revisiting ("Change", or the missing action such as "Calibrate guitar"). */
  action: string;
}

/** The summary step's rows (input, output, monitoring, calibration). */
export function summaryRows(s: Settings, session?: SetupSession): SummaryRow[] {
  const st = stepStatuses(s, session);
  const channel = s.input.channel === 'mix' ? 'channels 1 + 2' : `channel ${s.input.channel + 1}`;
  const cal = s.calibration;
  const measured = calibrationState(s);
  const keyboard = measured.keyboard ? `keyboard ${formatOffset(cal.keyboardOffsetMs)}` : 'keyboard not calibrated';
  const spread = cal.spreadMs !== null ? ` · spread ±${Math.round(cal.spreadMs)} ms` : '';
  const calValue = measured.guitar
    ? `Guitar ${formatOffset(cal.inputOffsetMs)} · ${keyboard}${spread}`
    : measured.keyboard
      ? `Guitar not calibrated · keyboard ${formatOffset(cal.keyboardOffsetMs)}`
      : st.calibration.text;
  const calAction = keyboardOnly(s) ? (measured.keyboard ? 'Change' : 'Calibrate keyboard') : measured.guitar ? 'Change' : 'Calibrate guitar';
  return [
    {
      label: 'Guitar input',
      value: s.input.label ? `${s.input.label} (${channel})` : st.input.text,
      tone: st.input.tone,
      step: 'input',
      action: s.input.label ? 'Change' : 'Connect',
    },
    { label: 'Output', value: s.output.label ?? 'System default', tone: s.output.label ? 'done' : 'optional', step: 'input', action: 'Change' },
    {
      label: 'Monitoring',
      value: !s.monitor.headphonesCardSeen ? 'Not set up yet' : s.monitor.enabled ? `On · ${AMP_PRESETS[s.monitor.preset].label} amp` : 'Off (you hear your own amp)',
      tone: st.monitor.tone,
      step: 'monitor',
      action: s.monitor.headphonesCardSeen ? 'Change' : 'Set up',
    },
    { label: 'Latency calibration', value: calValue, tone: st.calibration.tone, step: 'calibration', action: calAction },
  ];
}
