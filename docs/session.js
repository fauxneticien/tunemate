/**
 * Session viewer: fuzzy search + on-demand tune rendering.
 *
 * Data flow:
 *   meta.json + search-index.json  loaded once at startup
 *   tunes/<id>.json                fetched when a result is opened
 *
 * Rendering reuses the abcjs plugin: we inject <pre><code class="abcjs">
 * blocks and call abcjs.render() directly for each one.
 */

import MiniSearch from 'minisearch';
import pako from 'pako';
import abcjs from './plugins/abcjs/abcjs.js';

const SEARCH_OPTS = {
  prefix: true,
  fuzzy: 0.2,
  boost: { name: 2 },
  // Nudge well-known tunes up the list when scores are close.
  // log1p(pop)/10 means pop=7500 → ~1.9x, pop=100 → ~1.5x, pop=0 → 1x.
  boostDocument: (id) => {
    const m = metaById.get(id);
    return 1 + Math.log1p(m ? m.pop : 0) / 10;
  },
};
const MAX_SUGGESTIONS = 20;
const DEBOUNCE_MS = 150;

const qInput = document.getElementById('q');
const suggestionsEl = document.getElementById('suggestions');
const tuneViewEl = document.getElementById('tune-view');

let mini = null;
let metaById = new Map();         // id -> {n_settings, pop, ...}
let currentHits = [];             // suggestions currently displayed
let activeIdx = -1;               // highlighted suggestion index, -1 = none
let renderIdx = 0;                // monotonic id for abcjs render targets
let openSeq = 0;                  // bumps on each openTune; cancels in-flight renders

// --- Boot ----------------------------------------------------------------

async function boot() {
  qInput.disabled = true;
  qInput.placeholder = 'Loading search index…';

  const [indexBlob, meta] = await Promise.all([
    fetch('./search-index.json').then(r => r.json()),
    fetch('./meta.json').then(r => r.json()),
  ]);

  mini = MiniSearch.loadJS(indexBlob.index, {
    fields: ['name', 'aliases'],
    storeFields: ['name', 'type', 'mode'],
    extractField: (doc, f) => Array.isArray(doc[f]) ? doc[f].join(' ') : doc[f],
  });

  showBuildInfo(indexBlob.built_at);

  for (const row of meta) metaById.set(row.id, row);

  qInput.disabled = false;
  qInput.placeholder = 'Search by name or alias, then press Enter…';
  qInput.focus();

  // Deep-link: ?tune=<tune_id>[#<setting_id>]
  const view = parseTuneParam();
  if (view) {
    const m = metaById.get(view.tuneId);
    if (m) qInput.value = displayName(m.name);
    openTune(view.tuneId, view.settingId, { pushHistory: false });
  }
}

function showBuildInfo(builtAt) {
  const el = document.getElementById('build-info');
  if (!el || !builtAt) return;
  // ISO "2026-05-22T12:34:56+00:00" → "2026-05-22"
  el.textContent = `Last built: ${builtAt.slice(0, 10)}`;
  el.title = builtAt;
}

// --- URL state -----------------------------------------------------------
//
// URL format: ?tune=<tune_id>#<setting_id>
//   - tune_id selects which tune JSON to fetch
//   - the URL fragment is the bare setting_id, matching the h3 anchor
//     rendered inside the tune view, so the browser can scroll to it
//     natively (and copy/share links land on the right setting).
//
// Old ?view=N.M links are no longer supported — keep this in mind if
// any bookmarks need migrating.

