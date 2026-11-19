// @vitest-environment happy-dom
/** The highway dev screen degrades to a message where Canvas 2D is missing (happy-dom) and unmounts cleanly. */
import { expect, it } from 'vitest';
import type { AppContext } from '@shared/ui';
import { mount } from '../../src/ui/screens/dev-highway';

it('mounts without Canvas 2D and unmounts cleanly', async () => {
  const el = document.createElement('div');
  const handle = await mount(el, {} as AppContext, {});
  expect(el.textContent).toContain('Highway (dev)');
  expect(el.textContent).toContain('Canvas 2D is not available');
  handle.unmount();
  expect(el.childElementCount).toBe(0);
});
