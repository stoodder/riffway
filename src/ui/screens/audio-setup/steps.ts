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
    lead: 'With no amp in the chain, Riffway can play your guitar through an amp sim. Use headphones: laptop speakers feed back.',
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

/** Status lines for every step, from settings. The tuner has nothing persisted, so it is "optional". */
export function stepStatuses(s: Settings): Record<StepId, StepStatus> {
  const input: StepStatus = s.input.label ? { tone: 'done', text: s.input.label } : { tone: 'todo', text: 'Not connected yet' };
  const monitor: StepStatus = s.monitor.enabled ? { tone: 'done', text: `On · ${AMP_PRESETS[s.monitor.preset].label}` } : { tone: 'optional', text: 'Off' };
  const cal = s.calibration;
  const calibration: StepStatus =
    cal.method === 'play-to-click' || cal.method === 'loopback' || cal.method === 'tap-to-click'
      ? { tone: 'done', text: `${formatOffset(cal.method === 'tap-to-click' ? cal.keyboardOffsetMs : cal.inputOffsetMs)} offset` }
      : cal.method === 'estimated'
        ? { tone: 'warning', text: 'Estimated only' }
        : { tone: 'todo', text: 'Not calibrated' };
  const ready = input.tone === 'done' && calibration.tone === 'done';
  return {
    input,
    tuner: { tone: 'optional', text: 'Every session' },
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
}

/** The summary step's rows (input, output, monitoring, calibration). */
export function summaryRows(s: Settings): SummaryRow[] {
  const st = stepStatuses(s);
  const channel = s.input.channel === 'mix' ? 'channels 1 + 2' : `channel ${s.input.channel + 1}`;
  const cal = s.calibration;
  const calValue =
    st.calibration.tone === 'done'
      ? `Guitar ${formatOffset(cal.inputOffsetMs)} · keyboard ${formatOffset(cal.keyboardOffsetMs)}${cal.spreadMs !== null ? ` · spread ±${Math.round(cal.spreadMs)} ms` : ''}`
      : st.calibration.text;
  return [
    { label: 'Guitar input', value: s.input.label ? `${s.input.label} (${channel})` : 'Not connected yet', tone: st.input.tone, step: 'input' },
    { label: 'Output', value: s.output.label ?? 'System default', tone: s.output.label ? 'done' : 'optional', step: 'input' },
    {
      label: 'Monitoring',
      value: s.monitor.enabled ? `On · ${AMP_PRESETS[s.monitor.preset].label} amp` : 'Off (you hear your own amp)',
      tone: st.monitor.tone,
      step: 'monitor',
    },
    { label: 'Latency calibration', value: calValue, tone: st.calibration.tone, step: 'calibration' },
  ];
}
