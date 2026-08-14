// TTS worker — runs Piper/Kokoro ONNX inference off the main thread so the
// UI never freezes during narration generation. Mirrors ffmpeg-worker.js's
// shape: a classic (non-module) Worker using dynamic import() for the
// vendored ES-module bundles (works in a classic worker the same way it
// already does in app.js's classic <script>), one persistent instance,
// message-in/message-out protocol.
importScripts("./lib/ffmpeg-filters.js"); // for parseWavDurationSec

let base = null;
let piperEnginePromise = null;
let kokoroEnginePromise = null;
let kokoroFetchPatched = false;

const KOKORO_JS = "vendor/kokoro/kokoro.web.js";
const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const KOKORO_HF_PREFIX = `https://huggingface.co/${KOKORO_MODEL_ID}/resolve/main/`;
const PIPER_JS = "vendor/piper-tts-web.js";

// Every other network fetch in the caption-sync/TTS pipeline already bounds
// itself with an AbortController timeout — mirrors app.js's ensurePiper()
// fetchVoiceFile helper, moved here since Piper's voice-fetching now happens
// worker-side.
async function fetchWithTimeout(url, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Fetch failed: ${url} (${res.status})`);
    return res;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Fetch timed out after ${timeoutMs / 1000}s: ${url}`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// kokoro.web.js hardcodes its model/config/tokenizer/voice fetches to a
// fixed HuggingFace URL prefix — same permanent, narrowly-scoped self.fetch
// patch app.js's patchKokoroFetch() applies on main thread, duplicated here
// since `self` inside a worker has its own independent fetch to patch
// (window.fetch on main thread does not reach into this worker).
function patchKokoroFetch() {
  if (kokoroFetchPatched) return;
  kokoroFetchPatched = true;
  const origFetch = self.fetch.bind(self);
  const localPrefix = base + "vendor/kokoro-model/";
  self.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url);
    if (typeof url === "string" && url.startsWith(KOKORO_HF_PREFIX)) {
      return origFetch(localPrefix + url.slice(KOKORO_HF_PREFIX.length), init);
    }
    return origFetch(input, init);
  };
}

async function ensureKokoroEngine() {
  if (!kokoroEnginePromise) {
    kokoroEnginePromise = (async () => {
      patchKokoroFetch();
      const mod = await import(base + KOKORO_JS);
      const { KokoroTTS, env } = mod;
      env.wasmPaths = base + "vendor/kokoro/onnx/";
      // Confirmed live: ORT-web's threaded WASM build (the only variant
      // vendored) never finishes instantiating when loaded from a nested
      // Worker (this worker) — it spawns its own pthread-emulation
      // sub-workers internally, and that bootstrap hangs indefinitely with
      // zero further fetches/progress once nested one level deep, even
      // though the same threaded build works fine when ffmpeg-worker.js (a
      // top-level worker) loads it directly. Forcing numThreads to 1 skips
      // that pthread pool entirely and runs the module single-threaded
      // instead — env.numThreads is a small, narrowly-scoped addition to
      // the vendored bundle's own env export, mirroring its existing
      // wasmPaths forwarding setter exactly (see kokoro.web.js's `Mf`).
      env.numThreads = 1;
      // device: "wasm" pins execution providers to plain wasm, skipping
      // kokoro-js's default "auto" device-detection step entirely (which
      // otherwise probes navigator.gpu — unnecessary since this app only
      // ever exercises the wasm path in practice).
      return await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: "q8", device: "wasm" });
    })();
  }
  return kokoroEnginePromise;
}

