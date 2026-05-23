# session-tabs

View tunes from [TheSession](https://thesession.org/), rendered as tabs + audio playback in the browser. Search by name, by alias, or by humming/uploading audio.

Static site — `docs/` is the GitHub Pages root, no server runtime.

## Stack

- [abcjs](https://github.com/paulrosen/abcjs) — ABC notation rendering, tab, audio (CDN)
- [MiniSearch](https://github.com/lucaong/minisearch) — client-side fuzzy search (CDN)
- [pako](https://github.com/nodeca/pako) — zlib deflate for the "Open in ABC Tools" share URLs (CDN)
- [FolkFriend](https://github.com/TomWyllie/folkfriend) — WASM audio→tune transcription, committed under `docs/plugins/folkfriend/`
- [Font Awesome](https://fontawesome.com/) — icons for the menubar / bookmarks / trash (CDN)
- Vanilla ES modules, no bundler, no framework

## Run locally

```
python3 -m http.server -d docs 8000
# open http://localhost:8000/
```

## Rebuild the data

The repo ships pre-built `docs/meta.json`, `docs/search-index.json`, and
`docs/tunes/*.json`. To regenerate from the latest
[TheSession-data](https://github.com/adactio/TheSession-data) snapshot:

```
task download-session-data    # curl | tar into tmp/TheSession-data-main/
task build-session-data       # → docs/meta.json, docs/search-index.json, docs/tunes/*.json
```

Or without Task:

```
mkdir -p tmp
curl -L https://github.com/adactio/TheSession-data/archive/refs/heads/main.tar.gz | tar xz -C tmp

python3 build/build_session_data.py            # full dataset (~12k tunes)
# or:  python3 build/build_session_data.py --limit 100   # MWE subset

cd build && npm install && cd ..
node build/build_search_index.mjs
```

The FolkFriend tune index (`docs/plugins/folkfriend/tune-index.json`, ~34 MB) is also a committed artifact. Refresh it with:

```
task download-folkfriend-index
```

## Run with Docker

```
docker compose up --build
# → http://localhost:18080
```

The container has Python, Node, curl, and Task pre-installed, so
`docker compose exec app task download-session-data`,
`docker compose exec app task build-session-data`, and
`docker compose exec app task download-folkfriend-index`
work the same as outside.

## Search by audio

Click the 🎤 in the search bar to open a left-side panel:

- **Record** captures up to 10 seconds from the microphone.
- **Upload** decodes any browser-supported audio file (`.wav`, `.mp3`, `.ogg`, `.m4a`).

Either way the audio is transcribed by FolkFriend's WASM engine in-browser and the top 20 candidate settings are ranked. Each result shows a coloured confidence label (gradient `#CC1111` → `#11CC11`, FolkFriend's own calibration — real scores cluster around 0.1–0.2, so most matches show as "Unlikely" or "Possible" even when correct). The captured/uploaded clip stays available as an `<audio>` player above the result list so you can A/B against each candidate's abcjs synthesis.

The panel stays open across result clicks — FolkFriend's top hit is often wrong; pick another from the list and the tune view behind updates in place.

The WASM and the 34 MB tune index are lazy-loaded on first mic click, so they don't affect the initial page load.

## Bookmarks

- Click the bookmark icon on any setting header to save it.
- Open the bookmarks pane from the menubar's bookmark icon (top-left). List is sorted most-recent first.
- Each entry opens the tune at the bookmarked setting; the trash icon removes it.
- Stored in `localStorage` under the key `session-tabs:bookmarks`.

## Deep links

Each setting has a copy-link button that yields a URL of the form:

```
?tune=<tune_id>#<setting_id>
```

`?tune=<tune_id>` alone opens the tune scrolled to the top. The `#<setting_id>` fragment matches the `id` on each setting's `<h3>` so address-bar editing, back/forward, and right-click-copy all work as plain browser anchors.

## Data source

Tune data is from [TheSession](https://thesession.org/) via Jeremy Keith's
[TheSession-data](https://github.com/adactio/TheSession-data) dump.
If you find this useful, please
[donate to The Session](https://thesession.org/donate).

Audio search is powered by [FolkFriend](https://github.com/TomWyllie/folkfriend) by Tom Wyllie.
