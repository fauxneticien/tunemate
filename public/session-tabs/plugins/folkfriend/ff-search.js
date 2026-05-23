/**
 * FolkFriend audio-search wrapper.
 *
 * Public surface:
 *   searchByPcm(pcm, sampleRate)  → Promise<Hit[]>
 *   recordToBuffer({ maxMs })     → Promise<{pcm, sampleRate}>
 *   fileToPcm(file, targetRate?)  → Promise<{pcm, sampleRate}>
 *
 * The WASM engine and ~34 MB tune index are loaded lazily on first
 * call. The index ships in-repo as a same-origin static file, so the
 * browser HTTP cache covers cross-session reuse without IDB.
 */

import init, { FolkFriendWASM } from './folkfriend.js';

const INDEX_URL = new URL('./tune-index.json', import.meta.url);
// Hardcoded in the WASM (SPEC_WINDOW_SIZE). Each PCM chunk fed in
// must be exactly this many f32 samples; trailing partials are dropped.
const SPEC_WINDOW_SIZE = 1024;
const MIN_SAMPLE_RATE = 3952;
const MAX_SAMPLE_RATE = 66974;

let readyPromise = null;
let wasmInstance = null;

async function ensureReady() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    await init();
    const ff = new FolkFriendWASM();
    const res = await fetch(INDEX_URL);
    if (!res.ok) throw new Error(`tune-index fetch failed: HTTP ${res.status}`);
    const indexObj = await res.json();
    // Critical: pass the JS object, NOT a JSON string.
    ff.load_index_from_json_obj(indexObj);
    wasmInstance = ff;
  })();
  return readyPromise;
}

export async function searchByPcm(pcm, sampleRate) {
  await ensureReady();
  const ff = wasmInstance;

  if (sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    throw new Error(
      `Sample rate ${sampleRate} Hz outside FolkFriend's supported `
      + `range [${MIN_SAMPLE_RATE}, ${MAX_SAMPLE_RATE}]`);
  }
  if (!ff.set_sample_rate(sampleRate)) {
    throw new Error(`WASM rejected sample rate ${sampleRate}`);
  }

  const frames = Math.floor(pcm.length / SPEC_WINDOW_SIZE);
  if (frames === 0) {
    throw new Error(
      `Audio too short: ${pcm.length} samples (need ≥ ${SPEC_WINDOW_SIZE})`);
  }
  for (let i = 0; i < frames; i++) {
    const ptr = ff.alloc_single_pcm_window();
    const view = ff.get_allocated_pcm_window(ptr);
    view.set(pcm.subarray(i * SPEC_WINDOW_SIZE, (i + 1) * SPEC_WINDOW_SIZE));
    ff.feed_single_pcm_window(ptr);
  }
  // NOTE: do NOT call flush_pcm_buffer() here — despite the name, it
  // clears the buffer rather than draining it, so transcription on a
  // flushed buffer always returns "Could not detect any notes".
  // Verified against the test fixture: tune 8363 score 0.167 (#1)
  // matches the reference CLI ranking when flush is skipped.

  // transcribe_pcm_buffer returns either a contour string OR a JSON
  // error object as a string — disambiguate before querying.
  const out = ff.transcribe_pcm_buffer();
  if (out.startsWith('{')) {
    const err = (() => { try { return JSON.parse(out); } catch { return {}; } })();
    throw new Error(err.error || 'transcription failed');
  }
  return JSON.parse(ff.run_transcription_query(out));
}

export async function recordToBuffer({ maxMs = 10000 } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessorNode is deprecated but universally supported and
  // perfectly adequate for a one-shot capture. Swap for an
  // AudioWorkletNode if browsers start complaining.
  const processor = ctx.createScriptProcessor(SPEC_WINDOW_SIZE, 1, 1);
  const chunks = [];
  processor.onaudioprocess = (e) => {
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(ctx.destination);

  try {
    await new Promise((resolve) => setTimeout(resolve, maxMs));
  } finally {
    processor.disconnect();
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
  }

  const sampleRate = ctx.sampleRate;
  await ctx.close();

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const pcm = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) { pcm.set(c, offset); offset += c.length; }
  // blob is the same PCM re-wrapped as a 16-bit WAV so the UI can
  // attach it to an <audio> element for playback comparison against
  // the abcjs synthesis of each matched setting.
  const blob = pcmToWavBlob(pcm, sampleRate);
  return { pcm, sampleRate, blob };
}

export async function fileToPcm(file, targetRate = 48000) {
  const buf = await file.arrayBuffer();
  const tmp = new AudioContext();
  const decoded = await tmp.decodeAudioData(buf);
  await tmp.close();
  // Hand back the original file (File extends Blob) as the playback
  // source — the resampled/mono PCM we feed to the WASM is a lossy
  // derivative, but the user wants to hear what they actually played.
  if (decoded.sampleRate === targetRate && decoded.numberOfChannels === 1) {
    return { pcm: decoded.getChannelData(0), sampleRate: targetRate, blob: file };
  }
  const oac = new OfflineAudioContext(
    1, Math.ceil(decoded.duration * targetRate), targetRate);
  const src = oac.createBufferSource();
  src.buffer = decoded;
  src.connect(oac.destination);
  src.start();
  const rendered = await oac.startRendering();
  return { pcm: rendered.getChannelData(0), sampleRate: targetRate, blob: file };
}

// Minimal 16-bit PCM mono WAV encoder. Used for recordings only;
// uploaded files are already encoded.
function pcmToWavBlob(pcm, sampleRate) {
  const length = pcm.length;
  const buf = new ArrayBuffer(44 + length * 2);
  const v = new DataView(buf);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);                  // PCM fmt chunk size
  v.setUint16(20, 1, true);                   // audioFormat = PCM
  v.setUint16(22, 1, true);                   // numChannels = mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);      // byteRate (16-bit mono)
  v.setUint16(32, 2, true);                   // blockAlign
  v.setUint16(34, 16, true);                  // bitsPerSample
  writeStr(36, 'data');
  v.setUint32(40, length * 2, true);
  let off = 44;
  for (let i = 0; i < length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    off += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}
