// Everything runs in the browser: DeepSeek API, Piper TTS, ffmpeg.wasm.

const $ = (s) => document.querySelector(s);
const VERSION = 40;

// Compute the app's base path so it works on GitHub Pages (where the site
// lives under /username/repo/ rather than the domain root).
const BASE = document.currentScript ? new URL('.', document.currentScript.src).pathname : '/';
let currentVideo = null;      // File / Blob of background
let currentVideoUrl = null;
let currentVideoUnsupportedCodec = null; // e.g. "AV1" if sniffed as unsupported
let currentVideoTranscoded = null;       // cached H.264 Blob once auto-converted
let subtitles = [];           // [{start, end, text}]
let previewActive = false;
let previewRAF = null;
let ttsAudio = null;
let lastVideoUrl = null;

// ---------- TTS & video engine state ----------
const DEFAULT_VOICE = "en_US-libritts_r-medium";
const PIPER_JS = "./vendor/piper-tts-web.js";
let piperEngine = null;
let ffmpeg = null;
let ffmpegLoaded = false;

// ---------- Tiny helpers ----------
function showToast(msg, duration) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), duration || 2500);
}
function setProgress(pct, stage) {
  const bar = $("#progressBar");
  const fill = $("#progressFill");
  const txt = $("#progressPercent");
  bar.style.display = "block";
  fill.style.width = pct + "%";
  txt.textContent = stage ? `${pct}% — ${stage}` : `${pct}%`;
  if (pct >= 100) setTimeout(() => { bar.style.display = "none"; }, 1500);
}
function openSettings() { $("#settingsOverlay").classList.add("show"); $("#settingsPanel").classList.add("open"); }
function closeSettings() { $("#settingsOverlay").classList.remove("show"); $("#settingsPanel").classList.remove("open"); }

async function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => res();
    s.onerror = () => rej(new Error("Failed to load " + src));
    document.head.appendChild(s);
  });
}

// ---------- API config ----------
const MODELS = {
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  openai: ["gpt-4o-mini", "gpt-4o"],
};

function apiBase() {
  return $("#provider").value === "openai" ? "https://api.openai.com/v1" : "https://api.deepseek.com/v1";
}

function getApiKey() {
  const k = $("#apiKey").value.trim();
  if (!k) { alert("Enter your API key in Settings first."); return null; }
  return k;
}

// Persist all settings in localStorage so they survive page reloads / hard resets.
const SETTINGS_FIELDS = [
  "apiKey", "provider", "model", "storyLength",
  "resW", "resH", "fps",
  "font", "fontSize", "positionY", "textColor", "strokeColor", "strokeWidth",
  "voice",
];
function saveSettings() {
  try {
    const data = {};
    for (const id of SETTINGS_FIELDS) {
      const el = document.getElementById(id);
      if (el) data[id] = el.value;
    }
    localStorage.setItem("slopdaddy_settings", JSON.stringify(data));
  } catch (e) {}
}

function loadSettings() {
  try {
    const raw = localStorage.getItem("slopdaddy_settings");
    if (!raw) return;
    const data = JSON.parse(raw);
    // Restore everything except model (model dropdown is rebuilt by provider),
    // then restore model after populateModels runs.
    for (const id of SETTINGS_FIELDS) {
      const el = document.getElementById(id);
      if (el && data[id] !== undefined && id !== "model") el.value = data[id];
    }
    populateModels();
    if (data["model"]) {
      const m = document.getElementById("model");
      if (m && [...m.options].some(o => o.value === data["model"])) m.value = data["model"];
    }
    // Keep the quick voice selector in sync
    if (data["voice"]) {
      const vq = document.getElementById("voiceQuick");
      if (vq) vq.value = data["voice"];
    }
  } catch (e) {}
}

