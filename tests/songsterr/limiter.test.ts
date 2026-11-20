import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLimiter } from '../../server/sources/songsterr/limiter';

describe('remote search limiter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lets the first call through at once and spaces the next one by the interval', async () => {
    const slot = createLimiter(1000, () => Date.now());
    const signal = new AbortController().signal;
    const t0 = Date.now();
    await slot(signal);
    expect(Date.now() - t0).toBe(0);

    let done = false;
    const second = slot(signal).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(done).toBe(true);
    expect(Date.now() - t0).toBe(1000);
  });

  it('does not wait once the interval has passed', async () => {
    const slot = createLimiter(1000, () => Date.now());
    const signal = new AbortController().signal;
    await slot(signal);
    await vi.advanceTimersByTimeAsync(1500);
    const t = Date.now();
    await slot(signal);
    expect(Date.now()).toBe(t);
  });

  it('a newer call supersedes a waiting one with AbortError', async () => {
    const slot = createLimiter(1000, () => Date.now());
    const signal = new AbortController().signal;
    await slot(signal);
    const first = slot(signal);
    const firstResult = first.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(100);
    const second = slot(signal);
    const err = await firstResult;
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(second).resolves.toBeUndefined();
  });

  it('rejects a waiting call when its signal aborts, and an already aborted signal at once', async () => {
    const slot = createLimiter(1000, () => Date.now());
    await slot(new AbortController().signal);
    const ac = new AbortController();
    const waiting = slot(ac.signal).catch((err: unknown) => err);
    ac.abort();
    expect(((await waiting) as DOMException).name).toBe('AbortError');
    await expect(slot(AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('an aborted earlier call does not cancel a later waiting one', async () => {
    const slot = createLimiter(1000, () => Date.now());
    const early = new AbortController();
    await slot(early.signal);
    const later = slot(new AbortController().signal);
    early.abort();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(later).resolves.toBeUndefined();
  });
});
