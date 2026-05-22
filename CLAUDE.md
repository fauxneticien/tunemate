# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Static site that views tunes from [TheSession](https://thesession.org/), rendered as sheet music + violin tab + audio in the browser. No bundler, no framework, no server runtime. `docs/` is the GitHub Pages root and is served as-is.

## Commands

```
task serve          # python3 -m http.server -d docs 8000
task download-data  # curl | tar TheSession-data into tmp/TheSession-data-main/
task build-data     # CSVs → docs/{meta,search-index,tunes/*}.json
task build-data LIMIT=100   # MWE: keep only top-100 popular tunes

docker compose up --build   # same as `task serve`, with python/node/curl/task pre-installed
```

The repo ships pre-built `docs/meta.json`, `docs/search-index.json`, and `docs/tunes/*.json` — `build-data` is only needed when refreshing from upstream.

There are no tests, no linter, and no CI.

## Architecture

### Data pipeline (two stages, run in order by `task build-data`)

1. `build/build_session_data.py` reads `tmp/TheSession-data-main/csv/{tunes,aliases,tune_popularity}.csv` and writes:
   - `docs/tunes/<tune_id>.json` — one file per tune, with all its settings (ABC bodies, mode, contributor, date)
   - `docs/meta.json` — array of every tune sorted by popularity (id, name, type, mode, n_settings, pop)
   - `docs/search-docs.json` — **intermediate**, shape `{built_at, docs:[…]}`. Consumed and deleted by stage 2.
2. `build/build_search_index.mjs` reads `search-docs.json`, builds a MiniSearch index, writes `docs/search-index.json` as `{built_at, index:<serialized MiniSearch>}`, then deletes the intermediate. The `build/` npm package exists only for this step (MiniSearch + pako); none of it is served.

`built_at` is stamped by the Python script (UTC ISO seconds) and threaded through to the search-index so the viewer can show "Last built: …" without an extra fetch.

Tunes without a `tune_popularity.csv` row (0 tunebooks) are excluded from the build.

### Runtime (browser, no build step)

`docs/index.html` loads `docs/session.js` as an ES module. Third-party libs (abcjs, MiniSearch, pako) all come from CDN via `<script>` tag + importmap — never installed locally for runtime.

`session.js` boot sequence (`boot()`):
1. Parallel fetch of `meta.json` + `search-index.json`; rehydrate MiniSearch via `loadJS` from the unwrapped `index` field.
2. Write `built_at` into the fixed top-right `#build-info` element.
3. Build `metaById` lookup from `meta.json` (used for popularity boost in search and metadata display).
4. If URL has `?view=<tune_id>[.<setting_id>]`, immediately open that tune.

Tune bodies (`docs/tunes/<id>.json`) are fetched lazily on selection. Search popularity boost: `1 + log1p(pop)/10`.

### Render pipeline

When a tune is opened, `session.js` builds one `<pre><code class="abcjs">…</code></pre>` block per setting (ABC header assembled by `buildAbc()`), then calls `abcjs.render(code, idx)` from `docs/plugins/abcjs/abcjs.js` once per block via `requestAnimationFrame`. The plugin replaces each `<pre>` with a wrapper containing the SVG paper, an audio control div, an "Activate Audio" button, and a "Show Tabs" checkbox (violin tablature on by default).

Two concurrency/UX patterns to preserve:
- **`openSeq` cancellation**: `openTune()` increments a monotonic counter; every `await` is followed by an `if (mySeq !== openSeq) return;` guard so a second click during a slow fetch/render doesn't double-render or scribble over the new tune.
- **Deep-link priority render**: when `?view=….<setting_id>` is set, the target setting renders first (scroll lands on something useful immediately), then the rest stream in.

### Naming quirks (don't "fix" these)

- `displayName()` rewrites `"Foo, The"` / `"Foo,the"` / `"Foo, THE "` → `"The Foo"` (case- and whitespace-insensitive). TheSession stores articles trailing for sort order; we move them back for display only — the stored `name` is unchanged.
- `buildAbc()` normalizes mode names for ABC headers: `Edorian` → `Edor`, `Gmajor` → `Gmaj`, `Aminor` → `Amin`, `Dmixolydian` → `Dmix`. abcjs's key parser wants the short forms.

### Share links

Two distinct URL formats:
- **Internal deep link**: `?view=<tune_id>.<setting_id>` — handled by `parseViewParam`/`setViewParam`/`popstate`.
- **"Open in ABC Tools" link**: ABC body → pako `deflate` → base64url (`+`→`-`, `/`→`_`, strip `=`) → `michaeleskin.com/abctools/abctools.html?def=…&format=mandolin&capo=0&ssp=10&stn=true&name=…`. The encoding scheme is fixed by the external tool.

### Plugin layout

`docs/plugins/abcjs/` is structured as if it were one of several pluggable renderers (`manifest.json`, `selector: 'pre code.abcjs'`, `render(codeEl, idx)`), but in practice `session.js` imports it directly and is the only caller. The manifest's CDN list duplicates what `index.html` already loads — the plugin assumes `window.ABCJS` is already on the page.
