# ClassTab fixtures

Small sample of files from the ClassTab.org whole-site zip
(<https://www.classtab.org/zip/classtab.zip>, snapshot `Last-Modified: Sun, 01 Nov 2026 20:06:35 GMT`,
`ETag: "d9d168-65f3c90fbc18b"`, downloaded 2026-11-19). **For unit tests only.** Do not ship them
in the app and do not reuse them elsewhere.

Attribution: ClassTab.org, a classical guitar tablature site run by "Weed"
(weed@wussu.com). Each tab was written by the transcriber named in its own header, and every file
is kept byte-for-byte as it came (CRLF line endings, original encoding). ClassTab publishes no
site-wide licence. Files with the OLGA-style "private study, scholarship, or research" notice
were left out on purpose. All the music is public domain (composers died before 1910). See
`docs/sources/classtab.md`.

| Files | What it tests |
|---|---|
| `carulli_op241_morceaux_progressifs_no06_in_g.{txt,mid}` | Exact basename pair, with a `MIDI:` URL in the header, a beat-ruler line (`0   .   \| . .`) and `tuning:/key:/time:` on one line |
| `sor_op60_no10.{txt,mid}` | Exact pair, another transcriber's header style (`key - C    time - 4/4`) and its legend |
| `aguado_exercices_faciles_op10_no17_pastoral.{txt,mid}` | Exact pair, short beginner study |
| `giuliani_op021_twelve_waltzes_01_in_a.{txt,mid}` | Exact pair, Weed house style, `tempo: (see the Notes)` |
| `smith_js_the_anacreontic_song.{txt,mid}` | Exact pair, **non-UTF-8 (Latin-1) text**, `E  :---` string labels, tempo given in prose ("80 beats per minute") |
| `sor_op05_6_petites_pieces_faciles_6_valse_in_d.{txt,mid}` | Exact pair, **alternate tuning** `tuning: D A D G B E` (drop D) |
| `carulli_op114_no16_prelude_in_a.txt` + `_01.mid`, `_02.mid` | **No exact pair.** The MIDIs carry numbered suffixes (one per version), so pair them by prefix |
| `handel_hwv560_passepied.txt` | **Unpaired** (no MIDI at all, no beat ruler). Expected result: "needs rhythm alignment" |
