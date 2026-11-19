/**
 * Structural validation of export files (current schema). Small combinators that collect readable,
 * path-qualified errors (`stores.runs[3].accuracy: expected a number`). Unknown extra fields are
 * allowed and kept, so newer optional fields survive a round trip.
 * @module
 */
import { DEFAULT_SETTINGS } from '@shared/settings';
import { OUTCOMES } from '@shared/judge';

/** Collects errors up to a cap. */
export class ErrorList {
  readonly items: string[] = [];
  private dropped = 0;

  constructor(private readonly max = 20) {}

  add(message: string): void {
    if (this.items.length < this.max) this.items.push(message);
    else this.dropped += 1;
  }

  get ok(): boolean {
    return this.items.length === 0;
  }

  /** The errors, with a final "…and N more" line when capped. */
  list(): string[] {
    return this.dropped > 0 ? [...this.items, `…and ${this.dropped} more problems`] : [...this.items];
  }
}

/** Validates `value` at `path`, adding errors to `errs`. */
export type Check = (value: unknown, path: string, errs: ErrorList) => void;

interface OptionalField {
  optional: true;
  check: Check;
}
type Field = Check | OptionalField;

/** Mark an object field optional (absent or `undefined` is fine). */
export const optional = (check: Check): OptionalField => ({ optional: true, check });

const describe = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v);

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const str: Check = (v, path, errs) => {
  if (typeof v !== 'string') errs.add(`${path}: expected a string, got ${describe(v)}`);
};

export const num: Check = (v, path, errs) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) errs.add(`${path}: expected a finite number, got ${describe(v)}`);
};

export const int: Check = (v, path, errs) => {
  if (typeof v !== 'number' || !Number.isInteger(v)) errs.add(`${path}: expected an integer, got ${describe(v)}`);
};

export const bool: Check = (v, path, errs) => {
  if (typeof v !== 'boolean') errs.add(`${path}: expected true or false, got ${describe(v)}`);
};

/** An integer in `[min, max]`. */
export const intIn =
  (min: number, max: number): Check =>
  (v, path, errs) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) errs.add(`${path}: expected an integer ${min}–${max}`);
  };

/** A finite number in `[min, max]`. */
export const numIn =
  (min: number, max: number): Check =>
  (v, path, errs) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) errs.add(`${path}: expected a number ${min}–${max}`);
  };

/** One of the given literals. */
export const oneOf =
  (...values: readonly (string | number)[]): Check =>
  (v, path, errs) => {
    if (!values.includes(v as string | number)) errs.add(`${path}: expected one of ${values.map((x) => JSON.stringify(x)).join(', ')}`);
  };

/** A string matching `re` (`what` names the format in the message). */
export const matches =
  (re: RegExp, what: string): Check =>
  (v, path, errs) => {
    if (typeof v !== 'string' || !re.test(v)) errs.add(`${path}: expected ${what}`);
  };

export const nullable =
  (check: Check): Check =>
  (v, path, errs) => {
    if (v !== null) check(v, path, errs);
  };

export const arrayOf =
  (check: Check): Check =>
  (v, path, errs) => {
    if (!Array.isArray(v)) {
      errs.add(`${path}: expected an array, got ${describe(v)}`);
      return;
    }
    v.forEach((item, i) => check(item, `${path}[${i}]`, errs));
  };

/** An array of exactly `checks.length` items. */
export const tuple =
  (...checks: Check[]): Check =>
  (v, path, errs) => {
    if (!Array.isArray(v) || v.length !== checks.length) {
      errs.add(`${path}: expected an array of ${checks.length} items`);
      return;
    }
    checks.forEach((c, i) => c(v[i], `${path}[${i}]`, errs));
  };

/** A plain object with these fields (extra fields allowed). */
export const object =
  (shape: Record<string, Field>): Check =>
  (v, path, errs) => {
    if (!isRecord(v)) {
      errs.add(`${path}: expected an object, got ${describe(v)}`);
      return;
    }
    for (const [key, field] of Object.entries(shape)) {
      const value = v[key];
      if (typeof field === 'function') {
        if (!(key in v)) errs.add(`${path}.${key}: missing`);
        else field(value, `${path}.${key}`, errs);
      } else if (value !== undefined) {
        field.check(value, `${path}.${key}`, errs);
      }
    }
  };

/** A plain object whose values all pass `check` (string keys). */
export const recordOf =
  (check: Check): Check =>
  (v, path, errs) => {
    if (!isRecord(v)) {
      errs.add(`${path}: expected an object, got ${describe(v)}`);
      return;
    }
    for (const [k, item] of Object.entries(v)) check(item, `${path}[${JSON.stringify(k)}]`, errs);
  };

// ------------------------------------------------------------------------------------------------
// Record shapes (schema v1, shared/storage.ts)
// ------------------------------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_RE = /^\d{4}-W\d{2}$/;
const nonNegInt = intIn(0, Number.MAX_SAFE_INTEGER);
const percent = numIn(0, 100);
const speed = numIn(0.01, 4);
const stars = intIn(0, 5);
const arrangement = nonNegInt;

const outcomeCounts = object(Object.fromEntries(OUTCOMES.map((o) => [o, nonNegInt])));