function parseTuneParam() {
  const params = new URLSearchParams(window.location.search);
  const tuneStr = params.get('tune');
  if (!tuneStr) return null;
  const tuneId = parseInt(tuneStr, 10);
  if (Number.isNaN(tuneId)) return null;
  const hash = window.location.hash.replace(/^#/, '');
  const settingId = hash ? parseInt(hash, 10) : null;
  return { tuneId, settingId: Number.isNaN(settingId) ? null : settingId };
}

function setTuneParam(tuneId, settingId, push) {
  const url = new URL(window.location);
  url.search = '';
  url.searchParams.set('tune', String(tuneId));
  url.hash = settingId ? `#${settingId}` : '';
  const method = push ? 'pushState' : 'replaceState';
  history[method]({ tuneId, settingId }, '', url);
}

function buildShareUrl(tuneId, settingId) {
  const url = new URL(window.location);
  url.search = '';
  url.searchParams.set('tune', String(tuneId));
  url.hash = settingId ? `#${settingId}` : '';
  return url.href;
}

window.addEventListener('popstate', () => {
  const view = parseTuneParam();
  if (view) {
    openTune(view.tuneId, view.settingId, { pushHistory: false });
  } else {
    tuneViewEl.innerHTML = '';
    ++openSeq;  // cancel any in-flight render
  }
});

// --- Suggestions ---------------------------------------------------------

function updateSuggestions(query) {
  query = query.trim();
  const hits = query
    ? mini.search(query, SEARCH_OPTS).slice(0, MAX_SUGGESTIONS)
    : [];
  renderSuggestions(hits);
}

function renderSuggestions(hits) {
  currentHits = hits;
  activeIdx = -1;
  suggestionsEl.innerHTML = '';
  if (hits.length === 0) {
    suggestionsEl.hidden = true;
    return;
  }
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const m = metaById.get(h.id) || {};
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    const nameEl = document.createElement('span');
    nameEl.className = 'sugg-name';
    nameEl.textContent = displayName(h.name || m.name || '');
    const metaEl = document.createElement('span');
    metaEl.className = 'sugg-meta';
    metaEl.textContent = `${m.type || h.type} · ${m.mode || h.mode}`;
    li.append(nameEl, metaEl);
    // mousedown fires before blur — lets us select before the input loses focus.
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      openHit(i);
    });
    li.addEventListener('mouseenter', () => setActive(i));
    suggestionsEl.appendChild(li);
  }
  suggestionsEl.hidden = false;
}

function setActive(idx) {
  const items = suggestionsEl.children;
  if (activeIdx >= 0 && items[activeIdx]) items[activeIdx].classList.remove('active');
  activeIdx = idx;
  if (activeIdx >= 0 && items[activeIdx]) {
    items[activeIdx].classList.add('active');
    items[activeIdx].scrollIntoView({ block: 'nearest' });
  }
}

function openHit(idx) {
  const h = currentHits[idx];
  if (!h) return;
  qInput.value = displayName(h.name || (metaById.get(h.id) || {}).name || '');
  suggestionsEl.hidden = true;
  openTune(h.id);
}

let debounceTimer = null;
qInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => updateSuggestions(qInput.value), DEBOUNCE_MS);
});

qInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!currentHits.length) return;
    setActive((activeIdx + 1) % currentHits.length);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!currentHits.length) return;
    setActive(activeIdx <= 0 ? currentHits.length - 1 : activeIdx - 1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (activeIdx >= 0) {
      openHit(activeIdx);
    } else if (currentHits.length) {
      openHit(0);
    } else {
      // No suggestions cached yet — search now, open the top hit if any.
      const q = qInput.value.trim();
      if (!q) return;
      const top = mini.search(q, SEARCH_OPTS)[0];
      if (top) {
        qInput.value = displayName(top.name);
        openTune(top.id);
      }
    }
  } else if (e.key === 'Escape') {
    suggestionsEl.hidden = true;
  }
});

qInput.addEventListener('focus', () => {
  if (currentHits.length) suggestionsEl.hidden = false;
});

// Delay hide so click/mousedown on a suggestion still registers.
qInput.addEventListener('blur', () => {
  setTimeout(() => { suggestionsEl.hidden = true; }, 150);
});

// --- Audio search --------------------------------------------------------

