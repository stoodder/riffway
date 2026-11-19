# Local library folder

Last verified: 2026-11-19 · Status: **implement now**

No external terms apply: the user's own files stay on their machine. The folder is outside the repo, or gitignored,
and is never committed.

## Supported formats
| Extension | Parser | Rhythm data |
|---|---|---|
| `.gp` (GP7/8), `.gpx` (GP6), `.gp5`, `.gp4`, `.gp3` | alphaTab importer | Yes (exact) |
| `.musicxml`, `.xml` (MusicXML partwise), `.mxl` (compressed) | alphaTab importer | Yes. Use tab staff/fingering if present, otherwise assign frets |
| `.txt`, `.tab` (ASCII tab) | Riffway ASCII parser (shared with ClassTab and paste) | Usually none, so "needs rhythm alignment" unless a paired `.mid`, beat ruler or saved alignment exists |
| `.mid` beside a `.txt` with the same basename | Rhythm source for ASCII alignment (ClassTab convention) | Yes |

For a `.xml` file, check that the root element is `score-partwise`/`score-timewise` before treating it as MusicXML.
Skip unknown files silently. Cap the file size (for example 20 MB) and never execute anything.

## Watcher
- The companion server watches the configured folder recursively: `chokidar` 5.0.0 (pinned; see
  [libraries.md](../research/libraries.md)), with a debounce of about 300 ms. Wait for writes to finish
  (`awaitWriteFinish`) so half-copied files aren't parsed.
- Index: path → `{mtime, size, sha1, title, artist, tracks, tuning, tempo, durationSec, difficulty,
  hasRhythm, source: 'local' | 'classtab' | origin tag}`. Persist it as a JSON (or SQLite) cache on the server,
  so restarts only re-parse files whose mtime or size changed. Do a full rescan on startup and on demand.
- Metadata comes from the alphaTab `Score` (title, artist, tempo, track tunings). ASCII files use the header heuristics
  described in [classtab.md](classtab.md), falling back to the filename.
- Push index changes to the frontend over SSE/WebSocket so search updates live.

## Drag-and-drop import
The browser posts dropped files to the companion server (`POST /api/library/import`, multipart). The server:
1. Checks extension and size.
2. Sanitises the filename and blocks path traversal.
3. Writes the file into the library folder, or a configurable `Imported/` subfolder, adding ` (2)` and so on on collision
   (or skipping it if an identical sha1 already exists).
4. Leaves indexing to the watcher, so imports and manual copies take the same path.

The server binds to localhost only.
