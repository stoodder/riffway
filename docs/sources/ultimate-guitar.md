# Ultimate Guitar

Last verified: 2026-11-19 · Status: **link-out only** (plus ASCII paste)

## Terms (summary)
Source: <https://www.ultimate-guitar.com/about/tos.htm> (footer: last updated August 24, 2026), read once.
- §6.3: "Content received through the Service may be accessed for your personal, non-commercial use only."
- §6.2: content may not be reproduced onto any physical medium. The one exception: users "may print out
  text-based Tablature and/or Lyrics for your personal, non-commercial use" (some content providers don't allow even this).
- §6.4: no copying, reproducing, transferring or accessing content "except as expressly
  authorized". Reverse engineering and redistribution are also prohibited.
- §5.2(c)/§5.3: no collecting information from others, no probing the service.
- §14: sites "may link to, but not replicate, the Content of the Service" and "must not frame … the Content".
- `robots.txt` (read once): `User-agent: *` → `Disallow: /search.php`, `/tab-pro/download`,
  `/tabmanager/`, `/user/tab/view?*`, among others.

Conclusion: **no automated access of any kind** (search, tab pages, or Pro/GP downloads). Linking out is
explicitly allowed. A user who copies a tab for personal practice is the user's own action under §6.3.
The app only gives them a paste box.

## Link-out search
Button "Search on Ultimate Guitar" opens a new browser tab:

```
https://www.ultimate-guitar.com/search.php?search_type=title&value=<encodeURIComponent(query)>
```

The companion server must never request this URL. robots.txt disallows `/search.php` for bots, and only
the user's browser loads it. Do not use an iframe (§14 forbids framing).

## ASCII paste flow
The Import screen (`#/import`, `src/ui/screens/import/`, T-028) is the paste flow. "Paste a tab" on the
Library and the Import item in the nav open it; its header has the "Search on Ultimate Guitar" link-out,
built from the Artist and Title fields.
1. The user pastes the tab (or opens a `.txt` file). The parser (the same one used for ClassTab and local
   `.txt`) extracts fret events by column; "What Riffway read" shows the text with line numbers, the
   detected staff lines, tuning, bars, onsets and notes, and lists lines it couldn't parse.
2. Song details: Title (required; prefilled from a title line in the text), Artist, Tuning ("As detected"
   from string labels such as `e|B|G|D|A|E|` or `D|A|D|G|B|e|`, or a chosen tuning) and Capo.
3. **Rhythm alignment** (spec § Import formats): a BPM (typed or tapped) and time signature, then either
   **snap to grid** (column spacing read as the duration ratio, quantised to Auto / 1/8 / 1/8 triplet /
   1/16) or **tap along** (Space on each onset while a metronome plays). A preview strip plays the result
   at a chosen speed.
4. Save (`POST /api/library/paste`) writes `<Artist> - <Title>.txt` (or `<Title>.txt`) into the library folder's
   drop subfolder. Header lines are added only for overrides that differ from what the text says
   (`Title:`/`Artist:` when the typed values beat the text's own, `Tuning:`, `Capo:`, `Tempo: Q=`,
   `Time:`). The confirmed rhythm is a sidecar in `<dataDir>/sidecars/<songId>.json` (DEC-17), not in the
   file. The song is indexed like any local file and is playable at once.

A text tab already in the library that still needs rhythm ("Needs rhythm") opens the same screen in
align mode (`#/import?song=<id>`): the text is read-only and Save writes only the sidecar.

UG Pro/Guitar Pro files that the user downloaded by hand from their own UG account can simply be dropped into the
library folder.

## Implementation (T-026)
`server/sources/linkout/ultimate-guitar.ts`: `ultimateGuitarSearchUrl(query)` builds the URL above; the adapter returns
one link-out ("Search on Ultimate Guitar", hint: paste the tab on the Import screen or drop a Guitar Pro file) for a
non-empty query and has no local matching (Songsterr's matcher already lists library songs under its card). The
Library screen opens it with `window.open(url, '_blank', 'noopener,noreferrer')` and links to the Import screen
("Paste a tab").
No code or test requests `ultimate-guitar.com`.
