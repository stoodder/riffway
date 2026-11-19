# Libraries & techniques survey

> Research for Riffway (2026-11-19). Versions and licenses were checked against registry.npmjs.org on that date.
> Everything marked **verified** was run in a scratch project: Node 22.23.5, Chrome for Testing 153 (headless), Vite 8.3.8.

## TL;DR

| Concern | Pick | Version | License | Why |
|---|---|---|---|---|
| GP / MusicXML / alphaTex import | `@coderline/alphatab` (importer + `MidiFileGenerator` only) | 1.9.0 | MPL-2.0 | **Verified** in plain Node: GP3/GP5/GPX/GP7, MusicXML and alphaTex. Repeats are expanded, and string/fret, tuning, tempo, sections and technique flags all come through |
| alphaTab player | **Don't use it.** Render offline with `AlphaSynth.exportAudio` and schedule the result ourselves | (same) | MPL-2.0; soundfont Apache-2.0 | The player creates its own `new AudioContext()`, a second clock. **Verified**: offline render of a 120 s song took about 0.36 s in Node |
| ASCII tab | Our own parser | — | — | Nothing on npm |
| MIDI (ClassTab) | `@tonejs/midi` | 2.0.28 | MIT | Notes in seconds and ticks, plus a tempo map. **Verified** on alphaTab-exported MIDI |
| Pitch detection | Our own pure-TS MPM, with `pitchy` as test oracle and fallback | pitchy 4.1.0 | MIT | Allocation-free; runs in a worklet and in Node tests. **Verified** pitchy accurate from E2 to E6 |
| Time-stretch (backing audio) | `signalsmith-stretch` | 1.3.2 | MIT | WASM worklet from an inline Blob; `schedule({output, rate, loopStart, loopEnd})` |
| Amp sim | Our own worklet: oversampled soft-clip plus tone stack | — | — | Spec requires worklets; pure-TS DSP is testable |
| Cab sim | Native `BiquadFilterNode` chain, with optional `ConvolverNode` on a synthetic IR | — | — | No added latency, no IR licence issue |
| Guide synth | alphaSynth offline render → `AudioBufferSourceNode.start(when)`. Oscillator clicks for the metronome | — | Apache-2.0 (sonivox.sf2) | Bends, slides and palm mutes are already in the generated MIDI |
| Highway rendering | Canvas 2D with our own code. `pixi.js` only as an escape hatch | pixi 8.23.0 | MIT | Only about 50–300 notes visible at once |
| Server | `fastify` + `@fastify/static` | 5.12.8 / 10.1.11 | MIT | `inject()` tests need no sockets |
| File watching | `chokidar` | 5.0.0 | MIT | ESM. Node ≥20.19. v6.0.0 needs Node ≥22.22 |
| Search index | `minisearch` | 7.2.0 | MIT | Fuzzy and prefix search; serialisable index |
| Zip | `yauzl` | 3.4.0 | MIT | Streaming, mature |
| Dev runner | `concurrently` + `tsx watch`, with Vite `server.proxy` | 10.0.7 / 4.23.15 | MIT | One `npm run dev` |
| Server build | `esbuild` | 0.28.2 | MIT | Bundles to `dist-server/`, which serves `dist/` |
| IndexedDB | `idb` | 8.0.4 | ISC | Tiny wrapper, versioned `upgrade()` |
| Unit tests | `vitest` + `happy-dom` + `fake-indexeddb` | 5.1.1 / 21.0.4 / 6.2.8 | MIT / MIT / Apache-2.0 | Plus `@vitest/browser-playwright` for `OfflineAudioContext` |
| E2E | `@playwright/test` | 1.65.1 | Apache-2.0 | **Verified**: headless Chrome reads a WAV through `getUserMedia` |
| Toolchain | `vite` 8.3.8, `typescript` **6.0.3** | — | MIT / Apache-2.0 | The `typescript-eslint` 8.73 peer range is `<6.1.0`, so TS 7.0.2 (the Go port) would conflict |

## Installed pins (T-010)

`package.json` pins every package exactly (no `^`/`~`); `engines.node` is `>=22.12`, so chokidar stays on 5.0.0.
Survey picks above are installed at the listed versions (TypeScript 6.0.3, not 7). Packages the survey did not
cover, pinned for compatibility on 2026-11-19 (`npm ls` clean):

