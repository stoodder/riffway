/**
 * Typed import errors thrown by `loadSong` and every importer (T-011, T-012). Frozen by T-010.
 * Errors cross the worker boundary as `{message, code}` (see `SongWorkerResponse`).
 * @module
 */
import type { ImportDiagnostic } from '@shared/song';

/** Why an import failed. */
export type ImportErrorCode =
  /** Extension / content not recognised. */
  | 'unsupported'
  /** No 6-string guitar track (bass, drums, 7-string only). */
  | 'no-playable-track'
  /** Requested arrangement index is not a playable track. */
  | 'bad-arrangement'
  /** alphaTex (or other text) syntax errors; see `diagnostics`. */
  | 'syntax'
  /** The file parsed but produced no notes / no staff blocks. */
  | 'empty'
  /** The importer threw something unexpected. */
  | 'internal';

/** A failed import. `diagnostics` carry line/column details (alphaTex, ASCII). */
export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly diagnostics: ImportDiagnostic[];

  constructor(code: ImportErrorCode, message: string, diagnostics: ImportDiagnostic[] = [], options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ImportError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

/** Type guard that also works across realms (worker → main thread rehydration by name). */
export function isImportError(err: unknown): err is ImportError {
  return err instanceof ImportError || (err instanceof Error && err.name === 'ImportError');
}
