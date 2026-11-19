# Difficulty

## Summary
- Every section and every song (arrangement) gets a **rating from 1.0 to 10.0** and a **tier** (the
  rounded rating) with a name. Computed from the `Song` model by `src/core/difficulty/`, at 100% speed.
- Seven measurable factors, each normalised to 0–1, combined with fixed weights:
  density 0.35 · tempo 0.05 · position shifts 0.15 · fret span 0.10 · string skipping 0.10 ·
  techniques 0.15 · chords 0.10.
- `rating = 1 + 9 × raw`. Song rating = 0.7 × hardest section + 0.3 × duration-weighted mean.
- Constants live in `src/core/difficulty/constants.ts`. They are calibrated so every starter item
  lands within ±1 of its target tier (test in T-029). Change constants → update this doc.

| Tier | 1–2 | 3–4 | 5–6 | 7–8 | 9–10 |
|---|---|---|---|---|---|
| Name | Beginner | Developing | Intermediate | Advanced | Expert |

The player profile puts comfort around tiers 2–4; the starter library spans 1–6.

## Inputs
Per section with duration `T` seconds (sections shorter than 2 s merge into the next):
- **Onset groups** `G`: a single note or a chord (same chord id or onsets within 10 ms). Tied
  destinations are excluded. `n = |G|`.
- **Positions and shifts** from `src/core/handpos/` (the window rule in
  [game-mechanics.md](game-mechanics.md#hand-position-cue)).
- Effective tempo `bpm` = duration-weighted mean of the tempo map over the section.

## Factors
| Factor | Measure | Normalised `c` |
|---|---|---|
| Density | `D = n / T`; `Dp` = max groups in any 2 s window ÷ 2 | `clamp((0.6·D + 0.4·Dp − 1) / 7)` |
| Tempo | `bpm` | `clamp((bpm − 60) / 120)` |
| Position shifts | `S = Σ|Δlo| / T` (fret distance of shifts per second) | `clamp(S / 3)` |
| Fret span | `F` = max fret span of fretted notes inside one chord, or across 4 consecutive groups with no shift between them | `clamp((F − 3) / 3)` |
| String skipping | over consecutive single-note pairs: `K = mean(min(1, max(0, |Δstring| − 1) / 2))` | `clamp(K / 0.4)` |
| Techniques | `Tq = Σ w(group) / T`, `w` = sum of distinct technique weights in the group | `clamp(Tq / 2)` |
| Chords | `C = Σ load / T`; load = 0.5 for 2 notes, 1.0 for 3+, +0.5 if span ≥ 3 | `clamp(C / 3)` |

`clamp` limits to [0, 1]. Technique weights: bend 1.0 (+0.5 if ≥ 2 semitones), harmonic 0.8, slide 0.6,
hammer-on / pull-off 0.5, vibrato 0.3, dead note 0.2, palm mute 0.1, let ring 0.

```
raw     = 0.35 c_den + 0.05 c_tempo + 0.15 c_shift + 0.10 c_span + 0.10 c_skip + 0.15 c_tech + 0.10 c_chord
section = round1(1 + 9 × raw)
song    = round1(0.7 × max(section over sections ≥ 4 s) + 0.3 × Σ(section × T) / ΣT)
tier    = clamp(round(rating), 1, 10)
```

The report (`DifficultyReport` in `shared/song.ts`) keeps every factor's raw measure and `c`, so the
song page can show *why* ("fast position shifts", "string skipping") and skill tags can be derived
(e.g. `c_tech ≥ 0.4` with bends → `bends`).

## Worked example
"Power Chord Drive", one 4-bar section in 4/4 at 120 BPM (T = 8 s): eighth-note palm-muted power
chords A5 (frets 5/7) → C5 (8/10) → D5 (10/12) → G5 (3/5), 8 per bar.

| Factor | Measure | c | w·c |
|---|---|---|---|
| Density | n = 32, D = 4.0, Dp = 4.0 → (2.4 + 1.6 − 1) / 7 | 0.429 | 0.150 |
| Tempo | 120 BPM → 60 / 120 | 0.500 | 0.025 |
| Shifts | lo 5 → 8 → 10 → 3: Σ = 3 + 2 + 7 = 12; S = 1.5 | 0.500 | 0.075 |
| Span | F = 2 | 0 | 0 |
| Skipping | no single-note pairs | 0 | 0 |
| Techniques | 32 × 0.1 (palm mute) / 8 = 0.4 | 0.200 | 0.030 |
| Chords | 32 × 0.5 / 8 = 2.0 | 0.667 | 0.067 |

raw = 0.347 → rating = 1 + 9 × 0.347 = **4.1**, tier 4 (Developing). For contrast, a quarter-note
"Ode to Joy" melody at 100 BPM (D ≈ 1.67, few skips, no techniques) gives raw ≈ 0.05 → **1.5**, tier 2.

## Known limits
- Fingerstyle pieces are rated for the left hand and density; right-hand pattern difficulty is not modelled.
- ASCII tabs with `needs-alignment` get a provisional rating from proportional onsets, marked "≈".
- Ratings describe the arrangement at 100% speed; the speed trainer handles personal difficulty.

## Tests
Unit tests per factor on hand-built `Song` fixtures, the worked example above as a golden test
(4.1 ± 0.05), monotonicity checks (faster tempo → higher rating), and the starter calibration test.