| Package | Version | Why this version |
|---|---|---|
| `@fastify/multipart` | 10.1.9 | Latest; fastify 5 plugin (multipart import and audio upload) |
| `@vitest/browser-playwright` | 5.1.1 | Must equal vitest 5.1.1 (peer) |
| `playwright` | 1.65.1 | Peer of the Vitest provider; same as `@playwright/test` 1.65.1 |
| `eslint` | 10.15.0 | Within typescript-eslint 8.73 peer range (`^8.57 \|\| ^9 \|\| ^10`) |
| `@eslint/js` | 10.0.1 | Matches ESLint 10 |
| `globals` | 17.14.0 | Browser + Node globals for the flat config |
| `@types/node` | 22.20.5 | Node 22 LTS line (vitest peer `^22 \|\| >=24`) |
| `@types/yauzl` | 3.4.0 | Types for yauzl 3.4.0 |
| `@types/audioworklet` | 0.0.102 | `AudioWorkletGlobalScope` types, used only by `src/audio/worklets/tsconfig.json` (conflicts with the DOM lib) |

Notes:
- Playwright 1.65.1 expects Chromium revision 1255; the agent container ships revision 1243 at
  `/opt/pw-browsers/chromium` (Chrome for Testing 153). `playwright.config.ts` and `vitest.config.ts` pass
  `executablePath` when that path exists; elsewhere run `npx playwright install chromium`.
- `signalsmith-stretch` ships no types; minimal declarations live in `src/types/signalsmith-stretch.d.ts`.
- Server build: `esbuild --bundle --packages=external` resolves the `@shared/*`/`@core/*` tsconfig paths
  before externalising packages (verified), so path aliases need no esbuild plugin.
- Vite `worker.format` is `'es'`; worklets still build to self-contained modules (verified with aliases).

## 1. Tab parsing and rendering: alphaTab

`ScoreLoader.loadScoreFromBytes(bytes)` detects the format: GP3–5, GPX, GP7/8 (`.gp`), MusicXML and CapXML. `ScoreLoader.loadAlphaTex(str)` parses alphaTex. Both work in Node with no DOM (see the verified section). To use it on the server, import `@coderline/alphatab`. In a browser Web Worker, the main entry's `initializeMain()` returns early, so it does not take over `onmessage`. Avoid `@coderline/alphatab/worker`, which does.

alphaTex syntax errors come back as structured diagnostics (code, line and column). That makes alphaTex a good intermediate format for ASCII-tab conversion and for authoring the starter library.

**Player.** `AlphaSynthWebAudioOutputBase` calls `new AudioContext()` with no latency hint and no way to inject our own context. Driving it would mean two clocks, which breaks the spec's single-clock rule. Use only the importer and the offline synth (§7).

**Notation rendering** (an optional "sheet" view later) needs `@coderline/alphatab-vite` 1.9.0 for fonts and workers. It is not needed for the highway.

**Alternatives.** OSMD 2.3.1 (BSD-3) and VexFlow 5.3.0 (MIT) only render; nothing else in JS reads GP3–7. MPL-2.0 is file-level copyleft, so an unmodified dependency is fine.

## 2. ASCII tab

npm has no maintained ASCII-tab parser; searches for "guitar tab parser" and "ascii tab" return nothing relevant. Write our own in pure TS:

1. Find blocks of 6 consecutive lines that match `^[eBGDAE]?\|?[-0-9hpbr/\\~x|()<>.^ ]+`.
2. Read the tuning from the line prefixes, so Drop D is detected.
3. Tokenise column-wise. Handle multi-digit frets, `h p / \ b r ~ x`, and `PM----` lines.
4. Use `|` as bar lines and keep each note's column index.
5. Estimate onsets from proportional column spacing within each bar, then let the rhythm-alignment UI correct them (snap to grid at the given BPM, or tap-along).
6. For ClassTab, prefer the timing from the paired MIDI file (§3) and match notes by pitch sequence.

Output either our `NoteEvent[]` directly or alphaTex, which alphaTab then turns into the same model as GP files.

## 3. MIDI parsing

Use **`@tonejs/midi` 2.0.28** (MIT). `new Midi(bytes)` gives `header.ppq`, `header.tempos`, and per-track `notes[{midi, time (s), ticks, duration}]`, which is what ClassTab pairing needs. Last published in 2022 but stable. Its dependency `midi-file` 1.2.4 (MIT) is there if we need raw events.

**Verified:** alphaTab's `MidiFile.toBinary()` round-trips through `@tonejs/midi` with matching tempos and note times. alphaTab cannot *import* MIDI.

## 4. Pitch, onset and chord detection