// ---------- Init ----------
async function init() {
  $("#versionBadge").textContent = `v${VERSION}`;
  populateVoices([DEFAULT_VOICE]);
  loadSettings();
  populateModels();
  // Save on any settings change
  for (const id of SETTINGS_FIELDS) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", saveSettings);
    if (el && el.tagName === "SELECT") el.addEventListener("change", saveSettings);
  }
}

function populateModels() {
  const p = $("#provider").value;
  $("#model").innerHTML = MODELS[p].map((m, i) => `<option value="${m}" ${i===0?'selected':''}>${m}</option>`).join("");
}
$("#provider").addEventListener("change", populateModels);

function populateVoices(list) {
  const opts = list.map(v => `<option value="${v}">${v}</option>`).join("");
  $("#voice").innerHTML = opts;
  $("#voiceQuick").innerHTML = '<option value="">Use settings voice</option>' + opts;
}
function syncVoiceQuick() { const v = $("#voiceQuick").value; if (v) $("#voice").value = v; }
function getVoice() { syncVoiceQuick(); return $("#voice").value || DEFAULT_VOICE; }

// ---------- DeepSeek story generation (streaming, client-side) ----------
async function streamChat(messages, onChunk) {
  const key = getApiKey();
  if (!key) return;
  const base = apiBase();
  const resp = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({
      model: $("#model").value,
      stream: true,
      temperature: 0.9,
      messages,
    }),
  });
  if (!resp.ok) throw new Error("API error: " + resp.status);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
        if (delta && delta.content) onChunk(delta.content);
      } catch (e) {}
    }
  }
}

async function generateStory() {
  const btn = $("#genStoryBtn");
  const ta = $("#storyText");
  const premise = $("#premise").value.trim();
  btn.textContent = "Generating...";
  btn.disabled = true;
  ta.value = "";

  const system = storySystemPrompt();
  const user = storyUserPrompt(premise || "a dramatic family conflict");

  try {
    await streamChat(
      [{ role: "system", content: system }, { role: "user", content: user }],
      (chunk) => { ta.value += chunk; autoGrow(ta); validateInputs(); }
    );
    showToast("Story generated!");
  } catch (e) { alert("Generation failed: " + e.message); }
  btn.textContent = "Generate Story";
  btn.disabled = false;
}

async function getIdeas() {
  const btn = $("#ideasBtn");
  const ta = $("#premise");
  btn.textContent = "Loading...";
  btn.disabled = true;
  ta.value = "";
  try {
    await streamChat(
      [{ role: "system", content: "You output only one short creative idea. No markdown, no quotes." },
       { role: "user", content: ideasPrompt() }],
      (chunk) => { ta.value += chunk; autoGrow(ta); }
    );
    validateInputs();
  } catch (e) { alert("Failed: " + e.message); }
  btn.textContent = "Suggest Ideas";
  btn.disabled = false;
}

// ---------- Video upload ----------
// The bundled ffmpeg.wasm core has no usable AV1/VP8/VP9 decode path — feeding
// it those hangs forever with zero output (no error, no timeout). Sniff the
// MP4 sample-entry fourcc so we know to auto-convert before export instead of
// letting the user wait on a render that will never finish.
const UNSUPPORTED_VIDEO_CODECS = {
  av01: "AV1", vp09: "VP9", vp08: "VP8",
};
async function sniffUnsupportedVideoCodec(file) {
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const text = new TextDecoder("latin1").decode(buf);
    for (const fourcc in UNSUPPORTED_VIDEO_CODECS) {
      if (text.includes(fourcc)) return UNSUPPORTED_VIDEO_CODECS[fourcc];
    }
  } catch (e) { /* best-effort only */ }
  return null;
}

