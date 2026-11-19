/**
 * Display text for the library screen: source names, rhythm and availability labels, durations.
 * @module
 */
import type { RhythmStatus, SourceId } from '@shared/song';
import type { Availability } from '@shared/sources';
import type { BadgeTone, IconName } from '../../components';

/** Short source names for badges and filter chips. */
export const SOURCE_LABEL: Readonly<Record<SourceId, string>> = {
  local: 'My files',
  starter: 'Starter',
  classtab: 'ClassTab',
  songsterr: 'Songsterr',
  'ultimate-guitar': 'Ultimate Guitar',
  'gp-pack': 'Guitar Pro pack',
};

/** How each rhythm status reads in a result row. */
export const RHYTHM_LABEL: Readonly<Record<RhythmStatus, string>> = {
  exact: 'Rhythm from file',
  midi: 'Rhythm from MIDI',
  ruler: 'Rhythm from beat ruler',
  aligned: 'Rhythm aligned',
  'needs-alignment': 'Needs rhythm alignment',
};

/** Availability chip per result. */
export const AVAILABILITY: Readonly<Record<Availability, { label: string; tone: BadgeTone; icon: IconName; help: string }>> = {
  playable: { label: 'Playable now', tone: 'success', icon: 'play', help: 'Ready to play.' },
  'needs-rhythm': {
    label: 'Needs rhythm',
    tone: 'warning',
    icon: 'warning',
    help: 'This tab has fret numbers but no timing yet. Align its rhythm once to play it.',
  },
  'needs-import': {
    label: 'Needs import',
    tone: 'danger',
    icon: 'error',
    help: "This file couldn't be read as a playable 6-string guitar part. Try another version of the file.",
  },
};

/** Chip for an entry whose import failed (`SearchResult.error`); the help text is the error itself. */
export const FAILED_IMPORT: { label: string; tone: BadgeTone; icon: IconName } = { label: 'Failed to import', tone: 'danger', icon: 'error' };

/** Availability chip of a result: "Failed to import" (with its error) when the import failed. */
export function availabilityChip(r: { availability: Availability; error?: string }): { label: string; tone: BadgeTone; icon: IconName; help: string } {
  return r.error ? { ...FAILED_IMPORT, help: r.error } : AVAILABILITY[r.availability];
}

/** `m:ss` (or `h:mm:ss`) for a duration in seconds; `''` for unknown/zero. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** "1 song" / "12 songs" (thousands separated). */
export function songCount(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'song' : 'songs'}`;
}
