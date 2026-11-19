# Local library folder

Last verified: 2026-11-19 · Status: **implemented** (T-017 index + watcher, T-026 drag-drop import)

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

## Watcher and index (implemented, T-017)
- The companion server watches the configured folder recursively with `chokidar` 5.0.0 (pinned; see
  [libraries.md](../research/libraries.md)): `awaitWriteFinish` (200 ms stability, 50 ms poll) so half-copied
  files aren't parsed, then a 300 ms debounce; a batch of changes triggers a rescan of the folder. Hidden
  files/folders (dot-names) and symlinks are skipped; the folder is created if it does not exist.
- Each file goes through `loadSong` + `analyzeDifficulty` (`server/indexer/analyzer.ts`) into an `IndexEntry`
  (`shared/sources.ts`): id, path, sha1, title/artist/composer, tracks, tuning, tempo, duration, rhythm status,
  difficulty, tags, `hasMidi`, `hasSidecar`. Metadata comes from the alphaTab `Score`; ASCII files use the header
  heuristics described in [classtab.md](classtab.md), falling back to the filename.
- **Ids (DEC-14):** `local:<first 16 hex of sha1>` at first index, sticky per path when the content changes; a
  file moved with identical content keeps its id; a second live copy of identical content gets a path-salted id.
- **Cache:** `<dataDir>/index.json`. A restart re-parses only files whose mtime or size changed (or whose paired
  `.mid` or rhythm sidecar changed), entries that failed before, and everything after an app version bump.
  Startup and `POST /api/library/rescan` do a full rescan; `reindex(id)` re-parses one song (sidecar saved).
- Files that are not songs (`ImportError` `unsupported`, or `empty` for `.txt`/`.tab`) are skipped silently.
  Files that fail to import stay visible with an `error` message. Only **transient** failures (an
  unexpected importer error, or a typed `ImportError` with code `internal`) are retried on every scan;
  deterministic ones (syntax, no playable track, too large) stay cached by mtime + size until the file
  changes. A playable song whose difficulty analysis failed is also re-analysed.
- A `.txt`/`.tab` with a sibling `.mid` of the same basename (any case) gets it as its rhythm source.
- Index changes are pushed to the frontend over SSE (`GET /api/events`: `library.changed` with reason
  `added`/`changed`/`removed`/`rescan`, and `index.progress`), so search updates live.

## Drag-and-drop import
The browser posts dropped files to the companion server (`POST /api/library/import`, multipart field `files`,
at most 100 files). The import runs in **two phases**, so a request over the file limit (413
`too-many-files`) or one that fails mid-stream leaves nothing in the library:

*Phase 1, stage every part:*
1. Rejects names that carry a path (`/`, `\`, `..`) outright, so traversal attempts are reported, never
   silently trimmed. Only song extensions (see the table above) and `.mid` are accepted.
2. Sanitises the name: Unicode NFC, control and reserved characters (`<>:"|?*`) replaced by `_`, whitespace
   collapsed, leading dots removed, extension lower-cased, at most 200 bytes.
3. Streams it to a hidden temp file (`.riffway-upload-<random>.part`) in the target folder (the library
   root, or the configured `importSubfolder`, which must stay inside the library), hashing it on the way;
   capped at 20 MB; empty files are rejected.

*Phase 2, place the staged files (only once every part has been staged):*
4. Reports `duplicate` when identical content (sha1) is already in the library or in the same request.
   Otherwise claims the first free name among `name`, `name (2)`, `name (3)` … **exclusively** (a hard link,
   or an exclusive copy where hard links are unsupported), so an existing file is never replaced and
   concurrent imports never overwrite each other.
5. Removes every temp file before replying, and leaves indexing to the watcher, so imports and manual
   copies take the same path.

## Security
The server binds to `127.0.0.1` only. Every request must carry a loopback `Host` (`localhost`, `127.0.0.1`,
`[::1]`). When the browser sends an `Origin`, it must be an http(s) loopback origin **on the same port as the
`Host`** (default ports filled in from the scheme): the app itself, or Vite's dev proxy, which keeps the
browser's `Host`. Any other local server is a different origin and gets 403, even on loopback. This blocks
DNS-rebinding reads and cross-site or other-local-server form posts. `GET /api/songs/:id/file` looks the id up in the index (request data never becomes a path) and
re-checks, after resolving symlinks, that a local file lies inside the library folder.