// Re-encode an unsupported-codec video to H.264 entirely client-side, using
// only APIs that work identically in every browser (unlike MediaRecorder,
// whose H.264 *encode* support Firefox lacks — it only ever emits WebM,
// which ffmpeg.wasm can't decode either). Seek through the video frame by
// frame (the browser's own decoder handles AV1/VP9 fine for playback), draw
// each frame to a <canvas>, and JPEG-encode it (canvas.toDataURL is
// synchronous and universally supported). The JPEG sequence is streamed to
// the ffmpeg worker, which assembles + encodes it to H.264 with its own
// already-proven libx264 path. Since the background loops during render
// anyway (-stream_loop -1), only the first CONVERT_MAX_SECONDS are needed.
const CONVERT_FPS = 12;
const CONVERT_MAX_SECONDS = 20;
function seekVideo(video, t) {
  return new Promise((resolve) => {
    const onSeeked = () => { video.removeEventListener("seeked", onSeeked); resolve(); };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = t;
  });
}
async function autoTranscodeToH264(file, onProgress) {
  await ensureFFmpeg();
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error("couldn't load video for conversion"));
    });
    // libx264 requires even dimensions; some browsers report odd intrinsic
    // sizes for anamorphic (non-square-pixel) sources, so round down.
    const w = video.videoWidth - (video.videoWidth % 2);
    const h = video.videoHeight - (video.videoHeight % 2);
    if (!w || !h) throw new Error("video has no readable frames");
    const duration = Math.min(isFinite(video.duration) ? video.duration : CONVERT_MAX_SECONDS, CONVERT_MAX_SECONDS);
    const frameCount = Math.max(1, Math.round(duration * CONVERT_FPS));

    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { alpha: false });

    for (let i = 0; i < frameCount; i++) {
      await seekVideo(video, Math.min(i / CONVERT_FPS, video.duration || 0));
      ctx.drawImage(video, 0, 0, w, h);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      const bin = atob(dataUrl.split(",")[1]);
      const bytes = new Uint8Array(bin.length);
      for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
      ffmpegWorker.postMessage({ type: "convertFrame", index: i, data: bytes.buffer }, [bytes.buffer]);
      if (onProgress) onProgress(Math.min(90, Math.round(((i + 1) / frameCount) * 90)));
    }

    return await new Promise((resolve, reject) => {
      ffmpegWorker.onmessage = (e) => {
        if (e.data.type === "convertDone") {
          if (onProgress) onProgress(100);
          resolve(new Blob([e.data.data], { type: "video/mp4" }));
        } else if (e.data.type === "error") {
          reject(new Error(e.data.message));
        }
      };
      ffmpegWorker.postMessage({ type: "convertFinish", fps: CONVERT_FPS, frameCount });
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function handleVideoUpload(input) {
  const file = input.files[0];
  if (!file) return;
  await setBackground(file, file.name);
}
async function setBackground(file, label) {
  currentVideo = file;
  currentVideoUnsupportedCodec = null;
  currentVideoTranscoded = null;
  if (currentVideoUrl) URL.revokeObjectURL(currentVideoUrl);
  currentVideoUrl = URL.createObjectURL(file);
  const vid = $("#videoPreview");
  vid.src = currentVideoUrl;
  vid.style.display = "block";
  $("#previewPlaceholder").style.display = "none";
  const area = $("#videoUploadArea");
  area.classList.add("uploaded");
  area.querySelector(".icon").textContent = "✓";
  $("#uploadStatus").textContent = label;

  const codec = await sniffUnsupportedVideoCodec(file);
  currentVideoUnsupportedCodec = codec;
  if (codec) {
    showToast(`This video is ${codec}-encoded — the in-browser renderer can't read that directly. It'll be auto-converted to H.264 the first time you export.`, 8000);
  }
}

// ---------- Preview (realtime captions) ----------
function updateCaptionStyle() {
  const el = $("#captionOverlay");
  el.style.fontFamily = $("#font").value + ", sans-serif";
  el.style.fontSize = $("#fontSize").value + "px";
  el.style.color = $("#textColor").value;
  const sw = parseInt($("#strokeWidth").value) || 0;
  const sc = $("#strokeColor").value;
  el.style.textShadow = sw ? `-${sw}px -${sw}px 0 ${sc}, ${sw}px -${sw}px 0 ${sc}, -${sw}px ${sw}px 0 ${sc}, ${sw}px ${sw}px 0 ${sc}` : "none";
  el.style.top = ($("#positionY").value * 100) + "%";
  el.style.transform = "translateY(-50%)";
}
function renderCaption(time) {
  const cap = subtitles.find(s => time >= s.start && time <= s.end);
  const el = $("#captionOverlay");
  if (cap) { el.textContent = cap.text; el.classList.add("show"); }
  else el.classList.remove("show");
}
function captionsLoop() {
  if (!previewActive) return;
  if (ttsAudio && !ttsAudio.paused) renderCaption(ttsAudio.currentTime);
  previewRAF = requestAnimationFrame(captionsLoop);
}
function stopPreview() {
  previewActive = false;
  if (previewRAF) { cancelAnimationFrame(previewRAF); previewRAF = null; }
  if (ttsAudio) { ttsAudio.pause(); ttsAudio.currentTime = 0; ttsAudio = null; }
  const vid = $("#videoPreview");
  vid.pause(); vid.currentTime = 0;
  $("#captionOverlay").classList.remove("show");
  $("#captionOverlay").textContent = "";
  $("#previewBtn").textContent = "Preview";
}

function showDownloadToast(msg) {
  const t = $("#downloadToast");
  if (!t) return;
  $("#downloadToastText").textContent = msg || "Downloading...";
  t.classList.add("show");
}
function hideDownloadToast() {
  const t = $("#downloadToast");
  if (t) t.classList.remove("show");
}

// Wait until the page is cross-origin isolated (the coi-serviceworker enables
// this on GitHub Pages, with a one-time reload). Piper's threaded wasm needs
// SharedArrayBuffer, which is only available when crossOriginIsolated.
async function waitForIsolation(timeoutMs = 15000) {
  const start = Date.now();
  while (!window.crossOriginIsolated && typeof SharedArrayBuffer === "undefined") {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise(r => setTimeout(r, 250));
  }
  return true;
}

async function ensurePiper() {
  if (piperEngine) return piperEngine;
  showDownloadToast("Preparing TTS engine...");
  const isolated = await waitForIsolation();
  if (!isolated) {
    hideDownloadToast();
    throw new Error("TTS engine needs cross-origin isolation (the page will reload once — try again after it loads).");
  }
  try {
    const mod = await import(PIPER_JS);
    const { PiperWebEngine, OnnxWebRuntime, PhonemizeWebRuntime } = mod;
    const voiceProvider = {
      async fetch(voice) {
        // Correct HuggingFace path for piper voices.
        const parts = voice.split("-");
        const lang = parts[0].split("_")[0];
        const base = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang}/${parts[0]}/`;
        const sub = parts.slice(1).join("/");
        const stem = parts.join("-");
        const jsonUrl = `${base}${sub}/${stem}.onnx.json`;
        const onnxUrl = `${base}${sub}/${stem}.onnx`;
        const json = await (await fetch(jsonUrl)).json();
        const onnx = URL.createObjectURL(await (await fetch(onnxUrl)).blob());
        return [json, onnx];
      },
    };
    piperEngine = new PiperWebEngine({
      onnxRuntime: new OnnxWebRuntime({ basePath: BASE + "onnx/", numThreads: 1 }),
      phonemizeRuntime: new PhonemizeWebRuntime({ basePath: BASE + "piper/" }),
      voiceProvider,
    });
  } catch (e) {
    hideDownloadToast();
    throw e;
  }
  return piperEngine;
}

async function generateSpeech(text) {
  const engine = await ensurePiper();
  const voice = getVoice();
  // Sanitize again here as a safety net — piper's tokenizer uses TextEncoder
  // and throws "String contains an invalid character" on any lone surrogate.
  text = sanitizeText(text);
  if (!text) throw new Error("Story text is empty after cleaning.");
  showDownloadToast(`Generating voice...`);
  try {
    const response = await engine.generate(text, voice, 0);
    hideDownloadToast();
    const audioUrl = URL.createObjectURL(response.file);
    // Piper phoneme data doesn't expose per-word timestamps directly;
    // estimate word timings from the audio duration.
    const durationSec = (response.duration || 0) / 1000;
    const words = computeWordTimings(text, durationSec);
    return { audioUrl, words };
  } catch (e) {
    hideDownloadToast();
    console.error("generateSpeech failed:", e);
    const detail = (e && e.stack) ? ("\n\n" + e.stack.split("\n").slice(0, 4).join("\n")) : "";
    throw new Error((e && e.message ? e.message : "TTS failed") + detail);
  }
}

// Estimate per-word timing from the full audio duration.
// We align words to the audio by distributing the narration time across
// words proportional to character length (better than uniform since it
// reflects word size), and respect paragraph pauses in the source text.
function computeWordTimings(text, totalDuration) {
  // Fallback estimate: if no real duration, assume ~150 words/min (~0.4s/word).
  if (!totalDuration || totalDuration <= 0) {
    const wordCount = (text.trim().split(/\s+/).filter(Boolean)).length || 1;
    totalDuration = wordCount * 0.4;
  }
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
  const allWords = [];
  let offset = 0;

  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(w => w && !/^[.,!?;:]+$/.test(w));
    if (!words.length) continue;
    allWords.push(...words.map(w => ({ w, para: true })));
  }

  const charTotal = allWords.reduce((s, x) => s + x.w.length + 1, 0) || 1;
  const perChar = totalDuration / charTotal;

  // Small fixed pause between paragraphs (~0.6s) is subtracted from total
  // but since totalDuration already includes it, we just let timing flow.
  const times = [];
  let t = 0;
  for (const { w } of allWords) {
    const dur = (w.length + 1) * perChar;
    times.push({ text: w, start: t, end: t + dur });
    t += dur;
  }
  // Scale so last word ends exactly at totalDuration
  if (times.length && t > 0) {
    const scale = totalDuration / t;
    times.forEach(x => { x.start *= scale; x.end *= scale; });
  }
  return times;
}

function buildSubsFromWords(words) {
  const subs = [];
  let i = 0;
  const maxChars = 14;
  while (i < words.length) {
    let takeTwo = false;
    if (i + 1 < words.length) {
      const combined = words[i].text + " " + words[i + 1].text;
      if (combined.length <= maxChars && (words[i + 1].start - words[i].end) < 0.35) takeTwo = true;
    }
    const g = takeTwo ? [words[i], words[i + 1]] : [words[i]];
    subs.push({ start: g[0].start, end: g[g.length - 1].end, text: g.map(w => w.text).join(" ") });
    i += g.length;
  }
  return subs;
}

async function startPreview() {
  const story = sanitizeText($("#storyText").value.trim());
  if (!story) { alert("Generate or paste a story first."); return; }
  if (!currentVideo) { alert("Upload a background video first."); return; }
  if (previewActive) { stopPreview(); return; }

  const btn = $("#previewBtn");
  btn.textContent = "Loading...";
  btn.disabled = true;
  try {
    const { audioUrl, words } = await generateSpeech(story);
    subtitles = buildSubsFromWords(words);
    if (!subtitles.length) { alert("No caption timing produced."); btn.textContent = "Preview"; btn.disabled = false; return; }

    updateCaptionStyle();
    const vid = $("#videoPreview");
    vid.currentTime = 0; vid.muted = true; vid.loop = true;
    if (ttsAudio) { ttsAudio.pause(); ttsAudio.remove(); }
    ttsAudio = new Audio(audioUrl);
    ttsAudio.addEventListener("ended", () => stopPreview());
    ttsAudio.addEventListener("pause", () => { vid.pause(); $("#captionOverlay").classList.remove("show"); });
    vid.play(); ttsAudio.play();
    previewActive = true;
    btn.textContent = "Stop";
    captionsLoop();
    showToast("Previewing...");
  } catch (e) {
    alert("Preview failed: " + e.message);
    btn.textContent = "Preview";
  }
  btn.disabled = false;
}
// ---------- Export (ffmpeg.wasm via core directly) ----------

let ffmpegWorker = null;
let ffmpegWorkerReady = null;

// Run ffmpeg in a Web Worker so the UI never freezes during rendering.
function ensureFFmpeg() {
  if (ffmpegWorker) return ffmpegWorkerReady;
  showDownloadToast("Preparing video engine (first time only, ~25MB)...");
  const base = new URL("./", document.baseURI).href;
  ffmpegWorker = new Worker(BASE + "ffmpeg-worker.js");
  ffmpegWorkerReady = (async () => {
    // The subtitles filter (libass) has no fonts to draw with inside the WASM
    // sandbox — there's no OS font store in there. Without one, captions
    // burn in as nothing: ffmpeg exits 0, the video looks fine, just silently
    // caption-free. Ship one bundled font so libass always has something.
    const fontBuf = await (await fetch(BASE + "vendor/fonts/DejaVuSans.ttf")).arrayBuffer();
    return new Promise((resolve, reject) => {
      ffmpegWorker.onmessage = (e) => {
        if (e.data.type === "ready") {
          hideDownloadToast();
          resolve();
        } else if (e.data.type === "error") {
          hideDownloadToast();
          reject(new Error(e.data.message));
        }
      };
      ffmpegWorker.onerror = (e) => {
        hideDownloadToast();
        reject(new Error("video worker failed: " + (e.message || "unknown")));
      };
      ffmpegWorker.postMessage({ type: "ready", base, font: fontBuf }, [fontBuf]);
    });
  })();
  return ffmpegWorkerReady;
}

// Render via the worker; resolves to an ArrayBuffer of the MP4.
// ffmpeg.exec() runs synchronously inside the worker, so if it's fed a codec
// it has no decoder for (see UNSUPPORTED_VIDEO_CODECS), it hangs forever with
// no progress tick, no error, nothing. Watch for a stall and bail out rather
// than leaving the user staring at a frozen progress bar indefinitely.
const RENDER_STALL_TIMEOUT_MS = 45000;
function renderVideoInWorker(payload, onProgress) {
  return new Promise((resolve, reject) => {
    let stallTimer = null;
    const resetStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        // The worker is unrecoverably stuck mid-exec (synchronous WASM call) —
        // terminate it outright and force a fresh worker on the next attempt.
        ffmpegWorker.terminate();
        ffmpegWorker = null;
        ffmpegWorkerReady = null;
        reject(new Error(
          "Rendering stalled with no progress for " + (RENDER_STALL_TIMEOUT_MS / 1000) +
          "s. This almost always means the background video's codec (e.g. AV1/VP9) " +
          "isn't supported by the in-browser renderer — re-encode it to H.264 and try again."
        ));
      }, RENDER_STALL_TIMEOUT_MS);
    };
    ffmpegWorker.onmessage = (e) => {
      if (e.data.type === "done") {
        clearTimeout(stallTimer);
        if (e.data.debug) console.warn("RENDER DEBUG", JSON.stringify(e.data.debug));
        resolve(new Uint8Array(e.data.data));
      } else if (e.data.type === "progress") {
        resetStallTimer();
        if (onProgress) {
          // ffmpeg progress is 0..1; map to 30%..95% (final 100 on completion)
          const pct = Math.min(95, Math.round(30 + (e.data.progress || 0) * 65));
          onProgress(pct);
        }
      } else if (e.data.type === "error") {
        clearTimeout(stallTimer);
        reject(new Error(e.data.message));
      }
    };
    resetStallTimer();
    ffmpegWorker.postMessage(payload, [payload.bg.buffer, payload.audio.buffer]);
  });
}

// Safe UTF-8 encoder that never throws — replaces lone surrogates with U+FFFD
// instead of crashing like TextEncoder does.
function safeUtf8(str) {
  const bytes = [];
  for (const ch of str) {
    let cp = ch.codePointAt(0);
    if (cp === 0xFFFD) { bytes.push(0xEF, 0xBF, 0xBD); continue; }
    const isLoneHigh = cp >= 0xD800 && cp <= 0xDBFF;
    const isLoneLow = cp >= 0xDC00 && cp <= 0xDFFF;
    if (isLoneHigh || isLoneLow) { bytes.push(0xEF, 0xBF, 0xBD); continue; }
    if (cp <= 0x7F) bytes.push(cp);
    else if (cp <= 0x7FF) bytes.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F));
    else if (cp <= 0xFFFF) bytes.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    else bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
  }
  return new Uint8Array(bytes);
}

async function exportVideo() {
  if (!currentVideo) { alert("Upload a background video first."); return; }
  const story = sanitizeText($("#storyText").value.trim());
  if (!story) { alert("Generate or paste a story first."); return; }

  stopPreview();
  const btn = $("#exportBtn");
  btn.textContent = "Exporting...";
  btn.disabled = true;

  try {
    let bgFile = currentVideo;
    if (currentVideoUnsupportedCodec) {
      if (!currentVideoTranscoded) {
        const codec = currentVideoUnsupportedCodec;
        setProgress(0, `Converting ${codec} video to H.264...`);
        try {
          currentVideoTranscoded = await autoTranscodeToH264(currentVideo,
            (pct) => setProgress(pct, `Converting ${codec} video to H.264...`));
        } catch (convErr) {
          throw new Error(
            `Couldn't auto-convert this ${codec} video in your browser (${convErr.message}). ` +
            `Re-encode it manually, e.g.: ffmpeg -i input.mp4 -c:v libx264 -c:a aac output.mp4`
          );
        }
      }
      bgFile = currentVideoTranscoded;
    }

    setProgress(0, "Generating voice...");
    const { audioUrl, words } = await generateSpeech(story);
    subtitles = buildSubsFromWords(words);

    await ensureFFmpeg();
    const w = parseInt($("#resW").value) || 1080;
    const h = parseInt($("#resH").value) || 1920;
    const fps = parseInt($("#fps").value) || 30;

    setProgress(30, "Rendering...");
    const bg = new Uint8Array(await bgFile.arrayBuffer());
    const audioData = new Uint8Array(await (await fetch(audioUrl)).arrayBuffer());
    const subs = subtitles.map(s => ({ start: s.start, end: s.end, text: sanitizeText(s.text) }));
    const style = {
      fontSize: parseInt($("#fontSize").value) || 68,
      textColor: $("#textColor").value,
      strokeColor: $("#strokeColor").value,
      strokeWidth: parseInt($("#strokeWidth").value) || 3,
      positionY: parseFloat($("#positionY").value) || 0.55,
    };

    const outBytes = await renderVideoInWorker({
      type: "render",
      base: new URL("./", document.baseURI).href,
      bg, audio: audioData, subs, style, w, h, fps,
    }, (pct) => setProgress(pct, "Rendering..."));

    const blob = new Blob([outBytes.buffer], { type: "video/mp4" });
    if (lastVideoUrl) URL.revokeObjectURL(lastVideoUrl);
    lastVideoUrl = URL.createObjectURL(blob);

    const div = document.createElement("div");
    div.className = "video-result";
    div.innerHTML = `
      <div class="actions">
        <button onclick="previewExported(lastVideoUrl)">Preview</button>
        <button onclick="downloadVideo(lastVideoUrl)">Download</button>
        <button onclick="copyVideoLink(lastVideoUrl)">Copy Link</button>
      </div>`;
    $("#outputContainer").prepend(div);
    showToast("Video exported!");
    setProgress(100);
  } catch (e) {
    console.error(e);
    const detail = (e && e.stack) ? ("\n\n" + e.stack.split("\n").slice(0, 4).join("\n")) : "";
    alert("Export failed: " + (e && e.message ? e.message : String(e)) + detail);
  }
  btn.textContent = "Export Video";
  btn.disabled = false;
}