// Score → label thresholds match FolkFriend's calibration
// (ResultRow.vue:76-105). Ties go to the lower bucket.
function scoreLabel(score) {
  if (score > 0.65) return 'Very Close';
  if (score > 0.5)  return 'Close';
  if (score > 0.2)  return 'Possible';
  if (score > 0)    return 'Unlikely';
  return 'No Match';
}

// Linear gradient #CC1111 → #11CC11 clamped to [0, 0.7]. Matches
// FolkFriend's utils.js:61-79 colour curve. Real scores cluster
// around 0.1–0.2 so the visible band is mostly the red-to-orange end.
function scoreColour(score) {
  const t = Math.max(0, Math.min(0.7, score)) / 0.7;
  const lerp = (a, b) => Math.round(a + t * (b - a));
  return `rgb(${lerp(0xCC, 0x11)}, ${lerp(0x11, 0xCC)}, ${lerp(0x11, 0x11)})`;
}

document.getElementById('audio-search-btn').addEventListener('click', async () => {
  // Lazy import: keeps 386 KB WASM + 34 MB tune index out of the
  // initial page load. Both only fetch when the user first opens the
  // modal AND triggers a search.
  const ff = await import('./plugins/folkfriend/ff-search.js');
  openAudioSearchModal(ff);
});

