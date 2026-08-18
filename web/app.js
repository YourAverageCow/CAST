// Everything runs in the browser: multiple AI story-gen providers, Piper TTS, ffmpeg.wasm.

const $ = (s) => document.querySelector(s);
const VERSION = 70;

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
let sidebarMusicFile = null; // background music for the sidebar's single-export flow

// ---------- TTS & video engine state ----------
// Piper/Kokoro voice lists and the TTS_ENGINES registry live in
// web/lib/tts-engines.js — this section just holds the per-engine runtime
// instances (lazily created, one per engine that needs local init).
const PIPER_JS = "./vendor/piper-tts-web.js";
const KOKORO_JS = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";
const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
let piperEngine = null;
let kokoroEngine = null;

// ---------- Tiny helpers ----------
function showToast(msg, duration) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), duration || 2500);
}
function openSettings() { $("#settingsOverlay").classList.add("show"); $("#settingsPanel").classList.add("open"); }
function closeSettings() { $("#settingsOverlay").classList.remove("show"); $("#settingsPanel").classList.remove("open"); }
function toggleSettings() {
  if ($("#settingsPanel").classList.contains("open")) closeSettings();
  else openSettings();
}

// ---------- API config ----------
// STORY_PROVIDERS (web/lib/story-providers.js) is the registry — this
// section is just the DOM glue: which provider/model/base-URL/API-key the
// settings panel currently has selected, and building the <select>s from
// the registry instead of hardcoded <option> tags (mirrors buildEngineSelect
// for TTS_ENGINES).
function getStoryProvider() {
  return STORY_PROVIDERS[$("#provider").value] || STORY_PROVIDERS[DEFAULT_STORY_PROVIDER];
}

