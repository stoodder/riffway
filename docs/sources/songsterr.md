# Songsterr

Last verified: 2026-11-19 · Status: **link-out only** (plus local matching of files the user imports)

## Spec deviation
The spec (§ Song sources, adapter 2) assumed a "public search API" for searching the Songsterr catalog
from inside the app. **No such API is available to automated clients.** Riffway therefore offers
no in-app search of the Songsterr catalog. The "Definition of done" line "search … the Songsterr catalog
from one search box" is met as follows: the unified search box shows a **"Search on Songsterr"** action, and
any Songsterr songs the user has imported are matched locally. The owner should accept this change.

## Findings
- **API probe** (one request, recorded in [songsterr-probe.md](songsterr-probe.md)):
  `GET /api/songs?pattern=…` returned **HTTP 403 `ERR_ACCESS_POLICY`**. The message: "Bulk downloading,
  scraping or mirroring the catalogue is not permitted … do not retry. Do not work around this response."
  No agent and no app code may call `songsterr.com/api`.
- **robots.txt:** `Disallow: /api/` for `User-agent: *`.
- **ai.txt** (updated 2026-11-09): viewing tabs is free. **Guitar Pro download is a paid Plus feature.**
  Allowed: "build independent tools that do not modify, automate, or interfere with this site".
- **Terms** (<https://www.songsterr.com/terms>, "Last Modified: June 10, 2026"): no automated tool, script,
  browser extension or AI agent may bypass paid features or interfere with the Service. "Independent tools that do not
  modify, automate, or interfere with the Service" are carved out. Plus includes "Download (Guitar Pro,
  MIDI, MP3 and WAV)". Content may not be distributed or reused for commercial purposes or personal gain without
  written permission. Using the name "Songsterr" needs prior written consent. A plain-text label on a
  link-out button is nominative use, so keep it modest and use no logo.

## Compliant design
1. **Link-out search.** "Search on Songsterr" opens
   `https://www.songsterr.com/?pattern=<encodeURIComponent(query)>` in a new browser tab
   (`window.open(url, '_blank', 'noopener')`). The companion server never fetches this URL. A human
   should confirm once that the URL format still lands on the search results page, since agents must not probe it.
2. **User imports their own file.** A Plus subscriber downloads the Guitar Pro file (`.gp`/`.gp5`/…) from
   Songsterr by hand and drags it into Riffway, which copies it into the local library folder
   (see [local-folder.md](local-folder.md)). Free users have no GP download, so the UI should say so
   instead of suggesting a workaround.
3. **"Playable" matching.** The adapter has no remote calls. For a query, it finds library entries whose
   title/artist match (normalised: lower-case, diacritics stripped, punctuation and "the" removed,
   feat./live/remaster suffixes removed). It shows them as "In your library – playable".
   An optional `origin: songsterr` tag can be set on import when the user chooses it.
4. **Never:** scrape song pages, hit `/api/`, extract tabs from the web player, or embed the site in an iframe.