function openAudioSearchModal(ff) {
  const modal = document.getElementById('ff-modal');
  document.getElementById('ff-modal-title').textContent = 'Search by audio';
  document.getElementById('ff-audio-pane').hidden = false;
  document.getElementById('ff-bookmarks-pane').hidden = true;
  const recordBtn = document.getElementById('ff-record');
  const uploadInput = document.getElementById('ff-upload');
  const cancelBtn = document.getElementById('ff-cancel');
  const statusEl = document.getElementById('ff-status');
  const resultsEl = document.getElementById('ff-results');
  const audioEl = document.getElementById('ff-audio');

  let busy = false;
  let audioUrl = null;
  const setStatus = (text) => { statusEl.textContent = text; };

  setStatus('');
  resultsEl.innerHTML = '';
  audioEl.removeAttribute('src');
  audioEl.hidden = true;

  // Wire blob → <audio>. Revokes the previous URL so repeated
  // captures within one modal session don't leak. Guards against
  // a stale ff-search.js (without `blob`) — common when the module
  // is dynamically imported and the page hasn't been hard-reloaded
  // after the wrapper changes.
  const attachAudio = (blob) => {
    if (!(blob instanceof Blob)) {
      console.warn('attachAudio: expected a Blob, got', blob);
      return;
    }
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(blob);
    audioEl.src = audioUrl;
    audioEl.hidden = false;
  };

  const onRecord = async () => {
    if (busy) return;
    busy = true;
    try {
      setStatus('Recording (10s)… hum the tune.');
      const { pcm, sampleRate, blob } = await ff.recordToBuffer({ maxMs: 10000 });
      attachAudio(blob);
      await runSearch(pcm, sampleRate);
    } catch (err) {
      console.error(err);
      setStatus(`Error: ${err.message}`);
    } finally {
      busy = false;
    }
  };

  const onUpload = async (e) => {
    if (busy) return;
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    busy = true;
    try {
      setStatus(`Decoding ${file.name}…`);
      const { pcm, sampleRate, blob } = await ff.fileToPcm(file);
      attachAudio(blob);
      await runSearch(pcm, sampleRate);
    } catch (err) {
      console.error(err);
      setStatus(`Error: ${err.message}`);
    } finally {
      // Reset so the same file can be picked again.
      uploadInput.value = '';
      busy = false;
    }
  };

  const runSearch = async (pcm, sampleRate) => {
    setStatus(`Transcribing ${pcm.length} samples @ ${sampleRate} Hz…`);
    resultsEl.innerHTML = '';
    const hits = await ff.searchByPcm(pcm, sampleRate);
    setStatus(hits.length
      ? `Found ${hits.length} matches — click one to open.`
      : 'No matches.');
    renderAudioResults(hits);
  };

  const renderAudioResults = (hits) => {
    resultsEl.innerHTML = '';
    for (const h of hits) {
      const tuneId = Number(h.setting.tune_id);
      const settingId = Number(h.setting_id);
      const m = metaById.get(tuneId) || {};
      const li = document.createElement('li');
      li.className = 'ff-result';
      li.tabIndex = 0;
      li.setAttribute('role', 'button');

      const nameEl = document.createElement('span');
      nameEl.className = 'ff-result-name';
      nameEl.textContent = displayName(m.name || h.display_name || '');

      const metaEl = document.createElement('span');
      metaEl.className = 'ff-result-meta';
      const type = m.type || h.setting.dance || '';
      const mode = m.mode || h.setting.mode || '';
      metaEl.append(`${type} · ${mode} · `);
      const scoreEl = document.createElement('span');
      scoreEl.className = 'ff-result-score';
      scoreEl.style.color = scoreColour(h.score);
      scoreEl.textContent = `${scoreLabel(h.score)} (${h.score.toFixed(2)})`;
      metaEl.appendChild(scoreEl);
      metaEl.append(` to ${tuneId}#${settingId}`);

      li.append(nameEl, metaEl);

      const onPick = () => {
        // Keep the modal open: folkfriend's top hit is often wrong and
        // the user may need to try the #2/#3 result. openTune pushes
        // ?tune=N#M via history.pushState (no reload).
        resultsEl.querySelectorAll('.ff-result-active')
          .forEach(el => el.classList.remove('ff-result-active'));
        li.classList.add('ff-result-active');
        openTune(tuneId, settingId);
      };
      li.addEventListener('click', onPick);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick();
        }
      });
      resultsEl.appendChild(li);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      modal.close();
    }
  };

  const closeModal = () => {
    recordBtn.removeEventListener('click', onRecord);
    uploadInput.removeEventListener('change', onUpload);
    cancelBtn.removeEventListener('click', closeModal);
    document.removeEventListener('keydown', onKeyDown);
    modal.removeEventListener('close', closeModal);
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      audioUrl = null;
    }
    audioEl.pause();
    audioEl.removeAttribute('src');
    audioEl.hidden = true;
    if (modal.open) modal.close();
    busy = false;
  };

  recordBtn.addEventListener('click', onRecord);
  uploadInput.addEventListener('change', onUpload);
  cancelBtn.addEventListener('click', closeModal);
  // dialog.close() (from ESC handler or close button) fires 'close';
  // route both through closeModal for unified cleanup.
  modal.addEventListener('close', closeModal);
  document.addEventListener('keydown', onKeyDown);

  // show() (not showModal()) — keeps the page behind interactive so
  // openTune's scroll and the tune view itself remain usable while
  // the results panel persists for retry clicks.
  modal.show();
}

// --- Tune view -----------------------------------------------------------