function buildProviderSelect() {
  $("#provider").innerHTML = Object.values(STORY_PROVIDERS)
    .map(p => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join("");
}

// A provider's base URL is fixed except Ollama/self-hosted ones
// (editableBaseUrl), where the settings panel exposes a text field so the
// user can point at a different host/port than the localhost default.
function apiBase() {
  const provider = getStoryProvider();
  if (provider.editableBaseUrl) {
    return $("#customBaseUrl").value.trim() || provider.baseUrl;
  }
  return provider.baseUrl;
}

function getModel() {
  const provider = getStoryProvider();
  return provider.customModel ? $("#modelCustom").value.trim() : $("#model").value;
}

// Ollama (and any other needsApiKey:false provider) doesn't require a key —
// only alert/block generation for providers that actually need one.
function getApiKey() {
  const provider = getStoryProvider();
  const k = $("#apiKey").value.trim();
  if (!k && provider.needsApiKey) return null;
  return k;
}

// Persist all settings in localStorage so they survive page reloads / hard resets.
function numOr(raw, parseFn, fallback) {
  const n = parseFn(raw);
  return Number.isFinite(n) ? n : fallback;
}

const SETTINGS_FIELDS = [
  "apiKey", "provider", "model", "modelCustom", "customBaseUrl", "storyLength",
  "storySystemPromptOverride",
  "resW", "resH", "fps", "defaultMusicVolume",
  "font", "fontSize", "positionY", "textColor", "strokeColor", "strokeWidth",
  "voice", "captionPreset",
  "channelName",
  "ttsEngine", "ttsOpenaiKey", "ttsElevenlabsKey",
  "enableBrowserAsr",
];
function saveSettings() {
  try {
    const data = {};
    for (const id of SETTINGS_FIELDS) {
      const el = document.getElementById(id);
      if (el) data[id] = el.type === "checkbox" ? el.checked : el.value;
    }
    localStorage.setItem("cast_settings", JSON.stringify(data));
  } catch (e) {}
}

// Returns the parsed saved-settings object (or null) so init() can restore
// `voice` after populateVoices() has built that engine's option list —
// can't set a <select>'s value to an option that doesn't exist yet.
// Just the live label — wired to #defaultMusicVolume's own "input" event so
// it updates on every drag.
function updateDefaultMusicVolumeLabel() {
  const el = document.getElementById("defaultMusicVolume");
  const valueEl = document.getElementById("defaultMusicVolumeValue");
  if (el && valueEl) valueEl.textContent = Math.round(numOr(el.value, parseFloat, 0.25) * 100) + "%";
}

// Called only on load/import (not on every live drag) — resyncs the label
// AND seeds the sidebar's own per-video #musicVolume slider from the
// restored default. Still freely adjustable per export afterward, same as
// every other "default X" setting.
function resyncDefaultMusicVolumeLabel() {
  updateDefaultMusicVolumeLabel();
  const el = document.getElementById("defaultMusicVolume");
  const musicVolumeEl = document.getElementById("musicVolume");
  if (el && musicVolumeEl) musicVolumeEl.value = el.value;
}

function loadSettings() {
  try {
    const raw = localStorage.getItem("cast_settings");
    if (!raw) { resyncDefaultMusicVolumeLabel(); return null; }
    const data = JSON.parse(raw);
    // Restore everything except model (rebuilt per-provider) and voice
    // (rebuilt per-engine) — both restored once their options exist.
    for (const id of SETTINGS_FIELDS) {
      const el = document.getElementById(id);
      if (!el || data[id] === undefined || id === "model" || id === "voice") continue;
      if (el.type === "checkbox") el.checked = !!data[id]; else el.value = data[id];
    }
    populateModels();
    if (data["model"]) {
      const m = document.getElementById("model");
      if (m && [...m.options].some(o => o.value === data["model"])) m.value = data["model"];
    }
    resyncDefaultMusicVolumeLabel();
    return data;
  } catch (e) { return null; }
}

// Shared by the file-based and clipboard-based export paths below — the
// exact same JSON, just handed off differently (a downloaded file vs. a
// clipboard write).
function settingsExportJson() {
  const raw = localStorage.getItem("cast_settings");
  const data = raw ? JSON.parse(raw) : {};
  data._exportedFromVersion = VERSION;
  return JSON.stringify(data, null, 2);
}

function exportSettings() {
  const blob = new Blob([settingsExportJson()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `cast-settings-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
}

async function copySettingsToClipboard() {
  try {
    await navigator.clipboard.writeText(settingsExportJson());
    showToast("Settings copied to clipboard.");
  } catch (e) {
    alert("Couldn't copy to clipboard: " + (e && e.message ? e.message : String(e)));
  }
}

// Shared by the file-based and clipboard-based import paths below — parses
// and applies a settings JSON string exactly the same way regardless of
// where the text came from. loadSettings() (not applyLoadedSettings() —
// that's a main-only function, this app has no tabbed Settings panel to
// resync) already handles restoring every field from localStorage.
function applySettingsJsonText(jsonText) {
  const data = JSON.parse(jsonText);
  delete data._exportedFromVersion;
  localStorage.setItem("cast_settings", JSON.stringify(data));
  loadSettings();
}

function importSettingsFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applySettingsJsonText(reader.result);
      showToast("Settings imported.");
    } catch (e) {
      alert("Couldn't import that file: " + (e && e.message ? e.message : String(e)));
    }
  };
  reader.readAsText(file);
  input.value = "";
}

async function pasteSettingsFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) { alert("Clipboard is empty."); return; }
    applySettingsJsonText(text);
    showToast("Settings imported from clipboard.");
  } catch (e) {
    alert("Couldn't import from clipboard: " + (e && e.message ? e.message : String(e)) + " — try \"Import Settings\" with a saved file instead.");
  }
}

// Deliberately leaves the channel profile picture and panel-width
// localStorage keys untouched — this resets *settings*, not branding or
// layout. Reloads rather than calling loadSettings() in place — with no
// saved blob, loadSettings() has nothing to restore and would leave every
// field showing whatever was on screen a moment ago instead of its actual
// HTML-attribute default — a fresh load is what actually applies defaults.
function resetSettingsToDefaults() {
  if (!confirm("Reset all settings to their defaults? This can't be undone.")) return;
  localStorage.removeItem("cast_settings");
  location.reload();
}

function toggleKeyVisibility(id, btn) {
  const el = document.getElementById(id);
  if (!el) return;
  const revealing = el.type === "password";
  el.type = revealing ? "text" : "password";
  btn.textContent = revealing ? "Hide" : "Show";
}
async function copyKeyToClipboard(id, btn) {
  const el = document.getElementById(id);
  if (!el || !el.value) return;
  try {
    await navigator.clipboard.writeText(el.value);
    const original = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = original; }, 1500);
  } catch (e) {
    alert("Couldn't copy to clipboard: " + (e && e.message ? e.message : String(e)));
  }
}

// ---------- Init ----------
function buildEngineSelect() {
  const opts = Object.values(TTS_ENGINES).map(e =>
    `<option value="${e.id}">${escapeHtml(e.label)}</option>`
  ).join("");
  $("#ttsEngine").innerHTML = opts;
  $("#ttsEngineQuick").innerHTML = '<option value="">Use settings engine</option>' + opts;
}
// Probed once at startup: is a real local backend (server.js's /render,
// shelling out to the user's own installed ffmpeg) reachable? True only
// when running via `node server.js` with ffmpeg on PATH — always false on
// the deployed GitHub Pages build (no server there to answer), which is
// exactly what makes the WASM fallback below automatic with no extra logic.
let nativeRenderAvailable = false;
async function probeNativeRenderBackend() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const resp = await fetch("/render-capability", { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return false;
    const data = await resp.json();
    return !!data.available;
  } catch (e) {
    return false;
  }
}

// Same probe pattern, for server.js's /transcribe (shells out to the user's
// own installed `whisper` CLI) — real per-word timestamps from actually
// transcribing the generated audio, tier 1 of the caption-sync cascade in
// generateSpeech() below. Also always false on the deployed GitHub Pages
// build (no server to answer), same as nativeRenderAvailable.
let nativeWhisperAvailable = false;
async function probeNativeWhisperBackend() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const resp = await fetch("/transcribe-capability", { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return false;
    const data = await resp.json();
    return !!data.available;
  } catch (e) {
    return false;
  }
}

// Copies a returning visitor's pre-rebrand localStorage data forward under
// the new "cast_*" keys without deleting the old copy — just leaves an
// unused old copy sitting there. Must run before loadSettings() so a
// returning user's saved settings are found under the new key on their
// very first post-rebrand load.
function migrateLegacyLocalStorageKeys() {
  const migrations = [
    ["slopdaddy_settings", "cast_settings"],
    ["slopdaddy_sidebarWidth", "cast_sidebarWidth"],
    ["slopdaddy_settingsWidth", "cast_settingsWidth"],
    ["slopdaddy_channelProfilePic", "cast_channelProfilePic"],
  ];
  for (const [oldKey, newKey] of migrations) {
    if (localStorage.getItem(newKey) === null && localStorage.getItem(oldKey) !== null) {
      localStorage.setItem(newKey, localStorage.getItem(oldKey));
    }
  }
}

async function init() {
  migrateLegacyLocalStorageKeys();
  $("#versionBadge").textContent = `v${VERSION}`;
  [nativeRenderAvailable, nativeWhisperAvailable] = await Promise.all([
    probeNativeRenderBackend(), probeNativeWhisperBackend(), loadDefaultStorySystemPrompt(),
  ]);
  buildEngineSelect();
  buildProviderSelect();
  const savedData = loadSettings(); // returns saved data; `model`/`voice` need their options built first
  // First-ever run (nothing saved yet) starts the textarea pre-filled with
  // the real default prompt, not an empty box — resetStorySystemPrompt()
  // and a later loadSettings() (Import) both already set a non-empty value
  // through the normal path, so this only ever fires once per fresh install.
  if (!$("#storySystemPromptOverride").value.trim()) {
    $("#storySystemPromptOverride").value = DEFAULT_STORY_SYSTEM_PROMPT;
  }
  populateModels();
  await populateVoices(getEngine());
  if (savedData && savedData.voice) {
    const hasOption = [...$("#voice").options].some(o => o.value === savedData.voice);
    if (hasOption) { $("#voice").value = savedData.voice; $("#voiceQuick").value = savedData.voice; }
  }
  onEngineChangeUI();
  buildPresetSelects();
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
  $("#defaultMusicVolume").addEventListener("input", updateDefaultMusicVolumeLabel);
  // Re-detect Ollama's installed models when the base URL changes (e.g.
  // pointing at a different port/host) — debounced-ish via a simple
  // trailing timer so this doesn't fire a network request on every
  // keystroke while typing a new URL.
  let ollamaModelRefreshTimer;
  $("#customBaseUrl").addEventListener("input", () => {
    clearTimeout(ollamaModelRefreshTimer);
    ollamaModelRefreshTimer = setTimeout(refreshOllamaModelList, 500);
  });
  initCaptionDrag();
  initPanelResize("sidebar", "sidebarResizeHandle", 1, "cast_sidebarWidth");
  initPanelResize("settingsPanel", "settingsResizeHandle", -1, "cast_settingsWidth");
  // The sidebar (and with it the preview box) can be resized by dragging its
  // edge — recompute the preview's pixel-to-output scale when that happens.
  new ResizeObserver(() => { if (currentVideo) updateCaptionStyle(); }).observe($("#previewContainer"));
  initBatchUI();
  loadChannelProfilePic();
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

// Rebuilds #model's <select> options for whichever provider is selected, and
// toggles the custom-model/custom-base-URL fields a provider like Ollama
// needs instead of/alongside them. Called on #provider's change event and
// once from init()/loadSettings().
function populateModels() {
  const provider = getStoryProvider();
  $("#model").style.display = provider.customModel ? "none" : "";
  $("#modelCustomRow").style.display = provider.customModel ? "" : "none";
  if (!provider.customModel) {
    $("#model").innerHTML = provider.models.map((m, i) => `<option value="${m}" ${i === 0 ? "selected" : ""}>${m}</option>`).join("");
  }
  $("#customBaseUrlRow").style.display = provider.editableBaseUrl ? "" : "none";
  if (provider.editableBaseUrl && !$("#customBaseUrl").value) {
    $("#customBaseUrl").value = provider.baseUrl;
  }
  $("#apiKeyRow").style.display = provider.needsApiKey ? "" : "none";
  // Not awaited — populateModels() itself isn't async and every existing
  // caller (provider-change listener, init()) doesn't need to block on a
  // local network round trip just to show/hide the rest of the panel.
  refreshOllamaModelList();
}
$("#provider").addEventListener("change", populateModels);

// Ollama exposes its own native model-list API at /api/tags — a sibling to
// the OpenAI-compatibility endpoint at /v1 this app otherwise talks to for
// actual generation, not part of the OpenAI-compatible surface itself, so
// this is genuinely Ollama-specific rather than something every provider on
// the "editable base URL" field (LM Studio, vLLM, ...) could also use.
// Lets the model field auto-detect what's actually pulled instead of
// requiring the user to type an exact model name/tag from memory.
async function refreshOllamaModelList() {
  const provider = getStoryProvider();
  const select = $("#ollamaModelSelect");
  const status = $("#ollamaModelStatus");
  if (provider.id !== "ollama") { select.style.display = "none"; status.textContent = ""; return; }
  const baseUrl = $("#customBaseUrl").value.trim() || provider.baseUrl;
  const tagsUrl = baseUrl.replace(/\/v1\/?$/, "") + "/api/tags";
  try {
    const ctrl = new AbortController();
    // Local server — should respond near-instantly if it's actually
    // running; a short timeout means "not running" fails fast instead of
    // making the Story tab feel stuck for the default 3+ minutes fetch()
    // would otherwise wait on a connection nothing is listening on.
    const t = setTimeout(() => ctrl.abort(), 3000);
    let resp;
    try {
      resp = await fetch(tagsUrl, { signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    const models = (data.models || []).map(m => m.name || m.model).filter(Boolean);
    if (!models.length) {
      select.style.display = "none";
      status.textContent = "No models found — pull one with `ollama pull <model>`, or enter a name manually below.";
      return;
    }
    select.innerHTML = models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
    select.style.display = "";
    // Prefer whatever's already saved if it's still actually installed,
    // otherwise default to the first detected model rather than leaving
    // the field blank.
    const saved = $("#modelCustom").value.trim();
    select.value = models.includes(saved) ? saved : models[0];
    onOllamaModelSelectChange();
    status.textContent = `${models.length} model${models.length === 1 ? "" : "s"} detected — pick one, or type a different name below.`;
  } catch (e) {
    select.style.display = "none";
    status.textContent = "Couldn't detect models — make sure Ollama is running, or enter a model name manually below.";
  }
}
function onOllamaModelSelectChange() {
  const select = $("#ollamaModelSelect");
  if (!select.value) return;
  $("#modelCustom").value = select.value;
  $("#modelCustom").dispatchEvent(new Event("input", { bubbles: true }));
}

// Rebuilds #voice/#voiceQuick from the given engine's own voice list —
// engines have entirely different voices, so this runs on init and every
// engine change. Async because Browser Speech's list comes from
// speechSynthesis.getVoices(), which some browsers populate lazily.
async function populateVoices(engineId) {
  engineId = engineId || DEFAULT_TTS_ENGINE;
  const engine = TTS_ENGINES[engineId];
  const list = await engine.listVoices();
  const opts = list.map(v => `<option value="${v.id}">${escapeHtml(v.label)}</option>`).join("");
  $("#voice").innerHTML = opts;
  $("#voiceQuick").innerHTML = '<option value="">Use settings voice</option>' + opts;
}
function syncVoiceQuick() { const v = $("#voiceQuick").value; if (v) $("#voice").value = v; }
// Quick engine override in the sidebar mirrors the settings-panel select
// (setting #ttsEngine directly, same as syncVoiceQuick does for #voice) —
// but changing engines invalidates the current voice list, so it also
// repopulates voices and resets the now-stale voiceQuick selection.
async function syncEngineQuick() {
  const v = $("#ttsEngineQuick").value;
  if (!v) return;
  $("#ttsEngine").value = v;
  $("#voiceQuick").value = "";
  await onEngineChangeUI();
  saveSettings();
}
function getEngine() { return $("#ttsEngine").value || DEFAULT_TTS_ENGINE; }
function getVoice() {
  syncVoiceQuick();
  return $("#voice").value || TTS_ENGINES[getEngine()].defaultVoice() || "";
}

// A batch job waiting behind others for its turn at storyGenLimiter's cap
// used to be visually indistinguishable from one actively generating —
// both just showed "Generating..." — which reads as "stuck" rather than
// "queued" once a slow provider/model makes that wait genuinely long.
function makeClientSlotLimiter(max) {
  let active = 0;
  const queue = [];
  const state = { max };
  return {
    acquire() {
      return new Promise((resolve) => {
        const tryAcquire = () => {
          if (active < state.max) { active++; resolve(); }
          else queue.push(tryAcquire);
        };
        tryAcquire();
      });
    },
    release() {
      active--;
      const next = queue.shift();
      if (next) next();
    },
    setMax(n) {
      state.max = n;
      while (active < state.max && queue.length) queue.shift()();
    },
    getMax() { return state.max; },
    getActive() { return active; },
  };
}
const DEFAULT_STORY_GEN_CONCURRENCY = 3;
const storyGenLimiter = makeClientSlotLimiter(DEFAULT_STORY_GEN_CONCURRENCY);

// ---------- Story generation (streaming, client-side) ----------
// Provider-agnostic: STORY_PROVIDERS (web/lib/story-providers.js) supplies
// buildChatRequest() (the {url, headers, body} to send) and parseSSEDelta()
// (how to pull the next text chunk out of one parsed `data: ` line) — this
// function is just the shared fetch + SSE-read loop every provider streams
// through, regardless of whether its wire format is OpenAI's or Anthropic's.
// Every call goes through storyGenLimiter by default, so unbounded
// concurrent requests can't get silently throttled by a low-rate-limit key.
async function streamChat(messages, onChunk, temperature, skipLimiter, onAcquired) {
  if (skipLimiter) { if (onAcquired) onAcquired(); return streamChatInner(messages, onChunk, temperature); }
  await storyGenLimiter.acquire();
  // onAcquired (optional) fires the instant this call actually starts
  // running, as opposed to still sitting in storyGenLimiter's queue behind
  // other jobs.
  if (onAcquired) onAcquired();
  try {
    return await streamChatInner(messages, onChunk, temperature);
  } finally {
    storyGenLimiter.release();
  }
}
async function streamChatInner(messages, onChunk, temperature) {
  const provider = getStoryProvider();
  const key = getApiKey();
  // Throw, don't silently return — every caller treats a resolved
  // streamChat() as success (shows a "Story generated!"/etc. toast) even
  // though onChunk was never called and the textarea it was writing into is
  // still empty. Callers already wrap this in try/catch and alert(e.message).
  if (key === null) throw new Error("Enter your API key in Settings first.");
  const { url, headers, body } = buildChatRequest(provider, {
    model: getModel(), messages, temperature: temperature == null ? 0.9 : temperature, apiKey: key, baseUrl: apiBase(),
  });
  // Two separate bounds: the initial connection (a provider that's down/
  // unreachable could otherwise hang at the fetch() call itself with no
  // error and no recovery) and a stall watchdog on the stream once it
  // starts (a connection that stops delivering chunks mid-story, without
  // ever formally closing, would otherwise hang forever at reader.read()).
  const ctrl = new AbortController();
  const connectTimer = setTimeout(() => {
    showToast(`Story provider isn't responding — still waiting (30s)...`, 4000);
    ctrl.abort();
  }, 30000);
  let resp;
  try {
    resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Request timed out — the provider didn't respond within 30s.");
    throw e;
  } finally {
    clearTimeout(connectTimer);
  }
  if (!resp.ok) throw new Error("API error: " + resp.status);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Reasoning models (e.g. DeepSeek's deepseek-reasoner) stream real bytes —
  // delta.reasoning_content "thinking" tokens — for a real stretch before
  // any delta.content shows up. parseSSEDelta only ever looks at
  // delta.content, so those chunks reset the stall watchdog below (real
  // data IS arriving) but never call onChunk() — told once, not per-chunk,
  // the moment reasoning starts, so a long wait doesn't read as a hang.
  let sawRealContent = false;
  let toldReasoning = false;
  const reasoningStallStart = { t: null };
  try {
    while (true) {
      let stallTimer;
      const stallGuard = new Promise((_, reject) => {
        stallTimer = setTimeout(() => {
          showToast("Story generation stalled — no data received for 60s.", 4000);
          reject(new Error("Story generation stalled — no data received for 60s."));
        }, 60000);
      });
      let done, value;
      try {
        ({ done, value } = await Promise.race([reader.read(), stallGuard]));
      } finally {
        clearTimeout(stallTimer);
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          continue; // a malformed/partial SSE line is expected occasionally — skip it, not a real error
        }
        const text = parseSSEDelta(provider.api, parsed);
        if (text) {
          sawRealContent = true;
          // Deliberately NOT wrapped in try/catch — swallowing an error a
          // caller's onChunk throws (e.g. a stale/removed DOM element) lets
          // the underlying network request keep succeeding invisibly while
          // the real bug vanishes with no error, no toast, nothing.
          onChunk(text);
        } else if (!sawRealContent) {
          const delta = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
          if (delta && delta.reasoning_content) {
            if (!toldReasoning) {
              toldReasoning = true;
              reasoningStallStart.t = Date.now();
              showToast(`${provider.label} is thinking before it answers — this can take a while on a reasoning model.`, 5000);
            } else if (Date.now() - reasoningStallStart.t > 30000) {
              reasoningStallStart.t = Date.now();
              showToast(`Still thinking (${provider.label})... this is normal for a reasoning model, just slow.`, 5000);
            }
          }
        }
      }
    }
  } catch (e) {
    // A stall throws out of the race above while reader.read() is still
    // pending underneath it — cancel the reader so the underlying
    // connection actually tears down instead of being silently abandoned.
    try { await reader.cancel(); } catch (cancelErr) { /* best-effort */ }
    throw e;
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
       { role: "user", content: ideasPrompt(STORY_CATEGORIES[Math.floor(Math.random() * STORY_CATEGORIES.length)]) }],
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
const TITLE_CARD_DURATION_SEC = 3;
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
// Background music for the sidebar's single-export flow. The auto-choice
// library (bundled royalty-free tracks) is intentionally empty for now —
// this is just the upload-your-own path, wired the same way it'll consume
// a bundled library later without changing how a job carries its music.
function handleMusicUpload(input) {
  const file = input.files[0];
  if (!file) return;
  sidebarMusicFile = file;
  $("#musicStatus").textContent = file.name;
}
function clearMusic() {
  sidebarMusicFile = null;
  $("#musicInput").value = "";
  $("#musicStatus").textContent = "No music selected.";
}

// ---------- Preset assets (repo-hosted videos/music, picked instead of uploaded) ----------
// Populates the preset <select>s from lib/presets.js's manifest and hides
// each row entirely when its list is empty, so an unconfigured preset
// library shows no dead UI. Called once from init(); the manifest is
// static for the app's lifetime so batch-card templates read the same
// lists directly rather than re-populating per card.
function buildPresetSelects() {
  const videoRow = $("#presetVideoRow");
  if (videoRow) {
    videoRow.style.display = PRESET_VIDEOS.length ? "" : "none";
    const opts = PRESET_VIDEOS.map(p => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join("");
    $("#presetVideoSelect").innerHTML = '<option value="">Or pick a preset...</option>' + opts;
  }
  const musicRow = $("#presetMusicRow");
  if (musicRow) {
    musicRow.style.display = PRESET_MUSIC.length ? "" : "none";
    const opts = PRESET_MUSIC.map(p => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join("");
    $("#presetMusicSelect").innerHTML = '<option value="">Or pick a preset...</option>' + opts;
  }
}
// `preset.path` may be same-origin or a full cross-origin URL (see
// lib/presets.js) — a cross-origin fetch can fail (CORS/CORP block, network
// error) far more often than a same-origin one, so this always throws a
// clear, preset-identifying error rather than letting a raw fetch error
// (or an opaque failed response) reach the caller.
async function fetchPresetFile(preset, fallbackType) {
  try {
    const resp = await fetch(preset.path);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    return new File([blob], preset.label, { type: blob.type || fallbackType });
  } catch (e) {
    throw new Error(`Failed to load preset "${preset.label}": ${e.message}`);
  }
}
async function selectPresetVideo(id, selectEl) {
  if (!id) return;
  const preset = PRESET_VIDEOS.find(p => p.id === id);
  if (!preset) return;
  showToast(`Loading preset "${preset.label}"...`);
  try {
    const file = await fetchPresetFile(preset, "video/mp4");
    await setBackground(file, preset.label);
  } catch (e) {
    alert(e.message);
    if (selectEl) selectEl.value = "";
  }
}
async function selectPresetMusic(id, selectEl) {
  if (!id) return;
  const preset = PRESET_MUSIC.find(p => p.id === id);
  if (!preset) return;
  showToast(`Loading preset "${preset.label}"...`);
  try {
    const file = await fetchPresetFile(preset, "audio/mpeg");
    sidebarMusicFile = file;
    $("#musicStatus").textContent = preset.label;
  } catch (e) {
    alert(e.message);
    if (selectEl) selectEl.value = "";
  }
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

// Kokoro (kokoro-js) mirrors Piper's lazy-singleton pattern: one shared
// engine instance, model weights fetched from HuggingFace by the library
// itself on first use and cached by the browser (same "don't vendor large
// binaries that already have a good CDN/HF home" approach Piper's own voice
// files use). dtype "q8" is the quantized variant — ~86MB vs. ~326MB fp32,
// no meaningful quality loss per the model's own documentation.
async function ensureKokoro() {
  if (kokoroEngine) return kokoroEngine;
  showDownloadToast("Preparing Kokoro TTS engine (first time only, ~90MB)...");
  try {
    const mod = await import(KOKORO_JS);
    const { KokoroTTS } = mod;
    kokoroEngine = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: "q8" });
  } catch (e) {
    hideDownloadToast();
    throw e;
  }
  hideDownloadToast();
  return kokoroEngine;
}

// Every engine's ONNX/network session gets funneled through this one-at-a-
// time queue — Piper/Kokoro's shared instances aren't verified concurrency-
// safe, cloud engines benefit from not hammering rate limits, and Browser
// Speech literally can't speak two utterances at once through one
// speechSynthesis instance. TTS is fast relative to rendering, so
// serializing it costs little even under a large parallel batch.
let ttsQueueTail = Promise.resolve();
function queueTTS(fn) {
  const run = ttsQueueTail.then(fn, fn);
  // Swallow rejections here so one failed job doesn't wedge the queue for
  // everything queued after it — the caller still sees the real rejection
  // via `run`, this is only to keep ttsQueueTail chainable.
  ttsQueueTail = run.catch(() => {});
  return run;
}

// Tier 2 of the caption-sync cascade (the always-on default when native
// Whisper isn't available and browser ASR isn't enabled) — a lightweight
// Web Audio energy-threshold pass over the generated audio, no ML model, no
// download. Finds REAL silence/pause boundaries so snapPausesToWords can
// correct computeWordTimings' assumed pause length at punctuation instead
// of trusting a guess. TTS output is clean single-speaker audio with a low
// noise floor, so a trained VAD model's main advantage (robustness to
// background noise) buys little here — confirmed in research before
// building this. Returns [{start,end}] in seconds, or null on any failure.
async function detectSilenceGaps(audioBlob) {
  try {
    const buf = await audioBlob.arrayBuffer();
    const audioCtx = new AudioContext();
    const audioBuffer = await audioCtx.decodeAudioData(buf);
    audioCtx.close();
    const data = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const windowSec = 0.02; // 20ms windows
    const windowSize = Math.max(1, Math.round(sampleRate * windowSec));
    const windowCount = Math.ceil(data.length / windowSize);
    const energies = new Float32Array(windowCount);
    let peak = 0;
    for (let w = 0; w < windowCount; w++) {
      const start = w * windowSize;
      const end = Math.min(data.length, start + windowSize);
      let sum = 0;
      for (let i = start; i < end; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / Math.max(1, end - start));
      energies[w] = rms;
      if (rms > peak) peak = rms;
    }
    if (peak <= 0) return null;
    const threshold = peak * 0.08; // ~22dB below peak
    // Confirmed live against real Piper output: natural inter-sentence
    // pauses run ~100-140ms, not the 150ms originally assumed here — tuned
    // down after that measurement so real (if brief) pauses actually register.
    const minSilenceWindows = Math.round(0.09 / windowSec);
    const gaps = [];
    let runStart = -1;
    for (let w = 0; w < windowCount; w++) {
      if (energies[w] < threshold) {
        if (runStart === -1) runStart = w;
      } else if (runStart !== -1) {
        if (w - runStart >= minSilenceWindows) {
          gaps.push({ start: (runStart * windowSize) / sampleRate, end: (w * windowSize) / sampleRate });
        }
        runStart = -1;
      }
    }
    if (runStart !== -1 && windowCount - runStart >= minSilenceWindows) {
      gaps.push({ start: (runStart * windowSize) / sampleRate, end: (windowCount * windowSize) / sampleRate });
    }
    return gaps.length ? gaps : null;
  } catch (e) {
    return null;
  }
}

// Tier 3 (opt-in, #enableBrowserAsr) — a full in-browser Whisper via
// @huggingface/transformers, mirroring ensureKokoro()'s lazy-singleton CDN-
// import pattern exactly, for people without native Whisper who want real
// alignment anyway and don't mind a one-time ~40MB model download plus real
// per-generation processing time.
const TRANSFORMERS_JS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";
let browserWhisperPipeline = null;
async function ensureBrowserWhisper() {
  if (browserWhisperPipeline) return browserWhisperPipeline;
  showDownloadToast("Preparing AI transcription (first time only, ~40MB)...");
  try {
    const mod = await import(TRANSFORMERS_JS);
    browserWhisperPipeline = await mod.pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en");
  } catch (e) {
    hideDownloadToast();
    throw e;
  }
  hideDownloadToast();
  return browserWhisperPipeline;
}
// Same return shape as transcribeNatively (raw {text,start,end}[], not yet
// aligned to the known script) so both tiers feed the same
// alignWordsBySequence. transformers.js's per-word chunks come back as
// {text, timestamp:[start,end]} — normalized here.
async function transcribeInBrowser(audioBlob) {
  try {
    const pipe = await ensureBrowserWhisper();
    const buf = await audioBlob.arrayBuffer();
    const audioCtx = new AudioContext({ sampleRate: 16000 });
    const audioBuffer = await audioCtx.decodeAudioData(buf);
    audioCtx.close();
    const result = await pipe(audioBuffer.getChannelData(0), { return_timestamps: "word" });
    const chunks = result && result.chunks;
    if (!chunks || !chunks.length) return null;
    return chunks.map(c => ({ text: c.text, start: c.timestamp[0], end: c.timestamp[1] }));
  } catch (e) {
    return null;
  }
}

// The caption-sync cascade — real alignment wins whenever available,
// cheapest safety net last. Every ASR/VAD step is wrapped (transcribeNatively
// /transcribeInBrowser/detectSilenceGaps all return null rather than throw
// on failure) so a failure just falls through to the next tier instead of
// breaking generation outright.
//   0. engine's own real timing (ElevenLabs char-alignment, Browser Speech
//      boundary events) — already resolved by the caller.
//   1. native Whisper (server.js /transcribe) — silent, automatic.
//   2. opt-in browser Whisper (#enableBrowserAsr) — only tried when native
//      isn't available, since native is strictly better when present.
//   3. computeWordTimings' estimate, corrected by real detected pauses
//      (VAD) when neither ASR tier produced anything usable.
async function resolveWordTimings(text, audioBlob, durationSec, engineWordTimings) {
  if (engineWordTimings && engineWordTimings.length) return engineWordTimings;

  let asrWords = null;
  if (nativeWhisperAvailable) {
    asrWords = await transcribeNatively(audioBlob);
  } else {
    const asrCheckbox = $("#enableBrowserAsr");
    if (asrCheckbox && asrCheckbox.checked) asrWords = await transcribeInBrowser(audioBlob);
  }
  if (asrWords) {
    const aligned = alignWordsBySequence(text, asrWords, durationSec);
    if (aligned) return aligned;
  }

  let words = computeWordTimings(text, durationSec);
  const pauseGaps = await detectSilenceGaps(audioBlob);
  if (pauseGaps) words = snapPausesToWords(words, pauseGaps, durationSec);
  return words;
}

async function generateSpeech(text, voice, engineId) {
  engineId = engineId || getEngine();
  const engine = TTS_ENGINES[engineId];
  if (!engine) throw new Error("Unknown TTS engine: " + engineId);
  voice = voice || getVoice();
  // Sanitize again here as a safety net — most engines' tokenizers use
  // TextEncoder and throw "String contains an invalid character" on any
  // lone surrogate.
  text = sanitizeText(text);
  if (!text) throw new Error("Story text is empty after cleaning.");
  const config = getEngineConfig(engineId);
  if (engine.needsApiKey && !config) return Promise.reject(new Error("Missing API key for " + engine.label));
  return queueTTS(async () => {
    showDownloadToast(`Generating voice (${engine.label})...`);
    try {
      const { audioBlob, durationSec, wordTimings } = await engine.generate(text, voice, config);
      hideDownloadToast();
      const audioUrl = URL.createObjectURL(audioBlob);
      const words = await resolveWordTimings(text, audioBlob, durationSec, wordTimings);
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

// Native rendering needs no ffmpeg.wasm/font download at all — skip
// warming up the WASM pool entirely when the local backend is available.
// Falls straight through to the original ensureFFmpeg() otherwise (GitHub
// Pages, or ffmpeg missing from PATH — server.js's own /render-capability
// probe already accounts for that).
function ensureRenderBackend(poolSize) {
  if (nativeRenderAvailable) return Promise.resolve();
  return ensureFFmpeg(poolSize);
}

// POSTs the same payload shape the WASM worker takes to server.js's
// /render, over a simple length-prefixed binary frame (no multipart parser
// needed): [4-byte LE uint32 metadata length][JSON metadata][bg][audio]
// [music if present][title-card PNG if present] — server.js's
// parseRenderBody() is the exact inverse of this. Progress arrives over a
// separate SSE connection correlated by a client-generated id, opened
// before the POST so no progress ticks can race ahead of it.
async function renderVideoNatively(payload, onProgress) {
  const id = crypto.randomUUID();
  let es = null;
  if (onProgress) {
    es = new EventSource(`/render-progress/${id}`);
    es.onmessage = (e) => {
      try { onProgress(JSON.parse(e.data).pct); } catch (err) { /* ignore malformed tick */ }
    };
  }
  try {
    const hasMusic = !!payload.music;
    const hasTitleCard = !!(payload.titleCard && payload.titleCard.imageBytes);
    const meta = {
      subs: payload.subs, style: payload.style,
      w: payload.w, h: payload.h, fps: payload.fps, bgW: payload.bgW, bgH: payload.bgH,
      musicVolume: payload.musicVolume,
      hasMusic, hasTitleCard,
      titleCard: hasTitleCard
        ? { cardDurationSec: payload.titleCard.cardDurationSec, narrationDelaySec: payload.titleCard.narrationDelaySec }
        : null,
      bgLen: payload.bg.byteLength,
      audioLen: payload.audio.byteLength,
      musicLen: hasMusic ? payload.music.byteLength : 0,
      titleCardImageLen: hasTitleCard ? payload.titleCard.imageBytes.byteLength : 0,
    };
    const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, metaBytes.byteLength, true);
    const parts = [header, metaBytes, payload.bg, payload.audio];
    if (hasMusic) parts.push(payload.music);
    if (hasTitleCard) parts.push(new Uint8Array(payload.titleCard.imageBytes));

    const resp = await fetch(`/render?id=${id}`, { method: "POST", body: new Blob(parts) });
    if (!resp.ok) {
      let msg = `Native render failed (${resp.status})`;
      try { const errJson = await resp.json(); if (errJson.error) msg = errJson.error; } catch (e) { /* non-JSON error body */ }
      throw new Error(msg);
    }
    const buf = await resp.arrayBuffer();
    if (onProgress) onProgress(100);
    return new Uint8Array(buf);
  } finally {
    if (es) es.close();
  }
}

// Renders one job's video — via the local native backend when available,
// falling back to the ffmpeg.wasm worker pool otherwise. Resolves to a
// Uint8Array of the MP4 either way, so callers don't need to know which path ran.
function renderVideoInWorker(payload, onProgress) {
  if (nativeRenderAvailable) return renderVideoNatively(payload, onProgress);
  return ffmpegPool.submit((worker) => worker.render(payload, onProgress));
}

// Tier 1 of the caption-sync cascade (see generateSpeech()) — POSTs the raw
// narration audio to server.js's /transcribe, which shells out to the
// user's own installed `whisper` CLI for real per-word timestamps. No
// framing needed (unlike /render): the server doesn't need the known
// script text, just the audio — whisper transcribes freely, and matching
// its output back onto the known text happens client-side via
// alignWordsBySequence. Returns the raw {text,start,end}[] word list (not
// yet aligned to the known script) or null on any failure, so the caller
// falls through to the next tier cleanly.
async function transcribeNatively(audioBlob) {
  const id = crypto.randomUUID();
  try {
    const resp = await fetch(`/transcribe?id=${id}`, { method: "POST", body: audioBlob });
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data && data.words && data.words.length) ? data.words : null;
  } catch (e) {
    return null;
  }
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
    captionPreset: $("#captionPreset").value || "capcut",
    channelName: $("#channelName").value.trim() || "Anonymous",
    ttsEngine: getEngine(),
  };
}

// API-key/config bundle a TTS engine's generate() needs, per-engine. Kept
// fully separate from the story-gen #apiKey/#provider fields — a user might
// use DeepSeek for stories and OpenAI for narration at the same time.
function getEngineConfig(engineId) {
  if (engineId === "openaiTts") {
    const key = $("#ttsOpenaiKey").value.trim();
    if (!key) { alert("Enter an OpenAI API key in Settings → Narration Voice first."); return null; }
    return { apiKey: key };
  }
  if (engineId === "elevenlabs") {
    const key = $("#ttsElevenlabsKey").value.trim();
    if (!key) { alert("Enter an ElevenLabs API key in Settings → Narration Voice first."); return null; }
    return { apiKey: key };
  }
  return {};
}

// Shows/hides the API key fields for whichever engine is selected, updates
// the reliability note, and rebuilds the voice list — call whenever the
// engine changes (init, settings #ttsEngine change, or a batch card's own
// engine override).
async function onEngineChangeUI() {
  const engineId = getEngine();
  const engine = TTS_ENGINES[engineId];
  $("#ttsOpenaiKeyRow").style.display = engineId === "openaiTts" ? "" : "none";
  $("#ttsElevenlabsKeyRow").style.display = engineId === "elevenlabs" ? "" : "none";
  const notes = {
    piper: "Runs fully offline in your browser. Free, no API key.",
    kokoro: "Runs fully offline in your browser, higher quality than Piper. Free, no API key — first use downloads a ~90MB model.",
    openaiTts: "Cloud API — costs money per character generated.",
    elevenlabs: "Cloud API — free tier (~10k characters/month, requires attribution, no commercial use) then paid.",
    browserSpeech: "Uses your OS's built-in voices. Needs a one-time \"share tab audio\" permission prompt to record narration — less reliable in Firefox than Chrome, and quality varies a lot by OS.",
  };
  $("#engineNote").textContent = notes[engineId] || "";
  await populateVoices(engineId);
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
    const { audioUrl, words } = await generateSpeech(story, settings.voice, settings.ttsEngine);

    const w = parseInt(settings.resW) || 1080;
    const h = parseInt(settings.resH) || 1920;
    const fps = parseInt(settings.fps) || 30;

    let titleCardPayload = null;
    let cardDurationSec = 0;
    let narrationDelaySec = 0;
    let narrationWords = words;
    if (job.titleCardEnabled) {
      update({ status: "render", progressPct: 5, progressLabel: "Building title card..." });
      // An auto-extracted title is literally the story's first line, already
      // spoken as part of the narration — instead of showing it once on the
      // card and then again as a caption after a fixed delay, let its own
      // audio play while the card is up (narrationDelaySec stays 0) and drop
      // those words from the caption list, sizing the card to exactly how
      // long that line takes to say. A user-typed custom title isn't
      // guaranteed to match anything in the story, so that case keeps the
      // old fixed-duration/fixed-delay behavior.
      const isAutoTitle = !job.titleCardText;
      const titleText = (job.titleCardText || extractTitleFromStory(story) || "Untitled").trim();
      const cardBlob = await renderTitleCardImage({ title: titleText, channelName: globalSettings.channelName, w, h });

      if (isAutoTitle && words.length) {
        const titleWordCount = Math.min(countFirstParagraphWords(story), words.length);
        const lastTitleWord = words[titleWordCount - 1];
        cardDurationSec = lastTitleWord ? lastTitleWord.end : TITLE_CARD_DURATION_SEC;
        narrationWords = words.slice(titleWordCount);
      } else {
        cardDurationSec = TITLE_CARD_DURATION_SEC;
        narrationDelaySec = TITLE_CARD_DURATION_SEC;
      }
      titleCardPayload = { imageBytes: await cardBlob.arrayBuffer(), cardDurationSec, narrationDelaySec };
    }

    // "capcut" = one bold word at a time; "classic" = grouped phrases
    // (the original style). Both feed the same per-cue drawtext+enable()
    // render path — this only changes how cues are grouped, not how
    // they're rendered.
    const rawSubs = settings.captionPreset === "classic" ? buildSubsFromWords(narrationWords) : buildWordCues(narrationWords);
    const subs = rawSubs.map(s => ({ start: s.start, end: s.end, text: sanitizeText(s.text) }));
    if (narrationDelaySec > 0) {
      for (const s of subs) { s.start += narrationDelaySec; s.end += narrationDelaySec; }
    }

    let musicPayload = null;
    if (job.musicFile) {
      musicPayload = new Uint8Array(await job.musicFile.arrayBuffer());
    }

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
      music: musicPayload, musicVolume: job.musicVolume,
      titleCard: titleCardPayload,
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
    titleCardEnabled: $("#titleCardEnabled").checked,
    titleCardText: $("#titleCardText").value.trim() || null,
    musicFile: sidebarMusicFile,
    musicVolume: parseFloat($("#musicVolume").value) || 0.25,
  });

  await ensureRenderBackend(1);
  const globalSettings = getGlobalSettings();
  await runJob(job, globalSettings, (j) => {
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
  if (!url) { alert("Nothing to download yet."); return; }
  const a = document.createElement("a");
  a.href = url; a.download = "aitah-story.mp4";
  document.body.appendChild(a);
  a.click();
  // Some browsers (notably Firefox) can drop a programmatic download if the
  // triggering element is removed from the DOM in the same synchronous
  // tick as the click — deferring the removal is the standard workaround.
  setTimeout(() => document.body.removeChild(a), 0);
}
function copyVideoLink(url) {
  navigator.clipboard.writeText(url).then(() => showToast("Link copied!"));
}

// ---------- Title card ----------
// Renders a fake-Reddit-post-style title card as a flat PNG using Canvas —
// avatar, channel name + verified badge, wrapped title text, and a bottom
// engagement row (like/comment/share icons). Doing all of this in Canvas
// instead of ffmpeg's filter graph sidesteps drawtext's font/layout
// limitations entirely (no font provider, no rich text layout, no icon
// glyphs) — the whole card is just one flat image ffmpeg composites via
// `overlay`, so none of that complexity has to live in the filter graph.
// Not unit-tested — like autoTranscodeToH264's canvas work, this is DOM-
// coupled glue code with no meaningful logic to test outside a real canvas.
const CHANNEL_PROFILE_PIC_KEY = "cast_channelProfilePic";
let channelProfilePicDataUrl = null;

function loadChannelProfilePic() {
  try { channelProfilePicDataUrl = localStorage.getItem(CHANNEL_PROFILE_PIC_KEY) || null; } catch (e) {}
  updateProfilePicPreview();
}
function saveChannelProfilePic(dataUrl) {
  channelProfilePicDataUrl = dataUrl;
  try {
    if (dataUrl) localStorage.setItem(CHANNEL_PROFILE_PIC_KEY, dataUrl);
    else localStorage.removeItem(CHANNEL_PROFILE_PIC_KEY);
  } catch (e) {}
  updateProfilePicPreview();
}
function updateProfilePicPreview() {
  const img = $("#channelProfilePicPreview");
  if (!img) return;
  if (channelProfilePicDataUrl) { img.src = channelProfilePicDataUrl; img.style.display = "block"; }
  else { img.style.display = "none"; }
}
async function handleProfilePicUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("couldn't read image"));
    reader.readAsDataURL(file);
  });
  saveChannelProfilePic(dataUrl);
}
function removeProfilePic() { saveChannelProfilePic(null); }

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function wrapCanvasText(ctx, text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const w of words) {
    const test = current ? current + " " + w : w;
    if (current && ctx.measureText(test).width > maxWidth) {
      lines.push(current);
      current = w;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}
function drawHeartIcon(ctx, cx, cy, size, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  const r = size / 4;
  ctx.arc(cx - r, cy - r, r, Math.PI, 0);
  ctx.arc(cx + r, cy - r, r, Math.PI, 0);
  ctx.lineTo(cx + size / 2, cy);
  ctx.lineTo(cx, cy + size / 1.6);
  ctx.lineTo(cx - size / 2, cy);
  ctx.closePath();
  ctx.fill();
}
function drawCommentIcon(ctx, cx, cy, size, color) {
  ctx.fillStyle = color;
  roundRectPath(ctx, cx - size / 2, cy - size / 2.4, size, size * 0.8, size * 0.2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.1, cy + size * 0.32);
  ctx.lineTo(cx + size * 0.05, cy + size * 0.32);
  ctx.lineTo(cx - size * 0.05, cy + size * 0.55);
  ctx.closePath();
  ctx.fill();
}
function drawShareIcon(ctx, cx, cy, size, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, size * 0.12);
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(cx, cy + size / 2);
  ctx.lineTo(cx, cy - size / 6);
  ctx.moveTo(cx - size / 3, cy + size / 8);
  ctx.lineTo(cx, cy - size / 6);
  ctx.lineTo(cx + size / 3, cy + size / 8);
  ctx.stroke();
  ctx.beginPath();
  roundRectPath(ctx, cx - size / 2, cy + size / 2 - size * 0.08, size, size * 0.28, size * 0.08);
  ctx.stroke();
}

