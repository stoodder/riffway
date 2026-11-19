/**
 * Error types shared by every context (browser, worker, worklet, server).
 *
 * Stub modules created by T-010 throw {@link NotImplementedError} until their owning task fills
 * them in. Code that wants to degrade gracefully can test with {@link isNotImplemented}.
 *
 * @module
 */

/** Thrown by a stub whose owning task has not landed yet. */
export class NotImplementedError extends Error {
  /** The stubbed function, e.g. `'loadSong'`. */
  readonly feature: string;
  /** The task that will implement it, e.g. `'T-011'`. */
  readonly task: string;

  constructor(feature: string, task: string) {
    super(`${feature} is not implemented yet (${task})`);
    this.name = 'NotImplementedError';
    this.feature = feature;
    this.task = task;
  }
}

/**
 * Throw a {@link NotImplementedError}. Typed as `never` so stubs can keep their final return type:
 * `export function loadSong(...): Song { return notImplemented('loadSong', 'T-011'); }`
 */
export function notImplemented(feature: string, task: string): never {
  throw new NotImplementedError(feature, task);
}

/** True for a {@link NotImplementedError} (also across realms, by name). */
export function isNotImplemented(err: unknown): err is NotImplementedError {
  return err instanceof NotImplementedError || (err instanceof Error && err.name === 'NotImplementedError');
}