async function openTune(id, scrollToSettingId = null, opts = {}) {
  const { pushHistory = true } = opts;
  const mySeq = ++openSeq;

  if (pushHistory) setTuneParam(id, scrollToSettingId, /*push=*/true);

  tuneViewEl.innerHTML = '<p>Loading tune…</p>';
  let tune;
  try {
    tune = await fetch(`./tunes/${id}.json`).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
  } catch (err) {
    if (mySeq !== openSeq) return;
    tuneViewEl.innerHTML = `<p>Failed to load tune ${id}: ${err.message}</p>`;
    return;
  }
  if (mySeq !== openSeq) return;  // another openTune started while we awaited

  // Header
  tuneViewEl.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'tune-header';
  const h2 = document.createElement('h2');
  h2.textContent = displayName(tune.name);
  header.appendChild(h2);
  const metaP = document.createElement('p');
  metaP.className = 'tune-meta';
  metaP.textContent = `${tune.type} · ${tune.meter} · ${tune.mode} · ${tune.settings.length} settings`;
  header.appendChild(metaP);
  tuneViewEl.appendChild(header);

  // Stage all DOM placeholders first so the layout reflows once.
  const codeEls = [];
  let targetCode = null;
  for (const s of tune.settings) {
    const section = document.createElement('section');
    section.className = 'setting';

    const abc = buildAbc(tune, s);

    const headerRow = document.createElement('div');
    headerRow.className = 'setting-header';

    const h3 = document.createElement('h3');
    // Bare numeric id so the URL fragment (#<setting_id>) resolves
    // to this h3 — letting the browser scroll natively for both
    // initial-load deep-links and copy-link behavior.
    h3.id = String(s.setting_id);
    h3.textContent = `Setting ${s.setting_id} — ${s.mode} — by ${s.username || 'unknown'} (${(s.date || '').slice(0, 10)})`;
    headerRow.appendChild(h3);

    headerRow.appendChild(makeBookmarkButton(tune, s));
    headerRow.appendChild(makeCopyLinkButton(tune.tune_id, s.setting_id));

    const link = document.createElement('a');
    link.className = 'abctools-link';
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Open in ABC Tools ↗';
    link.href = abcToolsUrl(displayName(tune.name), abc);
    headerRow.appendChild(link);

    section.appendChild(headerRow);

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'abcjs';
    code.textContent = abc;
    pre.appendChild(code);
    section.appendChild(pre);
    tuneViewEl.appendChild(section);
    codeEls.push(code);

    if (scrollToSettingId && s.setting_id === scrollToSettingId) {
      targetCode = code;
    }
  }

  // If not deep-linking to a specific setting, scroll to the tune
  // top right away so the user sees it while abcjs renders.
  if (!scrollToSettingId) {
    tuneViewEl.scrollIntoView({ block: 'start' });
  }

  // Render target first so a deep-link is usable immediately, then the rest.
  const renderOrder = targetCode
    ? [targetCode, ...codeEls.filter(c => c !== targetCode)]
    : codeEls;

  for (const code of renderOrder) {
    await new Promise(r => requestAnimationFrame(r));
    if (mySeq !== openSeq) return;
    abcjs.render(code, renderIdx++);
  }

  // Final scroll to the targeted setting, AFTER every abcjs render
  // has expanded its <pre> into a full SVG. Doing this earlier
  // (before/during renders) lands in the wrong place because later
  // settings push the target h3 further down as they expand.
  if (mySeq !== openSeq) return;
  if (scrollToSettingId) {
    const targetH3 = document.getElementById(String(scrollToSettingId));
    if (targetH3) targetH3.scrollIntoView();  // default = instant, no animation
  }
}

function makeCopyLinkButton(tuneId, settingId) {
  const btn = document.createElement('button');
  btn.className = 'copy-link';
  btn.type = 'button';
  btn.title = 'Copy link to this setting';
  btn.setAttribute('aria-label', 'Copy link to this setting');
  btn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
    </svg>`;
  const note = document.createElement('span');
  note.className = 'copy-note';
  note.hidden = true;
  btn.addEventListener('click', async () => {
    const url = buildShareUrl(tuneId, settingId);
    const ok = await copyText(url);
    btn.classList.toggle('copied', ok);
    btn.classList.toggle('copy-failed', !ok);
    note.textContent = ok ? 'Copied!' : 'Copy failed';
    note.hidden = false;
    clearTimeout(btn._noteTimer);
    btn._noteTimer = setTimeout(() => {
      btn.classList.remove('copied', 'copy-failed');
      note.hidden = true;
    }, 1500);
  });
  // Return both — caller will append both to the h3.
  const frag = document.createDocumentFragment();
  frag.append(btn, note);
  return frag;
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      console.warn('navigator.clipboard.writeText failed, falling back', e);
    }
  }
  // execCommand fallback for http:// over LAN, file://, older browsers.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'absolute';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (e) {
    console.error('execCommand("copy") threw', e);
  }
  document.body.removeChild(ta);
  return ok;
}

/**
 * Build a michaeleskin.com/abctools URL for the given ABC.
 * Encoding: zlib deflate (pako) → base64url, matching the tool's `def=` param.
 */
function abcToolsUrl(name, abc) {
  const compressed = pako.deflate(abc);
  let binary = '';
  for (let i = 0; i < compressed.length; i++) {
    binary += String.fromCharCode(compressed[i]);
  }
  const def = btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const nameParam = encodeURIComponent((name || '').replace(/\s+/g, '_'));
  return `https://michaeleskin.com/abctools/abctools.html?def=${def}`
    + `&format=mandolin&capo=0&ssp=10&stn=true&name=${nameParam}`;
}

