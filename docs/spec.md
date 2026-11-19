# Riffway — original product spec (verbatim from the owner, 2026-11-19)

> Source of truth for scope. Brainstorm answers are in docs/user-profile.md.
> Deviations decided during the build are logged in TASKS.md ("Decisions").

## Goal
Build an interactive guitar-learning web app that turns guitar tabs into a playable rhythm game in the spirit of Guitar Hero / Rocksmith. I play along on a real 6-string electric guitar plugged into my computer; the app lets me hear myself, listens to what I play, scores my timing and pitch, and helps me learn songs progressively. It should be fun enough that I want to come back, and effective enough that I actually improve. I want access to as much music as possible, through legitimate means.

## About me
- Setup: electric guitar → Cubilux USB-C to 1/4" cable → Mac, running Chrome.
- (Brainstorm answers: see docs/user-profile.md)

## Platform & stack
- Local-only app: Vite + TypeScript frontend, plus a small local Node companion server for folder indexing, source indexes, and proxying API requests the browser can't make directly. One command starts both (`npm run dev`); also provide an optimized local build. No hosting or deployment.
- Must work in current Chrome on macOS.
- Standard 6-string guitar, standard tuning by default (support alternate tunings like Drop D when the song file specifies them). No bass / 7-string.

## Core experience
- Notes scroll **horizontally** (right → left) toward a fixed hit line on the left. Six lanes, one per string, oriented like standard tab (high e on top, low E on bottom). Each note shows its fret number.
- Game mechanics must still hold up horizontally: timing windows (Perfect / Great / Good / Miss), combo/streak multiplier, score, accuracy %, star rating per song, and an end-of-song results screen.
- Judge pitch and timing separately: distinguish a wrong note from an early/late note and from a miss, and show that feedback clearly.
- Show a hand-position cue ahead of fret-position shifts.
- Render technique markings where the source has them (hammer-on, pull-off, slide, bend, palm mute). Detecting them is a stretch goal; displaying them is not.
- Practice tools: speed control without pitch change, A/B section looping, a speed trainer that raises tempo after clean runs, count-in, and metronome.

## Guitar input
- The Cubilux cable appears as a standard class-compliant audio input. The app must:
  - list available input devices, let me pick one, and remember the choice
  - show a live input level meter and a built-in tuner
  - include a latency calibration step and apply the offset to scoring
  - request the input with echo cancellation, noise suppression, and auto gain all disabled
- Pitch detection: make single-note detection solid first. Chord detection is a stretch goal; until then, score chords leniently (e.g., onset + any chord tone) and be transparent in the UI about how chords are judged.
- Keyboard input mode: keys map to lanes/notes so the game can be played and tested without a guitar.

## Monitoring & audio
- There's no amp in my chain, so route my guitar signal to the output so I can hear myself, with a simple amp/cab simulation (at least clean and overdrive presets). Optimize for low latency, show the measured monitoring latency, and recommend headphones in the UI.
- Backing audio: let me attach an audio file I own (MP3/WAV/M4A) to a song and align it to the tab (offset plus beat/tempo alignment). Fall back to synthesized guide playback from the tab when no audio is attached.
- Mixer with independent levels for guitar monitor, backing track, guide synth, and metronome.

## Timing & performance
- All note scheduling and hit judgment run on the AudioContext clock. The renderer only reads that clock; it never drives timing.
- Do audio processing (pitch detection, monitoring, amp sim) in AudioWorklets.
- Render the note highway with canvas or WebGL at a smooth 60fps, including on long, dense songs.

## Song sources & library
Timing gameplay needs rhythm data, not just fret numbers. Build one unified, searchable library fed by pluggable **source adapters** (a shared interface so new sources can be added later).

Ground rules for every adapter: verify the source's current terms before building it; use only official/public APIs or downloads the source itself offers; never fetch tab content from undocumented endpoints or bypass logins or paywalls. Document each source's terms and approach in docs/sources/.

