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
1. The user clicks "Paste a tab" (available from the UG button's popover and from Import).
2. Riffway shows a textarea and fields for title/artist (prefilled from the search query), tuning (auto-detected from string
   labels such as `e|B|G|D|A|E|` or `D|A|D|G|B|e|`, editable), BPM and time signature.
3. The parser (the same one used for ClassTab and local `.txt`) extracts fret events by column. It shows a preview of the
   detected staff systems and highlights lines it couldn't parse.
4. **Rhythm alignment** (spec § Import formats): default snap-to-grid treats column spacing as the duration ratio and
   quantises it to the chosen subdivision. The alternative is a tap-along, where the user taps the beat or each note while
   a metronome plays at the entered BPM. In both cases the song stays marked "needs rhythm alignment" until the user confirms.
5. Save writes `<artist> - <title>.txt` into the local library folder, with a small header holding BPM, tuning and
   the confirmed alignment (or a sidecar `.riffway.json`). It is indexed like any local file.

UG Pro/Guitar Pro files that the user downloaded by hand from their own UG account can simply be dropped into the
library folder.
