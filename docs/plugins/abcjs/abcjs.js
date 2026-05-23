/**
 * ABCJS Plugin
 * Renders ABC music notation with audio playback and violin tablature
 */

// --- Helper Functions ---

function composeAfterParsing(...fns) {
  return (tune) => fns.reduce((t, fn) => fn(t), tune);
}

function addNoteNameAnnotations(tune) {
  const acc_lookup = Object.fromEntries(
    tune.getKeySignature().accidentals.map(a =>
      [a.note.toLowerCase(), a.acc === 'sharp' ? '#' : 'b']
    )
  );

  for (const line of tune.lines) {
    if (!line.staff) continue;
    for (const staff of line.staff) {
      for (const voice of staff.voices) {
        for (const o of voice) {
          if (!('pitches' in o)) continue;
          let note_name = o.pitches[0].name;
          if (note_name.toLowerCase() in acc_lookup) {
            note_name += acc_lookup[note_name.toLowerCase()];
          }
          o.chord = o.chord || [];
          o.chord.push({ name: note_name, position: 'below' });
        }
      }
    }
  }
  return tune;
}

const baseOptions = {
  responsive: 'resize',
  format: { annotationfont: "Palatino 10" },
  add_classes: true,
  afterParsing: composeAfterParsing(addNoteNameAnnotations)
};

function renderWithTabs(abc, paperId, showTabs, overrides = {}) {
  const container = document.getElementById(paperId);
  if (!container) return;
  container.innerHTML = "";
  // Pin add_classes on regardless of overrides — abcjs-mm{N} classes are
  // load-bearing for measure-selection and silently no-op without them.
  const options = { ...baseOptions, ...overrides, add_classes: true };
  if (showTabs) options.tablature = [{ instrument: "violin" }];
  return ABCJS.renderAbc(paperId, abc, options);
}

// --- Cursor Control ---

function CursorControl(rootSelector) {
  this.cursor = null;
  this.rootSelector = rootSelector;
  // When non-null, the synth is playing a snippet (offscreen visualObj
  // whose coords don't match this paper). Set to the 1-indexed full-
  // setting measure that snippet's mm0 corresponds to, so onEvent can
  // remap to the in-page DOM.
  this.snippetLo = null;
  this._lastSnippetMm = -1;

  this.onStart = function() {
    const svg = document.querySelector(this.rootSelector + " svg");
    if (!svg) return;
    // Sweep any leftover cursors before creating a new one. abcjs fires
    // onStart on every play (post-pause and post-setTune included) but
    // never removes the old <line>, so without this every play/pause
    // cycle and every snippet swap accumulates an orphan cursor.
    svg.querySelectorAll('.abcjs-cursor').forEach(el => el.remove());
    this._lastSnippetMm = -1;
    this.cursor = document.createElementNS("http://www.w3.org/2000/svg", "line");
    this.cursor.setAttribute("class", "abcjs-cursor");
    this.cursor.setAttributeNS(null, 'x1', 0);
    this.cursor.setAttributeNS(null, 'y1', 0);
    this.cursor.setAttributeNS(null, 'x2', 0);
    this.cursor.setAttributeNS(null, 'y2', 0);
    svg.appendChild(this.cursor);
  };

  this.removeSelection = function() {
    document.querySelectorAll(this.rootSelector + " .abcjs-highlight")
      .forEach(el => el.classList.remove("abcjs-highlight"));
  };

  this.onEvent = function(ev) {
    if (ev.measureStart && ev.left === null) return;
    this.removeSelection();
    ev.elements.forEach(note => note.forEach(n => n.classList.add("abcjs-highlight")));
    if (!this.cursor) return;

    // Snippet mode: ev coords are from an offscreen render that doesn't
    // match this paper. Remap by reading the snippet event's measure
    // class (abcjs-mm{N}) and translating to the in-page measure
    // (snippet mm0 = full setting measure snippetLo). The cursor jumps
    // once per measure to the leftmost note x — finer-grained tracking
    // lags audibly behind the synth and feels distracting against the
    // static .abcjs-mm-selected highlight, which already shows which
    // measures are sounding.
    if (this.snippetLo != null) {
      const firstEl = ev.elements[0] && ev.elements[0][0];
      const cls = firstEl ? (firstEl.getAttribute('class') || '') : '';
      const mmMatch = cls.match(/abcjs-mm(\d+)/);
      if (!mmMatch) return;
      const snippetMm = parseInt(mmMatch[1], 10);
      if (snippetMm === this._lastSnippetMm) return;
      this._lastSnippetMm = snippetMm;

      const paper = document.querySelector(this.rootSelector);
      if (!paper) return;
      const fullMm = snippetMm + (this.snippetLo - 1);
      const measureEls = paper.querySelectorAll(
        `.abcjs-mm${fullMm}.abcjs-note, .abcjs-mm${fullMm}.abcjs-tab-number`);
      let left = Infinity, top = Infinity, bottom = -Infinity;
      for (const el of measureEls) {
        if (typeof el.getBBox !== 'function') continue;
        let bb;
        try { bb = el.getBBox(); } catch (_) { continue; }
        if (!bb || !bb.height) continue;
        if (bb.x < left) left = bb.x;
        if (bb.y < top) top = bb.y;
        if (bb.y + bb.height > bottom) bottom = bb.y + bb.height;
      }
      if (left === Infinity) return;  // measure not found on this paper
      this.cursor.setAttribute("x1", left - 2);
      this.cursor.setAttribute("x2", left - 2);
      this.cursor.setAttribute("y1", top);
      this.cursor.setAttribute("y2", bottom);
      return;
    }

    // Full-setting mode: ev.top/ev.height covers only the main staff —
    // abcjs renders the tab line as a sibling layer with separate y.
    // Union the actual bboxes of every highlighted element (which include
    // tab numbers when tabs are on) so the cursor spans staff + tab.
    let top = ev.top;
    let bottom = ev.top + ev.height;
    for (const group of ev.elements) {
      for (const el of group) {
        if (typeof el.getBBox !== 'function') continue;
        let bb;
        try { bb = el.getBBox(); } catch (_) { continue; }
        if (!bb || !bb.height) continue;
        if (bb.y < top) top = bb.y;
        if (bb.y + bb.height > bottom) bottom = bb.y + bb.height;
      }
    }
    this.cursor.setAttribute("x1", ev.left - 2);
    this.cursor.setAttribute("x2", ev.left - 2);
    this.cursor.setAttribute("y1", top);
    this.cursor.setAttribute("y2", bottom);
  };

  this.onFinished = function() {
    this.removeSelection();
    if (this.cursor) {
      this.cursor.setAttribute("x1", 0);
      this.cursor.setAttribute("x2", 0);
      this.cursor.setAttribute("y1", 0);
      this.cursor.setAttribute("y2", 0);
    }
  };
}

