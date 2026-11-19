/**
 * App startup wiring (`src/app/startup.ts`): the calibration follows device switches app-wide, without
 * the calibration panel mounted.
 */
import { describe, expect, it } from 'vitest';
import { guitarResultPatch } from '../../src/audio/calibration';
import { startAppWiring } from '../../src/app/startup';
import { memorySettings } from './helpers';

const USB = { input: { deviceId: 'a', label: 'Scarlett Solo USB', channel: 0 as const }, output: { sinkId: 'h', label: 'Headphones' } };
const NOW = 1_700_000_000_000;

describe('startAppWiring', () => {
  it('restores the device pair profile when the input changes, until stopped', async () => {
    const st = memorySettings(USB);
    await st.update(guitarResultPatch(st.get(), { offsetMs: 40, spreadMs: 2 }, NOW));
    await st.update({ input: { deviceId: 'b', label: 'Other Interface' } });
    await st.update(guitarResultPatch(st.get(), { offsetMs: 90, spreadMs: 3 }, NOW + 1));

    const stop = startAppWiring({ settings: st });
    await st.update({ input: { deviceId: 'a', label: 'Scarlett Solo USB' } });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(st.get().calibration).toMatchObject({ inputOffsetMs: 40, method: 'play-to-click' });

    stop();
    await st.update({ input: { deviceId: 'b', label: 'Other Interface' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(st.get().calibration.inputOffsetMs).toBe(40);
  });
});
