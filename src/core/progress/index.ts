/**
 * Pure progress logic (T-020): section mastery, weekly streaks with freezes, comfort tier and
 * recommendations (docs/progress.md). Node-testable; persistence lives in `src/storage/`.
 * @module
 */
export {
  addDays,
  DAY_MS,
  isoWeek,
  isoWeekAt,
  localDate,
  mondayOf,
  mondayOfIsoWeek,
  nextDayCheckAt,
  nextIsoWeek,
  previousIsoWeek,
  NEXT_DAY_CHECK_HOUR,
} from './dates';
export {
  applySectionRun,
  isCheckDue,
  isFullSpeed,
  isPlateau,
  MASTERY_CLEAN_RUNS,
  PLATEAU_MESSAGE,
  PLATEAU_PASSES,
  songMastery,
  speedBucket,
  type SectionRunInput,
  type SongMastery,
} from './mastery';
export {
  evaluateStreak,
  GRACE_EXTRA_DAYS,
  initialStreak,
  MAX_FREEZES,
  PRACTICE_DAY_SEC,
  WEEK_TARGET_MAX,
  WEEK_TARGET_MIN,
  WEEKS_PER_FREEZE,
} from './streak';
export {
  comfortTier,
  COMFORT_ACCURACY,
  COMFORT_SONGS,
  DEFAULT_COMFORT_TIER,
  recommend,
  RECOMMENDATION_MIX,
  sessionGoals,
  type RecommendInput,
} from './recommend';