/**
 * Display-name normalization. Many tune names in TheSession are stored
 * as "Green Mountain, The" so they sort alphabetically by the first
 * meaningful word. For display we move the article to the front:
 *   "Green Mountain, The"  →  "The Green Mountain"
 *   "Wise Maid,the"        →  "The Wise Maid"
 *   "Kesh, THE "           →  "The Kesh"
 * Match is case- and whitespace-insensitive around the comma and `the`.
 */
function displayName(name) {
  if (!name) return '';
  const trimmed = name.trim();
  const m = trimmed.match(/,\s*the\s*$/i);
  return m ? 'The ' + trimmed.slice(0, m.index) : trimmed;
}

function buildAbc(tune, setting) {
  // ABC mode like "Edorian" → "Edor", "Gmajor" → "Gmaj"
  const mode = (setting.mode || tune.mode || 'C').replace(/major$/i, 'maj').replace(/minor$/i, 'min').replace(/dorian$/i, 'dor').replace(/mixolydian$/i, 'mix');
  return [
    'X: 1',
    `T: ${tune.name}`,
    `R: ${tune.type}`,
    `M: ${tune.meter || '4/4'}`,
    'L: 1/8',
    `K: ${mode}`,
    setting.abc,
  ].join('\n');
}

// --- Bookmarks -----------------------------------------------------------

const BOOKMARKS_KEY = 'session-tabs:bookmarks';

