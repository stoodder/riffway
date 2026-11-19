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
Per section with duration `T` seconds:
- **Sections:** `Song.sections`; a section shorter than 2 s merges into the next one (the last one, if
  short, into the previous), names joined with " + "; `sectionIndex` is the first merged index. A song
  without sections is one span "Whole song" from 0 to its end.
- **Onset groups** `G` (`onsetGroups`, `src/core/model/`): a single note or a chord (same chord id or
  onsets within 10 ms). Tied destinations are excluded. `n = |G|`. A group belongs to the section
  whose start is the latest one ≤ its time.
- **Positions and shifts** from `src/core/handpos/` (the window rule in
  [game-mechanics.md](game-mechanics.md#hand-position-cue)). A shift's `|Δlo|` counts in the section
  where the new position starts. Every `lo` change counts, including 1-fret ones (cues need ≥ 2).
  "Fretted" means fret > 0 and not a dead note, everywhere below.
- Effective tempo `bpm` = duration-weighted mean of the tempo map over the section (the first tempo
  applies before the first change; 120 BPM if the map is empty).

## Factors
| Factor | Measure | Normalised `c` |
|---|---|---|
| Density | `D = n / T`; `Dp` = max groups with onset in any half-open window `[t, t + 2 s)` ÷ 2 | `clamp((0.6·D + 0.4·Dp − 1) / 7)` |
| Tempo | `bpm` | `clamp((bpm − 60) / 120)` |
| Position shifts | `S = Σ|Δlo| / T` (fret distance of shifts per second) | `clamp(S / 3)` |
| Fret span | `F` = max fretted span (max − min fret) inside one chord, or across 4 consecutive groups in one hand position (all groups when the section has fewer than 4) | `clamp((F − 3) / 3)` |
| String skipping | over consecutive single-note pairs: `K = mean(min(1, max(0, |Δstring| − 1) / 2))`, 0 without pairs | `clamp(K / 0.4)` |
| Techniques | `Tq = Σ w(group) / T`, `w` = sum of distinct technique weights in the group | `clamp(Tq / 2)` |
| Chords | `C = Σ load / T`; load = 0.5 for 2 notes, 1.0 for 3+, +0.5 if fretted span ≥ 3 | `clamp(C / 3)` |

`clamp` limits to [0, 1]. Technique weights: bend 1.0 (+0.5 if ≥ 2 semitones), harmonic 0.8, slide 0.6,
hammer-on / pull-off 0.5 (on the origin note; `legatoDest` adds nothing), vibrato 0.3, dead note 0.2,
palm mute 0.1, let ring 0, ghost 0.

```
raw     = 0.35 c_den + 0.05 c_tempo + 0.15 c_shift + 0.10 c_span + 0.10 c_skip + 0.15 c_tech + 0.10 c_chord
section = round1(1 + 9 × raw)
song    = round1(0.7 × max(section over sections ≥ 4 s, or all if none) + 0.3 × Σ(section × T) / ΣT)
tier    = clamp(round(rating), 1, 10)
```

The report (`DifficultyReport` in `shared/song.ts`) keeps every factor's raw measure and `c` per
section, so the song page can show *why*. `provisional` is set for `needs-alignment` songs.

**Skill tags** (`skills`, feed `SongTags.skills`), in this order:
| Tag | Rule |
|---|---|
| `bends` | groups with a bend ≥ max(3, 5% of all groups) |
| `legato` | groups with a hammer-on / pull-off origin ≥ max(3, 5% of all groups) |
| `chords` | chord groups ≥ max(4, 25% of all groups) |
| `string-skipping` | some section has `c_skip ≥ 0.5` (`K ≥ 0.2`) |
| `position-shifts` | some section has `c_shift ≥ 1/3` (`S ≥ 1` fret/s) |

**Highlights** (`highlights`): factors whose peak `c` over sections is ≥ 0.4, ordered by peak
`weight × c`, at most 3. Phrases: density "dense, fast notes", tempo "fast tempo", shifts "fast
position shifts", span "wide fret stretches", skipping "string skipping", techniques
"technique-heavy", chords "frequent chords".

## Worked example
"Power Chord Drive", one 4-bar section in 4/4 at 120 BPM (T = 8 s): eighth-note palm-muted power
chords, one per bar: A5 (low E 5/7) → C5 (8/10) → G5 (3/5) → E5 (A string 7/9), 8 per bar.

| Factor | Measure | c | w·c |
|---|---|---|---|
| Density | n = 32, D = 4.0, Dp = 4.0 → (2.4 + 1.6 − 1) / 7 | 0.429 | 0.150 |
| Tempo | 120 BPM → 60 / 120 | 0.500 | 0.025 |
| Shifts | lo 5 → 8 → 3 → 7: Σ = 3 + 5 + 4 = 12; S = 1.5 | 0.500 | 0.075 |
| Span | F = 2 | 0 | 0 |
| Skipping | no single-note pairs | 0 | 0 |
| Techniques | 32 × 0.1 (palm mute) / 8 = 0.4 | 0.200 | 0.030 |
| Chords | 32 × 0.5 / 8 = 2.0 | 0.667 | 0.067 |

raw = 0.347 → rating = 1 + 9 × 0.347 = **4.1**, tier 4 (Developing). Skills `chords`,
`position-shifts`; highlights "dense, fast notes", "fast position shifts", "frequent chords". The
hand-position cues appear 0.75 s (1.5 beats) before each shift, at 1.25, 3.25 and 5.25 s.

(A D5 at 10/12 after the C5 would *not* shift: 8–12 fits one 5-fret window from fret 7.)

For contrast, the opening phrase of "Ode to Joy" on the top two strings in quarter notes at 100 BPM
(4 bars, 15 notes, T = 9.6 s; D ≈ 1.56, Dp = 2, no shifts, skips or techniques) gives raw ≈ 0.054 →
**1.5**, tier 2.

## Known limits
- Fingerstyle pieces are rated for the left hand and density; right-hand pattern difficulty is not modelled.
- ASCII tabs with `needs-alignment` get a provisional rating from proportional onsets, marked "≈".
- Ratings describe the arrangement at 100% speed; the speed trainer handles personal difficulty.
- The 2 s merge and 4 s hardest-section thresholds are in seconds, so a large tempo change can move a
  very short section across them; otherwise a faster tempo, more shifts or more techniques never
  lower a rating (tested).

## Tests
`tests/difficulty/` and `tests/handpos/`: unit tests per factor on hand-built `Song` fixtures
(`tests/difficulty/song-builder.ts`), the worked example above as a golden test (every measure, 4.1),
the Ode-to-Joy fixture (1.5 ± 0.2), seeded monotonicity properties (tempo, techniques, shifts), and a
5,000-note song analysed in < 20 ms. The starter calibration test lives with T-029.
