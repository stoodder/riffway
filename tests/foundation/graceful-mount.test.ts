// @vitest-environment happy-dom
/**
 * Screens and panels mount gracefully when the app context is incomplete or a service fails to
 * start: they render their title and an explanation instead of throwing (T-030).
 */
import { describe, expect, it } from 'vitest';
import type { AppContext, ServiceRegistry } from '@shared/ui';
import { mountPanel } from '../../src/ui/panels';
import { mount as mountLibrary } from '../../src/ui/screens/library';

/** A context whose service registry fails every `get` (e.g. no Web Audio in this window). */
function failingServices(): AppContext {
  const services = {
    get: () => Promise.reject(new Error('AudioContext is not supported')),
    peek: () => null,
  } as unknown as ServiceRegistry;
  return { services } as unknown as AppContext;
}

describe('graceful mounts', () => {
  for (const [id, title] of [
    ['tuner', 'Tuner'],
    ['input', 'Guitar input'],
  ] as const) {
    it(`the ${id} panel shows an "unavailable" card when the audio services fail`, async () => {
      const el = document.createElement('div');
      const handle = await mountPanel(id, el, failingServices(), {} as never);
      const card = el.querySelector<HTMLElement>(`[data-panel="${id}"]`);
      expect(card?.dataset.state).toBe('unavailable');
      expect(el.textContent).toContain(title);
      expect(el.querySelector('[role="status"]')?.textContent).toContain('AudioContext is not supported');
      handle.unmount();
      expect(el.childElementCount).toBe(0);
    });
  }

  it('the library screen explains what is missing instead of throwing', async () => {
    const el = document.createElement('div');
    const handle = await mountLibrary(el, {} as AppContext, {});
    expect(el.querySelector('h1')?.textContent).toBe('Library');
    expect(el.textContent).toContain('Library unavailable');
    expect(el.textContent).toContain('missing: api, router, ui');
    handle.unmount();
    expect(el.childElementCount).toBe(0);
  });
});