function loadBookmarks() {
  try {
    const raw = localStorage.getItem(BOOKMARKS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveBookmarks(bms) {
  localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bms));
  document.dispatchEvent(new CustomEvent('bookmarkschanged'));
}

function isBookmarked(tuneId, settingId) {
  return loadBookmarks().some(b => b.tuneId === tuneId && b.settingId === settingId);
}

function addBookmark({ tuneId, settingId, name, type, mode }) {
  const bms = loadBookmarks().filter(b => !(b.tuneId === tuneId && b.settingId === settingId));
  bms.push({ tuneId, settingId, name, type, mode, addedAt: Date.now() });
  saveBookmarks(bms);
}

function removeBookmark(tuneId, settingId) {
  const bms = loadBookmarks().filter(b => !(b.tuneId === tuneId && b.settingId === settingId));
  saveBookmarks(bms);
}

// Sync icon state on every visible setting whenever bookmarks change —
// covers the case where the bookmarks modal removes an entry while the
// underlying tune view is showing the corresponding setting.
document.addEventListener('bookmarkschanged', () => {
  document.querySelectorAll('.bookmark-btn[data-bm-key]').forEach(btn => {
    const [tid, sid] = btn.dataset.bmKey.split('.').map(Number);
    applyBookmarkIcon(btn, isBookmarked(tid, sid));
  });
});

function applyBookmarkIcon(btn, on) {
  const i = btn.querySelector('i');
  i.className = on ? 'fa-solid fa-bookmark' : 'fa-regular fa-bookmark';
  btn.classList.toggle('is-bookmarked', on);
  btn.setAttribute('aria-pressed', String(on));
}

function makeBookmarkButton(tune, setting) {
  const btn = document.createElement('button');
  btn.className = 'bookmark-btn';
  btn.type = 'button';
  btn.dataset.bmKey = `${tune.tune_id}.${setting.setting_id}`;
  btn.setAttribute('aria-label', 'Toggle bookmark');
  const i = document.createElement('i');
  btn.appendChild(i);
  applyBookmarkIcon(btn, isBookmarked(tune.tune_id, setting.setting_id));
  btn.addEventListener('click', () => {
    if (isBookmarked(tune.tune_id, setting.setting_id)) {
      removeBookmark(tune.tune_id, setting.setting_id);
    } else {
      addBookmark({
        tuneId: tune.tune_id,
        settingId: setting.setting_id,
        name: tune.name,
        type: tune.type,
        mode: setting.mode || tune.mode,
      });
    }
  });
  return btn;
}

function openBookmarksModal() {
  const modal = document.getElementById('ff-modal');
  // If the modal is already open in audio-search mode, close it first
  // so its cleanup runs before we swap panes.
  if (modal.open) modal.close();

  document.getElementById('ff-modal-title').textContent = 'Bookmarks';
  document.getElementById('ff-audio-pane').hidden = true;
  document.getElementById('ff-bookmarks-pane').hidden = false;

  const cancelBtn = document.getElementById('ff-cancel');
  const listEl = document.getElementById('ff-bookmarks-list');

  const render = () => {
    const bms = loadBookmarks().sort((a, b) => b.addedAt - a.addedAt);
    listEl.innerHTML = '';
    if (!bms.length) {
      const li = document.createElement('li');
      li.className = 'ff-empty';
      li.textContent = 'No bookmarks yet — click the bookmark icon next to any setting to save it.';
      listEl.appendChild(li);
      return;
    }
    for (const bm of bms) {
      const li = document.createElement('li');
      li.className = 'ff-result';
      li.tabIndex = 0;
      li.setAttribute('role', 'button');

      const nameEl = document.createElement('span');
      nameEl.className = 'ff-result-name';
      nameEl.textContent = displayName(bm.name || '');

      const metaEl = document.createElement('span');
      metaEl.className = 'ff-result-meta';
      metaEl.textContent = `${bm.type || ''} · ${bm.mode || ''} · ${bm.tuneId}#${bm.settingId}`;

      const trash = document.createElement('button');
      trash.className = 'bm-trash';
      trash.type = 'button';
      trash.setAttribute('aria-label', 'Remove bookmark');
      trash.innerHTML = '<i class="fa-solid fa-trash"></i>';
      trash.addEventListener('click', (e) => {
        e.stopPropagation();
        removeBookmark(bm.tuneId, bm.settingId);
        render();
      });

      li.append(nameEl, metaEl, trash);

      const onPick = () => openTune(bm.tuneId, bm.settingId);
      li.addEventListener('click', onPick);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick();
        }
      });
      listEl.appendChild(li);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      modal.close();
    }
  };

  const closeModal = () => {
    cancelBtn.removeEventListener('click', closeModal);
    document.removeEventListener('keydown', onKeyDown);
    modal.removeEventListener('close', closeModal);
    if (modal.open) modal.close();
  };

  cancelBtn.addEventListener('click', closeModal);
  modal.addEventListener('close', closeModal);
  document.addEventListener('keydown', onKeyDown);

  render();
  modal.show();
}

// --- Menubar -------------------------------------------------------------

document.getElementById('nav-home').addEventListener('click', () => {
  history.pushState({}, '', window.location.pathname);
  ++openSeq;  // cancel any in-flight render
  tuneViewEl.innerHTML = '';
  qInput.value = '';
  suggestionsEl.hidden = true;
  qInput.focus();
});

document.getElementById('nav-bookmarks').addEventListener('click', () => {
  openBookmarksModal();
});

// --- Go ------------------------------------------------------------------

boot().catch(err => {
  console.error(err);
  qInput.placeholder = 'Failed to load search index — see console.';
});
