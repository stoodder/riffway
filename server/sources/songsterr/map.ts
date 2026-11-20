/**
 * Remote search response → {@link RemoteSearchHit}s (docs/guides/songsterr-search.md § 3d). Pure.
 *
 * OWNER: this file is a skeleton. The response format is yours to describe: fill in {@link RawSong},
 * {@link songUrl}, {@link rawTuning}, {@link isSixStringGuitar} and the field reads marked `OWNER`
 * in {@link mapSearchResponse}, with tests against fixtures you save yourself
 * (`tests/fixtures/songsterr/`, `tests/songsterr/map.test.ts`). Until then it maps every response
 * to `[]`. The generic part (guitar tracks only, tuning → `describeTuning` slug and label) is done.
 * @module
 */
import type { RemoteSearchHit } from '@shared/sources';
import { describeTuning } from '@core/model/tuning';

/** OWNER: the shape of one item in the search response (only the fields you use). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- OWNER fills in the fields
export interface RawSong {}

/** OWNER: song page URL for a raw item (opened in the player's browser, never requested by Riffway). */
export function songUrl(raw: RawSong): string {
  void raw;
  return '';
}

/**
 * OWNER: return the raw tuning as MIDI note numbers, or undefined.
 * Riffway order is string 1 = high e. If the site lists low → high, reverse it.
 */
export function rawTuning(track: unknown): number[] | undefined {
  void track;
  return undefined;
}

/** Keep 6-string guitar tracks only. OWNER: decide from the track's instrument fields. */
export function isSixStringGuitar(track: unknown): boolean {
  void track;
  return false;
}

/** OWNER: one raw item's id, title, artist and tracks (`undefined` id/title skips the item). */
function readItem(raw: RawSong): { remoteId?: string; title?: string; artist?: string; tracks: unknown[] } {
  void raw;
  return { tracks: [] };
}

/** Display name of a raw track. OWNER: read the track's name field. */
function trackName(track: unknown): string {
  void track;
  return '';
}

/** Tuning fields for hits: first 6-string tuning → `describeTuning` id and label. */
export function tuningFields(tracks: readonly { tuning?: number[] }[]): Pick<RemoteSearchHit, 'tuning' | 'tuningId' | 'tuningLabel'> {
  const tuning = tracks.find((t) => t.tuning?.length === 6)?.tuning;
  if (!tuning) return {};
  const described = describeTuning(tuning);
  return { tuning, tuningId: described.id, tuningLabel: described.label };
}

/** Response JSON → hits. Never throws on odd items: skips them. */
export function mapSearchResponse(json: unknown): RemoteSearchHit[] {
  if (!Array.isArray(json)) return [];
  const out: RemoteSearchHit[] = [];
  for (const raw of json as RawSong[]) {
    try {
      const { remoteId, title, artist, tracks: rawTracks } = readItem(raw);
      if (!remoteId || !title) continue;
      const tracks = rawTracks.filter(isSixStringGuitar).map((t) => ({ name: trackName(t), tuning: rawTuning(t) }));
      const hit: RemoteSearchHit = { source: 'songsterr', remoteId, title, url: songUrl(raw), tracks, ...tuningFields(tracks) };
      if (artist) hit.artist = artist;
      out.push(hit);
    } catch {
      // An odd item: skip it.
    }
  }
  return out;
}