**Algorithm.** Use MPM (McLeod NSDF + parabolic peak picking). It needs about 2 periods, has fewer octave errors than plain autocorrelation, and suits guitar, where the low strings have a weak fundamental. YIN is comparable.

**Window.** E2 has a 12.1 ms period, so 2 periods is about 1165 samples at 48 kHz. Use **N=2048 (42.7 ms)** while the expected note is below about 160 Hz, and **N=1024 (21.3 ms)** above that, with a hop of 128–256 samples (2.7–5.3 ms). Computing NSDF through an FFT costs about 0.3 ms per call at N=2048.

**Verified** with a pitchy test signal (a strong 2nd harmonic plus noise): N=1024 and N=2048 both give 82.4, 110.0, 146.8, 196.0, 329.6, 659.2 and 1318.6 Hz with clarity 1.00.

**Onsets.** Take timing from onsets, not from the pitch tracker. The DI guitar signal is clean, so use high-frequency-weighted energy or spectral flux on 128–256-sample hops with adaptive thresholds. Add a pitch-change onset for hammer-ons, pull-offs and slides. Judge pitch from frames 20–40 ms *after* the onset, because the attack is inharmonic. Report onset time as `currentTime`-based sample frames, minus the calibration offset.

**Chords (later).** We already know which notes to expect, so treat this as *verification*, not recognition:

- Use a harmonic-weighted chroma vector compared to the expected chord template (cosine similarity).
- Or measure salience at each expected f0 (harmonic sum).

Reject `@spotify/basic-pitch`: polyphonic but TF.js-heavy and not real-time.

**Recommendation.** Port MPM into `src/dsp/pitch.ts`: pure TS, preallocated buffers, and a small radix-2 FFT. Run it in the worklet and in Vitest. Use `pitchy` as a dev-dependency oracle. pitchy allocates result arrays on each call, which we want to avoid on the audio thread.

## 5. Time-stretching (backing audio)

- **`signalsmith-stretch` 1.3.2 — pick.** MIT; the upstream C++ is MIT too.
  - It is a WASM AudioWorklet registered from an inline `Blob`, so Vite needs no configuration.
  - Buffer mode: `addBuffers([L, R])`, then `schedule({ output: ctxTime, input: sec, rate, loopStart, loopEnd })`. The built-in loop region maps directly to A/B looping, and changing `rate` covers the speed trainer.
  - Schedule changes at least `latency()` seconds ahead. Quality is best from 0.75× to 1.5×.
- **`@soundtouchjs/audio-worklet` 2.1.1** (MPL-2.0; legacy `soundtouchjs` 0.3.0 is LGPL-2.1) is a usable fallback with lower quality.
- **`rubberband-wasm` 3.3.0** (GPLv2): reject on licence.

Chrome's `decodeAudioData` handles MP3, WAV and M4A/AAC. The guide synth never needs stretching: re-render or re-schedule it at the new tempo.

## 6. Amp/cab sim and low-latency monitoring

**Amp.** Build one AudioWorklet that runs input gain → 4× oversampled (polyphase half-band FIR) asymmetric `tanh` clipper → tone-stack biquads, all in pure-TS DSP. Presets are *clean* (low drive) and *overdrive*. FIR group delay at 4× is a few samples at 48 kHz, which is negligible. `WaveShaperNode` with `oversample:'4x'` is a reasonable baseline to A/B against, but the spec asks for a worklet.

**Cab.** Chain native `BiquadFilterNode`s: high-pass about 80 Hz, a peak around 120 Hz, a dip around 400 Hz, a presence peak around 2.5 kHz, and low-pass around 5–6 kHz. Free cab IR packs usually forbid redistribution. If we want convolution, render a synthetic IR offline from that filter chain and feed it to `ConvolverNode`.

**Context and input:**

- Create `new AudioContext({ latencyHint: 0, sampleRate: 48000 })` with the rate matched to the device, so Chrome doesn't resample. **Verified**: `baseLatency` = 128/48000 = 2.67 ms.
- Call `getUserMedia({ audio: { deviceId: {exact}, echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:1, sampleRate:48000 } })`, then read back `track.getSettings()`. Headless Chrome reported `channelCount: 2` and `sampleRate: 44100` despite these constraints, so always read the actual values and take channel 0.
- Choose the output device with `ctx.setSinkId()`.

**Estimate shown in the UI:**

```
track.getSettings().latency  +  ctx.baseLatency  +  ctx.outputLatency  +  worklet quantum (128/sr)
```