Adapters for this iteration:
1. **Local library folder:** I point the app at a folder (e.g. ~/Music/Tabs). The companion server watches and indexes Guitar Pro (.gp, .gp3–.gp5, .gpx), MusicXML, and ASCII tab files so everything I download is searchable in-app. Drag-and-drop import copies files into this folder.
2. **Songsterr catalog search:** use Songsterr's public search API to search their catalog (title, artist, tracks, tuning) from inside the app. Results link out to the song on Songsterr; I bring it in by importing the Guitar Pro file. Results already in my local library show as playable.
3. **ClassTab:** download and index the whole-site zip that ClassTab.org offers (tabs + MIDI, updated monthly), with a refresh command. Pair each ASCII tab with its MIDI file to derive rhythm; where pairing fails, mark the song "needs rhythm alignment."
4. **Ultimate Guitar:** no automated access. Provide a "Search on Ultimate Guitar" button that opens their search in a new browser tab, plus the ASCII paste flow below.
5. **More sources:** research other legitimate sources (official APIs, public-domain / Creative Commons collections, free packs such as Guitar Pro's free riffs/licks/exercises pack). Add them to TASKS.md as candidate adapters with notes on terms and effort; implement the clearly permitted, low-effort ones.

Import formats:
- **Guitar Pro & MusicXML:** evaluate alphaTab (or similar) for parsing, rendering, and synthesized playback.
- **ASCII tab (paste or file):** BPM input plus a rhythm-alignment step (e.g., tap-along or snap-to-grid). Make it as painless as possible.

Search UI: one search box across all sources, with filters for source, difficulty, tuning, and "playable now" vs "needs import."

Starter library: a handful of public-domain songs and original exercises spanning beginner → intermediate (calibrated to my skill level), committed to the repo so the app is playable out of the box.

## Data & storage
- Song files live in the local library folder (gitignored, never committed).
- Progress, scores, settings, and audio-file links live in IndexedDB.
- Export/import progress and settings as a JSON file for backup.

## Difficulty & progression
- Compute a difficulty rating per song and per section from measurable factors: tempo, note density, fret span and position shifts, string skipping, techniques, chord count. Document the formula in docs/ and show it as a clear tier or 1–10 scale.
- Track progress: best scores, accuracy history, sections mastered, practice streaks. Recommend what to play next based on my results and goals.

## Learning research
Before designing features, research what makes music practice both fun and effective (e.g., dynamic difficulty à la Rocksmith, slow-to-fast tempo ramping, chunking and looping hard sections, immediate feedback, spaced repetition, warm-ups, streaks/goals that motivate without dark patterns). Write findings with sources to docs/research/learning.md and map each finding to a concrete feature or a deliberate decision not to build it.

## UI
Sleek, intuitive, and fun. Clear hierarchy, responsive animations, satisfying hit feedback, readable at a glance while I'm playing. Keyboard navigation for menus is a nice-to-have.

## Testing (phase 5)
- Unit tests for parsing, difficulty scoring, hit judgment, and each source adapter (recorded fixture responses, not live network).
- Audio pipeline tests with generated tones and recorded guitar samples (no live guitar available to the agent), including timing-accuracy checks.
- Playwright end-to-end tests, played via keyboard input mode, that capture screenshots of key screens.
- A manual test checklist for the owner covering guitar input, monitoring latency, and calibration.

## Definition of done (this iteration)
- I can select my USB guitar input, tune, and calibrate latency.
- I can hear my guitar through the app with an amp sim at acceptable latency.
- I can search my local library, ClassTab, and the Songsterr catalog from one search box, and import and play results.
- I can import a Guitar Pro or MusicXML file, or paste an ASCII tab, and play it as a horizontal-scroll game with live scoring that distinguishes wrong notes from timing errors.
- I can attach an audio file I own to a song and play along to it in sync.
- A starter library with difficulty ratings is included.
- Speed control and A/B looping work.
- Songs, progress, and settings persist between sessions, and progress can be exported/imported.
- Tests pass, review rounds are complete, docs are current, and the branch is merged to main.

## Out of scope (for now)
Hosting/deployment, accounts/cloud sync, multiplayer, mobile, bass/7-string, and automated access to any site that doesn't permit it (including Ultimate Guitar).
