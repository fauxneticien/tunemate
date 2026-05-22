# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Static site that views tunes from [TheSession](https://thesession.org/), rendered as sheet music + violin tab + audio in the browser, with name-search, audio-search (via FolkFriend WASM), and per-setting bookmarks. No bundler, no framework, no server runtime. `docs/` is the GitHub Pages root and is served as-is.

## Commands

```
task serve                       # python3 -m http.server -d docs 8000
task download-data               # curl | tar TheSession-data into tmp/TheSession-data-main/
task build-data                  # CSVs → docs/{meta,search-index,tunes/*}.json
task build-data LIMIT=100        # MWE: keep only top-100 popular tunes
task download-folkfriend-index   # refresh docs/plugins/folkfriend/tune-index.json (~34 MB)

docker compose up --build        # same as `task serve`, port 18080:8000, with python/node/curl/task pre-installed
```

The repo ships pre-built `docs/meta.json`, `docs/search-index.json`, `docs/tunes/*.json`, AND the FolkFriend artifacts (`docs/plugins/folkfriend/{folkfriend.js,folkfriend.d.ts,folkfriend_bg.wasm,tune-index.json,manifest.json,package.json}`). All are committed; build/download tasks are only needed when refreshing from upstream.

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

`docs/index.html` loads `docs/session.js` as an ES module. Third-party libs (abcjs, MiniSearch, pako, Font Awesome) all come from CDN via `<script>`/`<link>` tag + importmap — never installed locally for runtime.

`session.js` boot sequence (`boot()`):
1. Parallel fetch of `meta.json` + `search-index.json`; rehydrate MiniSearch via `loadJS` from the unwrapped `index` field.
2. Write `built_at` into the fixed top-right `#build-info` element.
3. Build `metaById` lookup from `meta.json` (used for popularity boost in search and metadata display).
4. If URL matches `?tune=<tune_id>[#<setting_id>]`, immediately open that tune.

Tune bodies (`docs/tunes/<id>.json`) are fetched lazily on selection. Search popularity boost: `1 + log1p(pop)/10`.

### Render pipeline

When a tune is opened, `session.js` builds one `<section class="setting">` per setting. Each section contains a header row (`<h3 id="<setting_id>">`, bookmark button, copy-link button, "Open in ABC Tools" link) and a `<pre><code class="abcjs">…</code></pre>` block. ABC headers are assembled by `buildAbc()`. After all placeholders are staged, `abcjs.render(code, idx)` from `docs/plugins/abcjs/abcjs.js` runs once per block, scheduled via `requestAnimationFrame`. The plugin replaces each `<pre>` with a wrapper containing the SVG paper, an audio control div, an "Activate Audio" button, and a "Show Tabs" checkbox (violin tablature on by default).

Three concurrency/UX patterns to preserve:
- **`openSeq` cancellation**: `openTune()` increments a monotonic counter; every `await` is followed by an `if (mySeq !== openSeq) return;` guard so a second click during a slow fetch/render doesn't double-render or scribble over the new tune.
- **Deep-link priority render**: when `?tune=…#<setting_id>` is set, the target setting renders first so the deep-link is usable immediately; the rest stream in after.
- **Late scroll**: scrolling to the target h3 happens **after** all abcjs renders complete. Doing it earlier lands in the wrong place because settings above the target grow in height as abcjs expands their `<pre>` into SVG paper, pushing the target down.

### URL state / deep links

URL format: `?tune=<tune_id>#<setting_id>`. The query carries the tune; the fragment is the **bare** setting_id (no `setting-` prefix), and the corresponding `<h3>` carries `id="<setting_id>"` so browser-native fragment navigation works for address-bar editing, back/forward, and right-click-copy.

Helpers in `session.js`: `parseTuneParam`, `setTuneParam`, `buildShareUrl`. `popstate` re-reads via `parseTuneParam`. Programmatic navigation (audio-search hit click, bookmark open, deep-link copy) uses `openTune(tuneId, settingId)`, which calls `setTuneParam(...,push=true)` followed by render + `scrollIntoView()` once layout settles.

Old `?view=N.M` links are no longer supported. The "Open in ABC Tools" link is unchanged — see "Share links" below.

### Naming quirks (don't "fix" these)

- `displayName()` rewrites `"Foo, The"` / `"Foo,the"` / `"Foo, THE "` → `"The Foo"` (case- and whitespace-insensitive). TheSession stores articles trailing for sort order; we move them back for display only — the stored `name` is unchanged.
- `buildAbc()` normalizes mode names for ABC headers: `Edorian` → `Edor`, `Gmajor` → `Gmaj`, `Aminor` → `Amin`, `Dmixolydian` → `Dmix`. abcjs's key parser wants the short forms.

### Share links

Two distinct URL formats:
- **Internal deep link**: `?tune=<tune_id>#<setting_id>` — handled by `parseTuneParam`/`setTuneParam`/`popstate`. The fragment is a real DOM anchor (h3 `id`).
- **"Open in ABC Tools" link**: ABC body → pako `deflate` → base64url (`+`→`-`, `/`→`_`, strip `=`) → `michaeleskin.com/abctools/abctools.html?def=…&format=mandolin&capo=0&ssp=10&stn=true&name=…`. The encoding scheme is fixed by the external tool.

