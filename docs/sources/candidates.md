# Candidate sources

Last verified: 2026-11-19. Verdicts use the spec's rule: implement only sources that are **clearly permitted
and low-effort**. "Rhythm" means the source gives machine-readable note durations, which gameplay needs.

## Song and score sources

### Mutopia Project: candidate (first choice for the next adapter, and for the starter library)
- Terms: <https://www.mutopiaproject.org/legal.html>. Each piece is Public Domain, CC BY or CC BY-SA:
  "All music on Mutopia may be freely downloaded, printed, copied, distributed, modified, performed and
  recorded." CC BY-SA requires derivatives to stay under BY-SA. `robots.txt` allows everything.
- Access: static per-piece folders, for example `https://www.mutopiaproject.org/ftp/AguadoD/O3/aguado-op03n01/`,
  containing `.ly`, `.mid`, `.rdf` (metadata), PDF/PS and SVG preview. **There is no MusicXML and no zip of the whole site.**
  The LilyPond sources are also on GitHub (<https://github.com/MutopiaProject/MutopiaProject>, no repo
  licence stated; licences are per piece). Guitar: **395 pieces** (browse page).
- Rhythm: **yes**, since the MIDI is rendered from engraved notation. It has no fret/string data, so it needs
  automatic fret assignment (medium effort).
- Use now: hand-pick a few PD/CC-BY guitar pieces for the starter library (with attribution). Build a full adapter
  later, which would index the `.rdf` files and fetch MIDI on demand at ≤1 request per second.

### Guitar Pro free pack: link-out only (manual import)
- Page: <https://www.guitar-pro.com/free-tabs>. You must enter an **email address**, which also subscribes you
  to the newsletter. There is no direct file URL. Contents: "exercises, riffs, extracts of famous songs from the
  mySongBook library and licks", "for beginners to advanced players".
