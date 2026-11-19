# Recorded test audio: attribution and provenance

Short excerpts of real guitar recordings used by the audio-pipeline tests (`tests/audio-pipeline/`,
T-036, decision DEC-22). They are test fixtures only and are not shipped with the app.
`scripts/fetch-audio-fixtures.ts` downloads the sources and rebuilds every file here byte for byte;
`annotations.json` lists each clip's reference notes, its source files and their SHA-256.

All clips are 48 kHz mono 16-bit WAV, resampled from the originals (Kaiser-windowed sinc),
high-passed at 30 Hz (zero-phase; removes sub-audio rumble, as an AC-coupled guitar input would) and
faded in (5 ms) and out (30 ms). Nothing else is changed.

## `iowa-single-notes.wav`

15 single notes, E2–A5 on all six strings (13 *mf*, 2 *pp*), each in a 0.6 s slot with the attack
at 0.12 s.

- **Source:** University of Iowa Electronic Music Studios, *Musical Instrument Samples* — Guitar
  (Raimundo 118, performer Brian Penkrot, recorded 11 December 2011 in an anechoic chamber),
  24-bit/96 kHz mono AIFF chromatic files.
  <https://theremin.music.uiowa.edu/MISguitar.html>
- **Terms:** the collection "may be downloaded and used for any projects, without restrictions".
  Credit given here as a courtesy.
- **Reference onsets** are not published by the source. The fetch script locates each note by hand
  (approximate time listed in the script), takes the first sample of the attack that reaches 10 % of
  its peak, and confirms the pitch with an independent YIN estimate.

## `guitarset-rock1-mic.wav`, `guitarset-rock2-pickup.wav`

Two solo excerpts with their note annotations (onset, offset, pitch, string):

| Clip | GuitarSet track | Audio | Excerpt |
|---|---|---|---|
| `guitarset-rock1-mic.wav` | `01_Rock1-90-C#_solo` | `audio_mono-mic` (acoustic guitar, microphone) | 9.0–13.5 s |
| `guitarset-rock2-pickup.wav` | `03_Rock2-142-D_solo` | `audio_mono-pickup_mix` (hexaphonic pickup, summed to mono) | 6.8–11.4 s |

- **Source:** GuitarSet v1.1.0 — Qingyang Xi, Rachel M. Bittner, Johan Pauwels, Xuzhou Ye and
  Juan P. Bello, "GuitarSet: A Dataset for Guitar Transcription", *Proceedings of the 19th
  International Society for Music Information Retrieval Conference (ISMIR)*, Paris, 2018.
  Zenodo, doi:[10.5281/zenodo.3371780](https://doi.org/10.5281/zenodo.3371780).
- **License:** [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
- **Changes:** excerpted, resampled 44.1 → 48 kHz, high-passed at 30 Hz, faded, converted to 16-bit;
  annotation times shifted to the excerpt start, pitches rounded to MIDI (the exact annotated value is
  kept as `midiExact`).