### Audio search (FolkFriend plugin)

`docs/plugins/folkfriend/` ships the WASM transcription engine and tune index as committed artifacts:

| File | Purpose |
|---|---|
| `folkfriend.js` / `folkfriend.d.ts` | wasm-pack `--target web` bindings |
| `folkfriend_bg.wasm` | ~386 KB compiled engine |
| `tune-index.json` | ~34 MB JSON tune database (settings + aliases) |
| `ff-search.js` | thin wrapper: `searchByPcm`, `recordToBuffer`, `fileToPcm` (+ a `pcmToWavBlob` helper used to expose recordings as an `<audio>` source) |
| `ff-search.css` | modal + result-row styles (also shared by the bookmarks pane) |
| `manifest.json` | descriptive metadata, not read at runtime |

`session.js` lazy-imports `ff-search.js` only on the first mic-button click, so the 386 KB WASM and the 34 MB index never hit the initial page load. Subsequent loads come from the browser HTTP cache (revalidate-and-304 against same-origin static files — no IndexedDB layer needed).

**Critical quirks the wrapper has to respect**:
1. `load_index_from_json_obj` takes a JS object, not a JSON string.
2. PCM windows must be **exactly** 1024 samples (`SPEC_WINDOW_SIZE`); trailing partial is dropped.
3. `alloc_single_pcm_window` intentionally leaks ~4 KB per window (Rust `mem::forget` keeps the Float32Array view valid for JS writes); accepted for v1.
4. `transcribe_pcm_buffer()` returns either a contour string OR a JSON `{"error":…}` — `startsWith('{')` disambiguates.
5. **`flush_pcm_buffer()` is NOT called between feeding and transcribing**: despite the name, it clears the buffer rather than draining it, and transcription on a flushed buffer always returns "Could not detect any notes". The hand-off doc's skeleton was wrong on this point; verified against the test fixture (tune 8363 score 0.167, matching the CLI reference ranking). See the inline note in `searchByPcm()`.
6. `set_sample_rate(rate)` validates `rate ∈ [3952, 66974]`.

Result rendering: each hit gets a colour-graded label per FolkFriend's calibration (`#CC1111` red at score 0 → `#11CC11` green at score 0.7, clamped). Helpers `scoreLabel` and `scoreColour` live in `session.js`. Real-world scores cluster around 0.1–0.2 so the visible band is mostly red-to-orange — that's expected.

### Modal architecture

A single `<dialog id="ff-modal" class="ff-modal">` hosts both panes:
- `#ff-audio-pane` — audio search (record/upload buttons, status line, `<audio>` preview, results list)
- `#ff-bookmarks-pane` — bookmarks list

The opener functions (`openAudioSearchModal`, `openBookmarksModal`) toggle the panes' `hidden` attribute and swap `#ff-modal-title`. Both call `dialog.show()` (not `showModal()`) so the page behind stays interactive — by design, so clicking a result re-renders the tune in place without closing the panel (FolkFriend's top hit is often wrong; the user picks another result on a miss). Each opener wires its own `ff-cancel` / `keydown(Esc)` / `close` listeners; opening one closes the other first so listeners get cleaned up via the shared `close` event.

### Bookmarks

Stored in `localStorage` under the key `session-tabs:bookmarks` as a JSON array of `{ tuneId, settingId, name, type, mode, addedAt }` (`addedAt` is a `Date.now()` ms timestamp). Sorted most-recent-first on display only — write order is irrelevant. Re-bookmarking dedupes and refreshes `addedAt`.

Cross-view sync: every write dispatches a `bookmarkschanged` `CustomEvent` on `document`. A single delegated listener iterates all visible `.bookmark-btn[data-bm-key]` elements and refreshes their `fa-solid`/`fa-regular fa-bookmark` icon + `is-bookmarked` class. This is how deleting a bookmark from the modal updates the bookmark icon on the tune view behind it without a re-render.

### Menubar

`<nav id="menubar">` is fixed at top-left, mirroring `#build-info` at top-right. Two Font Awesome icon buttons:
- `fa-home` → clears URL to `/`, bumps `openSeq` to cancel any in-flight render, clears `#tune-view`, clears search input, refocuses.
- `fa-bookmark` → `openBookmarksModal()`.

### Plugin layout

`docs/plugins/` is structured as if it hosted multiple pluggable renderers, but in practice each is imported directly by `session.js` and is the only caller.

- `docs/plugins/abcjs/` — manifest, entrypoint (`abcjs.js`), CSS. Reads `pre code.abcjs` blocks and replaces with rendered SVG. The manifest's CDN list duplicates what `index.html` already loads; the plugin assumes `window.ABCJS` is already on the page.
- `docs/plugins/folkfriend/` — manifest, entrypoint (`ff-search.js`), CSS, WASM + bindings + tune index. See "Audio search" above. `.ff-modal` / `.ff-result*` styles in this plugin's CSS are also reused by the bookmarks pane in `session.js`; that's a deliberate shared-style coupling, not a folkfriend dependency.
