/** The highway dev screen (`#/dev/highway`) in Chromium: renders the fixture, drives frames, unmounts cleanly. */
import { expect, it } from 'vitest';
import type { AppContext } from '@shared/ui';
import { mount } from '../../src/ui/screens/dev-highway';

it('renders the glyph fixture with controls and a live frame readout', async () => {
  const el = document.createElement('div');
  el.style.width = '1200px';
  document.body.append(el);
  const handle = await mount(el, {} as AppContext, { t: '20', combo: '25', shot: '1' });
  const canvas = el.querySelector('canvas')!;
  expect(canvas.width).toBe(Math.round(canvas.clientWidth * devicePixelRatio));
  expect(el.querySelectorAll('input[type="range"]').length).toBe(3);
  expect(el.querySelectorAll('[role="switch"]').length).toBe(3);
  await new Promise((r) => setTimeout(r, 700));
  expect(el.querySelector('.dh-stats')!.textContent).toMatch(/fps · draw p50 [\d.]+ ms · p95 [\d.]+ ms · 139 notes/);
  // Something other than the background was painted in the lanes.
  const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
  let bright = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i]! + data[i + 1]! + data[i + 2]! > 400) bright++;
  expect(bright).toBeGreaterThan(1000);
  handle.unmount();
  expect(el.childElementCount).toBe(0);
  el.remove();
});
