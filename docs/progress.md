# Progress, streaks and recommendations

## Summary
- All player data lives in IndexedDB database `riffway` (via `idb` 8.0.4), versioned with
  fall-through `upgrade()` steps. Types in `shared/storage.ts`.
- Progress counts **clean runs**, not minutes or plays (learning research rows 4–5).
- Streaks are **weekly** and forgiving (automatic freezes, silent misses, no loss alerts).
- Recommendations target the comfort tier + 1 (60% stretch / 30% comfort / 10% reach) and always
  include the next-day check and the weakest section.
- Export/import is one versioned JSON file. Backing-audio bytes are not included.
Pure logic is in `src/core/progress/` (Node-testable); persistence in `src/storage/`.

## IndexedDB stores (schema v1)
| Store | Key | Value (abridged) | Indexes |
|---|---|---|---|
| `settings` | `'settings'` | `Settings` (`shared/settings.ts`) | — |
| `runs` | auto | `{songId, arrangement, startedAt, endedAt, speed, loop?: {startBar, endBar}, mode: 'play'|'practice', score, accuracy, stars, maxCombo, counts, sections: {idx, notes, hits, accuracy}[], histogram, clean: boolean, inputSource, activeSec}` | `[songId+arrangement, startedAt]`, `startedAt` |
| `bests` | `[songId, arrangement, speedBucket]` | `{score, accuracy, stars, runId, at}` (speedBucket = speed rounded to 5%; 100 = full) | — |
| `sectionProgress` | `[songId, arrangement, sectionIdx]` | `{cleanRuns, cleanRunsAt100, lastSpeed, trainer: {speed, failStreak}, masteredAt?, lockedInAt?, nextCheckAt?, bestAccuracy, passesSinceGain}` | `nextCheckAt` |
| `practiceDays` | `'YYYY-MM-DD'` (local) | `{activeSec, runs}` | — |
| `streak` | `'streak'` | `{weekTarget, current, best, freezes, weeksTowardFreeze, lastEvaluatedWeek, repairWeek?}` | — |
| `audioLinks` | `[songId, arrangement]` | `{audioId, fileName, anchors: {songTime, audioTime}[], gainDb, enabled}` | — |
| `songCache` | `songId` | `{meta, difficulty, lastPlayedAt, favourite}` (for home screen without a server round trip) | `lastPlayedAt` |

Records also carry their key fields (`songId`, `arrangement`, …); exact types are in `shared/storage.ts`.
A run is **clean** when accuracy ≥ 90% and there are no more than 2 consecutive misses.
Active time = time the transport is playing (not paused), summed per local day.

## Section mastery (`src/core/progress/mastery.ts`)
- **Speed trainer state** per section: start 70% (60% if the section is ≥ 2 tiers above comfort; floor
  40%). Clean run → +5%; failed run (< 70%) twice in a row → −5% and "Slow down a notch";
  70–89% holds. Cap 100% (110% overspeed only after mastery, opt-in).
- **Mastered:** 2 clean runs at 100% in one session. Sets `masteredAt`, `nextCheckAt = next local day 04:00`.
- **Locked in:** a clean run at 100% on a later day when `nextCheckAt` is due. Failing the check
  resets `masteredAt` and starts the trainer at 85%.
- Song mastered = all sections mastered; **repertoire** = songs with every section locked in.
- Plateau nudge after 6 passes without accuracy gain: "Good place to stop — this usually improves
  after sleep."

## Streaks (`src/core/progress/streak.ts`)
- A **practice day** = ≥ 5 min active play. Daily goal default 15 min (5/10/15/30/45).
- Weekly target default **4 practice days** (2–7). Weeks are ISO weeks, local time. The streak counts
  consecutive weeks meeting the target.
- **Freezes:** earn 1 per 2 completed weeks, hold max 2, applied automatically to a missed week.
- **Grace:** a missed week without a freeze is repaired by 2 extra practice days the next week.
- Evaluate lazily on app open and after each run (no timers, no notifications). Never show a
  "streak lost" message; show current and best side by side.

## Recommendations (`src/core/progress/recommend.ts`)
**Comfort tier** = highest tier with ≥ 85% accuracy at 100% speed on ≥ 2 distinct songs; default 2
for a new player (profile: beginner–intermediate).

Candidates = library songs with rhythm (not `needs-alignment`) plus starter items. Score each:
```
target = comfort + 1 (stretch) | comfort (comfort) | comfort + 2 (reach)
fit    = 1 − |tier − target| / 3                    (clamped ≥ 0)
pref   = +0.2 if style tag matches preferred (default 'pick'), +0.1 if genre in rock/metal or "recognizable"
fresh  = −0.3 if played in the last 24 h unless it is a review item
score  = fit + pref + fresh
```
Fill 10 slots: 6 stretch, 3 comfort/review, 1 reach (reach suggested as a single section).
**Session goals** (3, player picks one, phrased as process goals): (1) next-day checks due,
(2) the weakest section of the most recent stretch song ("Get Verse 2 clean at 80%"),
(3) one new stretch song. Fingerstyle items are excluded from goals unless the player enables
"Fingerstyle" in preferences.

## Export / import (`src/storage/export.ts`)
```json
{ "app": "riffway", "schemaVersion": 1, "exportedAt": "2026-11-19T20:00:00Z",
  "settings": { }, "stores": { "runs": [], "bests": [], "sectionProgress": [], "practiceDays": [],
  "streak": { }, "audioLinks": [], "songCache": [] },
  "server": { "sidecars": { "<songId>": { } } } }
```
- File name `riffway-backup-YYYY-MM-DD.json`. `server.sidecars` comes from `GET /api/sidecars`.
- Import: validate `app` and `schemaVersion` (reject newer), migrate forward with the same steps as
  `upgrade()`, preview counts, then **replace** or **merge** (merge: union by key, keep the newer
  record by timestamp; bests keep the higher score). Sidecars are posted back to `POST /api/sidecars`.
- Audio links whose `audioId` is missing on the server show "Re-attach audio" on the song page.

## Tests
`fake-indexeddb` for stores and migrations; pure tests for mastery transitions, streak weeks
(freeze earn/apply, grace repair, year boundary, DST), recommendation mix and determinism, and an
export → wipe → import round trip that yields identical store contents.
