# ClassTab.org

Last verified: 2026-11-19 · Status: **implemented** (T-025, `server/sources/classtab/`)

## Access
- Whole-site zip, offered on the home page as "updated monthly":
  **<https://www.classtab.org/zip/classtab.zip>**. There is no API, and none is needed.
- Snapshot checked: **14,274,920 bytes** (13.6 MB) compressed, 65.9 MB unpacked, 6,336 entries.
  Headers: `Last-Modified: Sun, 01 Nov 2026 20:06:35 GMT`, `ETag: "d9d168-65f3c90fbc18b"`,
  `Cache-Control: max-age=172800`, `Content-Type: application/zip`.
- `robots.txt`: `Crawl-delay: 10` and nothing relevant disallowed. The adapter fetches **one file**,
  only when the user runs refresh. It never crawls individual pages.
- **Refresh detection:** store the `ETag` and `Last-Modified` values. On refresh, send a conditional GET
  (`If-None-Match` / `If-Modified-Since`). A `304` response means nothing changed. A HEAD request also works.
  Apache's ETag begins with the byte size in hex (`d9d168` = 14,274,920). Limit refresh to once a day.
- Network quirk seen from the sandbox: TLS 1.3 handshakes to the host were often reset, while TLS 1.2
  with retries worked. Add retry with backoff (≥10 s, to match the crawl delay).

## Terms
- The site states **no licence or terms of use**. It covers only submission guidelines and history.
  ClassTab grew out of the classical section of OLGA. Most pieces are public-domain compositions,
  but each transcription belongs to the person who tabbed it.
- 240 of 3,976 tabs carry the OLGA notice: *"This file is the author's own work and represents
  their interpretation of the song. You may only use this file for private study, scholarship, or
  research."* Eight files contain the word "copyright".
- Implications: downloading the zip the site offers and indexing it locally for the owner's practice
  is fine. **Never commit or redistribute the zip or the tab corpus.** The library folder is gitignored.
  Unit-test fixtures are **synthetic files we author** in ClassTab's style (`tests/fixtures/classtab-synthetic/`);
  no ClassTab file is copied into the repo (TASKS.md D2).

## Layout (empirical)
- One flat folder, `classtab/`. Besides tabs and MIDIs it holds `0_readme.txt`, `index.htm`, 9 other `.htm`
  pages, `tabreader.js`, 3 jpg and 3 pdf files. **Ignore** every non-`.txt`/`.mid` file. Never execute
  `.js`.
- **3,976 `.txt` tabs** (not counting `0_readme.txt`) and **2,341 `.mid` files**, by about 620 composers.
- Naming: `composer[_firstname]_[opus/catalogue]_[number]_[title].ext`, in lowercase with underscores. Names
  can contain `'`, `(`, `)` and `-` (for example `anon_brian_boru's_march.txt`). Treat them as opaque strings.
- Text: **CRLF** line endings in every file. 3,680 are pure ASCII and 295 are Latin-1/CP1252. Decode as
  UTF-8 first and fall back to windows-1252.
- MIDI: 2,320 are format 1 and 21 are format 0. Most have 2–3 tracks.

## Pairing tabs with MIDI
| Rule | Tabs paired | Rate |
|---|---|---|
| Exact basename (`x.txt` ↔ `x.mid`) | 2,226 | 56.0% |
| + suffixed variants `x_1.mid`, `x_01.mid`, `x_duet.mid`, `x_a.mid` | 2,276 | 57.2% |
| + `MIDI: http://www.classtab.org/<name>.mid` URL found in the tab text | **2,282** | **57.4%** |

Patterns that fail to pair:
- One tab file can hold several versions (274 files contain lines such as "1st version", "version 2 … (MIDI 2)"),
  and each version has its own numbered MIDI.
- A header URL can name a different file (`bach_js_0147_…` against the real file `bach_js_bwv0147_…`). 30 tabs cite URLs that don't resolve.
- 15 MIDIs have no matching tab at all: `satie_gymnopedie_1a`, `…_am` (a transposed key),
  `…_wd`/`…_wl53` (alternative editions).
- 1,694 tabs have no MIDI at all.

