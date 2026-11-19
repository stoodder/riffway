# Song sources

Last verified: 2026-11-19

Riffway's library is built from pluggable **SourceAdapters** (`SourceAdapter` in `shared/sources.ts`), which run
only in the local companion server and are registered in `server/sources/registry.ts`. Each adapter has a `kind`:
- `library` / `download` (local folder, starter, ClassTab): `scan()` lists files for the server to index (plus
  `watch()`, and `refresh()` for downloads). Indexed entries carry an availability: playable now, needs rhythm,
  or needs import.
- `link-out` (Songsterr, Ultimate Guitar, Guitar Pro free pack): no I/O of any kind. `linkOuts(query)` returns
  URLs the user's browser opens in a new tab, and `matchLocal(query, entries)` may flag library songs that match.

`GET /api/search` runs one MiniSearch query over the unified index and adds every enabled link-out adapter's
link-outs (only for a non-empty query). The Library screen (`src/ui/screens/library/`) shows the results, the
filters and the link-out row, and imports dropped files into the library folder. Before an adapter calls anything,
its terms are checked and recorded here. An adapter whose source allows no automated access does no network I/O
at all: it only offers a link-out URL and matches files the user imports.

| Source | Status | Access method | Terms summary | Effort | Doc |
|---|---|---|---|---|---|
| Local library folder | implement now | fs watcher + drag-drop import via companion server | User's own files, kept local | M | [local-folder.md](local-folder.md) |
| ClassTab.org | implement now | One official whole-site zip (`/zip/classtab.zip`), conditional GET refresh | No site licence. Some tabs are "private study" only. Index locally, never redistribute | M | [classtab.md](classtab.md) |
| Songsterr | link-out only (implemented, T-026) | Opens `songsterr.com/?pattern=` in a browser tab. Matches imported GP files locally | API declined to automated clients (403). `/api/` disallowed. GP download is Plus-only | S | [songsterr.md](songsterr.md) |
| Ultimate Guitar | link-out only (implemented, T-026) | Opens `search.php?search_type=title&value=`. ASCII paste | Personal non-commercial use. Linking OK. No framing. `/search.php` disallowed for bots | S (+M paste/align) | [ultimate-guitar.md](ultimate-guitar.md) |
| Guitar Pro free pack | link-out only (implemented, T-026) | User downloads it (email required) and drops it into the library folder | No licence. Reproduction needs Arobas's written permission | S | [candidates.md](candidates.md) |
| Mutopia Project | candidate | Static per-piece `.mid`/`.ly`/`.rdf` | PD / CC BY / CC BY-SA. robots allows all | M (fret assignment) | [candidates.md](candidates.md) |
| The Session | candidate (owner decision) | Official read-only JSON API + weekly GitHub dump (ABC) | Free to share, **but no LLM processing** | M | [candidates.md](candidates.md) |
| Other ABC collections | candidate | Per-collection downloads | Varies; verify each | M | [candidates.md](candidates.md) |
| alphaTab test files | candidate (fixtures) | Repository files | MPL-2.0; verify origin of each file | S | [candidates.md](candidates.md) |
| MusicBrainz | candidate (metadata) | Official WS/2 API, ≤1 req/s | Core data CC0 | S | [candidates.md](candidates.md) |
| IMSLP | rejected | Metadata list API; PDF scans | No machine-readable rhythm | — | [candidates.md](candidates.md) |
| MuseScore.com | rejected | No public API (withdrawn) | — | — | [candidates.md](candidates.md) |
| OpenScore | rejected | GitHub `.mscx` | CC0 but no guitar repertoire | — | [candidates.md](candidates.md) |
| TuxGuitar | rejected | — | LGPL app, no song set | — | [candidates.md](candidates.md) |
| DadaGP | rejected | On request | Research-only, UG-derived | — | [candidates.md](candidates.md) |
| Hooktheory | rejected | Authenticated API | Chords only, no melodies | — | [candidates.md](candidates.md) |
| Spotify | rejected | OAuth Web API | Restricted dev mode; metadata only | — | [candidates.md](candidates.md) |

Test-audio fixtures for pitch and timing (GuitarSet CC BY 4.0, Iowa MIS, NSynth) are listed in
[candidates.md](candidates.md#recorded-guitar-audio-for-pitchtiming-test-fixtures). The record of the
Songsterr API probe is in [songsterr-probe.md](songsterr-probe.md).
