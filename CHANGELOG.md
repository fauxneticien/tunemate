# Changelog

All notable changes to this project will be documented here. Format inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 2026-05-22

### Added

- **Audio search via [FolkFriend](https://github.com/TomWyllie/folkfriend) (GPL v3) by Tom Wyllie.** Click the 🎤 in the search bar to open a left-side panel; record up to 10 s from the mic or upload an audio file, and FolkFriend's WASM transcription engine ranks the top 20 candidate settings on-device. No backend. All transcription logic, training, score calibration, and the colour-gradient label scheme are FolkFriend's — see `docs/plugins/folkfriend/README.md` for the full attribution and `LICENSE`.
  - Plugin layout under `docs/plugins/folkfriend/`: wasm-pack `--target web` bindings (`folkfriend.js`/`folkfriend_bg.wasm`, ~386 KB), the ~34 MB tune index (`tune-index.json`, committed; refresh via `task download-folkfriend-index`), a thin wrapper (`ff-search.js`) exporting `searchByPcm` / `recordToBuffer` / `fileToPcm`, and matching styles (`ff-search.css`).
  - WASM and index are lazy-loaded on the first mic click — zero impact on initial page weight. Same-origin HTTP caching covers cross-session reuse (no IndexedDB layer).
  - Captured/uploaded audio is retained as a `<audio controls>` element above the result list so users can A/B against each candidate's abcjs synthesis. Recordings are encoded to 16-bit mono WAV via a built-in `pcmToWavBlob` helper; uploads use the original file blob.
  - Confidence labels (`No Match` / `Unlikely` / `Possible` / `Close` / `Very Close`) and colour gradient (`#CC1111` → `#11CC11`, clamped to `[0, 0.7]`) reproduce FolkFriend's own calibration.
  - Each result row shows `<tune name> — <type · mode · ColouredLabel (score) to <tuneId>#<settingId>>`. The modal stays open across result clicks because FolkFriend's top hit is often wrong; users pick another on a miss.

- **Bookmarks.**
  - Per-setting bookmark icon (`fa-regular` outlined → `fa-solid` filled-gold on save) in each setting header.
  - Top-left menubar button opens a bookmarks pane (reuses the audio-search modal element via two `hidden`-toggled `<section>`s).
  - Stored in `localStorage` under `session-tabs:bookmarks`. Sorted most-recent-first. Trash icon per row removes.
  - `bookmarkschanged` CustomEvent dispatched on every write keeps the bookmark-icon state on the underlying tune view in sync when the modal mutates it.

- **Top-left menubar** (`#menubar`, fixed, mirrors `#build-info` on the right). `fa-home` clears the URL/state and refocuses the search box; `fa-bookmark` opens the bookmarks pane.

- **Font Awesome 6 (free) via jsDelivr** for menubar / bookmark / trash icons.

- **`task download-folkfriend-index`** to refresh the committed `docs/plugins/folkfriend/tune-index.json` from upstream.

### Changed

- **URL/linking system overhauled**: `?view=<tune_id>.<setting_id>` → `?tune=<tune_id>#<setting_id>`. The `<h3>` for each setting now carries `id="<setting_id>"` (bare numeric), so the fragment matches a real DOM anchor — browser-native fragment navigation (address-bar edit, back/forward, right-click-copy) works without any JS scroll math. Helpers renamed: `parseViewParam` → `parseTuneParam`, `setViewParam` → `setTuneParam`. **Breaking**: old `?view=…` links no longer resolve.

- **Deep-link scroll moved to the end of `openTune()`**, after every abcjs render completes. Previously fired before SVG paper expansion, which made the target h3's measured Y position stale and landed the scroll in the wrong place (somewhere near the top settings). No more smooth-scroll animation — `scrollIntoView()` default (instant) only.

- **Search-bar layout switched to flex** to fit the new 🎤 button beside the input.

- **Docker host port changed to `18080`** to avoid collisions with VS Code's auto-forwarded dev ports (3000/5000/8000/8080).

### Fixed

- **FolkFriend transcription returning `"Could not detect any notes"` for valid audio.** The integration hand-off doc's skeleton called `flush_pcm_buffer()` after feeding PCM windows; despite the name, `flush` *clears* the buffer rather than draining it, so transcription always saw nothing. Removed the call; verified against the test fixture (tune 8363 / "macroom fling, the" at score 0.167, matching the upstream CLI reference ranking exactly).

- **Audio-search results no longer pollute the main search input.** Hits now render inside the modal panel instead of being adapted into the name-search suggestions dropdown (which had the side effect of writing the chosen tune's name into the `<input>`).

- **Reusing a recording without leaking blob URLs.** The modal revokes the previous `URL.createObjectURL` before attaching a new clip; closing the modal pauses + clears the `<audio>` element and revokes the final URL.

### Notes

- Browser-level note for users on VS Code's remote port-forwarding: the tunnel truncates large response bodies (the 34 MB tune-index hit `ERR_CONTENT_LENGTH_MISMATCH`). Workaround: bind the docker mapping to a port VS Code doesn't auto-forward (current default: `18080`), or stop the auto-forward from the Ports panel.