async function ensurePiperEngine() {
  if (!piperEnginePromise) {
    piperEnginePromise = (async () => {
      const mod = await import(base + PIPER_JS);
      const { PiperWebEngine, OnnxWebRuntime, PhonemizeWebRuntime } = mod;
      const voiceProvider = {
        async fetch(voice, speed) {
          // Piper's real speed knob is length_scale inside the voice's own
          // config JSON (fed into the ONNX model's "scales" tensor), not a
          // generate()-call argument — applied here (rather than read live
          // from the DOM the way app.js's applyPiperSpeed() used to, since
          // there's no DOM inside a worker) using the speed value passed in
          // this message's config. Inverse relationship: larger length_scale
          // = slower audio.
          const applySpeed = (json) => {
            if (!json || !json.inference || !speed || speed === 1) return json;
            return { ...json, inference: { ...json.inference, length_scale: (json.inference.length_scale || 1) / speed } };
          };
          if (voice === "en_US-ryan-medium") {
            const jsonRes = await fetchWithTimeout(base + "vendor/piper-voices/en_US-ryan-medium.onnx.json");
            const onnxRes = await fetchWithTimeout(base + "vendor/piper-voices/en_US-ryan-medium.onnx");
            const json = await jsonRes.json();
            const onnx = URL.createObjectURL(await onnxRes.blob());
            return [applySpeed(json), onnx];
          }
          const parts = voice.split("-");
          const lang = parts[0].split("_")[0];
          const hfBase = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang}/${parts[0]}/`;
          const sub = parts.slice(1).join("/");
          const stem = parts.join("-");
          const json = await (await fetchWithTimeout(`${hfBase}${sub}/${stem}.onnx.json`)).json();
          const onnx = URL.createObjectURL(await (await fetchWithTimeout(`${hfBase}${sub}/${stem}.onnx`)).blob());
          return [applySpeed(json), onnx];
        },
      };
      return new PiperWebEngine({
        onnxRuntime: new OnnxWebRuntime({ basePath: base + "onnx/", numThreads: 1 }),
        phonemizeRuntime: new PhonemizeWebRuntime({ basePath: base + "piper/" }),
        // voiceProvider.fetch(voice) is called with just `voice` by
        // PiperWebEngine — wrap it here so the per-call speed (threaded
        // through generate() below via a module-scoped var) reaches it.
        voiceProvider: { fetch: (voice) => voiceProvider.fetch(voice, pendingPiperSpeed) },
      });
    })();
  }
  return piperEnginePromise;
}
// PiperWebEngine.generate() re-fetches the voice fresh on every call via
// voiceProvider.fetch(voice) (no speed param in that library's own call
// signature) — this is set immediately before each generate() call below so
// the fetch closure above picks up the current request's speed.
let pendingPiperSpeed = 1;

// ---------- Kokoro chunk/trim/WAV-encode (moved from tts-engines.js — see
// that file's history for the trimSilenceFloat32/encodeMonoFloat32Wav
// rationale, unchanged here, just relocated off main thread) ----------
const KOKORO_SILENCE_RMS_THRESHOLD = 0.01;
const KOKORO_MAX_TRIM_SEC = 0.6;
const KOKORO_INTER_CHUNK_GAP_SEC = 0.12;
function trimSilenceFloat32(samples, sampleRate, maxTrimSec) {
  const maxTrimSamples = Math.floor(maxTrimSec * sampleRate);
  let start = 0;
  while (start < samples.length && start < maxTrimSamples && Math.abs(samples[start]) < KOKORO_SILENCE_RMS_THRESHOLD) start++;
  let end = samples.length;
  const minEnd = Math.max(start, samples.length - maxTrimSamples);
  while (end > minEnd && Math.abs(samples[end - 1]) < KOKORO_SILENCE_RMS_THRESHOLD) end--;
  return samples.subarray(start, end);
}
function encodeMonoFloat32Wav(samples, sampleRate) {
  const bytesPerSample = 4;
  const buffer = new ArrayBuffer(44 + bytesPerSample * samples.length);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF"); view.setUint32(4, 36 + bytesPerSample * samples.length, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, bytesPerSample * sampleRate, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 32, true);
  writeStr(36, "data"); view.setUint32(40, bytesPerSample * samples.length, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += bytesPerSample) view.setFloat32(offset, samples[i], true);
  return buffer;
}

async function generateKokoro(text, voice, config) {
  const tts = await ensureKokoroEngine();
  const speed = (config && config.speed) || 1;
  // See tts-engines.js's original comment (kept there historically, now
  // moot since the code moved) — Kokoro's ~510-token per-call limit means
  // long text must be chunked on sentence boundaries and generated
  // per-chunk, not via tts.stream() (confirmed to deadlock on this model).
  const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim());
  const chunks = sentences.length ? sentences : [text];
  const sampleChunks = [];
  let sampleRate = 24000;
  // Each chunk is a real, separate synthesis call — a genuine progress
  // signal (not a fake timer), so the main thread can show live
  // "chunk N/total" feedback instead of a static label for however long
  // a full story's worth of chunked generation takes.
  let chunkIndex = 0;
  for (const chunk of chunks) {
    self.postMessage({ type: "progress", current: chunkIndex, total: chunks.length });
    const audio = await tts.generate(chunk, { voice, speed });
    sampleRate = audio.sampling_rate;
    sampleChunks.push(trimSilenceFloat32(audio.audio, sampleRate, KOKORO_MAX_TRIM_SEC));
    chunkIndex++;
  }
  self.postMessage({ type: "progress", current: chunks.length, total: chunks.length });
  const gapSamples = sampleChunks.length > 1 ? Math.floor(KOKORO_INTER_CHUNK_GAP_SEC * sampleRate) : 0;
  const totalLen = sampleChunks.reduce((sum, c) => sum + c.length, 0) + gapSamples * Math.max(0, sampleChunks.length - 1);
  const merged = new Float32Array(totalLen);
  let offset = 0;
  sampleChunks.forEach((chunk, i) => {
    merged.set(chunk, offset);
    offset += chunk.length;
    if (i < sampleChunks.length - 1) offset += gapSamples;
  });
  const wavBuffer = encodeMonoFloat32Wav(merged, sampleRate);
  const durationSec = parseWavDurationSec(new Uint8Array(wavBuffer)) || (merged.length / sampleRate);
  return { audioBuffer: wavBuffer, mimeType: "audio/wav", durationSec };
}

async function generatePiper(text, voice, config) {
  const engine = await ensurePiperEngine();
  pendingPiperSpeed = (config && config.speed) || 1;
  const response = await engine.generate(text, voice, 0);
  const audioBuffer = await response.file.arrayBuffer();
  return { audioBuffer, mimeType: response.file.type || "audio/wav", durationSec: (response.duration || 0) / 1000 };
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      base = msg.base;
      self.postMessage({ type: "ready" });
      return;
    }
    if (msg.type === "kokoro-generate") {
      const { audioBuffer, mimeType, durationSec } = await generateKokoro(msg.text, msg.voice, msg.config);
      self.postMessage({ type: "result", audioBuffer, mimeType, durationSec }, [audioBuffer]);
      return;
    }
    if (msg.type === "piper-generate") {
      const { audioBuffer, mimeType, durationSec } = await generatePiper(msg.text, msg.voice, msg.config);
      self.postMessage({ type: "result", audioBuffer, mimeType, durationSec }, [audioBuffer]);
      return;
    }
  } catch (err) {
    self.postMessage({ type: "error", message: (err && err.message) || String(err) });
  }
};
