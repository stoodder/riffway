# Difficulty

## Summary
- Every section and every song (arrangement) gets a **rating from 1.0 to 10.0** and a **tier** (the
  rounded rating) with a name. Computed from the `Song` model by `src/core/difficulty/`, at 100% speed.
- Seven measurable factors, each normalised to 0–1, combined with fixed weights:
  density 0.35 · tempo 0.05 · position shifts 0.10 · fret span 0.05 · string skipping 0.25 ·
  techniques 0.15 · chords 0.05.
- `rating = 1 + 9 × raw`. Song rating = 0.7 × hardest section + 0.3 × duration-weighted mean.
- Constants live in `src/core/difficulty/constants.ts`. They are calibrated so every starter item
  lands within ±1 of its target tier ([Calibration](#calibration)). Change constants → update this doc.

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
| Density | `D = n / T`; `Dp` = max groups with onset in any half-open window `[t, t + 2 s)` ÷ 2 | `clamp((0.6·D + 0.4·Dp − 1) / 4.5)` |
| Tempo | `bpm` | `clamp((bpm − 60) / 120)` |
| Position shifts | `S = Σ|Δlo| / T` (fret distance of shifts per second) | `clamp(S / 3)` |
| Fret span | `F` = max fretted span (max − min fret) inside one chord, or across 4 consecutive groups in one hand position (all groups when the section has fewer than 4) | `clamp((F − 3) / 3)` |
| String skipping | over consecutive single-note pairs: `K = mean(min(1, max(0, |Δstring| − 1) / 2))`, 0 without pairs | `clamp(K / 0.25)` |
| Techniques | `Tq = Σ w(group) / T`, `w` = sum of distinct technique weights in the group | `clamp(Tq)` |
| Chords | `C = Σ load / T`; load = 0.5 for 2 notes, 1.0 for 3+, +0.5 if fretted span ≥ 3 | `clamp(C / 3)` |

`clamp` limits to [0, 1]. Technique weights: bend 1.0 (+0.5 if ≥ 2 semitones), harmonic 0.8, slide 0.6,
hammer-on / pull-off 0.5 (on the origin note; `legatoDest` adds nothing), vibrato 0.3, dead note 0.2,
palm mute 0.1, let ring 0, ghost 0.

```
raw     = 0.35 c_den + 0.05 c_tempo + 0.10 c_shift + 0.05 c_span + 0.25 c_skip + 0.15 c_tech + 0.05 c_chord
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
| `string-skipping` | some section has `c_skip ≥ 0.8` (`K ≥ 0.2`) |
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
| Density | n = 32, D = 4.0, Dp = 4.0 → (2.4 + 1.6 − 1) / 4.5 | 0.667 | 0.233 |
| Tempo | 120 BPM → 60 / 120 | 0.500 | 0.025 |
| Shifts | lo 5 → 8 → 3 → 7: Σ = 3 + 5 + 4 = 12; S = 1.5 | 0.500 | 0.050 |
| Span | F = 2 | 0 | 0 |
| Skipping | no single-note pairs | 0 | 0 |
| Techniques | 32 × 0.1 (palm mute) / 8 = 0.4 | 0.400 | 0.060 |
| Chords | 32 × 0.5 / 8 = 2.0 | 0.667 | 0.033 |

raw = 0.402 → rating = 1 + 9 × 0.402 = **4.6**, tier 5 (Intermediate). Skills `chords`,
`position-shifts`; highlights "dense, fast notes", "technique-heavy", "fast position shifts"
("frequent chords" qualifies too but ranks fourth). The hand-position cues appear 0.75 s (1.5 beats)
before each shift, at 1.25, 3.25 and 5.25 s.

(A D5 at 10/12 after the C5 would *not* shift: 8–12 fits one 5-fret window from fret 7.)

For contrast, the opening phrase of "Ode to Joy" on the top two strings in quarter notes at 100 BPM
(4 bars, 15 notes, T = 9.6 s; D ≈ 1.56, Dp = 2, no shifts, skips or techniques) gives raw ≈ 0.074 →
**1.7**, tier 2.

## Known limits
- Fingerstyle pieces are rated for the left hand and density; right-hand pattern difficulty is not modelled.
- ASCII tabs with `needs-alignment` get a provisional rating from proportional onsets, marked "≈".
- Ratings describe the arrangement at 100% speed; the speed trainer handles personal difficulty.
- Two-voice fingerstyle (melody over an independent bass or arpeggio) is rated by its density, pinches
  (2-note chords) and string skipping only; voice independence itself is not measured. The starter's
  two such pieces rate about one tier below their targets ([Calibration](#calibration)).
- The 2 s merge and 4 s hardest-section thresholds are in seconds, so a large tempo change can move a
  very short section across them; otherwise a faster tempo or more techniques never lower a rating
  (tested).
- More position shifts almost never lower a rating, with one exception (R1-C-06): fret span is measured
  inside one hand position, so a new shift that splits a wide-span run can remove that span. The
  dip is at most `0.05 × 9 × c_span` (≤ 0.45 points) minus what the shift adds.

## Calibration
The starter library (`starter/manifest.json`, `targetTier` per item, tiers 1–6) is the calibration
set. Its targets come from what each arrangement teaches (`starter/README.md`); the constants are
tuned so the real pipeline (server indexer → `loadSong` → `analyzeDifficulty`) puts every item
within ±1 tier of its target, with few, round, explainable changes rather than a best fit.

T-029 found the original constants compressed the library into ratings 1.2–4.5: three items missed
by two or more tiers (Pentatonic Box Lick 3.3 for 5, Spanish Romance 3.3 and Bourrée 3.2 for 6). The
changes, each with its reason:

| Constant | Was | Now | Why |
|---|---|---|---|
| Density scale | 7 | 4.5 | `c = 1` at 5.5 groups/s (sixteenths at ~83 BPM), the speed of the tier-5 picking exercise. The old ceiling of 8 groups/s was never approached (library maximum 5.9, `c` 0.70), so the heaviest factor used only its lower part on tier 1–6 material. The offset stays 1 (one note per second is free), so tier-1 material stays tier 1. Harder repertoire must add other demands to climb further. |
| Techniques scale | 2 | 1 | `c = 1` at one weight unit per second (a bend, or two hammer-ons, every second). At 2 no starter section passed 0.5, so the technique lesson (Pentatonic Box Lick) rated two tiers low. |
| Skipping weight | 0.10 | 0.25 | String skipping is the only factor that sees the picking hand ([Known limits](#known-limits)). The player picks ([user-profile.md](user-profile.md)), and arpeggio and two-voice pieces (Rising Sun, Spanish Romance, Bourrée) rated 1–3 tiers low. |
| Skipping scale | 0.4 | 0.25 | `c = 1` when every other note pair skips one string (`K = 0.25`); arpeggio patterns reach it. |
| Shifts weight | 0.15 | 0.10 | The fret distance per second saturates on short power-chord passages (In the Hall of the Mountain King, 7.5 frets/s) and on natural harmonics at frets 12/7/5. Hand-position cues announce every shift of ≥ 2 frets in advance. |
| Span weight | 0.10 | 0.05 | No starter section spans more than 4 frets (`c` ≤ 0.33), and the span is measured inside one hand position, so a shift can remove it (R1-C-06). The lower weight halves that dip. |
| Chords weight | 0.10 | 0.05 | Starter chords are mostly 2–3-note power chords and bass-plus-melody pinches. Each chord already counts in density, and its moves count as shifts, so power-chord items rated above their targets. |
| `string-skipping` tag | `c_skip ≥ 0.5` | `c_skip ≥ 0.8` | Keeps the tag at `K ≥ 0.2` under the new scale. |

The weights still sum to 1. Everything else (tempo, the remaining scales, technique weights, chord
loads, section rules, song aggregation) is unchanged.

| Item | Target | Before | After |
|---|---|---|---|
| Open Strings & First Frets | 1 | 1.2 | 1.3 |
| Ode to Joy | 2 | 1.6 | 1.9 |
| Power Chord Drive | 3 | 3.5 | 3.6 |
| Greensleeves | 3 | 1.5 | 1.9 |
| Scarborough Fair | 3 | 2.1 | 3.3 |
| Drop-D Palm-Mute Chug | 4 | 3.5 | 4.3 |
| House of the Rising Sun | 4 | 3.1 | 5.1 |
| In the Hall of the Mountain King | 5 | 4.1 | 4.3 |
| Pentatonic Box Lick | 5 | 3.3 | 4.6 |
| Alternate Picking Builder | 5 | 4.5 | 5.1 |
| Carol of the Bells | 5 | 3.6 | 4.2 |
| Für Elise (Theme) | 5 | 4.1 | 5.2 |
| Spanish Romance | 6 | 3.3 | 4.6 |
| Bourrée in E minor | 6 | 3.2 | 4.8 |

After: every item within ±1 (7 exact), Spearman rank correlation with the targets 0.60 → 0.76,
mean |rating − target| 1.13 → 0.61. Known residuals: the two-voice fingerstyle pieces still rate a
tier low (voice independence is not measured) and House of the Rising Sun a tier high (its
arpeggios skip strings constantly, which fingers handle more easily than a pick). Spanish Romance
sits 0.1 above the ±1 edge, so an arrangement change can tip it.

## Tests
`tests/difficulty/` and `tests/handpos/`: unit tests per factor on hand-built `Song` fixtures
(`tests/difficulty/song-builder.ts`), the worked example above as a golden test (every measure, 4.6),
the Ode-to-Joy fixture (1.5 ± 0.2), seeded monotonicity properties (tempo, techniques, shifts), and a
5,000-note song analysed in < 20 ms. `tests/difficulty/doc-sync.test.ts` checks this doc's weights
and worked example against the code.

`tests/integration/` runs the real server indexer, importers and analysis end to end:
`starter-calibration.test.ts` checks every starter item against its target (±1 tier, rank
correlation ≥ 0.7, mean error ≤ 0.75), tuning, tags, search and the served file; and
`fixture-formats.test.ts` does the same for Guitar Pro, MusicXML/MXL, ASCII (with and without a
paired MIDI) and alphaTex fixtures.
