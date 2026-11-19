/**
 * Persisted ClassTab refresh state (`<dataDir>/classtab/state.json`).
 * @module
 */
import { isRecord, readJsonFile, writeJsonFile } from '../../json-file';

/** `state.json`. */
export interface ClassTabState {
  schema: 1;
  /** `ETag` of the last downloaded zip (sent as `If-None-Match`). */
  etag: string | null;
  /** `Last-Modified` of the last downloaded zip (sent as `If-Modified-Since`). */
  lastModified: string | null;
  /** Epoch ms of the last successful contact (200 or 304); drives the once-per-day limit. */
  lastRefresh: number | null;
  /** Epoch ms of the last successful download + extraction (a new corpus). */
  lastDownload: number | null;
  /** Size of the last downloaded zip. */
  zipBytes: number | null;
  /** Extracted `.txt` tabs (without the readme) and `.mid` files. */
  tabs: number;
  midis: number;
  /** Message of the last failed refresh (cleared by the next success). */
  error?: string;
}

/** State before the first download. */
export const EMPTY_STATE: ClassTabState = {
  schema: 1,
  etag: null,
  lastModified: null,
  lastRefresh: null,
  lastDownload: null,
  zipBytes: null,
  tabs: 0,
  midis: 0,
};

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Read `state.json`; missing or malformed fields fall back to {@link EMPTY_STATE}. */
export async function readClassTabState(file: string): Promise<ClassTabState> {
  const raw = await readJsonFile(file);
  if (!isRecord(raw) || raw.schema !== 1) return { ...EMPTY_STATE };
  const state: ClassTabState = {
    schema: 1,
    etag: strOrNull(raw.etag),
    lastModified: strOrNull(raw.lastModified),
    lastRefresh: numOrNull(raw.lastRefresh),
    lastDownload: numOrNull(raw.lastDownload),
    zipBytes: numOrNull(raw.zipBytes),
    tabs: numOrNull(raw.tabs) ?? 0,
    midis: numOrNull(raw.midis) ?? 0,
  };
  if (typeof raw.error === 'string') state.error = raw.error;
  return state;
}

/** Write `state.json` atomically. */
export function writeClassTabState(file: string, state: ClassTabState): Promise<void> {
  return writeJsonFile(file, state);
}
