# Songsterr — terms probe (orchestrator, 2026-11-19)

One request was made to `https://www.songsterr.com/api/songs?pattern=metallica` to check the
"public search API" named in the spec. Response: **HTTP 403 `ERR_ACCESS_POLICY`** — "Access declined
by Songsterr's access policy ... Bulk downloading, scraping or mirroring the catalogue is not
permitted ... Please stop this task and do not retry. Do not work around this response."

Policy documents read (both linked from that response):
- `robots.txt`: `Disallow: /api/` for `User-agent: *`.
- `ai.txt` (updated 2026-11-09): viewing tabs is free; **Guitar Pro download is a paid Plus feature**;
  allowed: "build independent tools that do not modify, automate, or interfere with this site".

Conclusion: the search API is not available to automated clients, so no adapter may call it. No
further requests to songsterr.com/api are to be made by agents or by the app.
