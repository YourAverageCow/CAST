// Everything runs in the browser: DeepSeek API, Piper TTS, ffmpeg.wasm.

const $ = (s) => document.querySelector(s);
const VERSION = 56;

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

// ---------- TTS & video engine state ----------
// libritts_r is audiobook-trained and reads flat/monotone. These are more
// expressive/energetic Piper voices, verified to actually exist in the
// rhasspy/piper-voices HuggingFace repo AND to use the standard 256-symbol
// phoneme table. Our phonemizeRuntime always encodes phonemes with that
// fixed 256-slot table internally (it doesn't read each voice's own
// phoneme_id_map), so any voice trained with a different-sized vocabulary
// (e.g. en_US-ryan-high and en_US-danny-low, both 130 symbols — legacy
// voices) throws an ONNX Gather out-of-bounds error mid-generation.
// Deliberately excluded here rather than merely undocumented.
const PIPER_VOICES = [
  "en_US-ryan-medium",
  "en_US-lessac-medium",
  "en_US-amy-medium",
  "en_US-hfc_female-medium",
  "en_US-hfc_male-medium",
  "en_US-joe-medium",
  "en_US-kristin-medium",
  "en_US-norman-medium",
  "en_US-libritts_r-medium",
  "en_GB-alan-medium",
  "en_GB-alba-medium",
  "en_GB-jenny_dioco-medium",
  "en_GB-northern_english_male-medium",
];
const DEFAULT_VOICE = PIPER_VOICES[0];
const PIPER_JS = "./vendor/piper-tts-web.js";
let piperEngine = null;

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
function toggleSettings() {
  if ($("#settingsPanel").classList.contains("open")) closeSettings();
  else openSettings();
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
  populateVoices(PIPER_VOICES);
  loadSettings();
  populateModels();
  // Save on any settings change
  for (const id of SETTINGS_FIELDS) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", saveSettings);
    if (el && el.tagName === "SELECT") el.addEventListener("change", saveSettings);
  }
  // Keep the caption preview live when style fields are edited by hand
  for (const id of ["font", "fontSize", "positionY", "textColor", "strokeColor", "strokeWidth", "resW"]) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", updateCaptionStyle);
  }
  initCaptionDrag();
  initPanelResize("sidebar", "sidebarResizeHandle", 1, "slopdaddy_sidebarWidth");
  initPanelResize("settingsPanel", "settingsResizeHandle", -1, "slopdaddy_settingsWidth");
  // The sidebar (and with it the preview box) can be resized by dragging its
  // edge — recompute the preview's pixel-to-output scale when that happens.
  new ResizeObserver(() => { if (currentVideo) updateCaptionStyle(); }).observe($("#previewContainer"));
  initBatchUI();
}

// Drag-to-resize for the left sidebar and the right settings panel. `sign`
// is +1 when the handle sits on the panel's right edge (dragging right
// grows it) or -1 when it sits on the left edge of a right-anchored panel
// (dragging left grows it, since the panel's own right edge stays pinned).
function initPanelResize(panelId, handleId, sign, storageKey) {
  const panel = document.getElementById(panelId);
  const handle = document.getElementById(handleId);
  if (!panel || !handle) return;

  const saved = parseInt(localStorage.getItem(storageKey));
  if (saved) panel.style.width = saved + "px";

  let startX = 0, startW = 0, dragging = false;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startW = panel.getBoundingClientRect().width;
    handle.classList.add("dragging");
    panel.classList.add("dragging-resize");
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const newW = startW + (e.clientX - startX) * sign;
    panel.style.width = newW + "px"; // CSS min/max-width clamps the actual value
  });
  function stop() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    panel.classList.remove("dragging-resize");
    localStorage.setItem(storageKey, Math.round(panel.getBoundingClientRect().width));
  }
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
}

function populateModels() {
  const p = $("#provider").value;
  $("#model").innerHTML = MODELS[p].map((m, i) => `<option value="${m}" ${i===0?'selected':''}>${m}</option>`).join("");
}
$("#provider").addEventListener("change", populateModels);

