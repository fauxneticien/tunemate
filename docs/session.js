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

  // Deep-link: ?view=<tune_id>[.<setting_id>]
  const view = parseViewParam();
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

function parseViewParam() {
  const v = new URLSearchParams(window.location.search).get('view');
  if (!v) return null;
  const [tuneStr, settingStr] = v.split('.');
  const tuneId = parseInt(tuneStr, 10);
  if (Number.isNaN(tuneId)) return null;
  const settingId = settingStr ? parseInt(settingStr, 10) : null;
  return { tuneId, settingId: Number.isNaN(settingId) ? null : settingId };
}

function setViewParam(tuneId, settingId, push) {
  const url = new URL(window.location);
  url.searchParams.set('view', settingId ? `${tuneId}.${settingId}` : `${tuneId}`);
  const method = push ? 'pushState' : 'replaceState';
  history[method]({ tuneId, settingId }, '', url);
}

function buildShareUrl(tuneId, settingId) {
  const url = new URL(window.location);
  url.searchParams.set('view', `${tuneId}.${settingId}`);
  return url.href;
}

window.addEventListener('popstate', () => {
  const view = parseViewParam();
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

// --- Tune view -----------------------------------------------------------

async function openTune(id, scrollToSettingId = null, opts = {}) {
  const { pushHistory = true } = opts;
  const mySeq = ++openSeq;

  if (pushHistory) setViewParam(id, scrollToSettingId, /*push=*/true);

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
  let targetSection = null;
  let targetCode = null;
  for (const s of tune.settings) {
    const section = document.createElement('section');
    section.className = 'setting';
    section.dataset.settingId = s.setting_id;
    section.id = `setting-${s.setting_id}`;

    const abc = buildAbc(tune, s);

    const headerRow = document.createElement('div');
    headerRow.className = 'setting-header';

    const h3 = document.createElement('h3');
    h3.textContent = `Setting ${s.setting_id} — ${s.mode} — by ${s.username || 'unknown'} (${(s.date || '').slice(0, 10)})`;
    headerRow.appendChild(h3);

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
      targetSection = section;
      targetCode = code;
    }
  }

  // Scroll: to the requested setting if any, otherwise to the tune top.
  (targetSection || tuneViewEl).scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Render target first so a deep-link is usable immediately, then the rest.
  const renderOrder = targetCode
    ? [targetCode, ...codeEls.filter(c => c !== targetCode)]
    : codeEls;

  for (const code of renderOrder) {
    await new Promise(r => requestAnimationFrame(r));
    if (mySeq !== openSeq) return;
    abcjs.render(code, renderIdx++);
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

// --- Go ------------------------------------------------------------------

boot().catch(err => {
  console.error(err);
  qInput.placeholder = 'Failed to load search index — see console.';
});