// --- Audio Functions ---

function loadIntoSynth(synthControl, visualObj) {
  // Re-init the midi buffer with a fresh tune. setTune resolves once the
  // synth's UI reflects the new track.
  const midiBuffer = new ABCJS.synth.CreateSynth();
  return midiBuffer.init({ visualObj, chordsOff: true })
    .then(() => synthControl.setTune(visualObj, true));
}

function buildSynthController(audioId, cursorControl) {
  if (!ABCJS.synth.supportsAudio()) {
    console.log("Audio not supported in this browser");
    return null;
  }
  const synthControl = new ABCJS.synth.SynthController();
  synthControl.load(`#${audioId}`, cursorControl, {
    displayLoop: true,
    displayRestart: true,
    displayPlay: true,
    displayProgress: true,
    displayWarp: true,
    displayClock: true,
  });
  synthControl.disable(true);
  return synthControl;
}

// Parse ABC into a visualObj without showing the rendered SVG on the page.
// abcjs's parser is fused with its renderer (renderAbc), so we render into
// a detached div and discard the DOM. The returned visualObj is enough to
// drive the synth — cursor highlighting on those notes is a no-op since
// the DOM nodes never made it onto the page, which is fine for snippet
// playback (the full setting's score remains visible with the static
// .abcjs-mm-selected highlight).
function parseAbcToVisualObj(abc) {
  const tmp = document.createElement('div');
  tmp.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;visibility:hidden';
  document.body.appendChild(tmp);
  try {
    const v = ABCJS.renderAbc(tmp, abc, { add_classes: true });
    return v && v[0] ? v[0] : null;
  } finally {
    tmp.remove();
  }
}

// --- Plugin Export ---

