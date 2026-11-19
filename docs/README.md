# Riffway docs

Riffway is a local-only guitar rhythm game and tab trainer. Notes scroll right → left on six string
lanes; your real guitar (USB input, pitch-tracked) is judged on timing and pitch separately. It runs in
Chrome on macOS as a Vite + TypeScript app plus a small Node companion server.

**State (iteration 1, complete):** playable end to end — guitar input + tuner + latency calibration,
monitoring with amp sim (Clean / Crunch / Overdrive / DI), horizontal highway with technique glyphs and
hand-position cues, Perfect/Great/Good/Wrong/Miss judging, practice tools (speed 40–100 %, A/B loops,
speed trainer, count-in, metronome, mixer), synthesized guide + attachable backing audio, unified
library search (local folder, starter, ClassTab, Songsterr/UG/Guitar Pro link-outs), GP/MusicXML/
alphaTex/ASCII import with rhythm alignment, difficulty 1–10, progress/streaks/recommendations,
export/import. Known limits and deviations: [`../TASKS.md`](../TASKS.md) § Decisions and
[`reviews/`](reviews/R3.md). Needs the owner's guitar for final checks: [manual-test-checklist.md](manual-test-checklist.md).

**Run it:** see the command table in [`../CLAUDE.md`](../CLAUDE.md) (`npm install`, `npm run dev`).

## Read next
| Doc | What it covers |
|---|---|
| [spec.md](spec.md) | Owner's original spec: scope source of truth |
| [user-profile.md](user-profile.md) | Player profile that shapes defaults and difficulty |
| [architecture.md](architecture.md) | Modules, process boundaries, data flow, API, storage, file ownership |
| [timing.md](timing.md) | AudioContext clock, scheduling, calibration, speed, loops, backing alignment |
| [game-mechanics.md](game-mechanics.md) | Timing windows, judge algorithm, score, stars, results, cues, keyboard mode |
| [audio-input.md](audio-input.md) | Device selection, level meter, tuner, pitch/onset worklet, recorded-guitar results |
| [monitoring.md](monitoring.md) | Low-latency monitoring, amp/cab sim, latency display, feedback guard |
| [song-formats.md](song-formats.md) | Internal song model, alphaTab/MusicXML/alphaTex/ASCII import, ClassTab pairing |
| [difficulty.md](difficulty.md) | Difficulty formula, 1–10 scale and tiers, calibration, worked example |
| [progress.md](progress.md) | IndexedDB stores, mastery, streaks, recommendations, export format |
| [sources/](sources/README.md) | Song source adapters and each source's terms |
| [research/learning.md](research/learning.md) | Practice research mapped to features and parameters |
| [research/libraries.md](research/libraries.md) | Library choices, pinned versions, verified APIs |
| [reviews/](reviews/R1.md) | Review rounds R1–R3 with findings and fix status |
| [manual-test-checklist.md](manual-test-checklist.md) | Owner's hands-on checks (guitar, latency, calibration) |
