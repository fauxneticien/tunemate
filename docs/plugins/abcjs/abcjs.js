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
  const options = { ...baseOptions, ...overrides };
  if (showTabs) options.tablature = [{ instrument: "violin" }];
  return ABCJS.renderAbc(paperId, abc, options);
}

// --- Cursor Control ---

function CursorControl(rootSelector) {
  this.cursor = null;
  this.rootSelector = rootSelector;

  this.onStart = function() {
    const svg = document.querySelector(this.rootSelector + " svg");
    if (!svg) return;
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
    if (this.cursor) {
      this.cursor.setAttribute("x1", ev.left - 2);
      this.cursor.setAttribute("x2", ev.left - 2);
      this.cursor.setAttribute("y1", ev.top);
      this.cursor.setAttribute("y2", ev.top + ev.height);
    }
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

function activateAudio(visualObj, cursorControl, audioId) {
  const button = document.querySelector(`#${audioId} ~ .activate-audio`);
  if (button) button.style.display = "none";

  if (!ABCJS.synth.supportsAudio()) {
    console.log("Audio not supported in this browser");
    return;
  }

  const controlOptions = {
    displayLoop: true,
    displayRestart: true,
    displayPlay: true,
    displayProgress: true,
    displayWarp: true,
    displayClock: true
  };

  const synthControl = new ABCJS.synth.SynthController();
  synthControl.load(`#${audioId}`, cursorControl, controlOptions);
  synthControl.disable(true);

  const midiBuffer = new ABCJS.synth.CreateSynth();
  midiBuffer.init({ visualObj: visualObj[0], chordsOff: true })
    .then(() => synthControl.setTune(visualObj[0], true));
}

// --- Plugin Export ---

export default {
  name: 'abcjs',
  selector: 'pre code.abcjs',

  render(codeEl, idx, overrides = {}) {
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

    const checkbox = wrapper.querySelector(".showTabs");
    let visualObj = renderWithTabs(abc, paperId, checkbox.checked, overrides);

    const cursorControl = new CursorControl(`#${paperId}`);

    checkbox.addEventListener("change", () => {
      visualObj = renderWithTabs(abc, paperId, checkbox.checked, overrides);
    });

    wrapper.querySelector(".activate-audio").addEventListener("click", () => {
      activateAudio(visualObj, cursorControl, audioId);
    });
  },

  init() {
    document.querySelectorAll(this.selector).forEach((el, idx) => {
      this.render(el, idx);
    });
  }
};