// Returns a PNG Blob sized w x h (matching the output resolution), with a
// transparent background outside the card itself.
async function renderTitleCardImage({ title, channelName, w, h }) {
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);

  const cardX = Math.round(w * 0.06);
  const cardW = w - cardX * 2;
  const pad = Math.round(cardW * 0.07);
  const avatarSize = Math.round(cardW * 0.15);
  const titleFontSize = Math.round(cardW * 0.075);
  const nameFontSize = Math.round(avatarSize * 0.4);

  ctx.font = `bold ${titleFontSize}px sans-serif`;
  const titleLines = wrapCanvasText(ctx, title || "Untitled", cardW - pad * 2);
  const titleLineHeight = titleFontSize * 1.28;

  const headerH = avatarSize + pad * 0.8;
  const titleH = titleLines.length * titleLineHeight;
  const footerH = Math.round(cardW * 0.09);
  const cardH = pad * 2.4 + headerH + titleH + footerH;
  const cardY = Math.round(h * 0.5 - cardH / 2);

  // Card background
  ctx.fillStyle = "#ffffff";
  roundRectPath(ctx, cardX, cardY, cardW, cardH, Math.round(cardW * 0.03));
  ctx.fill();

  let y = cardY + pad;
  const avatarX = cardX + pad, avatarY = y;
  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (channelProfilePicDataUrl) {
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error("bad avatar image"));
        im.src = channelProfilePicDataUrl;
      });
      ctx.drawImage(img, avatarX, avatarY, avatarSize, avatarSize);
    } catch (e) { ctx.fillStyle = "#cfd3d8"; ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize); }
  } else {
    // Generic silhouette placeholder, no photo needed.
    ctx.fillStyle = "#cfd3d8";
    ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize);
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize * 0.38, avatarSize * 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize * 0.95, avatarSize * 0.3, Math.PI, 0);
    ctx.fill();
  }
  ctx.restore();

  // Channel name + verified badge
  const nameX = avatarX + avatarSize + pad * 0.6;
  const nameY = avatarY + avatarSize / 2;
  ctx.fillStyle = "#0f1419";
  ctx.font = `bold ${nameFontSize}px sans-serif`;
  ctx.textBaseline = "middle";
  const name = channelName || "Anonymous";
  ctx.fillText(name, nameX, nameY);
  const nameW = ctx.measureText(name).width;
  const badgeR = nameFontSize * 0.42;
  const badgeX = nameX + nameW + badgeR + nameFontSize * 0.3;
  ctx.beginPath();
  ctx.arc(badgeX, nameY, badgeR, 0, Math.PI * 2);
  ctx.fillStyle = "#3ba8f5";
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(2, badgeR * 0.28);
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(badgeX - badgeR * 0.45, nameY);
  ctx.lineTo(badgeX - badgeR * 0.1, nameY + badgeR * 0.35);
  ctx.lineTo(badgeX + badgeR * 0.5, nameY - badgeR * 0.4);
  ctx.stroke();

  // Title text
  y = cardY + pad + headerH;
  ctx.fillStyle = "#0f1419";
  ctx.font = `bold ${titleFontSize}px sans-serif`;
  ctx.textBaseline = "alphabetic";
  for (const line of titleLines) {
    y += titleLineHeight;
    ctx.fillText(line, cardX + pad, y);
  }

  // Footer engagement row (icons only; counts are decorative placeholders,
  // matching how these story-video title cards conventionally look).
  const footerY = cardY + cardH - footerH / 2 - pad * 0.3;
  const iconSize = footerH * 0.55;
  let fx = cardX + pad;
  drawHeartIcon(ctx, fx, footerY, iconSize, "#8b98a5");
  fx += iconSize + iconSize * 0.4;
  ctx.fillStyle = "#8b98a5";
  ctx.font = `${Math.round(iconSize * 0.7)}px sans-serif`;
  ctx.textBaseline = "middle";
  ctx.fillText("99+", fx, footerY);
  fx += ctx.measureText("99+").width + iconSize * 1.2;
  drawCommentIcon(ctx, fx, footerY, iconSize, "#8b98a5");
  fx += iconSize + iconSize * 0.4;
  ctx.fillStyle = "#8b98a5";
  ctx.fillText("99+", fx, footerY);

  const shareX = cardX + cardW - pad - iconSize * 2.2;
  drawShareIcon(ctx, shareX, footerY, iconSize, "#8b98a5");
  ctx.fillStyle = "#8b98a5";
  ctx.font = `${Math.round(iconSize * 0.6)}px sans-serif`;
  ctx.fillText("Share", shareX + iconSize, footerY);

  return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}

