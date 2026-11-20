/**
 * Request limiter for remote search (docs/guides/songsterr-search.md § 3a): at most one request per
 * `intervalMs`; a newer call supersedes one that is still waiting (it rejects with `AbortError`).
 * @module
 */

/** A slot function: resolves when the caller may send its request. Rejects with `AbortError` when superseded or aborted. */
export type LimiterSlot = (signal: AbortSignal) => Promise<void>;

/** At most one request per `intervalMs`; a newer call supersedes a waiting one. */
export function createLimiter(intervalMs = 1000, now: () => number = Date.now): LimiterSlot {
  let last = -Infinity;
  let waiting: { cancel: () => void } | null = null;
  return async function slot(signal: AbortSignal): Promise<void> {
    waiting?.cancel();
    signal.throwIfAborted();
    const wait = Math.max(0, last + intervalMs - now());
    if (wait > 0) {
      await new Promise<void>((resolve, reject) => {
        const me = { cancel };
        const timer = setTimeout(done, wait);
        function release(): void {
          signal.removeEventListener('abort', cancel);
          if (waiting === me) waiting = null;
        }
        function done(): void {
          release();
          resolve();
        }
        function cancel(): void {
          clearTimeout(timer);
          release();
          reject(new DOMException('Superseded', 'AbortError'));
        }
        waiting = me;
        signal.addEventListener('abort', cancel, { once: true });
      });
    }
    signal.throwIfAborted();
    last = now();
  };
}
