/**
 * Highway (dev) screen (`#/dev/highway`, T-024): the canvas highway on a fixture song that exercises
 * every glyph, driven by a simulated clock, with a scripted demo player for hit feedback and a live
 * frame-cost readout. Dev builds and `?e2e=1` only (the shell gates `dev` screens).
 *
 * Query params (all optional, for screenshots): `song=fixture|dense`, `t` (start song time),
 * `play=0|1` (default 1), `demo=0|1` (default 1), `loop=1` (A/B on the chorus), `speed` (fraction),
 * `noteSpeed`, `cues=0|1`, `combo` (preset streak), `shot=1` (scripted feedback burst) and `freeze=1`
 * (draw two frames 90 ms apart, then stop: a stable frame for screenshots).
 * @module
 */
import type { TransportLoop } from '@shared/clock';
import type { Highway } from '@shared/services';
import type { Song } from '@shared/song';
import type { ScreenMount } from '@shared/ui';
import { computePositions } from '@core/handpos';
import { createHighway } from '../../../game/highway';
import { button, h, select, slider, toggle } from '../../components';
import { DemoPlayer } from './demo';
import { SimClock } from './sim-clock';
import { denseSong, glyphFixtureSong } from './songs';
import './dev-highway.css';

/** Frames kept for the rolling frame-cost stats. */
const STATS_WINDOW = 240;

function num(params: Record<string, string>, key: string, fallback: number): number {
  const v = Number(params[key]);
  return params[key] !== undefined && Number.isFinite(v) ? v : fallback;
}

/** Chorus A/B loop for the fixture song (1-bar pre-roll). */
function chorusLoop(song: Song): TransportLoop | null {
  const chorus = song.sections.find((s) => s.name === 'Chorus') ?? song.sections[0];
  if (!chorus) return null;
  const bar = song.timing.bars[chorus.startBar];
  return { start: chorus.start, end: chorus.end, preroll: bar ? bar.dur : 0 };
}

