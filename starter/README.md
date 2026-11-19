# Starter library

Fourteen songs and exercises that ship with Riffway so the app is useful on day one (D10). Each item
is an alphaTex file, `<slug>.atex`, listed in `manifest.json` (`StarterManifest`, `shared/sources.ts`).
The `starter` source adapter serves them with the song id `starter:<slug>`.

**Every arrangement is original to Riffway.** We wrote all the tablature ourselves: the fingerings,
voicings, riffs, harmonisations, variations and tempo maps. No published arrangement, tab or recording
was copied. The melodies are traditional or by composers who died more than 100 years ago, and the
exercises are our own compositions. Copyrighted later material is never used: lyrics, choral
settings, and the arrangements made famous by recordings.

## Items and provenance

| Tier | Item (`slug`) | Melody and public-domain status | What the arrangement teaches |
|---|---|---|---|
| 1 | Open Strings & First Frets (`open-strings-first-frets`) | Original exercise by Riffway | Open strings, first-position frets, a low-string riff |
| 2 | Ode to Joy (`ode-to-joy`) | Ludwig van Beethoven (1770–1827), Symphony No. 9 (1824). Public domain | Melody in C on the top strings, then an octave lower |
| 3 | Power Chord Drive (`power-chord-drive`) | Original exercise by Riffway | Two- and three-note power chords, palm-muted eighths |
| 3 | Greensleeves (`greensleeves`) | Traditional English, 16th century (printed in the 1580s). Public domain | 3/4 time, hammer-ons and pull-offs, open position |
| 3 | Scarborough Fair (`scarborough-fair`) | Traditional English ballad tune (Child 2, "The Elfin Knight"), in the form commonly sung today. Public domain. Not based on any recorded or published arrangement | Legato, in, out and shift slides; E Dorian |
| 4 | Drop-D Palm-Mute Chug (`drop-d-palm-mute-chug`) | Original exercise by Riffway | **Drop D**: one-finger power chords, palm-muted chugs and gallops, dead notes |
| 4 | House of the Rising Sun (`house-of-the-rising-sun`) | Traditional American folk song of unknown authorship. Public domain. Only the progression it is usually sung over (Am C D F / Am C E) is used, with our own picking patterns | 6/8 arpeggios, alternating bass, pinches, let ring |
| 5 | In the Hall of the Mountain King (`hall-of-the-mountain-king`) | Edvard Grieg (1843–1907), *Peer Gynt* (1875). Public domain | A tempo map that speeds up every bar (84 → 132 BPM), palm mutes, power chords. Target tier 4–5, rated 5 |
| 5 | Pentatonic Box Lick (`pentatonic-box-lick`) | Original exercise by Riffway | Full, half and release bends, hammer-ons, pull-offs, vibrato, triplets, a shift slide |
| 5 | Alternate Picking Builder (`alternate-picking-builder`) | Original exercise by Riffway | Strict alternate sixteenths, pedal point, three notes per string, gallops |
| 5 | Carol of the Bells (`carol-of-the-bells`) | Mykola Leontovych (1877–1921), *Shchedryk* (1916), the four-note ostinato. Public domain. The copyrighted 1936 English lyrics and choral setting are not used; the riff harmony and the lead are our own | A metal ostinato riff, legato bell motif, bends |
| 5 | Für Elise (Theme) (`fur-elise-theme`) | Ludwig van Beethoven, Bagatelle WoO 59 (c. 1810). Public domain | Position shifts between 5th and 12th position, both hands folded into one line, one natural harmonic |
| 6 | Spanish Romance (`spanish-romance`) | Anonymous, "Romance" / "Estudio en Mi" (Spain, late 19th century; earliest sources c. 1900). Public domain. Later claims cover specific arrangements, and none is used here | Fingerstyle triplet arpeggios under a melody voice, plus an original interlude in natural harmonics |
| 6 | Bourrée in E minor (`bourree-in-e-minor`) | Johann Sebastian Bach (1685–1750), Suite BWV 996 (c. 1710). Public domain | Two-voice fingerstyle counterpoint. The lute's low D is raised an octave; the first half is written out twice and the second half is played once |