// Extracts the story's title line for the auto-title-card case — mirrors
// the "AITAH for X" first-line convention the story prompts already enforce.
function extractTitleFromStory(story) {
  const firstLine = (story || "").split("\n").find(l => l.trim());
  return (firstLine || "").trim().slice(0, 140);
}

// ---------- Debug tools ----------
// Lets caption/title-card/style changes be checked in seconds, without
// generating a story or waiting on Piper TTS — this is exactly the kind of
// check that had to be hand-scripted in a console during development.
async function previewTitleCard() {
  const title = extractTitleFromStory($("#storyText").value.trim()) || "AITAH for testing this feature";
  const channelName = $("#channelName").value.trim() || "Anonymous";
  const blob = await renderTitleCardImage({ title, channelName, w: 1080, h: 1920 });
  const img = $("#debugImagePreview");
  const url = URL.createObjectURL(blob);
  if (img.dataset.prevUrl) URL.revokeObjectURL(img.dataset.prevUrl);
  img.src = url;
  img.dataset.prevUrl = url;
  $("#debugImageOverlay").classList.add("show");
}
function closeDebugImagePreview() {
  $("#debugImageOverlay").classList.remove("show");
}

// A flat-color "background" built from one repeated JPEG frame, streamed
// through the same convertFrame/convertFinish worker path autoTranscodeToH264
// already uses — so the debug tool doesn't require a real background video
// to be uploaded first.
async function makeSolidColorClip(w, h, durationSec) {
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#4a4f57";
  ctx.fillRect(0, 0, w, h);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  const bin = atob(dataUrl.split(",")[1]);
  const bytes = new Uint8Array(bin.length);
  for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);

  const frameCount = Math.max(1, Math.round(durationSec * CONVERT_FPS));
  return ffmpegPool.submit(async (worker) => {
    for (let i = 0; i < frameCount; i++) worker.postFrame(i, bytes.slice(0));
    return worker.transcodeFinish(CONVERT_FPS, frameCount);
  });
}
function makeSilentWavBytes(durationSec) {
  const sr = 22050;
  const numSamples = Math.max(1, Math.round(durationSec * sr));
  const buf = new ArrayBuffer(44 + numSamples * 2);
  const dv = new DataView(buf);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF"); dv.setUint32(4, 36 + numSamples * 2, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  writeStr(36, "data"); dv.setUint32(40, numSamples * 2, true);
  return new Uint8Array(buf);
}