Chrome reports a constant 10 ms for `latency`, and `outputLatency` is only an estimate (8 ms in headless). Published measurements put Chrome on macOS at about 20–70 ms round trip.

**Calibration:**

1. **Play-to-click** (Rocksmith-style; this one drives the scoring offset). The user plays an open string on 8–16 metronome clicks. Take offset = median(detected onset − scheduled click) and reject outliers. This captures output latency + input latency + human bias, which is exactly what judgment needs.
2. **Visual offset.** Tap a key as a flash crosses the hit line, so the highway is drawn `outputLatency` ahead.
3. **Loopback** (optional, for an interface with a free output): route a click from out to in and cross-correlate. The Cubilux cable is input-only, so this stays optional.

## 7. Guide synth

Use **alphaSynth offline rendering**:

1. Run `MidiFileGenerator` and load `sonivox.sf2` (Apache-2.0, 1.35 MB, ships in the package with GM guitar programs).
2. `AlphaSynth.exportAudio(opts, midiFile, [], gen.transpositionPitches)`, then `render(ms)`, which returns interleaved stereo Float32 chunks.
3. Do this in a Web Worker and transfer the PCM to the main thread.
4. Build `AudioBuffer`s and call `AudioBufferSourceNode.start(when, offset)` on *our* context.

Bends, slides, palm mutes and vibrato are already in the MIDI. For a speed change, scale the tempo automations and re-render (about 300× real time). For A/B loops, schedule bar-aligned buffer slices using the sync-point times.

Karplus-Strong would mean re-implementing techniques. Oscillators suit only the metronome and count-in.

## 8. Highway rendering

Use **Canvas 2D** on one full-window canvas. Keep the PixiJS (8.23.0) option behind a `HighwayRenderer` interface.

**Each frame:**

- `songMs = (ctx.getOutputTimestamp().contextTime − startCtxTime) × 1000 × speed − visualOffset`
- Find the visible window by **binary search** over notes sorted by `timeMs`, for `[songMs − behind, songMs + lookahead]`.
- Draw only those notes.

**Techniques:**

- Pre-render static lanes and the hit line into an `OffscreenCanvas`, and note gems into a sprite atlas; `drawImage` both.
- Scale the backing store by `devicePixelRatio` (`canvas.width = cssW*dpr; ctx.setTransform(dpr,0,0,dpr,0,0)`).
- Snap x positions to device pixels.
- No per-note `shadowBlur` (use pre-blurred sprites); pooled particles; no per-frame allocation.

## 9. Companion server

**Fastify 5** with `@fastify/static` serving `dist/` in production. JSON-schema routes and `app.inject()` give fixture-based adapter tests with no network. Express 5.3.0 would also work. Upstream requests use Node's global `fetch`.

**Watching.** Use `chokidar` 5.0.0 (ESM, Node ≥20.19, no globs) with `awaitWriteFinish` on the library folder. v6.0.0 requires Node ≥22.22; pin 5 unless `engines` requires 22.22+.

**Index.** Use MiniSearch, persisting `JSON.stringify(index)` under `.riffway/`. FlexSearch 0.8.212 is faster but its API has churned; Fuse.js 7.5.0 is a slower linear scan.

**Zip.** Use `yauzl` with `lazyEntries` and stream extraction. Add a zip-slip guard: the resolved path must stay inside the target directory. `adm-zip` 0.6.1 loads everything into memory. `fflate` 0.8.3 is a good in-memory alternative.

**Dev.** `concurrently -k "vite" "tsx watch server/index.ts"`, with Vite `server.proxy: { '/api': 'http://localhost:<port>' }`.

**Prod.** `vite build && esbuild server/index.ts --bundle --platform=node --format=esm --packages=external --outdir=dist-server`, then `node dist-server/index.js` serves the UI and the API on one port.

## 10. Storage

Use **`idb` 8.0.4**:

```ts
openDB('riffway', DB_VERSION, { upgrade(db, oldVersion, _new, tx) { switch (oldVersion) { case 0: …; case 1: … } } })
```

Use fall-through cases so every migration runs in order.

**Stores:** `settings` (single key), `songsMeta`, `scores` (index `[songId, playedAt]`), `sectionProgress`, `audioLinks`, `streaks`. Store times as epoch ms.

**Audio links.** Chrome can store a `FileSystemFileHandle` in IndexedDB, but it needs `requestPermission()` again each session. The alternative is copying the file into the library folder through the server.

