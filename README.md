# session-tabs

View tunes from [TheSession](https://thesession.org/), rendered as tabs + audio playback in the browser.

Static site — `docs/` is the GitHub Pages root, no server runtime.

## Stack

- [abcjs](https://github.com/paulrosen/abcjs) — ABC notation rendering, tab, audio (CDN)
- [MiniSearch](https://github.com/lucaong/minisearch) — client-side fuzzy search (CDN)
- [pako](https://github.com/nodeca/pako) — zlib deflate for the "Open in ABC Tools" share URLs (CDN)
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
task download-data    # curl | tar into tmp/TheSession-data-main/
task build-data       # → docs/meta.json, docs/search-index.json, docs/tunes/*.json
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

## Run with Docker

```
docker compose up --build
# → http://localhost:8000
```

The container has Python, Node, curl, and Task pre-installed, so
`docker compose exec app task download-data` and
`docker compose exec app task build-data` work the same as outside.

## Deep links

Each setting has a copy-link button that yields a URL of the form:

```
?view=<tune_id>.<setting_id>
```

`?view=<tune_id>` alone opens the tune at its first setting.

## Data source

Tune data is from [TheSession](https://thesession.org/) via Jeremy Keith's
[TheSession-data](https://github.com/adactio/TheSession-data) dump.
If you find this useful, please
[donate to The Session](https://thesession.org/donate).