export default {
  name: 'abcjs',
  selector: 'pre code.abcjs',

  render(codeEl, idx, opts = {}) {
    const abc = codeEl.textContent.trim();
    const wrapper = document.createElement("div");
    wrapper.id = `abcjs-wrapper-${idx}`;
    wrapper.classList.add("abcjs-wrapper");

    const paperId = `paper-${idx}`;
    const audioId = `audio-${idx}`;

    wrapper.innerHTML = `
      <label>
        <input type="checkbox" class="showTabs" checked> Show Tabs
      </label>
      <div id="${paperId}"></div>
      <div id="${audioId}" class="abcjs"></div>
      <button class="activate-audio">Activate Audio</button>
    `;

    codeEl.parentNode.replaceWith(wrapper);

    const { onMeasureClick, onAfterRender, getTempoPct, getAutoLoop, ...overrides } = opts;

    // Pull the tune-global measure index (abcjs-mm{N}) off the DOM classes.
    // Do NOT use analysis.measure — it's line-local and changes meaning
    // on every staff row. Same trap with abcjs-m{N} (single m).
    if (onMeasureClick) {
      overrides.clickListener = (_abcElem, _tuneNumber, classes) => {
        const match = classes && classes.match(/abcjs-mm(\d+)/);
        if (!match) return;
        onMeasureClick(parseInt(match[1], 10));
      };
    }

    const paperEl = wrapper.querySelector(`#${paperId}`);
    const checkbox = wrapper.querySelector(".showTabs");
    const doRender = () => {
      const v = renderWithTabs(abc, paperId, checkbox.checked, overrides);
      if (onAfterRender) onAfterRender(paperEl, v);
      return v;
    };

    let visualObj = doRender();

    const cursorControl = new CursorControl(`#${paperId}`);

    // Audio state: synthControl is created on first Activate Audio click;
    // snippetVisualObj overrides the played tune when non-null (driven
    // externally via the returned api.setSynthTune).
    let synthControl = null;
    let snippetVisualObj = null;
    const activeTune = () =>
      (snippetVisualObj || (visualObj && visualObj[0])) || null;

    // Tempo scaling: drive abcjs's own .abcjs-midi-tempo input inside
    // the audio controls. abcjs binds its warp handler to that input's
    // `change` event, so we set the value AND dispatch the event —
    // value-only assignment doesn't fire listeners. Programmatic API
    // calls (warpTune / qpm in audioParams) don't reliably take effect
    // in this build; the DOM control does.
    const applyWarp = () => {
      const pct = (typeof getTempoPct === 'function') ? getTempoPct() : 100;
      const tempoInput = wrapper.querySelector('.abcjs-midi-tempo');
      if (!tempoInput) return;
      if (Number(tempoInput.value) === pct) return;  // avoid feedback loops
      tempoInput.value = String(pct);
      tempoInput.dispatchEvent(new Event('change', { bubbles: true }));
    };

    // Sync the loop button to the autoLoop setting. Idempotent: clicks
    // only if the visual state (.abcjs-pushed) doesn't already match
    // the desired state. Safe to call multiple times — at activation
    // and on every settingschanged event.
    const applyLoop = () => {
      const want = (typeof getAutoLoop === 'function') ? !!getAutoLoop() : true;
      const loopBtn = wrapper.querySelector('.abcjs-midi-loop');
      if (!loopBtn) return;
      const isOn = loopBtn.classList.contains('abcjs-pushed');
      if (want !== isOn) loopBtn.click();
    };

    checkbox.addEventListener("change", () => {
      visualObj = doRender();
      // Tabs toggle re-renders the full setting. If we're currently
      // playing the full tune (no snippet override), reload it so the
      // synth's cursor binds to the new DOM nodes.
      if (synthControl && !snippetVisualObj) {
        const tune = activeTune();
        if (tune) loadIntoSynth(synthControl, tune).then(applyWarp);
      }
    });

    wrapper.querySelector(".activate-audio").addEventListener("click", (e) => {
      e.currentTarget.style.display = "none";
      synthControl = buildSynthController(audioId, cursorControl);
      const tune = activeTune();
      if (synthControl && tune) {
        loadIntoSynth(synthControl, tune).then(() => {
          applyWarp();
          applyLoop();
        });
      }
    });

    return {
      // Swap the played tune. Pass null to revert to the full setting.
      // Safe to call before Activate Audio: the new tune is stashed and
      // picked up on first activation. opts.lo is the 1-indexed full-
      // setting measure that the snippet's mm0 corresponds to; the
      // cursor uses it to remap snippet events back to this paper.
      setSynthTune(newVisualObj, opts = {}) {
        snippetVisualObj = newVisualObj || null;
        cursorControl.snippetLo = snippetVisualObj ? (opts.lo || 1) : null;
        if (!synthControl) return;
        const tune = activeTune();
        if (tune) loadIntoSynth(synthControl, tune).then(applyWarp);
      },
      // Live-adjust tempo on the active synth without reloading the
      // tune (no progress reset). No-op until Activate Audio has been
      // clicked — warpTune only takes effect on a loaded synth.
      applyTempo() {
        applyWarp();
      },
      // Sync loop state to the autoLoop preference. Same gating: no-op
      // until the audio controls have been built.
      applyLoop() {
        applyLoop();
      },
      // Shared parser so callers don't need their own hidden render div.
      parseAbc: parseAbcToVisualObj,
    };
  },

  init() {
    document.querySelectorAll(this.selector).forEach((el, idx) => {
      this.render(el, idx);
    });
  }
};
