/**
 * The calibration flow end to end with Chrome's fake audio capture device: real engine, real input
 * service (getUserMedia → analysis worklet), real clicks, the guitar step's UI. The fake device beeps
 * periodically, unrelated to our clicks, so the run must complete with *some* verdict, render it,
 * and never leave listeners or a busy state behind.
 */
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/ui/design';
import type { AudioEngine, InputService } from '@shared/services';
import type { AppContext } from '@shared/ui';
import { createEngine } from '../../src/audio/engine';
import { createInputService } from '../../src/audio/input';
import { createRunStep } from '../../src/ui/panels/calibration/run-step';
import { memorySettings } from './helpers';

let engine: AudioEngine | null = null;
let input: (InputService & { dispose?(): void }) | null = null;
afterEach(async () => {
  input?.close();
  input?.dispose?.();
  input = null;
  await engine?.dispose();
  engine = null;
});

describe('calibration with the fake capture device', () => {
  it('opens the input, runs the clicks and shows a verdict', async () => {
    engine = await createEngine();
    const settings = memorySettings();
    input = await createInputService(engine, settings);
    const toasts: string[] = [];
    const ctx = {
      settings,
      services: { get: async () => null, peek: () => null },
      ui: { toast: (m: string) => void toasts.push(m), confirm: async () => true, requireAudioGesture: async () => engine!.resume() },
    } as unknown as AppContext;
    const step = createRunStep('guitar', { ctx, engine, input, runOptions: { plan: { bpm: 240, countInBeats: 2, clicks: 12 } } });
    document.body.append(step.el);
    try {
      [...step.el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Start')!.click();
      const end = performance.now() + 15_000;
      while (step.el.dataset.phase !== 'result' && performance.now() < end) await new Promise((r) => setTimeout(r, 50));
      expect(toasts).toEqual([]);
      expect(step.el.dataset.phase).toBe('result');
      expect(input.current).not.toBeNull();
      expect(settings.get().input.deviceId).toBe(input.current!.device.deviceId);
      expect(['ok', 'no-events', 'too-few', 'inconsistent']).toContain(step.el.dataset.outcome);
      expect(step.el.querySelector('.rw-calib__outcome')).not.toBeNull();
      // Whatever the verdict, only a passing run is saved.
      expect(settings.get().calibration.method === 'play-to-click').toBe(step.el.dataset.outcome === 'ok');
    } finally {
      step.destroy();
      step.el.remove();
    }
  }, 30_000);
});