export const runRecord: Check = object({
  id: optional(intIn(1, Number.MAX_SAFE_INTEGER)),
  songId: str,
  arrangement,
  startedAt: num,
  endedAt: num,
  speed,
  loop: optional(object({ startBar: nonNegInt, endBar: nonNegInt })),
  mode: oneOf('play', 'practice'),
  score: num,
  accuracy: percent,
  stars,
  maxCombo: nonNegInt,
  counts: outcomeCounts,
  sections: arrayOf(object({ idx: nonNegInt, notes: nonNegInt, hits: nonNegInt, accuracy: percent })),
  histogram: object({ binMs: num, minMs: num, bins: arrayOf(nonNegInt) }),
  clean: bool,
  inputSource: oneOf('guitar', 'keyboard', 'test'),
  activeSec: numIn(0, Number.MAX_SAFE_INTEGER),
});

export const bestRecord: Check = object({
  songId: str,
  arrangement,
  speedBucket: nonNegInt,
  score: num,
  accuracy: percent,
  stars,
  runId: nonNegInt,
  at: num,
});

export const sectionProgress: Check = object({
  songId: str,
  arrangement,
  sectionIdx: nonNegInt,
  cleanRuns: nonNegInt,
  cleanRunsAt100: nonNegInt,
  lastSpeed: speed,
  trainer: object({ speed, failStreak: nonNegInt }),
  masteredAt: optional(num),
  lockedInAt: optional(num),
  nextCheckAt: optional(num),
  bestAccuracy: percent,
  passesSinceGain: nonNegInt,
  session: optional(object({ id: str, cleanRunsAt100: nonNegInt })),
});

export const practiceDay: Check = object({
  date: matches(DATE_RE, 'a date YYYY-MM-DD'),
  activeSec: numIn(0, Number.MAX_SAFE_INTEGER),
  runs: nonNegInt,
});

export const streakState: Check = object({
  weekTarget: intIn(2, 7),
  current: nonNegInt,
  best: nonNegInt,
  freezes: nonNegInt,
  weeksTowardFreeze: nonNegInt,
  lastEvaluatedWeek: nullable(matches(WEEK_RE, 'an ISO week YYYY-Www')),
  repairWeek: optional(matches(WEEK_RE, 'an ISO week YYYY-Www')),
});

export const audioLink: Check = object({
  songId: str,
  arrangement,
  audioId: str,
  fileName: str,
  anchors: arrayOf(object({ songTime: num, audioTime: num })),
  gainDb: num,
  enabled: bool,
});

export const songCacheEntry: Check = object({
  songId: str,
  meta: object({ id: str, title: str, source: str, tags: object({ style: arrayOf(str), genre: arrayOf(str), skills: arrayOf(str) }) }),
  difficulty: nullable(object({ rating: num, tier: intIn(1, 10) })),
  lastPlayedAt: nullable(num),
  favourite: bool,
});

export const rhythmSidecar: Check = object({
  schema: oneOf(1),
  bpm: num,
  timeSig: tuple(int, int),
  grid: oneOf(8, 12, 16),
  onsets: arrayOf(num),
  method: oneOf('snap', 'tap', 'manual'),
  savedAt: num,
});

/** Settings fields whose type is a union the default value cannot describe (path below `settings`). */
const SETTINGS_OVERRIDES: Record<string, Check> = {
  '.schema': oneOf(1),
  '.input.channel': oneOf(0, 1, 'mix'),
};

/**
 * Settings check derived from {@link DEFAULT_SETTINGS}: every present field must have the default's
 * type (missing fields are filled from defaults on import). `null` defaults accept null, strings or
 * numbers; arrays must be arrays of the default items' type.
 */
export const settingsShape: Check = (v, path, errs) => {
  if (!isRecord(v)) {
    errs.add(`${path}: expected an object, got ${describe(v)}`);
    return;
  }
  likeDefault(v, DEFAULT_SETTINGS, path, '', errs);
};

function likeDefault(value: unknown, def: unknown, path: string, rel: string, errs: ErrorList): void {
  const override = SETTINGS_OVERRIDES[rel];
  if (override) {
    override(value, path, errs);
  } else if (def === null) {
    if (value !== null && typeof value !== 'string' && typeof value !== 'number') errs.add(`${path}: expected null, a string or a number`);
  } else if (Array.isArray(def)) {
    if (!Array.isArray(value)) errs.add(`${path}: expected an array, got ${describe(value)}`);
    else if (def.length > 0) value.forEach((item, i) => likeDefault(item, def[0], `${path}[${i}]`, `${rel}[]`, errs));
  } else if (isRecord(def)) {
    if (!isRecord(value)) {
      errs.add(`${path}: expected an object, got ${describe(value)}`);
      return;
    }
    for (const [k, d] of Object.entries(def)) {
      if (value[k] !== undefined) likeDefault(value[k], d, `${path}.${k}`, `${rel}.${k}`, errs);
    }
  } else if (typeof value !== typeof def || (typeof value === 'number' && !Number.isFinite(value))) {
    errs.add(`${path}: expected ${typeof def}, got ${describe(value)}`);
  }
}