**Second rhythm source:** 2,127 tabs (53%) have beat-ruler lines above the staff (`0   .   | . . | . .`
in Weed's house style). 590 of them have no MIDI. Only **1,152 tabs (29%)** have neither MIDI nor a ruler.
Mark those "needs rhythm alignment".

## Headers inside tabs
Free-form. Common elements:
- Line 1: `Title - Composer (dates)`.
- Then `MIDI:`, `video:` and "tabbed by" lines.
- Then one line combining tuning, key and time, e.g. `tuning: E A D G B E    key: G major    time: 6/8`.

2,164 files have a line starting with `Tuning`. Variants include `Tuning: Standard (EADGBE)`, `tuning - D A D G B E`,
`Tuning : E A D F# B E - Time Signature: 2/4`, and prose such as `6th string = D`, `6=D` or `Tune 6th to D`.
Drop D is the most common alternate tuning. The headers also include tempo (`tempo: Q=100`), capo (90 files)
and a legend (`= note held`, `p pull off`). Parse them with tolerant regular expressions and fall back to standard tuning.

## Implementation (T-025)
- **Where the player gets it:** while ClassTab is enabled and not downloaded, the Library's "Find more
  tabs" section shows one low-key card, "Download ClassTab (≈14 MB, classical/fingerstyle)"
  (`src/ui/screens/library/classtab-offer.ts`), which starts the refresh below and shows its progress;
  Settings → Library & sources has the same download plus "Check for update" afterwards. Nothing is
  downloaded until the player clicks.
- **Refresh:** `npm run classtab:refresh [-- --force] [--data-dir <dir>]`, or `POST /api/classtab/refresh`
  (`{}` or `{"force": true}`; answers `202 {started: true}` or `200 {started: false, reason}`). Progress
  and the outcome arrive as `classtab.progress` events (`checking → downloading → extracting → indexing →
  done`, or `not-modified` / `error`) on `GET /api/events`. `GET /api/classtab/status` returns `ClassTabStatus`.
- **Politeness:** one GET of the zip with `User-Agent: Riffway/0.1 (personal local app)` (no personal
  data), `If-None-Match` / `If-Modified-Since` from the last download (only while the extracted files
  exist). At most one contact per day unless forced. Network errors, `429` and `5xx` get 3 attempts with
  10 s then 20 s waits (a longer `Retry-After` up to 5 min is honoured).
- **Safe extraction** (yauzl, streaming): only `.txt` / `.mid` are written, flat, into a fresh temp folder
  that replaces `files/` only after success. Entry names with `..`, an absolute path, a drive letter or
  control characters are refused and logged; symlinks, encrypted entries, case-insensitive duplicates and
  files over 10 MB are skipped. Limits: 100 MB zip, 20,000 entries, 300 MB unpacked; yauzl checks each
  entry's real size. Files keep the zip's mtime, so unchanged tabs stay cached in the index after a monthly update.
- **Layout** under `<dataDir>/classtab/`: `classtab.zip`, `files/`, `state.json` (validators, last check,
  counts, last error), `pairs.json` (pairing cache keyed by a fingerprint of `files/`).
- **Indexing:** T-012's `pairClassTab` (tab text decoded UTF-8 → windows-1252) gives each tab its MIDI;
  a multi-version tab is indexed once with version 1's MIDI. Every entry is tagged `fingerstyle` and
  `classical` (a search filter, never hidden), links to `https://www.classtab.org/<file>`, and takes
  the title from the header line. Composer: header if confirmed (life dates or `Composer:` label), else
  file-name prefix. `GET /api/songs/:id/rhythm` serves the paired MIDI.
  A running server notices a refresh made by the CLI (`state.json` watcher) and re-indexes.
- **First real run** (2026-11-19, snapshot of 2026-11-01): 3,976 tabs and 2,341 MIDI files; 2,276 tabs
  paired; rhythm from MIDI 1,921, beat ruler 432, needs alignment 1,616; 5 files skipped as not tabs and
  2 indexed as unplayable (bass / 7-string); composer found in 2,852 headers. About 70 s end to end.
- **After T-103** (ruler, duet and MIDI-retry improvements, same snapshot):

  | Count | Tabs |
  |---|---|
  | Rhythm from MIDI | 2,075 |
  | Rhythm from beat ruler | 506 |
  | Needs rhythm alignment | 1,388 |
  | Playable now (MIDI + ruler) | 2,581 |
  | Paired MIDI that failed the match | 198 |
  | With a composer | 3,956 |

  `ClassTabStatus.rhythm` counts only tabs that imported; a tab with an import error is listed in the
  library as "Failed to import" and counted in none of the rhythm buckets.