**Export.** JSON `{ app:'riffway', schemaVersion, exportedAt, stores:{…} }`. On import, validate it and migrate it forward with the same version steps.

Dexie 4.4.7 is heavier and not needed.

## 11. Testing

- **Pure modules under `src/dsp/`** (pitch, onset, clipper, oversampler, judgment) are tested in Vitest under Node using generated tones and WAV fixtures. The worklet processors stay thin shells around them.
- **Vite worklets** (**verified** in dev and build): `import url from './proc.ts?worker&url'` then `ctx.audioWorklet.addModule(url)`. Vite emits a self-contained IIFE, so imports in the processor are bundled.
- **Web Audio graph tests** (amp chain, scheduling accuracy) run in `OfflineAudioContext` through Vitest browser mode (`@vitest/browser-playwright`).
- **DOM tests:** `happy-dom` 21 (or `jsdom` 31) plus `import 'fake-indexeddb/auto'`.
- **E2E** runs in keyboard mode with Playwright. For the audio path, launch with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<abs>.wav`. Append `%noloop` to the path to play the file once instead of looping.
  - **Verified headless:** a 48 kHz mono WAV (1 s silence, then 110 Hz) arrived through `getUserMedia` → `AnalyserNode` (RMS 0 → 0.35), and the device list showed "Fake Default Audio Input".
  - Each browser instance gets exactly one WAV.
  - Use Chrome's new headless (`channel: 'chromium'`). This was verified with Chrome for Testing; the old `chromium-headless-shell` was not tested.

## Verified alphaTab Node API

This was run with `@coderline/alphatab@1.9.0` on Node 22.23.5. The same function parsed alphaTab's own test files (`hammer.gp3`/`.gp5`/`.gpx`/`.gp`) identically: 20 notes, last onset at 4000 ms.

```js
import { importer, midi, Settings } from '@coderline/alphatab';

export function loadTimeline(input /* Uint8Array | alphaTex string */, trackIndex = 0) {
  const settings = new Settings();
  const score = typeof input === 'string'
    ? importer.ScoreLoader.loadAlphaTex(input, settings)
    : importer.ScoreLoader.loadScoreFromBytes(input, settings); // GP3-7, GPX, MusicXML
  const midiFile = new midi.MidiFile();
  const gen = new midi.MidiFileGenerator(score, settings, new midi.AlphaSynthMidiFileHandler(midiFile));
  gen.generate(); // expands repeats/voltas/jumps into gen.tickLookup.masterBars (playback order)

  const ppq = midiFile.division; // 960
  const tempos = gen.tickLookup.masterBars.flatMap(m => m.tempoChanges); // {tick, tempo}, played timeline
  const tickToMs = tick => {
    let ms = 0, prevTick = 0, bpm = tempos[0]?.tempo ?? score.tempo;
    for (const t of tempos) {
      if (t.tick > tick) break;
      ms += ((t.tick - prevTick) * 60000) / (bpm * ppq); prevTick = t.tick; bpm = t.tempo;
    }
    return ms + ((tick - prevTick) * 60000) / (bpm * ppq);
  };
  const staff = score.tracks[trackIndex].staves[0];
  const notes = [];
  for (const mbl of gen.tickLookup.masterBars) {             // one entry per *played* bar
    for (let bl = mbl.firstBeat; bl; bl = bl === mbl.lastBeat ? null : bl.nextBeat) { // bl.start is bar-relative
      for (const { beat, playbackStart } of bl.highlightedBeats) {
        if (playbackStart !== bl.start || beat.voice.bar.staff !== staff) continue; // onsets of this staff only
        const tick = mbl.start + bl.start;
        for (const n of beat.notes) notes.push({
          timeMs: tickToMs(tick), durMs: tickToMs(tick + beat.playbackDuration) - tickToMs(tick),
          bar: mbl.masterBar.index, section: mbl.masterBar.section?.text ?? null,
          string: staff.tuning.length - n.string + 1, // alphaTab: 1 = LOWEST string → 1 = high e
          fret: n.fret, midi: n.realValue,
          hammerPull: n.isHammerPullOrigin, slide: n.slideOutType !== 0, bend: n.hasBend,
          palmMute: n.isPalmMute, tied: n.isTieDestination,
        });
      }
    }
  }
  return { title: score.title, tuning: staff.tuning /* MIDI numbers, high→low */, notes };
}