// Runs a short, fast real render through the exact same pipeline as a real
// export (captions, title card) using typed sample text and a synthesized
// silent track instead of a generated story + TTS. No music mixing here —
// music doesn't affect anything visual, so it's not worth the extra wait.
async function runDebugTestRender() {
  const statusEl = $("#debugStatus");
  const btn = $("#debugRenderBtn");
  btn.disabled = true;
  statusEl.textContent = "Rendering test clip...";
  try {
    const sampleText = sanitizeText($("#debugSampleText").value.trim()) || "Debug test caption.";
    const globalSettings = getGlobalSettings();

    let words, audioUrl = null;
    if ($("#debugAlsoTestTts").checked) {
      statusEl.textContent = `Testing TTS (${TTS_ENGINES[globalSettings.ttsEngine].label})...`;
      ({ audioUrl, words } = await generateSpeech(sampleText, globalSettings.voice, globalSettings.ttsEngine));
      statusEl.textContent = "TTS ok — rendering test clip...";
    } else {
      words = computeWordTimings(sampleText, 0); // ~150wpm fallback timing, no TTS needed
    }
    const rawSubs = globalSettings.captionPreset === "classic" ? buildSubsFromWords(words) : buildWordCues(words);
    let subs = rawSubs.map(s => ({ start: s.start, end: s.end, text: sanitizeText(s.text) }));
    const narrationSec = Math.max(1, (subs.length ? subs[subs.length - 1].end : 3) + 0.5);

    const w = 640, h = 360; // small + fast — this is a style/timing check, not a real export
    await ensureRenderBackend(1);

    let bgFile = currentVideo;
    let bgW = 0, bgH = 0;
    if (bgFile) {
      const dims = await probeVideoDimensions(bgFile);
      bgW = dims.w; bgH = dims.h;
    } else {
      bgFile = await makeSolidColorClip(w, h, narrationSec + TITLE_CARD_DURATION_SEC);
      bgW = w; bgH = h;
    }

    let titleCardPayload = null;
    let cardDurationSec = 0;
    if ($("#titleCardEnabled").checked) {
      // Debug tool deliberately tests caption sample text and title text
      // from two separate fields (see runDebugTestRender's comment above),
      // so unlike runJob's real pipeline there's nothing here to sync the
      // card to — always the old fixed-duration/fixed-delay behavior.
      cardDurationSec = TITLE_CARD_DURATION_SEC;
      const title = extractTitleFromStory($("#storyText").value.trim()) || "AITAH for a debug test";
      const cardBlob = await renderTitleCardImage({ title, channelName: globalSettings.channelName, w, h });
      titleCardPayload = { imageBytes: await cardBlob.arrayBuffer(), cardDurationSec, narrationDelaySec: cardDurationSec };
      subs = subs.map(s => ({ start: s.start + cardDurationSec, end: s.end + cardDurationSec, text: s.text }));
    }

    const bg = new Uint8Array(await bgFile.arrayBuffer());
    const audio = audioUrl
      ? new Uint8Array(await (await fetch(audioUrl)).arrayBuffer())
      : makeSilentWavBytes(narrationSec);
    const style = {
      fontSize: parseInt(globalSettings.fontSize) || 68,
      textColor: globalSettings.textColor,
      strokeColor: globalSettings.strokeColor,
      strokeWidth: parseInt(globalSettings.strokeWidth) || 3,
      positionY: parseFloat(globalSettings.positionY) || 0.55,
    };

    const outBytes = await renderVideoInWorker({
      type: "render",
      base: new URL("./", document.baseURI).href,
      bg, audio, subs, style, w, h, fps: 24, bgW, bgH,
      music: null, musicVolume: 0,
      titleCard: titleCardPayload,
    }, (pct) => { statusEl.textContent = `Rendering test clip... ${pct}%`; });

    const url = URL.createObjectURL(new Blob([outBytes.buffer], { type: "video/mp4" }));
    previewExported(url);
    statusEl.textContent = "Done — captions" + (titleCardPayload ? " + title card" : "") + " above.";
  } catch (e) {
    console.error(e);
    statusEl.textContent = "Failed: " + (e && e.message ? e.message : String(e));
  }
  btn.disabled = false;
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
  // Default to every reported core (still bounded by MAX_PARALLEL_RENDERS) —
  // updateParallelismHint()'s copy below already warns to dial back if it's
  // not stable on this machine.
  const defaultParallelism = Math.max(1, Math.min(MAX_PARALLEL_RENDERS, navigator.hardwareConcurrency || 2));
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
  const job = createJob({
    musicVolume: numOr($("#defaultMusicVolume") && $("#defaultMusicVolume").value, parseFloat, 0.25),
  });
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
// Rebuilds one batch card's own voice <select> for whichever engine it's
// currently using (its own override, or the global default) — same
// async-listVoices() reality as the settings panel's populateVoices().
async function populateBatchCardVoices(engineId, selectEl) {
  const engine = TTS_ENGINES[engineId] || TTS_ENGINES[DEFAULT_TTS_ENGINE];
  const list = await engine.listVoices();
  const opts = ['<option value="">Use settings voice</option>']
    .concat(list.map(v => `<option value="${v.id}">${escapeHtml(v.label)}</option>`))
    .join("");
  selectEl.innerHTML = opts;
}

function buildBatchCardElement(job) {
  const engineOpts = Object.values(TTS_ENGINES).map(e =>
    `<option value="${e.id}">${escapeHtml(e.label)}</option>`
  ).join("");
  const presetVideoOpts = PRESET_VIDEOS.map(p => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join("");
  const presetMusicOpts = PRESET_MUSIC.map(p => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join("");

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
    ${PRESET_VIDEOS.length ? `
    <select class="bc-presetVideo" style="margin-top:6px;">
      <option value="">Or pick a preset...</option>
      ${presetVideoOpts}
    </select>` : ""}
    <label>Voice</label>
    <select class="bc-voice"><option value="">Use settings voice</option></select>
    <button class="bc-customize-toggle">Customize style &#9662;</button>
    <div class="bc-customize" style="display:none">
      <div class="field-full"><label>TTS engine</label>
        <select class="bc-ttsEngine">
          <option value="">Use settings engine</option>
          ${engineOpts}
        </select>
      </div>
      <div class="field-full"><label>Caption preset</label>
        <select class="bc-captionPreset">
          <option value="">Use settings preset</option>
          <option value="capcut">CapCut (one word at a time)</option>
          <option value="classic">Classic (grouped phrases)</option>
        </select>
      </div>
      <div><label>Width</label><input type="number" class="bc-resW" min="480" max="2160" step="2"></div>
      <div><label>Height</label><input type="number" class="bc-resH" min="480" max="3840" step="2"></div>
      <div><label>FPS</label><input type="number" class="bc-fps" min="10" max="60"></div>
      <div><label>Font Size</label><input type="number" class="bc-fontSize" min="24" max="120"></div>
      <div><label>Position Y</label><input type="number" class="bc-positionY" min="0.05" max="0.95" step="0.01"></div>
      <div class="field-full"><label>Font</label><input type="text" class="bc-font"></div>
      <div><label>Text Color</label><input type="text" class="bc-textColor"></div>
      <div><label>Stroke Color</label><input type="text" class="bc-strokeColor"></div>
      <div class="field-full"><label>Stroke Width</label><input type="number" class="bc-strokeWidth" min="0" max="10"></div>
      <div class="field-full">
        <label style="display:flex;align-items:center;gap:6px;">
          <input type="checkbox" class="bc-titleCard" style="width:auto;" ${job.titleCardEnabled ? "checked" : ""}> Title card
        </label>
        <input type="text" class="bc-titleCardText" placeholder="Auto title from story (or type your own)" style="margin-top:6px;">
      </div>
      <div class="field-full">
        <label>Background music</label>
        <div class="row">
          <input type="file" class="bc-music-input" accept="audio/*" style="display:none">
          <button class="accent bc-music-upload" style="flex:1;">Upload</button>
          <button class="bc-music-clear" style="flex:1;">None</button>
        </div>
        <p class="bc-music-status" style="font-size:0.72rem;color:var(--muted);margin-top:4px;">No music selected.</p>
        ${PRESET_MUSIC.length ? `
        <select class="bc-presetMusic" style="margin-top:6px;">
          <option value="">Or pick a preset...</option>
          ${presetMusicOpts}
        </select>` : ""}
        <input type="range" class="bc-musicVolume" min="0" max="1" step="0.05" value="${job.musicVolume}">
      </div>
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
  const presetVideoSel = div.querySelector(".bc-presetVideo");
  if (presetVideoSel) {
    presetVideoSel.addEventListener("change", async (e) => {
      const id = e.target.value;
      if (!id) return;
      const preset = PRESET_VIDEOS.find(p => p.id === id);
      if (!preset) return;
      showToast(`Loading preset "${preset.label}"...`);
      try {
        const file = await fetchPresetFile(preset, "video/mp4");
        await setBatchCardBackground(job, file, div);
      } catch (err) {
        alert(err.message);
        e.target.value = "";
      }
    });
  }

  div.querySelector(".bc-voice").addEventListener("change", (e) => { job.voice = e.target.value || null; });
  div.querySelector(".bc-captionPreset").addEventListener("change", (e) => { job.captionPreset = e.target.value || null; });
  div.querySelector(".bc-ttsEngine").addEventListener("change", (e) => {
    job.ttsEngine = e.target.value || null;
    job.voice = null; // stale voice from the old engine's list wouldn't be valid for the new one
    populateBatchCardVoices(job.ttsEngine || DEFAULT_TTS_ENGINE, div.querySelector(".bc-voice"));
  });
  populateBatchCardVoices(job.ttsEngine || DEFAULT_TTS_ENGINE, div.querySelector(".bc-voice"));

  div.querySelector(".bc-titleCard").addEventListener("change", (e) => { job.titleCardEnabled = e.target.checked; });
  div.querySelector(".bc-titleCardText").addEventListener("input", (e) => { job.titleCardText = e.target.value || null; });

  const musicStatus = div.querySelector(".bc-music-status");
  const musicInput = div.querySelector(".bc-music-input");
  div.querySelector(".bc-music-upload").onclick = () => musicInput.click();
  musicInput.onchange = () => {
    const file = musicInput.files[0];
    if (!file) return;
    job.musicFile = file;
    musicStatus.textContent = file.name;
  };
  div.querySelector(".bc-music-clear").onclick = () => {
    job.musicFile = null;
    musicInput.value = "";
    musicStatus.textContent = "No music selected.";
  };
  const presetMusicSel = div.querySelector(".bc-presetMusic");
  if (presetMusicSel) {
    presetMusicSel.addEventListener("change", async (e) => {
      const id = e.target.value;
      if (!id) return;
      const preset = PRESET_MUSIC.find(p => p.id === id);
      if (!preset) return;
      showToast(`Loading preset "${preset.label}"...`);
      try {
        const file = await fetchPresetFile(preset, "audio/mpeg");
        job.musicFile = file;
        musicStatus.textContent = preset.label;
      } catch (err) {
        alert(err.message);
        e.target.value = "";
      }
    });
  }
  div.querySelector(".bc-musicVolume").addEventListener("input", (e) => { job.musicVolume = parseFloat(e.target.value); });

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
    if (field === "voice" || field === "captionPreset") continue; // handled above via <select> (change, not input)
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
       { role: "user", content: ideasPrompt(STORY_CATEGORIES[Math.floor(Math.random() * STORY_CATEGORIES.length)]) }],
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
    await ensureRenderBackend(parallelism);
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
  await ensureRenderBackend(parseInt($("#batchParallelism").value) || 1);
  await runJob(job, getGlobalSettings(), (j) => renderResultCard(j, $("#resultsGrid")));
}

// ---------- Prompts ----------
// The real content lives in story-system-prompt.txt (a plain text file
// alongside this script, editable directly without touching JS) — fetched
// once at startup by loadDefaultStorySystemPrompt() below. This short inline
// string is only a safety net for the rare case that fetch fails; it's
// deliberately NOT a full duplicate of the real prompt, since the whole
// point of moving it to its own file is one source of truth, not two that
// can drift apart.
let DEFAULT_STORY_SYSTEM_PROMPT = "You are a master of writing fake-but-believable AITAH (Am I The Asshole Here) Reddit posts. Open with a hook, write in first person, and end with \"So Reddit AITAH\".";
async function loadDefaultStorySystemPrompt() {
  try {
    const res = await fetch(BASE + "story-system-prompt.txt");
    if (!res.ok) return;
    const text = (await res.text()).trim();
    if (text) DEFAULT_STORY_SYSTEM_PROMPT = text;
  } catch (e) {
    // Keep the short built-in fallback above — a broken story-generation
    // prompt is a much worse failure than a plainer default one.
  }
}

// Settings' textarea holds the actual live prompt (pre-filled with the
// default above on first run, not an empty box — see init()) — this reads
// whatever's currently there, falling back to the default if it's ever
// empty, and always appends the word-count rule separately so the editable
// textarea itself never needs to contain template syntax.
function storySystemPrompt() {
  const wc = parseInt($("#storyLength").value) || 400;
  const base = ($("#storySystemPromptOverride").value || "").trim() || DEFAULT_STORY_SYSTEM_PROMPT;
  return `${base}\n\nKeep it around ${wc} words.`;
}
function resetStorySystemPrompt() {
  const ta = $("#storySystemPromptOverride");
  ta.value = DEFAULT_STORY_SYSTEM_PROMPT;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  showToast("Story prompt reset to default.");
}
function storyUserPrompt(premise) {
  return `Write an AITAH Reddit post about: ${premise}

Start with the title "AITAH for [doing the thing]" as the first line then a blank line then jump straight into the story.

DO NOT start with "Throwaway because..." or any throwaway disclaimer. Begin with a strong opening hook.

Use normal punctuation. Break the story into short paragraphs separated by blank lines.

Plain text only.`;
}
const STORY_CATEGORIES = [
  "family drama (parents, siblings, in-laws)",
  "workplace or coworker conflict",
  "friendship falling out",
  "money disagreement (splitting bills, lending, inheritance)",
  "wedding or engagement drama",
  "roommate conflict",
  "romantic relationship conflict, not a breakup",
  "parenting disagreement",
  "neighbor dispute",
  "travel or vacation conflict",
  "pet-related conflict",
  "holiday or family-gathering drama",
];
function ideasPrompt(category) {
  const hint = category ? ` Make the scenario specifically about: ${category}.` : "";
  return `Generate ONE creative idea for an AITAH Reddit post.${hint} Output ONLY the idea as a single string like "AITAH for [doing something dramatic]". No JSON, no quotes, no formatting.`;
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
