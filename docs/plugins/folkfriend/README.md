# FolkFriend plugin

Audio→tune transcription for session-tabs, powered by FolkFriend. This directory bundles a pre-built WASM port plus a thin browser wrapper that ranks candidate settings from microphone or file input.

## Attribution

This plugin would not exist without **[FolkFriend](https://github.com/TomWyllie/folkfriend) by Tom Wyllie**.

- **Engine** (`folkfriend.js`, `folkfriend.d.ts`, `folkfriend_bg.wasm`) — compiled directly from the upstream FolkFriend Rust crate. All transcription logic, training, calibration, and label/colour conventions originate there. Cargo version `1.3.0`, built with `wasm-pack build --target web --release`.
- **Tune index** (`tune-index.json`) — mirrored verbatim from FolkFriend's hosted dataset at `https://folkfriend-app-data.web.app/folkfriend-non-user-data.json`. The index itself is derived from public [TheSession](https://thesession.org/) data.
- **Score → label → colour mapping** — `scoreLabel` and `scoreColour` in the host repo's `session.js` reproduce FolkFriend's own calibration (`ResultRow.vue` / `utils.js`); the gradient endpoints (`#CC1111` / `#11CC11`) and thresholds (0.65 / 0.5 / 0.2) are Tom's, not ours.
- **License** — FolkFriend ships under **GPL v3** (see `LICENSE`).

If you find audio search useful here, the credit belongs upstream.

---

## Files

### Upstream artifacts (FolkFriend, GPL v3 — see `LICENSE`)

| File | Source |
|---|---|
| `LICENSE` | same GPL v3 as the original `TomWyllie/folkfriend`. |
| `folkfriend.js` | wasm-pack output. Loader + JS bindings. |
| `folkfriend.d.ts` | wasm-pack output. TypeScript types. |
| `folkfriend_bg.wasm` | Compiled FolkFriend transcription engine (~386 KB). |
| `package.json` | wasm-pack output (`"type": "module"`). Kept alongside the bindings; not consumed by the site. |
| `tune-index.json` | ~34 MB JSON tune database (`{ settings, aliases }`) — mirrored verbatim from `https://folkfriend-app-data.web.app/folkfriend-non-user-data.json`. Refresh with `task download-folkfriend-index` (defined in the repo-root `taskfile.yaml`). |

Build origin for the WASM artifacts: `TomWyllie/folkfriend` Cargo.toml version `1.3.0`, built with `wasm-pack build --target web --release` (Rust 1.75.0, wasm-pack 0.13.1). The host repo doesn't include the build infrastructure — rebuild from upstream when the engine needs updating.

### Local code (this repo)

| File | Purpose |
|---|---|
| `ff-search.js` | Thin wrapper. Exports `searchByPcm(pcm, sampleRate)`, `recordToBuffer({maxMs})`, `fileToPcm(file)`. Handles lazy WASM init, one-shot tune-index load, PCM windowing (1024 samples), and 16-bit-mono WAV encoding for recording playback. |
| `ff-search.css` | Modal panel + result-row styles. Also reused by the bookmarks pane in `session.js`. |
| `manifest.json` | Descriptive plugin metadata. Not read at runtime. |
| `README.md` | This file. |

## Wrapper quirks worth knowing

Documented in detail in the repo-root `CLAUDE.md` ("Audio search" section), but the headlines:

1. `load_index_from_json_obj` takes a **JS object**, not a JSON string.
2. PCM windows must be **exactly 1024 samples**.
3. **Do NOT call `flush_pcm_buffer()`** between feeding windows and transcribing — despite the name, it clears the buffer and transcription always returns "Could not detect any notes". Verified against the upstream test fixture; the wrapper omits the call.
4. `transcribe_pcm_buffer()` returns either a contour string OR a JSON `{"error":…}`; `startsWith('{')` disambiguates.
5. `set_sample_rate(rate)` validates `rate ∈ [3952, 66974]` Hz.
6. `alloc_single_pcm_window()` intentionally leaks ~4 KB per window (kept that way upstream for Float32Array-view validity). Accepted for v1.

## Licensing

The FolkFriend engine and tune index are GPL v3 (see `LICENSE`). The wrapper files (`ff-search.js`, `ff-search.css`, `manifest.json`, `README.md`) are part of this repo and inherit its top-level licensing.