loadTimeline(`\\title "Riff Test"
\\tempo 120
\\track "Guitar"
\\staff {tabs}
\\tuning (E4 B3 G3 D3 A2 D2)
\\section "Intro"
\\ro 0.6.4 3.6{h}.4 5.6.4 3.6.4 |
\\tempo 90 \\rc 2 5.5{sl}.4 7.5.4 7.3{b (0 4)}.4 0.6{pm}.4 |
\\section "Verse"
(0.6 2.5 2.4).2 (3.5 2.4).2`);
```

**Observed output.** Tuning `[64,59,55,50,45,38]` (Drop D); 21 notes. The repeated bars 0–1 appear twice:

- Bar 0 starts at 0 ms and bar 1 at 2000 ms (tempo changes to 90).
- The repeat starts at 4666.7 ms and the second pass of bar 1 at 6666.7 ms. "Verse" starts at 9333.3 ms.
- Flags are correct: `hammerPull` on 3→5, `slide` on 5.5, `bend` on 7.3, `palmMute` on 0.6.
- The times match `MidiFileGenerator.generateSyncPoints(score, true)[i].synthTime`.

**Other model facts:**

- `MasterBar`: `section.text`, `isRepeatStart`, `repeatCount`, `alternateEndings`, `tempoAutomations[].value`.
- `Note`: `bendPoints`, `slideInType`, `isHammerPullDestination`, `harmonicType`, `isDead`, `vibrato`, `leftHandFinger`.
- `Staff`: `capo`, `tuningName`.
- `Beat`: `isRest`, `chord`.
- `importer.ScoreLoader` throws `UnsupportedFormatError`; for alphaTex the cause carries the diagnostics.
- `exporter.Gp7Exporter().export(score, settings)` writes `.gp` (**verified** round-trip). It is handy for test fixtures.

**Offline guide render** (**verified**: 120 s of audio in 0.36 s in Node):

```js
const syn = new synth.AlphaSynth(nullOutput /* ISynthOutput stub, sampleRate 48000 */, 500);
syn.loadSoundFont(sf2Bytes /* dist/soundfont/sonivox.sf2 */, false);
const opts = new synth.AudioExportOptions(); opts.sampleRate = 48000;
const exp = syn.exportAudio(opts, midiFile, [], gen.transpositionPitches);
for (let c; (c = exp.render(500)); ) { /* c.samples: interleaved stereo Float32Array; stop when c.currentTime >= c.endTime */ }
```

## Risks

1. **Real-device latency.** Chrome on macOS is commonly 20–70 ms round trip, and the APIs under-report it (track `latency` is fixed at 0.01; `outputLatency` is an estimate). Calibration must be measured (play-to-click), and the displayed "monitoring latency" is only an estimate unless the user loops back. The owner's manual checklist has to cover this, because it cannot be verified here.
2. **Pitch and onset robustness on real guitar.** String noise, sympathetic strings, weak E2 fundamentals and legato onsets are only tested with synthetic tones so far. Collect recorded DI samples early, and tune thresholds and windows against them.
3. **alphaTab coupling and fidelity.** Our `loadTimeline` uses semi-internal lookup types (`tickLookup`, `highlightedBeats`) that may change between minors, so pin 1.9.x and keep golden-file tests. MusicXML import fidelity varies by exporter, and overfull bars, grace notes and multi-voice tabs need explicit handling. Also note that alphaTab string 1 is the *lowest* string.
4. **Version and engine drift.** chokidar 6 needs Node ≥22.22, and TypeScript 7 conflicts with typescript-eslint (`<6.1.0`). Declare `engines.node ">=22.12"` and pin TS 6.0.3.
5. **Playwright fake capture.** One WAV per browser launch, looped by default. It works in new headless only; it is unverified in `chromium-headless-shell`.

## Sources

- npm registry (`npm view …`, 2026-11-19)
- alphaTab — https://alphatab.net, https://github.com/CoderLine/alphaTab (test-data under `packages/alphatab/test-data`)
- Signalsmith Stretch — https://github.com/Signalsmith-Audio/signalsmith-stretch (MIT), npm README
- Vite worker `?worker&url` — https://vite.dev/guide/features.html
- Browser audio latency measurements — https://www.lesswrong.com/posts/ooXEzrX7Y9Go6D7st/browser-audio-latency
- Chromium `outputLatency` intent to ship — https://groups.google.com/a/chromium.org/g/blink-dev/c/dTQniJNVVMY
- Fake audio capture `%noloop` and per-browser limit — https://omarelb.substack.com/p/til-2-set-up-playwright-with-fake