- Terms (<https://www.guitar-pro.com/c/3-terms-of-use>, undated): "Any representation, reproduction,
  partial or total use of the contents" requires prior written authorisation from Arobas Music. No
  licence is given for the pack.
- Rhythm: yes (GP files). Verdict: **no automated download, nothing committed to the repo.** Add a "Get the free
  Guitar Pro pack" link and tell the user to drop the files into the library folder for personal use. The blog packs
  (for example "20 legendary riffs", "15 blues licks", "Top 50 riffs" on guitar-pro.com/blog) work the same way.

### The Session (thesession.org): candidate, blocked by licence; owner decision needed
- An official read-only API is documented at <https://thesession.org/api>: add `?format=json` to pages such as
  `/tunes/search?q=…` and `/tunes/ID`, up to 50 items per page. There is also a weekly CSV/JSON dump at
  <https://github.com/adactio/TheSession-data>. `robots.txt`: `Crawl-delay: 10`.
- The data is ABC notation, so **rhythm: yes** (single-line folk melodies; good picking practice).
- Licence (`LICENSE.md` in the dump): free to share and adapt, **but it forbids processing the material
  with LLM tools** (except for accessibility). The app itself is not an LLM system. However, agents
  (including the build pipeline) must not fetch, parse or create fixtures from this data. Do not implement it in an
  agent-built iteration unless the owner decides otherwise. Tests would need synthetic ABC.

### Other ABC collections: candidate
For example the Nottingham Music Database (ABC). Licences are often unclear, so each must be checked before use.
ABC itself is a good format (parse with abcjs, MIT).

### IMSLP: reject
- Only a metadata list API exists (<https://imslp.org/wiki/IMSLP:API>; people/works lists as JSON). The content is
  mostly PDF scans. Copyright status varies by country. No machine-readable rhythm. Link-out at most.

### MuseScore.com: reject
- Its public API was withdrawn. According to MuseScore forum posts, the team may relaunch limited access "to select
  developers and educational institutions". There is no documented access. Users can export MusicXML themselves
  and drop it into the library folder.

### OpenScore: reject (for now)
- CC0 (Lieder corpus, <https://github.com/OpenScore/Lieder>, `.mscx` files). It contains voice and piano, **no
  guitar**, and would need conversion and arranging.

### TuxGuitar: reject as a source
- An LGPL-2.1 editor. No documented, licensed set of sample songs was found. It is useful only as a reference
  GP3–5 reader.

### alphaTab repository test files: candidate (parser test fixtures only)
- MPL-2.0 (<https://github.com/CoderLine/alphaTab>). It contains GP/MusicXML test files. Check each file's
  origin before copying any into `tests/fixtures/`.

### "Free Guitar Pro tab" sites: reject
- None found with an explicit permissive licence. They host user transcriptions of copyrighted songs.

### DadaGP: reject
- Research-only and available on request (<https://github.com/dada-bots/dadaGP>). It is derived from Ultimate Guitar
  user uploads.

### Hooktheory API: reject
- <https://www.hooktheory.com/api/trends/docs>: chord-progression statistics only, with no melodies ("not on our
  immediate roadmap"). It needs account credentials and allows 10 requests per 10 seconds.

### MusicBrainz: candidate (metadata only)
- <https://musicbrainz.org/doc/MusicBrainz_API>. Needs a descriptive User-Agent and ≤1 request per second;
  core data is CC0. Could normalise artist/title for library matching. Low value, because local fuzzy matching is enough.

### Spotify Web API: reject
- OAuth app registration is required. New Development Mode apps have been restricted since 2026-02-11
  (<https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security>).
  It provides metadata only, and MusicBrainz covers that.

## Recorded guitar audio for pitch/timing TEST FIXTURES
| Source | Licence | What | Download (size) | Verdict |
|---|---|---|---|---|
| **GuitarSet** (Zenodo 10.5281/zenodo.3371780, v1.1.0) | **CC BY 4.0** | 360 solo/comp excerpts (~30 s each) with **note-level JAMS annotations: onset, offset, pitch, string**. Gives ground truth for both timing and pitch | `annotation.zip` <https://zenodo.org/api/records/3371780/files/annotation.zip/content> (39,132,574 B); `audio_mono-mic.zip` <https://zenodo.org/api/records/3371780/files/audio_mono-mic.zip/content> (656,927,981 B); `audio_mono-pickup_mix.zip` (683,145,360 B) | **Best choice.** Download once, cut 2–3 clips of a few seconds plus their annotations into `tests/fixtures/audio/` with attribution |
| **Univ. of Iowa MIS – Guitar** (<https://theremin.music.uiowa.edu/MISguitar.html>) | "may be downloaded and used for any projects, without restrictions" | Clean single notes, chromatic per string, pp/mf/ff, 24-bit/96 kHz stereo AIFF | e.g. <https://theremin.music.uiowa.edu/sound%20files/MIS/Piano_Other/guitar/Guitar.mf.sulE.E2B2.stereo.aif> (47,949,808 B; low E string, E2–B2) | Excellent for single-note pitch tests. Slice individual notes |
| **NSynth** (Magenta) | CC BY 4.0 | 4 s single notes at 16 kHz with pitch labels, including `guitar_acoustic_*` / `guitar_electronic_*` | <http://download.magenta.tensorflow.org/datasets/nsynth/nsynth-test.jsonwav.tar.gz> (349,501,546 B); valid set 1,068,767,009 B | Good backup. Large download for a few notes |
| Wikimedia Commons | Per file, mostly **CC BY-SA** | e.g. "Distorted guitar Palm mute open G string (off, on).ogg" (CC BY-SA 4.0, 194,990 B), "Guitar Clean tremolo.ogg" (CC BY-SA 3.0) | via the official API `prop=imageinfo&iiprop=url\|size\|extmetadata` | Share-alike: avoid unless no alternative |
| IDMT-SMT-Guitar (Zenodo 7544110) | CC BY-NC-ND 4.0 | Single notes and techniques, 1,329,918,978 B | — | Reject (ND forbids slicing) |