const VOICE_LABELS = {
  "en_US-ryan-medium": "Ryan (US male)",
  "en_US-lessac-medium": "Lessac (US male, clear)",
  "en_US-amy-medium": "Amy (US female)",
  "en_US-hfc_female-medium": "HFC Female (US)",
  "en_US-hfc_male-medium": "HFC Male (US)",
  "en_US-joe-medium": "Joe (US male)",
  "en_US-kristin-medium": "Kristin (US female)",
  "en_US-norman-medium": "Norman (US male, dramatic)",
  "en_US-libritts_r-medium": "LibriTTS (US, flat/audiobook)",
  "en_GB-alan-medium": "Alan (UK male)",
  "en_GB-alba-medium": "Alba (UK female)",
  "en_GB-jenny_dioco-medium": "Jenny (UK female)",
  "en_GB-northern_english_male-medium": "Northern English (UK male)",
};
function populateVoices(list) {
  const opts = list.map(v => `<option value="${v}">${VOICE_LABELS[v] || v}</option>`).join("");
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
// The fourcc-sniffing logic itself (detectUnsupportedCodec) lives in
// lib/video-utils.js — pure, unit-tested. This is just the async
// file-reading wrapper around it.
async function sniffUnsupportedVideoCodec(file) {
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    return detectUnsupportedCodec(buf);
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

    return await ffmpegPool.submit(async (worker) => {
      for (let i = 0; i < frameCount; i++) {
        await seekVideo(video, Math.min(i / CONVERT_FPS, video.duration || 0));
        ctx.drawImage(video, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        const bin = atob(dataUrl.split(",")[1]);
        const bytes = new Uint8Array(bin.length);
        for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
        worker.postFrame(i, bytes);
        if (onProgress) onProgress(Math.min(90, Math.round(((i + 1) / frameCount) * 90)));
      }
      const result = await worker.transcodeFinish(CONVERT_FPS, frameCount);
      if (onProgress) onProgress(100);
      return result;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Cheap metadata-only probe (no frame decode) — used to skip the ffmpeg
// scale/crop filter when the background is already at the export resolution.
function probeVideoDimensions(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve({ w: video.videoWidth || 0, h: video.videoHeight || 0 });
    };
    video.onerror = () => { URL.revokeObjectURL(url); resolve({ w: 0, h: 0 }); };
    video.src = url;
  });
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

  showCaptionSample();

  const codec = await sniffUnsupportedVideoCodec(file);
  currentVideoUnsupportedCodec = codec;
  if (codec) {
    showToast(`This video is ${codec}-encoded — the in-browser renderer can't read that directly. It'll be auto-converted to H.264 the first time you export.`, 8000);
  }
}

// ---------- Preview (realtime captions) ----------
// The preview box renders at whatever CSS width fits the sidebar (~400px),
// but captions are exported into a 1080px+-wide frame. Without correcting
// for that ratio, "68px" in the preview looks nothing like 68px in the
// actual output. Scale every pixel value (font size, stroke) by the same
// factor so the preview is a true-to-scale mockup of the real export.
function getPreviewScale() {
  const container = $("#previewContainer");
  const outputW = parseInt($("#resW").value) || 1080;
  return (container.clientWidth || 400) / outputW;
}
function updateCaptionStyle() {
  const el = $("#captionOverlay");
  const scale = getPreviewScale();
  el.style.fontFamily = $("#font").value + ", sans-serif";
  el.style.fontSize = ((parseInt($("#fontSize").value) || 68) * scale) + "px";
  el.style.color = $("#textColor").value;
  const sw = (parseInt($("#strokeWidth").value) || 0) * scale;
  const sc = $("#strokeColor").value;
  // 8-direction shadow (4 corners + 4 edges) so the outline fully surrounds
  // each glyph — 4 corners alone leaves visible gaps at the top/bottom/
  // left/right of the strokes, which is what looked "broken" in the preview.
  el.style.textShadow = sw
    ? [
        `-${sw}px -${sw}px 0 ${sc}`, `0 -${sw}px 0 ${sc}`, `${sw}px -${sw}px 0 ${sc}`,
        `${sw}px 0 0 ${sc}`,
        `${sw}px ${sw}px 0 ${sc}`, `0 ${sw}px 0 ${sc}`, `-${sw}px ${sw}px 0 ${sc}`,
        `-${sw}px 0 0 ${sc}`,
      ].join(", ")
    : "none";
  const y = parseFloat($("#positionY").value);
  el.style.left = "50%";
  el.style.top = ((isFinite(y) ? y : 0.55) * 100) + "%";
  el.style.transform = "translate(-50%, -50%)";
}
function renderCaption(time) {
  const cap = subtitles.find(s => time >= s.start && time <= s.end);
  if (cap) { $("#captionText").textContent = cap.text; $("#captionOverlay").classList.add("show"); }
  else { $("#captionText").textContent = ""; $("#captionOverlay").classList.remove("show"); }
}
function captionsLoop() {
  if (!previewActive) return;
  if (ttsAudio && !ttsAudio.paused) renderCaption(ttsAudio.currentTime);
  previewRAF = requestAnimationFrame(captionsLoop);
}
// Shows a static, draggable sample caption whenever nothing is actively
// narrating — lets the user position/size captions without needing a
// generated story or a running preview first.
function showCaptionSample() {
  if (!currentVideo) return;
  $("#captionText").textContent = "Your Caption Here";
  $("#captionOverlay").classList.add("show");
  updateCaptionStyle();
}
function stopPreview() {
  previewActive = false;
  if (previewRAF) { cancelAnimationFrame(previewRAF); previewRAF = null; }
  if (ttsAudio) { ttsAudio.pause(); ttsAudio.currentTime = 0; ttsAudio = null; }
  const vid = $("#videoPreview");
  vid.pause(); vid.currentTime = 0;
  $("#previewBtn").textContent = "Preview";
  showCaptionSample();
}

// ---------- Caption drag-to-position / drag-to-resize ----------
let captionDragState = null;
function initCaptionDrag() {
  const el = $("#captionOverlay");
  const handle = $("#captionResizeHandle");
  const container = $("#previewContainer");

  el.classList.add("editable");
  $("#captionEditHint").style.display = "block";

  el.addEventListener("pointerdown", (e) => {
    if (e.target === handle) return;
    e.preventDefault();
    captionDragState = {
      mode: "move", pointerId: e.pointerId,
      startY: e.clientY,
      startCY: parseFloat($("#positionY").value) || 0.55,
    };
    el.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault(); e.stopPropagation();
    const startSize = parseInt($("#fontSize").value) || 68;
    const startStroke = parseInt($("#strokeWidth").value) || 0;
    captionDragState = {
      mode: "resize", pointerId: e.pointerId,
      startY: e.clientY,
      startSize,
      // Keep the outline in proportion as the text grows/shrinks, instead
      // of it staying visually fixed while the glyphs scale around it.
      strokeRatio: startSize ? startStroke / startSize : 0,
    };
    handle.setPointerCapture(e.pointerId);
  });

  function onMove(e) {
    if (!captionDragState || e.pointerId !== captionDragState.pointerId) return;
    if (captionDragState.mode === "move") {
      const rect = container.getBoundingClientRect();
      const dy = (e.clientY - captionDragState.startY) / rect.height;
      $("#positionY").value = Math.min(0.95, Math.max(0.05, captionDragState.startCY + dy)).toFixed(3);
    } else {
      // Drag distance is in on-screen pixels; fontSize is in output-frame
      // pixels, which are larger by 1/scale — convert so a screen-drag of
      // N px visually grows the on-screen text by ~N px, not N * scale.
      const dy = (e.clientY - captionDragState.startY) / getPreviewScale();
      const newSize = Math.min(120, Math.max(24, Math.round(captionDragState.startSize + dy)));
      $("#fontSize").value = newSize;
      $("#strokeWidth").value = Math.min(10, Math.max(0, Math.round(newSize * captionDragState.strokeRatio)));
    }
    updateCaptionStyle();
  }
  function onUp(e) {
    if (!captionDragState || e.pointerId !== captionDragState.pointerId) return;
    captionDragState = null;
    saveSettings();
  }
  el.addEventListener("pointermove", onMove);
  handle.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  handle.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  handle.addEventListener("pointercancel", onUp);
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

// Piper runs on a single shared engine instance; concurrent-call safety
// isn't guaranteed (unverified, and the ONNX session inside it is stateful),
// so every generateSpeech call funnels through this one-at-a-time queue —
// including from parallel batch jobs, whose video rendering is otherwise
// fully concurrent. TTS is fast relative to rendering, so serializing it
// costs little even under a large batch.
let ttsQueueTail = Promise.resolve();
function queueTTS(fn) {
  const run = ttsQueueTail.then(fn, fn);
  // Swallow rejections here so one failed job doesn't wedge the queue for
  // everything queued after it — the caller still sees the real rejection
  // via `run`, this is only to keep ttsQueueTail chainable.
  ttsQueueTail = run.catch(() => {});
  return run;
}

async function generateSpeech(text, voice) {
  voice = voice || getVoice();
  // Sanitize again here as a safety net — piper's tokenizer uses TextEncoder
  // and throws "String contains an invalid character" on any lone surrogate.
  text = sanitizeText(text);
  if (!text) throw new Error("Story text is empty after cleaning.");
  return queueTTS(async () => {
    const engine = await ensurePiper();
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
  });
}

// computeWordTimings / buildSubsFromWords live in lib/captions.js (pure,
// unit-tested) and are used here unqualified since it's loaded as a
// classic <script> before this file.

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

// The pool (web/worker-pool.js) manages however many independent
// ffmpeg-worker.js instances are needed — 1 for today's single-video flow,
// more once batch rendering is wired up. Resizing is just creating a new
// pool; only the render/transcode call sites needed to change to route
// through `ffmpegPool.submit(...)` instead of talking to a single global
// worker directly.
let ffmpegPool = null;
let ffmpegPoolReady = null;
let ffmpegPoolSize = 0;

function ensureFFmpeg(poolSize) {
  poolSize = poolSize || 1;
  if (ffmpegPool && ffmpegPoolSize >= poolSize) return ffmpegPoolReady;
  // Only reached when growing past the current pool's capacity — destroy it
  // first so its Workers don't leak silently in the background.
  if (ffmpegPool) { ffmpegPool.destroy(); ffmpegPool = null; }
  ffmpegPoolSize = poolSize;
  showDownloadToast(
    poolSize > 1
      ? `Preparing video engine (first time only, ~25MB × ${poolSize})...`
      : "Preparing video engine (first time only, ~25MB)..."
  );
  const base = new URL("./", document.baseURI).href;
  ffmpegPoolReady = (async () => {
    // Captions are burned in via drawtext, which needs an exact font FILE
    // (there's no OS font store inside the WASM sandbox) — ship one bundled
    // font once here so every worker has it in its virtual FS.
    const fontBuf = await (await fetch(BASE + "vendor/fonts/DejaVuSans.ttf")).arrayBuffer();
    ffmpegPool = new FFmpegWorkerPool(poolSize, base, fontBuf);
    try {
      let readyCount = 0;
      await ffmpegPool.warmUp(() => {
        readyCount++;
        if (poolSize > 1) showDownloadToast(`Preparing video engine (${readyCount}/${poolSize} ready)...`);
      });
    } catch (e) {
      hideDownloadToast();
      throw e;
    }
    hideDownloadToast();
    if (!ffmpegPool.usingMT) {
      showToast(
        poolSize > 1
          ? "Running multiple renders at once uses the single-core video engine to avoid " +
            "overloading your CPU — each render is a bit slower, but they run in parallel."
          : "Fast multi-core video encoding isn't available here (usually Private Browsing, " +
            "which blocks the Service Worker it needs) — exports will be slower. " +
            "Use a normal browser window for faster exports.",
        8000
      );
    }
  })();
  return ffmpegPoolReady;
}

// Renders one job's video via the pool; resolves to a Uint8Array of the MP4.
function renderVideoInWorker(payload, onProgress) {
  return ffmpegPool.submit((worker) => worker.render(payload, onProgress));
}

// Snapshot of the global settings panel, in the same shape resolveJobSettings
// (lib/job-model.js) expects — the fallback values a job's own overrides
// are merged on top of.
function getGlobalSettings() {
  return {
    voice: getVoice(),
    resW: parseInt($("#resW").value) || 1080,
    resH: parseInt($("#resH").value) || 1920,
    fps: parseInt($("#fps").value) || 30,
    font: $("#font").value,
    fontSize: parseInt($("#fontSize").value) || 68,
    positionY: parseFloat($("#positionY").value) || 0.55,
    textColor: $("#textColor").value,
    strokeColor: $("#strokeColor").value,
    strokeWidth: parseInt($("#strokeWidth").value) || 3,
  };
}

// Runs one job end-to-end: transcode (if needed) -> voice -> render. Mutates
// `job` in place and calls onUpdate(job) after every state change instead of
// touching the DOM directly, so this is equally usable from the single-video
// sidebar (a "batch of one") and the batch composer. Never throws — check
// job.status/job.error after it resolves.
async function runJob(job, globalSettings, onUpdate) {
  const update = (patch) => { Object.assign(job, patch); if (onUpdate) onUpdate(job); };
  try {
    if (!job.bgFile) throw new Error("No background video.");
    const story = sanitizeText((job.story || "").trim());
    if (!story) throw new Error("No story text.");

    const settings = resolveJobSettings(job, globalSettings);

    let bgFile = job.bgFile;
    if (job.bgUnsupportedCodec) {
      if (!job.bgTranscoded) {
        const codec = job.bgUnsupportedCodec;
        update({ status: "transcode", progressPct: 0, progressLabel: `Converting ${codec} video to H.264...` });
        try {
          job.bgTranscoded = await autoTranscodeToH264(job.bgFile,
            (pct) => update({ progressPct: pct, progressLabel: `Converting ${codec} video to H.264...` }));
        } catch (convErr) {
          throw new Error(
            `Couldn't auto-convert this ${codec} video in your browser (${convErr.message}). ` +
            `Re-encode it manually, e.g.: ffmpeg -i input.mp4 -c:v libx264 -c:a aac output.mp4`
          );
        }
      }
      bgFile = job.bgTranscoded;
    }

    update({ status: "voice", progressPct: 0, progressLabel: "Generating voice..." });
    const { audioUrl, words } = await generateSpeech(story, settings.voice);
    const subs = buildSubsFromWords(words).map(s => ({ start: s.start, end: s.end, text: sanitizeText(s.text) }));

    const w = parseInt(settings.resW) || 1080;
    const h = parseInt(settings.resH) || 1920;
    const fps = parseInt(settings.fps) || 30;

    update({ status: "render", progressPct: 30, progressLabel: "Rendering..." });
    const bg = new Uint8Array(await bgFile.arrayBuffer());
    const audioData = new Uint8Array(await (await fetch(audioUrl)).arrayBuffer());
    const style = {
      fontSize: parseInt(settings.fontSize) || 68,
      textColor: settings.textColor,
      strokeColor: settings.strokeColor,
      strokeWidth: parseInt(settings.strokeWidth) || 3,
      positionY: parseFloat(settings.positionY) || 0.55,
    };
    // Lets the worker skip the scale/crop filter entirely when the
    // background is already at the export resolution.
    const { w: bgW, h: bgH } = await probeVideoDimensions(bgFile);

    const outBytes = await renderVideoInWorker({
      type: "render",
      base: new URL("./", document.baseURI).href,
      bg, audio: audioData, subs, style, w, h, fps, bgW, bgH,
    }, (pct) => update({ progressPct: pct, progressLabel: "Rendering..." }));

    const blob = new Blob([outBytes.buffer], { type: "video/mp4" });
    if (job.resultUrl) URL.revokeObjectURL(job.resultUrl);
    job.resultBlob = blob;
    update({ status: "done", progressPct: 100, progressLabel: "Done", resultUrl: URL.createObjectURL(blob) });
  } catch (e) {
    console.error(e);
    update({ status: "error", error: (e && e.message) || String(e) });
  }
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Renders (or updates in place, keyed by job.id) one result card. Buttons
// are bound directly to this job's own resultUrl instead of a shared global
// — each card is independent, so multiple can be live at once (batch mode).
function renderResultCard(job, container, opts) {
  opts = opts || {};
  let div = container.querySelector(`[data-job-id="${job.id}"]`);
  if (!div) {
    div = document.createElement("div");
    div.className = "video-result";
    div.dataset.jobId = job.id;
    if (opts.prepend) container.prepend(div); else container.appendChild(div);
  }
  // Batch cards (in #resultsGrid) show a short title so it's clear which
  // job a card belongs to; the single-flow's #outputContainer never has
  // more than one live card at a time, so it doesn't need one.
  const title = container.id === "resultsGrid"
    ? `<div class="result-card-title">${escapeHtml((job.premise || job.story || "Untitled").slice(0, 60))}</div>`
    : "";
  if (job.status === "done") {
    div.innerHTML = title + `
      <div class="actions">
        <button data-action="preview">Preview</button>
        <button data-action="download">Download</button>
        <button data-action="copy">Copy Link</button>
      </div>`;
    div.querySelector('[data-action="preview"]').onclick = () => previewExported(job.resultUrl);
    div.querySelector('[data-action="download"]').onclick = () => downloadVideo(job.resultUrl);
    div.querySelector('[data-action="copy"]').onclick = () => copyVideoLink(job.resultUrl);
  } else if (job.status === "error") {
    div.innerHTML = title +
      `<div class="result-error">${escapeHtml(job.error || "Export failed")}</div>` +
      (container.id === "resultsGrid" ? `<button class="result-retry-btn" data-action="retry">Retry</button>` : "");
    const retryBtn = div.querySelector('[data-action="retry"]');
    if (retryBtn) retryBtn.onclick = () => retryBatchJob(job);
  } else {
    div.innerHTML = title + `
      <div class="result-status">${escapeHtml(job.progressLabel || job.status)}</div>
      <div class="progress-bar-track"><div class="progress-bar-fill" style="width:${job.progressPct || 0}%"></div></div>`;
  }
  return div;
}

// The sidebar's "quick single export" — builds one job from the current
// sidebar/settings state and runs it through the same runJob() path batch
// jobs use, so there's exactly one render pipeline, not two.
async function exportVideo() {
  if (!currentVideo) { alert("Upload a background video first."); return; }
  const story = sanitizeText($("#storyText").value.trim());
  if (!story) { alert("Generate or paste a story first."); return; }

  stopPreview();
  const btn = $("#exportBtn");
  btn.textContent = "Exporting...";
  btn.disabled = true;

  const job = createJob({
    story,
    bgFile: currentVideo,
    bgUnsupportedCodec: currentVideoUnsupportedCodec,
    bgTranscoded: currentVideoTranscoded,
  });

  await ensureFFmpeg(1);
  const globalSettings = getGlobalSettings();
  await runJob(job, globalSettings, (j) => {
    setProgress(j.progressPct, j.progressLabel);
    renderResultCard(j, $("#outputContainer"), { prepend: true });
  });

  // Cache the transcoded background back onto the singleton so re-exporting
  // the same video doesn't re-transcode it, matching the old behavior.
  if (job.bgTranscoded) currentVideoTranscoded = job.bgTranscoded;

  if (job.status === "done") {
    showToast("Video exported!");
  } else {
    alert("Export failed: " + job.error);
  }

  btn.textContent = "Export Video";
  btn.disabled = false;
}

// sanitizeText lives in lib/captions.js (pure, unit-tested).

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

// ---------- Batch composer ----------
// Each card is its own fully independent job (own premise/story/background/
// voice/style) — the global settings panel only supplies the fallback
// values resolveJobSettings() falls back to for whatever a card doesn't
// override. Batch and Single share one ffmpegPool/runJob() pipeline.
let currentFlow = "single";
let batchJobs = [];
const MAX_PARALLEL_RENDERS = 15;

function setFlow(flow) {
  currentFlow = flow;
  $("#singleFlow").style.display = flow === "single" ? "" : "none";
  $("#batchFlow").style.display = flow === "batch" ? "" : "none";
  for (const btn of document.querySelectorAll(".flow-toggle-btn")) {
    btn.classList.toggle("active", btn.dataset.flow === flow);
  }
}

function initBatchUI() {
  const select = $("#batchParallelism");
  const opts = [];
  for (let i = 1; i <= MAX_PARALLEL_RENDERS; i++) opts.push(`<option value="${i}">${i}</option>`);
  select.innerHTML = opts.join("");
  // Conservative default — safe on most machines without a crowded tab;
  // still lets the user dial all the way up to MAX_PARALLEL_RENDERS.
  const defaultParallelism = Math.max(1, Math.min(3, navigator.hardwareConcurrency || 2));
  select.value = String(defaultParallelism);
  updateParallelismHint();
  select.addEventListener("change", updateParallelismHint);
  if (batchJobs.length === 0) addBatchCard();
}

function updateParallelismHint() {
  const n = parseInt($("#batchParallelism").value) || 1;
  $("#batchParallelismHint").textContent = n > 1
    ? `Renders ${n} at once, using the single-core video engine per render to avoid overloading your CPU. Higher than your machine can handle may slow things down or crash the tab — start lower and raise it if it's stable.`
    : "Renders one video at a time, using the faster multi-core video engine.";
}

function addBatchCard() {
  const job = createJob();
  batchJobs.push(job);
  const el = buildBatchCardElement(job);
  $("#batchCardList").appendChild(el);
  reindexBatchCards();
  return job;
}

function removeBatchCard(job, el) {
  batchJobs = batchJobs.filter(j => j !== job);
  el.remove();
  if (job.bgUrl) URL.revokeObjectURL(job.bgUrl);
  reindexBatchCards();
}

function reindexBatchCards() {
  const cards = $("#batchCardList").querySelectorAll(".batch-card-index");
  cards.forEach((el, i) => { el.textContent = "#" + (i + 1); });
}

// Builds one batch card's DOM once and wires all events directly to the
// job object — inputs write straight into `job.*` on every keystroke rather
// than going through a render/diff cycle, so typing never loses focus.
function buildBatchCardElement(job) {
  const voiceOpts = ['<option value="">Use settings voice</option>']
    .concat(PIPER_VOICES.map(v => `<option value="${v}">${VOICE_LABELS[v] || v}</option>`))
    .join("");

  const div = document.createElement("div");
  div.className = "batch-card";
  div.dataset.jobId = job.id;
  div.innerHTML = `
    <div class="batch-card-header">
      <span class="batch-card-index">#</span>
      <button class="batch-card-remove" title="Remove">&times;</button>
    </div>
    <label>Premise / Idea</label>
    <textarea class="bc-premise" rows="2" placeholder="e.g. My coworker keeps taking credit for my work..."></textarea>
    <div class="row">
      <button class="accent bc-ideas">Suggest Ideas</button>
      <button class="primary bc-genstory">Generate Story</button>
    </div>
    <label>Story</label>
    <textarea class="bc-story" rows="4" placeholder="Story text... or paste your own"></textarea>
    <label>Background video</label>
    <div class="bc-upload-area">Click to upload</div>
    <input type="file" class="bc-upload-input" accept="video/*" style="display:none">
    <label>Voice</label>
    <select class="bc-voice">${voiceOpts}</select>
    <button class="bc-customize-toggle">Customize style &#9662;</button>
    <div class="bc-customize" style="display:none">
      <div><label>Width</label><input type="number" class="bc-resW" min="480" max="2160" step="2"></div>
      <div><label>Height</label><input type="number" class="bc-resH" min="480" max="3840" step="2"></div>
      <div><label>FPS</label><input type="number" class="bc-fps" min="10" max="60"></div>
      <div><label>Font Size</label><input type="number" class="bc-fontSize" min="24" max="120"></div>
      <div><label>Position Y</label><input type="number" class="bc-positionY" min="0.05" max="0.95" step="0.01"></div>
      <div class="field-full"><label>Font</label><input type="text" class="bc-font"></div>
      <div><label>Text Color</label><input type="text" class="bc-textColor"></div>
      <div><label>Stroke Color</label><input type="text" class="bc-strokeColor"></div>
      <div class="field-full"><label>Stroke Width</label><input type="number" class="bc-strokeWidth" min="0" max="10"></div>
    </div>
  `;

  div.querySelector(".batch-card-remove").onclick = () => removeBatchCard(job, div);

  const premiseTa = div.querySelector(".bc-premise");
  const storyTa = div.querySelector(".bc-story");
  premiseTa.addEventListener("input", () => { job.premise = premiseTa.value; autoGrow(premiseTa); });
  storyTa.addEventListener("input", () => { job.story = storyTa.value; autoGrow(storyTa); });

  div.querySelector(".bc-ideas").onclick = () => getIdeasForCard(job, div.querySelector(".bc-ideas"), premiseTa);
  div.querySelector(".bc-genstory").onclick = () => generateStoryForCard(job, div.querySelector(".bc-genstory"), storyTa);

  const uploadArea = div.querySelector(".bc-upload-area");
  const uploadInput = div.querySelector(".bc-upload-input");
  uploadArea.onclick = () => uploadInput.click();
  uploadInput.onchange = () => { if (uploadInput.files[0]) setBatchCardBackground(job, uploadInput.files[0], div); };
  div.addEventListener("dragover", (e) => { e.preventDefault(); uploadArea.classList.add("drag"); });
  div.addEventListener("dragleave", () => uploadArea.classList.remove("drag"));
  div.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadArea.classList.remove("drag");
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("video/")) setBatchCardBackground(job, file, div);
  });

  div.querySelector(".bc-voice").addEventListener("change", (e) => { job.voice = e.target.value || null; });

  const customizeToggle = div.querySelector(".bc-customize-toggle");
  const customizePanel = div.querySelector(".bc-customize");
  customizeToggle.onclick = () => {
    const showing = customizePanel.style.display !== "none";
    customizePanel.style.display = showing ? "none" : "grid";
    customizeToggle.innerHTML = showing ? "Customize style &#9662;" : "Customize style &#9652;";
  };
  // Override fields are left blank (== inherit global default) until the
  // user actually types something — mirrors resolveJobSettings' null/""
  // fallback rule in lib/job-model.js.
  for (const field of JOB_OVERRIDE_FIELDS) {
    if (field === "voice") continue; // handled above via <select>
    const input = div.querySelector(`.bc-${field}`);
    if (!input) continue;
    input.addEventListener("input", () => {
      job[field] = input.value === "" ? null : input.value;
    });
  }

  return div;
}

async function setBatchCardBackground(job, file, cardEl) {
  job.bgFile = file;
  job.bgUnsupportedCodec = null;
  job.bgTranscoded = null;
  if (job.bgUrl) URL.revokeObjectURL(job.bgUrl);
  job.bgUrl = URL.createObjectURL(file);
  const area = cardEl.querySelector(".bc-upload-area");
  area.textContent = file.name;
  area.classList.add("uploaded");
  const codec = await sniffUnsupportedVideoCodec(file);
  job.bgUnsupportedCodec = codec;
  if (codec) {
    showToast(`This video is ${codec}-encoded — it'll be auto-converted to H.264 the first time this job renders.`, 6000);
  }
}

async function getIdeasForCard(job, btn, ta) {
  btn.textContent = "Loading...";
  btn.disabled = true;
  ta.value = "";
  try {
    await streamChat(
      [{ role: "system", content: "You output only one short creative idea. No markdown, no quotes." },
       { role: "user", content: ideasPrompt() }],
      (chunk) => { ta.value += chunk; job.premise = ta.value; autoGrow(ta); }
    );
  } catch (e) { alert("Failed: " + e.message); }
  btn.textContent = "Suggest Ideas";
  btn.disabled = false;
}

async function generateStoryForCard(job, btn, ta) {
  btn.textContent = "Generating...";
  btn.disabled = true;
  ta.value = "";
  const system = storySystemPrompt();
  const user = storyUserPrompt(job.premise || "a dramatic family conflict");
  try {
    await streamChat(
      [{ role: "system", content: system }, { role: "user", content: user }],
      (chunk) => { ta.value += chunk; job.story = ta.value; autoGrow(ta); }
    );
    showToast("Story generated!");
  } catch (e) { alert("Generation failed: " + e.message); }
  btn.textContent = "Generate Story";
  btn.disabled = false;
}

// Renders every draft/errored job through the pool at once — each job's own
// runJob() call queues on ffmpegPool.submit() internally, so this naturally
// gets "N at a time, rest wait" behavior for free from the pool, no extra
// scheduling logic needed here.
async function renderAllBatch() {
  const jobsToRun = batchJobs.filter(j => j.status === "draft" || j.status === "error");
  if (!jobsToRun.length) { showToast("Nothing to render — add a video or fix a failed one first."); return; }

  const btn = $("#renderAllBtn");
  btn.textContent = "Rendering...";
  btn.disabled = true;

  const parallelism = parseInt($("#batchParallelism").value) || 1;
  const globalSettings = getGlobalSettings();
  const grid = $("#resultsGrid");

  try {
    await ensureFFmpeg(parallelism);
    jobsToRun.forEach(j => { j.status = "queued"; j.progressLabel = "Queued..."; renderResultCard(j, grid); });
    await Promise.all(jobsToRun.map(job => runJob(job, globalSettings, (j) => renderResultCard(j, grid))));
    const failed = jobsToRun.filter(j => j.status === "error").length;
    showToast(failed ? `Batch done — ${failed} of ${jobsToRun.length} failed.` : "Batch complete!");
  } catch (e) {
    console.error(e);
    alert("Batch failed to start: " + (e && e.message ? e.message : String(e)));
  }

  btn.textContent = "Generate All";
  btn.disabled = false;
}

// Re-submits one failed batch job without touching the others.
async function retryBatchJob(job) {
  job.status = "queued";
  job.error = null;
  renderResultCard(job, $("#resultsGrid"));
  await ensureFFmpeg(parseInt($("#batchParallelism").value) || 1);
  await runJob(job, getGlobalSettings(), (j) => renderResultCard(j, $("#resultsGrid")));
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