### Departures from the originals
- **Für Elise:** both hands are folded into one guitar line. The low G in bar 10 is left out, and the
  high E (E6) in bar 13 is played as a 5th-fret natural harmonic.
- **House of the Rising Sun:** a harmonic study on the traditional progression. The vocal melody is not
  included.
- **Carol of the Bells:** the ostinato is Leontovych's. The harmony under it and the lead section are
  Riffway's own.

### How the notes were checked
Melodies were written from knowledge of the tunes, then checked note by note against free editions:

- **Bourrée:** the public-domain Mutopia edition (Mutopia-2011/04/01-1743).
- **Spanish Romance, Für Elise, In the Hall of the Mountain King, Ode to Joy and Greensleeves:** the
  Mutopia Project editions.
- **Scarborough Fair:** the commonly sung form transcribed on Wikipedia.

These editions were used only to verify pitches. Nothing was copied from them, and none of them is
redistributed.

## File conventions
- Header metadata: `\title` (equals the manifest `title`), `\artist`, `\music`, `\tab "Riffway"`,
  `\tempo` (equals the manifest `bpm`; tempo changes per bar are allowed), one `\track` with a
  `{tabs}` staff, a guitar `\instrument` (GM programs 24–31), `\tuning` (standard or Drop D, no capo)
  and `\ts`.
- At least two `\section`s, the first on bar 1. Sections cover whole bars.
- Fingerstyle pieces put the melody in the first `\voice`.
- alphaTex comments are `//` or `/* */`. The `%` character is **not** a comment in alphaTab 1.9.
- `// riffway: tags=<style>,<genre>,…` repeats the manifest tags (`pick`/`fingerstyle` plus genres).
- `// riffway: melody section="<name>" select=<rule> notes="<names>"` lists a section's melody in
  scientific pitch with sharps (`F#4`). `tests/starter/` checks it against the tab. The rules are:
  - `top`: the highest note of every onset.
  - `low`: the lowest note of every onset, for riffs and power chords.
  - `voice1`: the highest note of every onset in voice 1.
  - `downbeat`: the lowest note of each bar's first onset, for chord roots.

  In every rule, tie destinations are skipped.
- alphaTex syntax that is easy to get wrong:
  - Notes are `fret.string`, with string 1 = high e.
  - Hammer-ons and pull-offs are both `{h}`; alphaTab decides the direction from the pitches. `{p}` is
    a *pop* (slap bass), not a pull-off.
  - Legato slide is `{sl}` and shift slide is `{ss}`. Slides in are `{sib}`/`{sia}`; slides out are
    `{sou}`/`{sod}`.
  - Bends are `{b (0 4)}`, with values in quarter-tones (4 = a full step). Bend and release is
    `{b (0 4 4 0)}`.
  - Other note effects: `{pm}` palm mute, `{lr}` let ring, `{v}` vibrato, `{nh}` natural harmonic,
    `x` dead note, `-` tie.
  - Dots and tuplets belong to the beat: write `5.1.4{d}` and `5.1.8{tu 3}`, never `:4{d}`.
  - Metadata arguments go in parentheses, for example `\ts (3 4)` and `\tuning (E4 B3 G3 D3 A2 D2)`.

## Tests
Run `npx vitest run tests/starter`. The tests check that:

- Every file loads with zero alphaTex diagnostics.
- The manifest is complete and the targets cover tiers 1–6.
- Every bar is exactly full.
- Pitches stay between D2 and E6, at fret 22 or lower.
- No string sounds two notes at once.
- Each declared melody matches the tab.
- The library as a whole uses every technique glyph.

Calibrating each item against the computed difficulty is part of T-029.