function fmtTime(t: number): string {
  const s = Math.max(0, t);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

export const mount: ScreenMount = (el, _ctx, params) => {
  let song: Song = params.song === 'dense' ? denseSong() : glyphFixtureSong();
  const freeze = params.freeze === '1';
  const canvas = h('canvas', { class: 'dh-canvas', 'aria-label': 'Note highway', role: 'img' });
  const stage = h('div', { class: 'dh-stage' }, canvas);
  const stats = h('output', { class: 'dh-stats rw-num', 'aria-live': 'off' }, '—');
  const clockOut = h('output', { class: 'dh-time rw-num' }, '0:00.0');

  let clock = new SimClock(song.meta.durationSec);
  let highway!: Highway;
  let demo!: DemoPlayer;
  let demoOn = params.demo !== '0';
  let loopOn = params.loop === '1';
  let rafId = 0;
  const costs = new Float64Array(STATS_WINDOW);
  const sorted = new Float64Array(STATS_WINDOW);
  let costCount = 0;
  let frames = 0;
  let fpsT0 = performance.now();
  let fps = 0;

  // The play button is re-created in place on every state change (label + icon from the component kit).
  let playSlot = button({ label: 'Play', icon: 'play', variant: 'primary', onClick: () => togglePlay() });
  const refreshPlay = (): void => {
    const playing = clock.state === 'playing';
    const next = button({ label: playing ? 'Pause' : 'Play', icon: playing ? 'pause' : 'play', variant: 'primary', onClick: () => togglePlay() });
    playSlot.replaceWith(next);
    playSlot = next;
  };

  const position = slider({
    label: 'Position',
    min: -2,
    max: Math.ceil(song.meta.durationSec),
    step: 0.1,
    value: 0,
    format: fmtTime,
    onInput: (v) => {
      clock.seek(v);
      demo.rewind(v);
    },
  });
  const speed = slider({
    label: 'Speed',
    min: 0.4,
    max: 1.1,
    step: 0.05,
    value: num(params, 'speed', 1),
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => clock.setSpeed(v),
  });
  const noteSpeed = slider({
    label: 'Note speed',
    min: 0.5,
    max: 2,
    step: 0.1,
    value: num(params, 'noteSpeed', 1),
    format: (v) => `×${v.toFixed(1)}`,
    onInput: (v) => highway.setOptions({ noteSpeed: v }),
  });
  const cues = toggle({
    label: 'Hand-position cues',
    checked: params.cues !== '0',
    onChange: (on) => highway.setOptions({ handCues: on }),
  });
  const loopToggle = toggle({
    label: 'A/B loop (chorus)',
    checked: loopOn,
    onChange: (on) => {
      loopOn = on;
      applyLoop();
    },
  });
  const demoToggle = toggle({
    label: 'Demo player',
    description: 'Scripted judgments and combo',
    checked: demoOn,
    onChange: (on) => {
      demoOn = on;
      demo.rewind(clock.heardSongTime());
    },
  });
  const songSelect = select({
    label: 'Song',
    value: params.song === 'dense' ? 'dense' : 'fixture',
    options: [
      { value: 'fixture', label: 'Glyph fixture (16 bars)' },
      { value: 'dense', label: 'Dense 20 min × 16 notes/s' },
    ],
    onChange: (v) => {
      const wasPlaying = clock.state === 'playing';
      load(v === 'dense' ? denseSong() : glyphFixtureSong(), -1);
      if (wasPlaying) clock.play();
      refreshPlay();
    },
  });

  const applyLoop = (): void => {
    const loop = loopOn ? chorusLoop(song) : null;
    clock.setLoop(loop);
    highway.setOptions({ loop });
  };

  function togglePlay(): void {
    if (clock.state === 'playing') clock.pause();
    else clock.play();
    refreshPlay();
  }

  function load(next: Song, startAt: number): void {
    if (highway as Highway | undefined) highway.dispose();
    song = next;
    clock = new SimClock(song.meta.durationSec);
    clock.speed = speed.value;
    highway = createHighway(canvas, song, clock, {
      noteSpeed: noteSpeed.value,
      handCues: cues.checked,
      positions: computePositions(song),
      loop: null,
    });
    demo = new DemoPlayer(song, highway);
    clock.onChange((c) => {
      if (c.reason === 'seek' || c.reason === 'loop-wrap') demo.rewind(c.anchor.anchorSongTime);
    });
    position.input.max = String(Math.ceil(song.meta.durationSec));
    applyLoop();
    clock.seek(startAt);
    demo.rewind(startAt);
  }

  const restart = button({
    label: 'Restart',
    icon: 'loop',
    variant: 'secondary',
    onClick: () => {
      clock.seek(loopOn ? (chorusLoop(song)?.start ?? 0) - 2.4 : -1);
      if (clock.state !== 'playing') {
        clock.play();
        refreshPlay();
      }
    },
  });

  const root = h(
    'div',
    { class: 'dh' },
    h(
      'header',
      { class: 'dh-head' },
      h('div', null, h('p', { class: 'rw-eyebrow' }, 'Renderer'), h('h1', null, 'Highway (dev)')),
      h('div', { class: 'dh-readouts' }, clockOut, stats),
    ),
    stage,
    h(
      'div',
      { class: 'dh-controls' },
      h('div', { class: 'dh-transport' }, playSlot, restart),
      h('div', { class: 'dh-sliders' }, position.el, speed.el, noteSpeed.el),
      h('div', { class: 'dh-toggles' }, cues.el, loopToggle.el, demoToggle.el, songSelect.el),
    ),
  );
  el.append(root);

  if (!canvas.getContext('2d')) {
    // No Canvas 2D (e.g. a DOM emulator): say so instead of failing the route.
    stage.replaceChildren(h('p', { class: 'dh-unsupported' }, 'Canvas 2D is not available in this browser.'));
    return { unmount: () => root.remove() };
  }

  load(song, num(params, 't', -1));
  const presetCombo = num(params, 'combo', NaN);
  if (Number.isFinite(presetCombo)) demo.setCombo(presetCombo);

  if (params.shot === '1') scriptedShot();

  /** A fixed set of judgements on the latest groups before now (screenshots of every feedback kind). */
  function scriptedShot(): void {
    // Latest group first: the Miss and WrongNote gems are still on screen, the hits are consumed.
    const plan = [
      ['Miss', null],
      ['WrongNote', null],
      ['Perfect', null],
      ['Good', 'late'],
      ['Great', null],
      ['Good', 'early'],
    ] as const;
    const now = clock.heardSongTime();
    const groups = demo.groupsBefore(now + 0.02, plan.length);
    groups.forEach((g, k) => demo.emit(g, plan[k]![0], 0, plan[k]![1]));
    if (Number.isFinite(presetCombo)) demo.setCombo(presetCombo);
  }

  if (!freeze && params.play !== '0') clock.play();
  refreshPlay();

  const frame = (ts: number): void => {
    clock.tick(ts);
    const now = clock.heardSongTime(ts);
    if (demoOn && clock.state === 'playing') demo.update(now, clock.pass);
    const cost = highway.drawFrame(ts);
    costs[costCount % STATS_WINDOW] = cost;
    costCount++;
    frames++;
    if (ts - fpsT0 >= 500) {
      fps = (frames * 1000) / (ts - fpsT0);
      frames = 0;
      fpsT0 = ts;
      const n = Math.min(costCount, STATS_WINDOW);
      sorted.set(costs.subarray(0, n));
      const view = sorted.subarray(0, n).sort();
      const p50 = view[Math.floor(n * 0.5)] ?? 0;
      const p95 = view[Math.min(n - 1, Math.floor(n * 0.95))] ?? 0;
      stats.textContent = `${fps.toFixed(0)} fps · draw p50 ${p50.toFixed(2)} ms · p95 ${p95.toFixed(2)} ms · ${song.notes.length.toLocaleString()} notes`;
      position.set(Math.round(now * 10) / 10);
    }
    clockOut.textContent = fmtTime(now);
    rafId = requestAnimationFrame(frame);
  };

  if (freeze) {
    const t0 = performance.now();
    highway.drawFrame(t0);
    highway.drawFrame(t0 + 90);
    clockOut.textContent = fmtTime(clock.heardSongTime(t0));
    position.set(Math.round(clock.heardSongTime(t0) * 10) / 10);
    stats.textContent = `${song.notes.length.toLocaleString()} notes · frozen`;
  } else {
    rafId = requestAnimationFrame(frame);
  }

  return {
    unmount(): void {
      cancelAnimationFrame(rafId);
      highway.dispose();
      root.remove();
    },
  };
};