// Remove characters TextEncoder/ffmpeg choke on (lone surrogates, control chars).
function sanitizeText(s) {
  if (typeof s !== "string") return "";
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")   // lone high surrogates
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1") // lone low surrogates
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ""); // control chars
}

// ---------- Player / download ----------
function previewExported(url) {
  const overlay = $("#playerOverlay");
  const player = $("#playerVideo");
  if (!overlay || !player) return;
  player.src = url;
  overlay.classList.add("show");
  player.play();
}
function closePlayer() {
  const overlay = $("#playerOverlay");
  const player = $("#playerVideo");
  if (!overlay) return;
  player.pause();
  player.removeAttribute("src");
  player.load();
  overlay.classList.remove("show");
}
function downloadVideo(url) {
  const a = document.createElement("a");
  a.href = url; a.download = "aitah-story.mp4";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
function copyVideoLink(url) {
  navigator.clipboard.writeText(url).then(() => showToast("Link copied!"));
}

// ---------- Prompts (mirror prompts.txt) ----------
function storySystemPrompt() {
  const wc = parseInt($("#storyLength").value) || 400;
  return `You are a master of writing fake-but-believable AITAH (Am I The Asshole Here) Reddit posts.
Your stories must follow these rules:

1. Casual, slightly dramatic first-person storytelling
2. NO throwaway-account disclaimer — never start with "Throwaway because..." or anything similar.
3. Open the story immediately with a hook that sets up the conflict.
4. Vary your opening every time — never repeat the same first sentence across stories.
5. Short paragraphs (2-4 sentences) — Reddit style
6. Family/friend/relationship/financial drama
7. A clear conflict where the narrator might actually be wrong
8. Keep it around ${wc} words
9. End with "So Reddit AITAH" — no question mark, nothing after
10. Write in a natural slightly messy style — as if typed on a phone at 2am
11. DO NOT make it obviously AI-generated
12. CRITICAL: Your very first line MUST be the title in "AITAH for [doing the thing]" format
13. Use natural punctuation — commas, periods, quotes.
14. Break the story into short paragraphs separated by blank lines.

IMPORTANT: First line is ALWAYS the AITAH title. Then a blank line, then the story. NEVER use a "Throwaway because" opener. Plain text only.`;
}
function storyUserPrompt(premise) {
  return `Write an AITAH Reddit post about: ${premise}

Start with the title "AITAH for [doing the thing]" as the first line then a blank line then jump straight into the story.

DO NOT start with "Throwaway because..." or any throwaway disclaimer. Begin with a strong opening hook.

Use normal punctuation. Break the story into short paragraphs separated by blank lines.

Plain text only.`;
}
function ideasPrompt() {
  return `Generate ONE creative idea for an AITAH Reddit post. Output ONLY the idea as a single string like "AITAH for [doing something dramatic]". No JSON, no quotes, no formatting.`;
}

// ---------- Input validation ----------
function validateInputs() {
  const premise = $("#premise");
  const story = $("#storyText");
  premise.classList.toggle("valid", premise.value.trim().length > 5);
  story.classList.toggle("valid", story.value.trim().length > 20);
}
function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = (el.scrollHeight + 2) + "px";
}

// Drag & drop
document.addEventListener("dragover", (e) => { e.preventDefault(); $("#videoUploadArea").classList.add("drag"); });
document.addEventListener("dragleave", () => { $("#videoUploadArea").classList.remove("drag"); });
document.addEventListener("drop", (e) => {
  e.preventDefault();
  $("#videoUploadArea").classList.remove("drag");
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith("video/")) setBackground(file, file.name);
});

init();
