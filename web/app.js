// Everything runs in the browser: multiple AI story-gen providers, Piper/
// Kokoro TTS, ffmpeg.wasm.

const $ = (s) => document.querySelector(s);
// main branch only: package.json's "version" mirrors this as "<VERSION>.0.0"
// (electron-updater compares that semver against GitHub release tags) — bump
// both together.
const VERSION = 89;

// Compute the app's base path so it works on GitHub Pages (where the site
// lives under /username/repo/ rather than the domain root).
const BASE = document.currentScript ? new URL('.', document.currentScript.src).pathname : '/';
let currentVideo = null;      // File / Blob of background
let currentVideoUrl = null;
let currentVideoUnsupportedCodec = null; // e.g. "AV1" if sniffed as unsupported
let currentVideoTranscoded = null;       // cached H.264 Blob once auto-converted
let subtitles = [];           // [{start, end, text}]
let previewKaraokeGroups = null; // [{start, end, words:[{text,start,end}]}] when captionPreset === "karaoke"
let previewActive = false;
let previewRAF = null;
let ttsAudio = null;
let sidebarMusicFile = null; // background music for the sidebar's single-export flow
// Tracked separately from job.resultUrl (which the result-card's Download/
// Copy Link buttons keep needing after preview) — the debug tool's own
// preview blob has no other owner, so each run revokes the previous one.
let lastDebugPreviewUrl = null;

// ---------- TTS & video engine state ----------
// Piper/Kokoro voice lists and the TTS_ENGINES registry live in
// web/lib/tts-engines.js — this section just holds the per-engine runtime
// instances (lazily created, one per engine that needs local init).
const PIPER_JS = "./vendor/piper-tts-web.js";
// main branch only: kokoro.web.js, its ONNX-runtime WASM binaries, and the
// full model+all-10-voices are all vendored locally (web/vendor/kokoro/,
// web/vendor/kokoro-model/) so a fresh install works fully offline instead
// of needing this ~90MB+ first-use download — see ensureKokoro() below for
// how the model/voice fetches (hardcoded to huggingface.co inside
// kokoro.web.js, with no exposed config knob) get redirected there.
const KOKORO_JS = BASE + "vendor/kokoro/kokoro.web.js";
const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
// kokoro.web.js's voice-file fetch (unlike its model/config/tokenizer fetches,
// which go through from_pretrained's own model-id parameter) has its OWN
// independently hardcoded copy of this same URL — re-vendoring a newer
// kokoro-js build with a different model id/URL shape must update both.
const KOKORO_HF_PREFIX = `https://huggingface.co/${KOKORO_MODEL_ID}/resolve/main/`;
let piperEngine = null;
let kokoroEngine = null;

// ---------- Tiny helpers ----------
function showToast(msg, duration) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), duration || 2500);
}
const SETTINGS_TAB_KEY = "slopdaddy_settingsTab";
function setSettingsTab(tab) {
  document.querySelectorAll(".settings-tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".settings-tab-panel").forEach(p => p.classList.toggle("active", p.dataset.tab === tab));
  localStorage.setItem(SETTINGS_TAB_KEY, tab);
  if (tab === "debug") { refreshSystemDiagnostics(); refreshCacheInfo(); }
  if (tab === "video") { updateCaptionPreviewBackground(); showCaptionSample(); }
  if (tab === "publish") { refreshYoutubeAccounts(); }
  if (tab === "branding" && $("#channelBrandingMode").value === "sync") { refreshYoutubeAccounts(); }
}
function openSettings() {
  $("#settingsOverlay").classList.add("show");
  $("#settingsPanel").classList.add("open");
  setSettingsTab(localStorage.getItem(SETTINGS_TAB_KEY) || "story");
}
function closeSettings() { $("#settingsOverlay").classList.remove("show"); $("#settingsPanel").classList.remove("open"); }
function toggleSettings() {
  if ($("#settingsPanel").classList.contains("open")) closeSettings();
  else openSettings();
}
// Dispatching real input events (rather than just setting .value) lets the
// existing SETTINGS_FIELDS auto-save listener and the live caption-preview
// listener both react exactly as they would to a manual edit.
function applyResolutionPreset(w, h) {
  const resW = $("#resW"), resH = $("#resH");
  resW.value = w; resH.value = h;
  resW.dispatchEvent(new Event("input", { bubbles: true }));
  resH.dispatchEvent(new Event("input", { bubbles: true }));
}
const CRF_BY_QUALITY = { small: 28, balanced: 23, high: 18 };

// ---------- Caption presets ----------
// Populated once from CAPTION_PRESETS (web/lib/caption-presets.js) — same
// "build UI from the registry" pattern as buildFontSelect()/buildEngineSelect().
function buildCaptionPresetButtons() {
  $("#captionPresetRow").innerHTML = CAPTION_PRESETS.map(p =>
    `<button type="button" onclick="applyCaptionPreset('${p.id}')">${escapeHtml(p.label)}</button>`
  ).join("");
}
// A preset is just "fill in these fields" — same dispatched-input-event
// pattern as applyResolutionPreset(), not a separate locked mode. Editing
// any field afterward simply diverges from the preset with no tracking of
// which one was last picked (consistent with how every other preset button
// in this app already works).
function applyCaptionPreset(presetId) {
  const p = getCaptionPreset(presetId);
  const fields = {
    captionPreset: p.grouping, font: p.fontId, fontSize: p.fontSize,
    textColor: p.textColor, strokeColor: p.strokeColor, strokeWidth: p.strokeWidth,
    highlightColor: p.highlightColor || "yellow",
    boxColor: p.boxColor, boxAlpha: p.boxAlpha, boxBorderW: p.boxBorderW,
    shadowColor: p.shadowColor, shadowX: p.shadowX, shadowY: p.shadowY,
    captionEntrance: p.entrance,
  };
  for (const [id, value] of Object.entries(fields)) {
    const el = $("#" + id);
    if (!el || value === undefined) continue;
    el.value = value;
  }
  $("#captionUppercase").checked = !!p.uppercase;
  $("#captionBox").checked = !!p.box;
  $("#captionShadow").checked = !!p.shadow;
  // Dispatch on everything touched so SETTINGS_FIELDS auto-save, the color
  // swatches, and the box/shadow conditional rows all update in one go.
  for (const id of Object.keys(fields)) {
    const el = $("#" + id);
    if (el) el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  $("#captionUppercase").dispatchEvent(new Event("change", { bubbles: true }));
  $("#captionBox").dispatchEvent(new Event("change", { bubbles: true }));
  $("#captionShadow").dispatchEvent(new Event("change", { bubbles: true }));
  // Dispatching "input" on the hidden color inputs above persists/updates
  // the live caption preview, but the swatch buttons' own visible color/
  // label are only ever refreshed by syncColorSwatchDisplay() (normally
  // called from the color-picker popup) — without this, a preset would set
  // the right value invisibly while the swatch still shows its old color.
  for (const id of ["textColor", "strokeColor", "highlightColor", "boxColor", "shadowColor"]) {
    if (fields[id] !== undefined) syncColorSwatchDisplay(id);
  }
  updateCaptionBoxShadowRows();
}
function updateCaptionBoxShadowRows() {
  $("#captionBoxRow").style.display = $("#captionBox").checked ? "" : "none";
  $("#captionShadowRow").style.display = $("#captionShadow").checked ? "" : "none";
}

// ---------- Color picker (Settings -> Video & Captions: Text/Stroke Color) ----------
// The hidden #textColor/#strokeColor inputs remain the single source of
// truth (SETTINGS_FIELDS/saveSettings/loadSettings/getGlobalSettings all
// keep reading/writing them exactly as before) — this popup is just a
// richer way to set their value than typing a CSS color string by hand.
// web/lib/color.js does the actual hsv/rgb/hex math; resolving an arbitrary
// CSS color name (e.g. the "white"/"black" defaults) to RGB needs a canvas,
// which is why that one step lives here instead of in the pure module.
const CP_PRESETS = ["#ffffff", "#000000", "#ffeb3b", "#ff3b30", "#34c759", "#00e5ff", "#ff9500", "#ff2d95"];
let colorPickerState = null; // { targetId, h, s, v, a, originalValue }

function resolveCssColorToRgba(cssColor) {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000000";
  ctx.fillStyle = cssColor;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return { r, g, b, a: a / 255 };
}

function syncColorSwatchDisplay(id) {
  const value = $("#" + id).value || "#ffffff";
  const { r, g, b, a } = resolveCssColorToRgba(value);
  const hex = rgbToHex(r, g, b, a);
  const swatch = $("#" + id + "Swatch");
  const label = $("#" + id + "Label");
  // .color-swatch's CSS checker background-image shows through whenever the
  // color itself is translucent — layering a plain inline background-color
  // on top (rather than replacing background-image) is the simplest way to
  // get that "translucent over checker" look without fighting the CSS rule.
  if (swatch) swatch.style.backgroundColor = `rgba(${r},${g},${b},${a})`;
  if (label) label.textContent = hex.toUpperCase();
}

function openColorPicker(targetId, anchorEl) {
  const input = $("#" + targetId);
  const { r, g, b, a } = resolveCssColorToRgba(input.value || "#ffffff");
  const hsv = rgbToHsv(r, g, b);
  colorPickerState = { targetId, h: hsv.h, s: hsv.s, v: hsv.v, a, originalValue: input.value };

  const popup = $("#colorPickerPopup");
  if (!$("#cpPresets").childElementCount) {
    $("#cpPresets").innerHTML = CP_PRESETS.map(hex =>
      `<button type="button" class="cp-preset-swatch" style="background:${hex}" data-hex="${hex}" onclick="pickColorPreset('${hex}')"></button>`
    ).join("");
  }

  popup.classList.add("show");
  const rect = anchorEl.getBoundingClientRect();
  const popupRect = { w: 280 + 28, h: 420 }; // approx incl. padding, before layout
  let left = rect.left;
  let top = rect.bottom + 8;
  if (left + popupRect.w > window.innerWidth) left = Math.max(8, window.innerWidth - popupRect.w);
  if (top + popupRect.h > window.innerHeight) top = Math.max(8, rect.top - popupRect.h - 8);
  popup.style.left = left + "px";
  popup.style.top = top + "px";

  renderColorPicker();
  document.addEventListener("pointerdown", onColorPickerOutsideClick, true);
}

function closeColorPickerPopup() {
  $("#colorPickerPopup").classList.remove("show");
  document.removeEventListener("pointerdown", onColorPickerOutsideClick, true);
  colorPickerState = null;
}

function onColorPickerOutsideClick(e) {
  const popup = $("#colorPickerPopup");
  if (!colorPickerState) return;
  const btn = $("#" + colorPickerState.targetId + "Btn");
  if (popup.contains(e.target) || (btn && btn.contains(e.target))) return;
  applyColorPicker();
}

function renderColorPicker() {
  if (!colorPickerState) return;
  const { h, s, v, a } = colorPickerState;
  const rgb = hsvToRgb(h, s, v);
  const hex = rgbToHex(rgb.r, rgb.g, rgb.b, a);

  const svArea = $("#cpSvArea");
  svArea.style.backgroundColor = `hsl(${h}, 100%, 50%)`;
  const svRect = { w: svArea.clientWidth || 212, h: svArea.clientHeight || 130 };
  $("#cpSvThumb").style.left = (s * svRect.w) + "px";
  $("#cpSvThumb").style.top = ((1 - v) * svRect.h) + "px";

  $("#cpHueSlider").value = String(Math.round(h));
  $("#cpAlphaSlider").value = String(Math.round(a * 100));
  $("#cpAlphaSlider").style.background = `linear-gradient(to right, rgba(${rgb.r},${rgb.g},${rgb.b},0), rgb(${rgb.r},${rgb.g},${rgb.b}))`;

  $("#cpHex").value = hex.toUpperCase();
  $("#cpR").value = rgb.r;
  $("#cpG").value = rgb.g;
  $("#cpB").value = rgb.b;
  $("#cpA").value = Math.round(a * 100);
}

// Live-commits the in-progress color to the actual hidden input (so the
// caption preview and everything downstream updates immediately, matching
// how every other style control in this panel already behaves) — Cancel is
// what makes this reversible, not withholding the write until Apply.
function commitColorPickerState() {
  if (!colorPickerState) return;
  const { h, s, v, a, targetId } = colorPickerState;
  const rgb = hsvToRgb(h, s, v);
  const hex = rgbToHex(rgb.r, rgb.g, rgb.b, a);
  const input = $("#" + targetId);
  input.value = hex;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  syncColorSwatchDisplay(targetId);
}

function cpSetFromPointer(e) {
  const svArea = $("#cpSvArea");
  const rect = svArea.getBoundingClientRect();
  const x = clamp(e.clientX - rect.left, 0, rect.width);
  const y = clamp(e.clientY - rect.top, 0, rect.height);
  colorPickerState.s = rect.width ? x / rect.width : 0;
  colorPickerState.v = rect.height ? 1 - y / rect.height : 0;
  renderColorPicker();
  commitColorPickerState();
}

function initColorPickerEvents() {
  const svArea = $("#cpSvArea");
  svArea.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    svArea.setPointerCapture(e.pointerId);
    cpSetFromPointer(e);
  });
  svArea.addEventListener("pointermove", (e) => {
    if (e.buttons !== 1) return;
    cpSetFromPointer(e);
  });

  $("#cpHueSlider").addEventListener("input", () => {
    if (!colorPickerState) return;
    colorPickerState.h = parseInt($("#cpHueSlider").value, 10) || 0;
    renderColorPicker();
    commitColorPickerState();
  });
  $("#cpAlphaSlider").addEventListener("input", () => {
    if (!colorPickerState) return;
    colorPickerState.a = (parseInt($("#cpAlphaSlider").value, 10) || 0) / 100;
    renderColorPicker();
    commitColorPickerState();
  });

  $("#cpHex").addEventListener("change", () => {
    if (!colorPickerState) return;
    const rgba = hexToRgba($("#cpHex").value);
    if (!rgba) { renderColorPicker(); return; } // invalid — snap back to last-known-good
    const hsv = rgbToHsv(rgba.r, rgba.g, rgba.b);
    Object.assign(colorPickerState, { h: hsv.h, s: hsv.s, v: hsv.v, a: rgba.a });
    renderColorPicker();
    commitColorPickerState();
  });
  for (const id of ["cpR", "cpG", "cpB", "cpA"]) {
    $("#" + id).addEventListener("change", () => {
      if (!colorPickerState) return;
      const r = clamp(parseInt($("#cpR").value, 10) || 0, 0, 255);
      const g = clamp(parseInt($("#cpG").value, 10) || 0, 0, 255);
      const b = clamp(parseInt($("#cpB").value, 10) || 0, 0, 255);
      const a = clamp((parseInt($("#cpA").value, 10) || 0) / 100, 0, 1);
      const hsv = rgbToHsv(r, g, b);
      Object.assign(colorPickerState, { h: hsv.h, s: hsv.s, v: hsv.v, a });
      renderColorPicker();
      commitColorPickerState();
    });
  }
}

function pickColorPreset(hex) {
  if (!colorPickerState) return;
  const rgba = hexToRgba(hex);
  const hsv = rgbToHsv(rgba.r, rgba.g, rgba.b);
  Object.assign(colorPickerState, { h: hsv.h, s: hsv.s, v: hsv.v, a: 1 });
  renderColorPicker();
  commitColorPickerState();
}

function applyColorPicker() {
  closeColorPickerPopup();
}
function cancelColorPicker() {
  if (!colorPickerState) return;
  const { targetId, originalValue } = colorPickerState;
  const input = $("#" + targetId);
  input.value = originalValue;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  syncColorSwatchDisplay(targetId);
  closeColorPickerPopup();
}

// index.html's own inline <script> (in <head>) already applied the saved
// theme before first paint to avoid a flash — this re-applies it from the
// live #theme select (so switching it updates immediately) and wires the
// "system" mode to actually track OS theme changes, which the one-shot
// inline script can't do on its own.
let systemThemeMediaQuery = null;
function applyTheme(value) {
  if (systemThemeMediaQuery) { systemThemeMediaQuery.onchange = null; systemThemeMediaQuery = null; }
  if (value === "system") {
    systemThemeMediaQuery = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      if (systemThemeMediaQuery.matches) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = "light";
    };
    sync();
    systemThemeMediaQuery.onchange = sync;
  } else if (value === "light") {
    document.documentElement.dataset.theme = "light";
  } else {
    delete document.documentElement.dataset.theme;
  }
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
}
$("#provider").addEventListener("change", populateModels);

// Persist all settings in localStorage so they survive page reloads / hard resets.
const SETTINGS_FIELDS = [
  "apiKey", "provider", "model", "modelCustom", "customBaseUrl", "storyLength",
  "storySystemPromptOverride",
  "resW", "resH", "fps", "encodingQuality",
  "font", "fontSize", "positionY", "textColor", "strokeColor", "strokeWidth",
  "voice", "captionPreset", "captionUppercase", "highlightColor",
  "captionBox", "boxColor", "boxAlpha", "boxBorderW",
  "captionShadow", "shadowColor", "shadowX", "shadowY",
  "captionEntrance",
  "channelName",
  "ttsEngine", "ttsOpenaiKey", "ttsElevenlabsKey",
  "piperSpeed", "kokoroSpeed",
  "openaiTtsModel", "openaiTtsSpeed",
  "elevenlabsModel", "elevenlabsStability", "elevenlabsSimilarity",
  "browserSpeechRate", "browserSpeechPitch",
  "enableBrowserAsr", "whisperModel",
  "renderConcurrency", "transcribeConcurrency", "renderBackendPref",
  "theme", "outputFolder",
  "youtubeClientId", "youtubeClientSecret",
  "youtubeAutoGenerateMetadata", "youtubeTitleTemplate", "youtubeDescriptionTemplate",
  "youtubeDefaultPrivacy", "youtubeDefaultCategoryId",
  "youtubeAutoUpload", "youtubeAutoUploadAccountId",
  "channelBrandingMode", "channelBrandingSyncAccountId",
];
function saveSettings() {
  try {
    const data = {};
    for (const id of SETTINGS_FIELDS) {
      const el = document.getElementById(id);
      if (el) data[id] = el.type === "checkbox" ? el.checked : el.value;
    }
    localStorage.setItem("slopdaddy_settings", JSON.stringify(data));
  } catch (e) {}
}

// Returns the parsed saved-settings object (or null) so init() can restore
// `voice` after populateVoices() has built that engine's option list —
// can't set a <select>'s value to an option that doesn't exist yet.
function loadSettings() {
  try {
    const raw = localStorage.getItem("slopdaddy_settings");
    if (!raw) return null;
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
    return data;
  } catch (e) { return null; }
}

// Applies whatever's in localStorage's "slopdaddy_settings" blob to the live
// DOM — the same sequence init() runs once at startup, factored out so
// "Import Settings" and "Reset to Defaults" (which both rewrite that blob
// and then need the UI to reflect it, exactly like a fresh page load would)
// don't have to duplicate it.
async function applyLoadedSettings() {
  const savedData = loadSettings(); // returns saved data; `model`/`voice` need their options built first
  // First-ever run (nothing saved yet) starts the textarea pre-filled with
  // the real default prompt, not an empty box — resetStorySystemPrompt()
  // and a later loadSettings() (Import) both already set a non-empty value
  // through the normal path, so this only ever fires once per fresh install.
  if (!$("#storySystemPromptOverride").value.trim()) {
    $("#storySystemPromptOverride").value = DEFAULT_STORY_SYSTEM_PROMPT;
  }
  // loadSettings() above already ran populateModels() and restored `model`
  // once its options existed — do NOT call populateModels()/populateVoices()
  // again after this point without re-applying the saved value afterward;
  // both rebuild their <select>'s options from scratch (innerHTML), which
  // resets .value to the first option and silently wipes out a just-
  // restored one. onEngineChangeUI() below already populates voices for the
  // (already-restored) engine as a side effect, so that runs first and the
  // voice restore happens after it, not before.
  await onEngineChangeUI();
  if (savedData && savedData.voice) {
    const hasOption = [...$("#voice").options].some(o => o.value === savedData.voice);
    if (hasOption) { $("#voice").value = savedData.voice; $("#voiceQuick").value = savedData.voice; }
  }
  initPerformanceUI();
  onChannelBrandingModeChange();
  applyTheme($("#theme").value || "dark");
  syncColorSwatchDisplay("textColor");
  syncColorSwatchDisplay("strokeColor");
  syncColorSwatchDisplay("highlightColor");
  syncColorSwatchDisplay("boxColor");
  syncColorSwatchDisplay("shadowColor");
  updateCaptionBoxShadowRows();
  // loadSettings() above restores each slider's raw .value from storage
  // without dispatching input events, so their live value-label <span>s
  // (wired in init(), see the "Per-engine TTS sliders" loop) need an
  // explicit resync here or they'd keep showing each slider's HTML default
  // even after a restored/imported value has been applied.
  for (const id of [
    "piperSpeed", "kokoroSpeed", "openaiTtsSpeed",
    "elevenlabsStability", "elevenlabsSimilarity",
    "browserSpeechRate", "browserSpeechPitch",
  ]) {
    const el = document.getElementById(id);
    const valueEl = document.getElementById(id + "Value");
    if (el && valueEl) valueEl.textContent = parseFloat(el.value).toFixed(2);
  }
  return savedData;
}

function exportSettings() {
  const raw = localStorage.getItem("slopdaddy_settings");
  const data = raw ? JSON.parse(raw) : {};
  data._exportedFromVersion = VERSION;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `slopdaddy-settings-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
}

function importSettingsFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      delete data._exportedFromVersion;
      localStorage.setItem("slopdaddy_settings", JSON.stringify(data));
      await applyLoadedSettings();
      showToast("Settings imported.");
    } catch (e) {
      alert("Couldn't import that file: " + (e && e.message ? e.message : String(e)));
    }
  };
  reader.readAsText(file);
  input.value = "";
}

// Deliberately leaves the channel profile picture and panel-width/collapsed-
// state localStorage keys untouched — this resets *settings*, not branding
// or layout, so it can't silently delete an uploaded profile picture.
// Reloads rather than re-running applyLoadedSettings() in place: with no
// saved blob, loadSettings() has nothing to restore and would leave every
// field showing whatever was on screen a moment ago instead of its actual
// HTML-attribute default — a fresh load is what actually applies defaults.
function resetSettingsToDefaults() {
  if (!confirm("Reset all settings to their defaults? This can't be undone.")) return;
  localStorage.removeItem("slopdaddy_settings");
  location.reload();
}

// ---------- Init ----------
function buildEngineSelect() {
  const opts = Object.values(TTS_ENGINES).map(e => {
    // pocketTts is the one engine with a real "not installed" failure mode
    // most users will hit by default (a native `uvx pocket-tts` process,
    // unlike Piper/Kokoro's bundled/CDN-fetched browser models or the cloud
    // engines' API-key gating) — grey it out with a clear reason instead of
    // letting it be picked and only failing on generate.
    const unavailable = e.id === "pocketTts" && !nativePocketTtsAvailable;
    const label = unavailable ? `${e.label} — not installed` : e.label;
    return `<option value="${e.id}"${unavailable ? " disabled" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
  $("#ttsEngine").innerHTML = opts;
  $("#ttsEngineQuick").innerHTML = '<option value="">Use settings engine</option>' + opts;
}
// Real vendored fonts only (web/vendor/fonts/) — every option here actually
// changes the render (fontfile lookup by id, see getCaptionFont()), unlike
// the old hardcoded list of common system font names that only ever
// affected the CSS preview and had zero effect on the exported video.
function buildFontSelect() {
  $("#font").innerHTML = CAPTION_FONTS.map(f => `<option value="${f.id}">${escapeHtml(f.label)}</option>`).join("");
}
// Probed once at startup: is a real local backend (server.js's /render,
// shelling out to the user's own installed ffmpeg) reachable? True only
// when running via `node server.js` with ffmpeg on PATH — always false on
// the deployed GitHub Pages build (no server there to answer), which is
// exactly what makes the WASM fallback below automatic with no extra logic.
let nativeRenderAvailable = false;
// Whether native rendering actually gets USED, as opposed to whether it's
// merely available — Settings -> Performance's "Render backend" control
// lets the user force the browser (WASM) engine even when native ffmpeg is
// available (e.g. to compare output, or work around a native-specific
// issue), overriding the otherwise-automatic native-when-available choice.
// Every render-path decision point should call this, not read
// nativeRenderAvailable directly.
function useNativeRender() {
  const el = document.getElementById("renderBackendPref");
  return nativeRenderAvailable && (!el || el.value !== "wasm");
}
// Populated alongside nativeRenderAvailable by probeNativeRenderBackend()'s
// /render-capability response — used to size the Performance setting's range
// (Settings -> Performance) without duplicating os.cpus().length client-side.
let nativeCpuCount = 1;
async function probeNativeRenderBackend() {
  try {
    const ctrl = new AbortController();
    // Must outlast server.js's own checkFfmpeg timeout (5s) — a shorter
    // client-side abort here raced against a slow cold-start `ffmpeg
    // -filters` exec and could report native rendering unavailable (hiding
    // the whole Settings -> Performance section) even though the server
    // would have answered a couple seconds later.
    const t = setTimeout(() => ctrl.abort(), 6000);
    const resp = await fetch("/render-capability", { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return false;
    const data = await resp.json();
    if (data.cpuCount) nativeCpuCount = data.cpuCount;
    return !!data.available;
  } catch (e) {
    return false;
  }
}

// Settings -> Performance: only meaningful (and only shown) when the native
// render backend is available — the WASM fallback's concurrency is governed
// separately by #batchParallelism (see initBatchUI). Called once from init()
// after the native probe resolves, and again on the slider's own input.
function initPerformanceUI() {
  const section = $("#performanceSection");
  if (!nativeRenderAvailable) { section.style.display = "none"; return; }
  section.style.display = "";
  const slider = $("#renderConcurrency");
  slider.max = String(nativeCpuCount);
  $("#renderConcurrencyMax").textContent = String(nativeCpuCount);
  // Always defaults to every core on load — a previously-saved lower value
  // used to "stick" forever once set (including from a stray test/debug
  // session), which is the opposite of the intended default; "dial back"
  // is meant to be a deliberate in-session choice, not a silently
  // remembered one.
  slider.value = String(nativeCpuCount);
  $("#renderConcurrencyValue").textContent = slider.value;
  postPerformanceSettings();

  const tSection = $("#transcribeConcurrencySection");
  if (!nativeWhisperAvailable) { tSection.style.display = "none"; }
  else {
    tSection.style.display = "";
    const tSlider = $("#transcribeConcurrency");
    tSlider.max = String(nativeCpuCount);
    $("#transcribeConcurrencyMax").textContent = String(nativeCpuCount);
    tSlider.value = String(nativeCpuCount);
    $("#transcribeConcurrencyValue").textContent = tSlider.value;
    postTranscribeConcurrencySettings();
  }
  $("#whisperModelRow").style.display = nativeWhisperAvailable ? "" : "none";
}

async function postPerformanceSettings() {
  if (!nativeRenderAvailable) return;
  const n = parseInt($("#renderConcurrency").value, 10) || nativeCpuCount;
  await applyRenderConcurrency(n);
}

async function postTranscribeConcurrencySettings() {
  if (!nativeWhisperAvailable) return;
  const n = parseInt($("#transcribeConcurrency").value, 10) || nativeCpuCount;
  try {
    await fetch("/performance-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcribeConcurrency: n }),
    });
  } catch (e) { /* best-effort */ }
}

// Shared by the Settings -> Performance slider (postPerformanceSettings,
// above) and the batch screen's own "Parallel renders" dropdown
// (renderAllBatch/retryBatchJob below) — both are really just ways to set
// the same server-side renderLimiter, so route them through one function
// rather than each POSTing /performance-settings independently. Only
// renderConcurrency is set here (transcribeConcurrency is left alone) since
// "Parallel renders" is specifically about render throughput.
async function applyRenderConcurrency(n) {
  if (!nativeRenderAvailable) return;
  try {
    await fetch("/performance-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ renderConcurrency: n }),
    });
  } catch (e) { /* best-effort — a failed update just leaves the server's previous setting in place */ }
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
    const t = setTimeout(() => ctrl.abort(), 6000); // outlasts checkWhisper's 5s server-side timeout
    const resp = await fetch("/transcribe-capability", { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return false;
    const data = await resp.json();
    return !!data.available;
  } catch (e) {
    return false;
  }
}

// Same probe pattern again, for server.js's /pockettts (shells out to
// `uvx pocket-tts` — a small CPU-only TTS model with no browser build).
// Also always false on the deployed GitHub Pages build (no server).
let nativePocketTtsAvailable = false;
async function probeNativePocketTtsBackend() {
  try {
    const ctrl = new AbortController();
    // Must outlast checkPocketTts's 20s server-side timeout — its first-ever
    // check can genuinely take that long (uvx downloads the package on
    // first run) — a shorter client abort here would misreport it as
    // unavailable on exactly the case that most needs the extra time.
    const t = setTimeout(() => ctrl.abort(), 21000);
    const resp = await fetch("/pockettts-capability", { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return false;
    const data = await resp.json();
    return !!data.available;
  } catch (e) {
    return false;
  }
}

// Not a real capability check (no external tool to probe) — just "is a
// server present at all", same shape as the others. Naturally false on the
// deployed GitHub Pages build, which is what makes the whole Publish tab
// invisible there with no special-casing elsewhere.
let youtubeAvailable = false;
async function probeYoutubeCapability() {
  try {
    const resp = await fetch("/youtube-capability");
    if (!resp.ok) return false;
    const data = await resp.json();
    return !!data.available;
  } catch (e) {
    return false;
  }
}

async function init() {
  $("#versionBadge").textContent = `v${VERSION}`;
  [nativeRenderAvailable, nativeWhisperAvailable, nativePocketTtsAvailable, youtubeAvailable] = await Promise.all([
    probeNativeRenderBackend(), probeNativeWhisperBackend(), probeNativePocketTtsBackend(), probeYoutubeCapability(),
  ]);
  $("#publishTabBtn").style.display = youtubeAvailable ? "" : "none";
  // Fire-and-forget, not awaited — populates youtubeAccountsCache (and, via
  // refreshChannelBrandingSyncAccountSelect, applies the default "sync with
  // connected channel" branding) without the user needing to open the
  // Publish or Branding tab first. Doesn't block the rest of startup on a
  // network round trip that isn't required for the app to be usable.
  if (youtubeAvailable) refreshYoutubeAccounts();
  buildEngineSelect();
  buildProviderSelect();
  buildFontSelect();
  buildCaptionPresetButtons();
  const savedData = await applyLoadedSettings();
  buildPresetSelects();
  // Save on any settings change. A <select> reliably fires "change" (and,
  // in every browser this app targets, "input" too) — registering both
  // meant every dropdown change ran the full saveSettings() (stringify +
  // localStorage.setItem) twice back-to-back for no benefit.
  for (const id of SETTINGS_FIELDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener(el.tagName === "SELECT" ? "change" : "input", saveSettings);
  }
  $("#renderConcurrency").addEventListener("input", () => {
    $("#renderConcurrencyValue").textContent = $("#renderConcurrency").value;
    postPerformanceSettings();
  });
  $("#transcribeConcurrency").addEventListener("input", () => {
    $("#transcribeConcurrencyValue").textContent = $("#transcribeConcurrency").value;
    postTranscribeConcurrencySettings();
  });
  $("#theme").addEventListener("change", () => applyTheme($("#theme").value));
  $("#captionBox").addEventListener("change", updateCaptionBoxShadowRows);
  $("#captionShadow").addEventListener("change", updateCaptionBoxShadowRows);
  // Per-engine TTS sliders (Settings -> Voice) — same "live value label next
  // to the slider" pattern as renderConcurrency/transcribeConcurrency above.
  for (const id of [
    "piperSpeed", "kokoroSpeed", "openaiTtsSpeed",
    "elevenlabsStability", "elevenlabsSimilarity",
    "browserSpeechRate", "browserSpeechPitch",
  ]) {
    const el = document.getElementById(id);
    const valueEl = document.getElementById(id + "Value");
    if (el && valueEl) {
      el.addEventListener("input", () => { valueEl.textContent = parseFloat(el.value).toFixed(2); });
    }
  }
  // Keep the caption preview live when style fields are edited by hand
  for (const id of [
    "font", "fontSize", "positionY", "textColor", "strokeColor", "strokeWidth", "resW",
    "captionUppercase", "highlightColor", "captionBox", "boxColor", "boxAlpha", "boxBorderW",
    "captionShadow", "shadowColor", "shadowX", "shadowY", "captionEntrance",
  ]) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", updateCaptionStyle);
  }
  // Grouping choice changes which sample renders, not just style
  $("#captionPreset").addEventListener("input", showCaptionSample);
  $("#videoPreview").addEventListener("loadeddata", updateCaptionPreviewBackground);
  initCaptionDrag();
  initColorPickerEvents();
  initPanelResize("sidebar", "sidebarResizeHandle", 1, "slopdaddy_sidebarWidth");
  initSidebarToggle();
  // The sidebar (and with it the preview box) can be resized by dragging its
  // edge — recompute the preview's pixel-to-output scale when that happens.
  new ResizeObserver(() => updateCaptionStyle()).observe($("#captionLivePreviewBg"));
  initMediaLibraryUI();
  refreshMediaLibraryCache();
  initBatchUI();
  loadChannelProfilePic();
  initAppUpdates();
}

// ---------- Standalone app updates (Electron only) ----------
// window.electronAPI only exists under the Electron app (see
// electron/preload.js's narrow contextBridge surface) — a plain browser tab
// (including the deployed GitHub Pages build) has no such bridge and can't
// self-update anyway, so this whole section stays hidden rather than
// showing buttons that would do nothing.
async function chooseOutputFolder() {
  if (!window.electronAPI || !window.electronAPI.isElectron) return;
  const folder = await window.electronAPI.chooseOutputFolder();
  if (!folder) return;
  $("#outputFolder").value = folder;
  saveSettings();
}

function initAppUpdates() {
  if (!window.electronAPI || !window.electronAPI.isElectron) return;
  $("#appUpdatesSection").style.display = "";
  $("#outputFolderSection").style.display = "";
  // Shows this codebase's own v-number (the same VERSION shown in
  // #versionBadge everywhere else in the app), not package.json's semver —
  // that field exists purely for electron-updater's release-tag comparison,
  // not as a user-facing version number, so it'd read as a confusing
  // mismatch ("1.0.0" vs. the "v68" badge) if shown directly.
  window.electronAPI.getAppInfo().then((info) => {
    $("#appVersionText").textContent = `v${VERSION}` + (info.isPackaged ? "" : " (dev, unpackaged)");
  });
  window.electronAPI.onUpdateStatus(renderUpdateStatus);
}

// electron-updater reports package.json's semver (e.g. "69.0.0", tracking
// this codebase's VERSION per the x.0.0 convention) — display just the
// leading number so it reads as "v69", matching #versionBadge/#appVersionText
// instead of a confusing raw semver string.
function formatAppVersion(semver) {
  return "v" + String(semver).split(".")[0];
}

function renderUpdateStatus(status) {
  const text = $("#updateStatusText");
  const actionsRow = $("#updateActionsRow");
  const downloadBtn = $("#downloadUpdateBtn");
  const installBtn = $("#installUpdateBtn");
  const checkBtn = $("#checkUpdateBtn");
  downloadBtn.style.display = "none";
  installBtn.style.display = "none";
  actionsRow.style.display = "none";
  checkBtn.disabled = false;

  if (status.state === "checking") {
    text.textContent = "Checking for updates...";
    checkBtn.disabled = true;
  } else if (status.state === "available") {
    text.textContent = `Update available: ${formatAppVersion(status.version)}`;
    actionsRow.style.display = "flex";
    downloadBtn.style.display = "";
  } else if (status.state === "not-available") {
    text.textContent = "You're up to date.";
  } else if (status.state === "downloading") {
    text.textContent = `Downloading update... ${Math.round(status.percent || 0)}%`;
  } else if (status.state === "downloaded") {
    text.textContent = `Update ${formatAppVersion(status.version)} downloaded — restart to install.`;
    actionsRow.style.display = "flex";
    installBtn.style.display = "";
  } else if (status.state === "error") {
    text.textContent = "Update check failed: " + status.message;
  }
}

async function checkForAppUpdate() {
  if (!window.electronAPI) return;
  $("#updateStatusText").textContent = "Checking for updates...";
  $("#checkUpdateBtn").disabled = true;
  const result = await window.electronAPI.checkForUpdates();
  $("#checkUpdateBtn").disabled = false;
  // On success, the real outcome (available/not-available) arrives via the
  // onUpdateStatus event listener, not this return value — this only
  // surfaces a failure to even START the check (e.g. running unpackaged).
  if (!result.ok) $("#updateStatusText").textContent = "Update check failed: " + result.error;
}

async function downloadAppUpdate() {
  if (!window.electronAPI) return;
  $("#downloadUpdateBtn").disabled = true;
  $("#updateStatusText").textContent = "Downloading update...";
  const result = await window.electronAPI.downloadUpdate();
  if (!result.ok) {
    $("#updateStatusText").textContent = "Download failed: " + result.error;
    $("#downloadUpdateBtn").disabled = false;
  }
}

function installAppUpdate() {
  if (!window.electronAPI) return;
  window.electronAPI.quitAndInstall();
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

const SIDEBAR_COLLAPSED_KEY = "slopdaddy_sidebarCollapsed";
function setSidebarCollapsed(collapsed) {
  $("#sidebar").classList.toggle("collapsed", collapsed);
  const btn = $("#sidebarToggleBtn");
  btn.innerHTML = collapsed ? "&raquo;" : "&laquo;";
  btn.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
}
function toggleSidebar() {
  const collapsed = !$("#sidebar").classList.contains("collapsed");
  setSidebarCollapsed(collapsed);
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
}
function initSidebarToggle() {
  if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1") setSidebarCollapsed(true);
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

// ---------- Story generation (streaming, client-side) ----------
// Provider-agnostic: STORY_PROVIDERS (web/lib/story-providers.js) supplies
// buildChatRequest() (the {url, headers, body} to send) and parseSSEDelta()
// (how to pull the next text chunk out of one parsed `data: ` line) — this
// function is just the shared fetch + SSE-read loop every provider streams
// through, regardless of whether its wire format is OpenAI's or Anthropic's.
async function streamChat(messages, onChunk) {
  const provider = getStoryProvider();
  const key = getApiKey();
  // Throw, don't silently return — every caller treats a resolved
  // streamChat() as success (shows a "Story generated!"/etc. toast) even
  // though onChunk was never called and the textarea it was writing into is
  // still empty. Callers already wrap this in try/catch and alert(e.message).
  if (key === null) throw new Error("Enter your API key in Settings first.");
  const { url, headers, body } = buildChatRequest(provider, {
    model: getModel(), messages, temperature: 0.9, apiKey: key, baseUrl: apiBase(),
  });
  // Two separate bounds: the initial connection (a provider that's down/
  // unreachable could otherwise hang at the fetch() call itself with no
  // error and no recovery — the Generate button just stays "Generating..."
  // forever) and a stall watchdog on the stream once it starts (a
  // connection that stops delivering chunks mid-story, without ever
  // formally closing, would otherwise hang forever at reader.read() too).
  const ctrl = new AbortController();
  const connectTimer = setTimeout(() => ctrl.abort(), 30000);
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
  try {
    while (true) {
      let stallTimer;
      const stallGuard = new Promise((_, reject) => {
        stallTimer = setTimeout(() => reject(new Error("Story generation stalled — no data received for 60s.")), 60000);
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
        try {
          const parsed = JSON.parse(data);
          const text = parseSSEDelta(provider.api, parsed);
          if (text) onChunk(text);
        } catch (e) {}
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
  const container = $("#captionLivePreviewBg");
  const outputW = parseInt($("#resW").value) || 1080;
  return (container.clientWidth || 240) / outputW;
}
function currentCaptionGrouping() {
  return resolveCaptionGrouping($("#captionPreset").value);
}
function updateCaptionStyle() {
  const el = $("#captionOverlay");
  const scale = getPreviewScale();
  const fontId = $("#font").value;
  const fontDef = getCaptionFont(fontId);
  el.style.fontFamily = (fontDef ? fontDef.cssFamily : "SlopdaddyDejaVu") + ", sans-serif";
  const fontSize = (parseInt($("#fontSize").value) || 68) * scale;
  el.style.fontSize = fontSize + "px";
  el.style.color = $("#textColor").value;
  el.style.textTransform = $("#captionUppercase").checked ? "uppercase" : "none";
  const sw = (parseInt($("#strokeWidth").value) || 0) * scale;
  const sc = $("#strokeColor").value;
  // 8-direction shadow (4 corners + 4 edges) so the outline fully surrounds
  // each glyph — 4 corners alone leaves visible gaps at the top/bottom/
  // left/right of the strokes, which is what looked "broken" in the preview.
  const shadows = sw
    ? [
        `-${sw}px -${sw}px 0 ${sc}`, `0 -${sw}px 0 ${sc}`, `${sw}px -${sw}px 0 ${sc}`,
        `${sw}px 0 0 ${sc}`,
        `${sw}px ${sw}px 0 ${sc}`, `0 ${sw}px 0 ${sc}`, `-${sw}px ${sw}px 0 ${sc}`,
        `-${sw}px 0 0 ${sc}`,
      ]
    : [];
  // Approximate ffmpeg's real box/shadow with CSS — square corners (no fake
  // rounded pill the render can't reproduce) and a directional text-shadow.
  if ($("#captionBox").checked) {
    const rgb = hexToRgba($("#boxColor").value) || { r: 0, g: 0, b: 0 };
    const alpha = parseFloat($("#boxAlpha").value);
    el.style.backgroundColor = `rgba(${rgb.r},${rgb.g},${rgb.b},${isFinite(alpha) ? alpha : 0.5})`;
    el.style.padding = Math.max(2, ((parseInt($("#boxBorderW").value) || 16) * scale) / 2) + "px " + (fontSize * 0.3) + "px";
    el.style.borderRadius = "2px";
  } else {
    el.style.backgroundColor = "transparent";
    el.style.padding = "8px 12px";
    el.style.borderRadius = "6px";
  }
  if ($("#captionShadow").checked) {
    const shC = $("#shadowColor").value;
    const shX = (parseFloat($("#shadowX").value) || 0) * scale;
    const shY = (parseFloat($("#shadowY").value) || 0) * scale;
    shadows.push(`${shX}px ${shY}px 3px ${shC}`);
  }
  el.style.textShadow = shadows.length ? shadows.join(", ") : "none";
  const y = parseFloat($("#positionY").value);
  el.style.left = "50%";
  el.style.top = ((isFinite(y) ? y : 0.55) * 100) + "%";
  el.style.transform = "translate(-50%, -50%)";
  const entrance = $("#captionEntrance").value;
  el.classList.remove("entrance-fade", "entrance-pop");
  if (entrance === "fade") el.classList.add("entrance-fade");
  else if (entrance === "pop") el.classList.add("entrance-pop");
}
// Renders one <span> per word into #captionKaraokeWrap, toggling a
// highlight color on whichever word's own [start,end] window contains
// `time` — a CSS-flex approximation of the render's dual-drawtext-layer
// technique (no need to replicate the canvas x-offset math here, only the
// actual ffmpeg output needs pixel-exact positions).
function renderKaraokeCaption(group, time) {
  const wrap = $("#captionKaraokeWrap");
  const highlightColor = $("#highlightColor").value || "yellow";
  const uppercase = $("#captionUppercase").checked;
  wrap.innerHTML = group.words.map(w => {
    const active = time >= w.start && time <= w.end;
    const text = uppercase ? w.text.toUpperCase() : w.text;
    return `<span class="clp-word" style="${active ? `color:${highlightColor};` : ""}">${escapeHtml(text)}</span>`;
  }).join(" ");
}
function renderCaption(time) {
  const grouping = currentCaptionGrouping();
  const overlay = $("#captionOverlay");
  if (grouping === "karaoke" && previewKaraokeGroups && previewKaraokeGroups.length) {
    const group = previewKaraokeGroups.find(g => time >= g.start && time <= g.end);
    if (group) {
      $("#captionText").style.display = "none";
      $("#captionKaraokeWrap").style.display = "inline";
      renderKaraokeCaption(group, time);
      overlay.classList.add("show");
      return;
    }
  }
  $("#captionKaraokeWrap").style.display = "none";
  $("#captionText").style.display = "inline";
  const cap = subtitles.find(s => time >= s.start && time <= s.end);
  if (cap) { $("#captionText").textContent = cap.text; overlay.classList.add("show"); }
  else { $("#captionText").textContent = ""; overlay.classList.remove("show"); }
}
function captionsLoop() {
  if (!previewActive) return;
  if (ttsAudio && !ttsAudio.paused) renderCaption(ttsAudio.currentTime);
  previewRAF = requestAnimationFrame(captionsLoop);
}
// Shows a static, draggable sample caption whenever nothing is actively
// narrating — lets the user position/size captions without needing a
// generated story or a running preview first. Works even with no background
// video uploaded, since the preview now lives in Settings, not on the main
// page next to the upload area.
function showCaptionSample() {
  const grouping = currentCaptionGrouping();
  if (grouping === "karaoke") {
    const sample = [
      { text: "This", start: 0, end: 1 },
      { text: "is", start: 1, end: 2 },
      { text: "karaoke", start: 2, end: 3 },
    ];
    $("#captionText").style.display = "none";
    $("#captionKaraokeWrap").style.display = "inline";
    renderKaraokeCaption({ start: 0, end: 3, words: sample }, 1.5);
  } else {
    $("#captionKaraokeWrap").style.display = "none";
    $("#captionText").style.display = "inline";
    $("#captionText").textContent = $("#captionUppercase").checked ? "YOUR CAPTION HERE" : "Your Caption Here";
  }
  $("#captionOverlay").classList.add("show");
  updateCaptionStyle();
}
// Shows a frozen frame of the uploaded background video (or a neutral
// placeholder when none is uploaded) as the in-Settings preview's
// background — object-fit:cover math via canvas, mirroring how the main
// page's own upload preview crops a video.
function updateCaptionPreviewBackground() {
  const bg = $("#captionLivePreviewBg");
  if (!bg) return;
  const vid = $("#videoPreview");
  if (!currentVideo || !vid || !vid.videoWidth) {
    bg.style.backgroundImage = "none";
    return;
  }
  try {
    const canvas = document.createElement("canvas");
    const targetW = 240, targetH = Math.round(240 * 16 / 9);
    canvas.width = targetW; canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    const vw = vid.videoWidth, vh = vid.videoHeight;
    const scale = Math.max(targetW / vw, targetH / vh);
    const dw = vw * scale, dh = vh * scale;
    ctx.drawImage(vid, (targetW - dw) / 2, (targetH - dh) / 2, dw, dh);
    bg.style.backgroundImage = `url(${canvas.toDataURL("image/jpeg", 0.85)})`;
  } catch (e) {
    bg.style.backgroundImage = "none";
  }
}
function stopPreview() {
  previewActive = false;
  if (previewRAF) { cancelAnimationFrame(previewRAF); previewRAF = null; }
  if (ttsAudio) {
    ttsAudio.pause();
    ttsAudio.currentTime = 0;
    if (ttsAudio.src) URL.revokeObjectURL(ttsAudio.src);
    ttsAudio = null;
  }
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
  const container = $("#captionLivePreviewBg");

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

// Piper's real speed knob is `length_scale` inside the voice's own config
// JSON (fed into the ONNX model as part of the "scales" tensor), not a
// generate()-call argument — and PiperWebEngine.generate() calls
// voiceProvider.fetch(voice) fresh on every single generate, not just once,
// so reading the live #piperSpeed value here (rather than needing to thread
// it through PiperEngine.generate()'s signature) picks up a mid-session
// change on the very next narration. length_scale is inversely proportional
// to speed (Piper convention: larger length_scale = longer/slower audio).
function applyPiperSpeed(json) {
  const el = $("#piperSpeed");
  const speed = el ? parseFloat(el.value) || 1 : 1;
  if (!json || !json.inference || speed === 1) return json;
  return { ...json, inference: { ...json.inference, length_scale: (json.inference.length_scale || 1) / speed } };
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
    // Every other network fetch in the caption-sync/TTS pipeline (native
    // transcribe, cloud TTS engines) already bounds itself with an
    // AbortController timeout — these two HuggingFace fetches (for any
    // non-vendored Piper voice) were the one place still using bare fetch(),
    // so a stalled connection here hung indefinitely with no error until
    // queueTTS's blunt 3-minute overall timeout finally caught it.
    async function fetchVoiceFile(url, timeoutMs = 30000) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`Voice file fetch failed: ${url} (${res.status})`);
        return res;
      } catch (e) {
        if (e.name === "AbortError") throw new Error(`Voice file fetch timed out after ${timeoutMs / 1000}s: ${url}`);
        throw e;
      } finally {
        clearTimeout(t);
      }
    }
    const voiceProvider = {
      async fetch(voice) {
        // The default voice is vendored locally (web/vendor/piper-voices/)
        // so a fresh install works offline without waiting on a first-use
        // download — every other voice still fetches from HuggingFace on
        // first use, same as before.
        if (voice === "en_US-ryan-medium") {
          const jsonRes = await fetchVoiceFile(BASE + "vendor/piper-voices/en_US-ryan-medium.onnx.json");
          const onnxRes = await fetchVoiceFile(BASE + "vendor/piper-voices/en_US-ryan-medium.onnx");
          const json = await jsonRes.json();
          const onnx = URL.createObjectURL(await onnxRes.blob());
          return [applyPiperSpeed(json), onnx];
        }
        // Correct HuggingFace path for piper voices.
        const parts = voice.split("-");
        const lang = parts[0].split("_")[0];
        const base = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang}/${parts[0]}/`;
        const sub = parts.slice(1).join("/");
        const stem = parts.join("-");
        const jsonUrl = `${base}${sub}/${stem}.onnx.json`;
        const onnxUrl = `${base}${sub}/${stem}.onnx`;
        const json = await (await fetchVoiceFile(jsonUrl)).json();
        const onnx = URL.createObjectURL(await (await fetchVoiceFile(onnxUrl)).blob());
        return [applyPiperSpeed(json), onnx];
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

// kokoro.web.js hardcodes its model/config/tokenizer/voice fetches to
// https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/...
// with no exposed config knob (confirmed by inspecting the bundled source —
// it re-exports only a narrow env.wasmPaths setter, not the full
// transformers.js env object that WOULD support this properly via
// localModelPath/remoteHost). A permanent, narrowly-scoped fetch patch is
// the only way to redirect those specific URLs to the vendored local copies
// in web/vendor/kokoro-model/ — everything else's fetch calls pass through
// completely untouched. Installed once and left active for the rest of the
// session, since a new (already-vendored) voice's .bin can be requested by
// Kokoro at any later .generate() call, not just during from_pretrained.
let kokoroFetchPatched = false;
function patchKokoroFetch() {
  if (kokoroFetchPatched) return;
  kokoroFetchPatched = true;
  const origFetch = window.fetch.bind(window);
  const localPrefix = BASE + "vendor/kokoro-model/";
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url);
    if (typeof url === "string" && url.startsWith(KOKORO_HF_PREFIX)) {
      return origFetch(localPrefix + url.slice(KOKORO_HF_PREFIX.length), init);
    }
    if (typeof url === "string" && url.includes("huggingface.co") && url.includes(KOKORO_MODEL_ID)) {
      console.warn("Kokoro fetch didn't match KOKORO_HF_PREFIX, falling through to network:", url);
    }
    return origFetch(input, init);
  };
}

// Kokoro (kokoro-js) mirrors Piper's lazy-singleton pattern: one shared
// engine instance. The model+all 10 voices are vendored locally (see
// patchKokoroFetch above) so this never actually hits HuggingFace on main —
// dtype "q8" is the quantized variant (~92MB) vs. ~326MB fp32, no meaningful
// quality loss per the model's own documentation, and is what the vendored
// files are.
async function ensureKokoro() {
  if (kokoroEngine) return kokoroEngine;
  showDownloadToast("Preparing Kokoro TTS engine...");
  try {
    patchKokoroFetch();
    const mod = await import(KOKORO_JS);
    const { KokoroTTS, env } = mod;
    env.wasmPaths = BASE + "vendor/kokoro/onnx/";
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
// Generous relative to even a slow WASM/ONNX synthesis of a long story on
// CPU (Piper/Kokoro), but bounded. Without this, a genuinely hung engine
// call — a real WASM/ONNX edge case, not just a network stall (which the
// individual cloud engines already guard against with their own fetch
// timeouts) — left fn() never settling, which meant ttsQueueTail never
// settled either. Since every future queueTTS() call chains off that same
// promise, ONE bad job permanently wedged voice generation for the rest
// of the session, not just that job — this is what made the whole app
// look stuck on "Generating voice..." forever with no recovery short of
// a reload. Racing fn() against a timeout guarantees `run` (and therefore
// ttsQueueTail) always settles, so the queue can never get stuck this way
// again; the hung call itself just becomes an orphaned promise no longer
// blocking anything.
const TTS_QUEUE_TIMEOUT_MS = 3 * 60 * 1000;
function queueTTS(fn) {
  const runOne = () => Promise.race([
    fn(),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`Voice generation timed out after ${TTS_QUEUE_TIMEOUT_MS / 1000}s — the TTS engine may have gotten stuck.`)),
      TTS_QUEUE_TIMEOUT_MS
    )),
  ]);
  const run = ttsQueueTail.then(runOne, runOne);
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
async function resolveWordTimings(text, audioBlob, durationSec, engineWordTimings, onTranscribeProgress) {
  if (engineWordTimings && engineWordTimings.length) return engineWordTimings;

  let asrWords = null;
  if (nativeWhisperAvailable) {
    asrWords = await transcribeNatively(audioBlob, onTranscribeProgress);
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

async function generateSpeech(text, voice, engineId, onTranscribeProgress) {
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
  // Only the actual engine call needs queueTTS's one-at-a-time lock —
  // Piper/Kokoro's shared singleton isn't verified concurrency-safe, and
  // BrowserSpeech genuinely can't speak two utterances through one
  // speechSynthesis instance at once. resolveWordTimings() (which may do a
  // real native-Whisper subprocess round trip via /transcribe) has no such
  // constraint, so it runs after the lock releases — this lets multiple
  // batch jobs' transcriptions run concurrently, bounded by the server's own
  // independent transcribeLimiter instead of being serialized behind every
  // other job's TTS+transcription combined.
  let generated;
  try {
    generated = await queueTTS(async () => {
      showDownloadToast(`Generating voice (${engine.label})...`);
      try {
        return await engine.generate(text, voice, config);
      } finally {
        hideDownloadToast();
      }
    });
  } catch (e) {
    console.error("generateSpeech failed:", e);
    const detail = (e && e.stack) ? ("\n\n" + e.stack.split("\n").slice(0, 4).join("\n")) : "";
    throw new Error((e && e.message ? e.message : "TTS failed") + detail);
  }
  const { audioBlob, durationSec, wordTimings } = generated;
  const audioUrl = URL.createObjectURL(audioBlob);
  const words = await resolveWordTimings(text, audioBlob, durationSec, wordTimings, onTranscribeProgress);
  return { audioUrl, words };
}

// ---------- Voice preview ----------
// A quick "hear this voice" button next to every voice dropdown — generates
// a short fixed line and plays it immediately, bypassing generateSpeech()'s
// resolveWordTimings() caption-sync cascade entirely (no captions needed for
// a one-off preview, and skipping it avoids a pointless native-Whisper round
// trip). Still goes through queueTTS since Piper/Kokoro's shared engine
// instance isn't verified safe for concurrent calls.
let previewAudio = null;
async function previewVoice(engineId, voice, btn) {
  const engine = TTS_ENGINES[engineId];
  if (!engine) return;
  if (!voice) { showToast("No voice selected."); return; }
  const config = getEngineConfig(engineId);
  if (engine.needsApiKey && !config) return; // getEngineConfig() already alerted
  // Revoking only ever happened on the "ended" event — interrupting a still-
  // playing preview (clicking Preview again before it finished) dropped the
  // reference without ever revoking that blob URL.
  if (previewAudio) { previewAudio.pause(); if (previewAudio.src) URL.revokeObjectURL(previewAudio.src); previewAudio = null; }
  const originalLabel = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.textContent = "..."; }
  try {
    const { audioBlob } = await queueTTS(() => engine.generate("This is a preview.", voice, config));
    const url = URL.createObjectURL(audioBlob);
    previewAudio = new Audio(url);
    previewAudio.addEventListener("ended", () => URL.revokeObjectURL(url));
    await previewAudio.play();
  } catch (e) {
    console.error("previewVoice failed:", e);
    alert("Voice preview failed: " + (e && e.message ? e.message : String(e)));
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = originalLabel; }
  }
}
function previewSettingsVoice(btn) {
  previewVoice(getEngine(), $("#voice").value, btn);
}
function previewQuickVoice(btn) {
  const engineId = $("#ttsEngineQuick").value || getEngine();
  const voice = $("#voiceQuick").value || getVoice();
  previewVoice(engineId, voice, btn);
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
    const grouping = currentCaptionGrouping();
    if (grouping === "karaoke") {
      previewKaraokeGroups = buildKaraokeGroups(words);
      subtitles = [];
    } else if (grouping === "word") {
      subtitles = buildWordCues(words);
      previewKaraokeGroups = null;
    } else {
      subtitles = buildSubsFromWords(words);
      previewKaraokeGroups = null;
    }
    if (!subtitles.length && !(previewKaraokeGroups && previewKaraokeGroups.length)) { alert("No caption timing produced."); btn.textContent = "Preview"; btn.disabled = false; return; }

    updateCaptionStyle();
    const vid = $("#videoPreview");
    vid.currentTime = 0; vid.muted = true; vid.loop = true;
    if (ttsAudio) { ttsAudio.pause(); if (ttsAudio.src) URL.revokeObjectURL(ttsAudio.src); ttsAudio.remove(); }
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

// Fetched once for the whole session, not once per ensureFFmpeg() call —
// each PoolWorker.ensureReady() already slices its own transferable copy
// out of these buffers (see worker-pool.js), so the originals here are
// never detached and stay safe to reuse across multiple pool (re)creations.
let captionFontsPromise = null;
function fetchCaptionFonts() {
  if (!captionFontsPromise) {
    captionFontsPromise = Promise.all(CAPTION_FONTS.map(async (f) => ({
      file: f.file, buf: await (await fetch(BASE + "vendor/fonts/" + f.file)).arrayBuffer(),
    }))).catch((e) => { captionFontsPromise = null; throw e; }); // allow a retry on transient failure
  }
  return captionFontsPromise;
}

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
    // Captions are burned in via drawtext, which needs exact font FILES
    // (there's no OS font store inside the WASM sandbox) — ship every
    // vendored caption font once here so each worker has all of them in its
    // virtual FS and can render whichever one a job actually selects.
    // Cached at module scope (see fetchCaptionFonts) since ensureFFmpeg()
    // can run more than once per session — raising batch parallelism mid-
    // session grows the pool, which used to re-fetch every font file from
    // scratch each time instead of reusing the first fetch's bytes.
    const fonts = await fetchCaptionFonts();
    ffmpegPool = new FFmpegWorkerPool(poolSize, base, fonts);
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
  if (useNativeRender()) return Promise.resolve();
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
      try { onProgress(JSON.parse(e.data)); } catch (err) { /* ignore malformed tick */ }
    };
  }
  try {
    const hasMusic = !!payload.music;
    const hasTitleCard = !!(payload.titleCard && payload.titleCard.imageBytes);
    // When runJob() has already uploaded these bytes via ensureAssetCached
    // (see hashAssetBytes/ensureAssetCached), the actual bg/music bytes are
    // omitted from this request entirely — the server already has them
    // cached by hash (server.js's BG_CACHE_DIR) and copies from there
    // instead of expecting a fresh upload, which is what avoids re-sending
    // the same background video N times across a batch that shares one.
    const bgCached = !!payload.bgCached;
    const musicCached = hasMusic && !!payload.musicCached;
    const meta = {
      subs: payload.subs, karaokeGroups: payload.karaokeGroups, style: payload.style,
      w: payload.w, h: payload.h, fps: payload.fps, bgW: payload.bgW, bgH: payload.bgH,
      musicVolume: payload.musicVolume, crf: payload.crf,
      hasMusic, hasTitleCard,
      titleCard: hasTitleCard
        ? { cardDurationSec: payload.titleCard.cardDurationSec, narrationDelaySec: payload.titleCard.narrationDelaySec }
        : null,
      bgHash: payload.bgHash || null, bgCached,
      bgLen: bgCached ? 0 : payload.bg.byteLength,
      audioLen: payload.audio.byteLength,
      musicHash: hasMusic ? (payload.musicHash || null) : null, musicCached,
      musicLen: hasMusic ? (musicCached ? 0 : payload.music.byteLength) : 0,
      titleCardImageLen: hasTitleCard ? payload.titleCard.imageBytes.byteLength : 0,
    };
    const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, metaBytes.byteLength, true);
    const parts = [header, metaBytes];
    if (!bgCached) parts.push(payload.bg);
    parts.push(payload.audio);
    if (hasMusic && !musicCached) parts.push(payload.music);
    if (hasTitleCard) parts.push(new Uint8Array(payload.titleCard.imageBytes));

    const resp = await fetch(`/render?id=${id}`, { method: "POST", body: new Blob(parts) });
    if (!resp.ok) {
      let msg = `Native render failed (${resp.status})`;
      try { const errJson = await resp.json(); if (errJson.error) msg = errJson.error; } catch (e) { /* non-JSON error body */ }
      throw new Error(msg);
    }
    const buf = await resp.arrayBuffer();
    if (onProgress) onProgress({ phase: "done", pct: 100 });
    return new Uint8Array(buf);
  } finally {
    if (es) es.close();
  }
}

// Renders one job's video — via the local native backend when available,
// falling back to the ffmpeg.wasm worker pool otherwise. Resolves to a
// Uint8Array of the MP4 either way, so callers don't need to know which path ran.
function renderVideoInWorker(payload, onProgress) {
  if (useNativeRender()) return renderVideoNatively(payload, onProgress);
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
async function transcribeNatively(audioBlob, onProgress) {
  const id = crypto.randomUUID();
  const model = $("#whisperModel") ? $("#whisperModel").value : "tiny.en";
  // server.js's runNativeTranscribe already calls sendProgress(id, 10) at
  // start and sendProgress(id, 90) near the end — nothing on the client
  // ever listened for it, so the whole native-Whisper round trip (which can
  // genuinely take minutes for a long story) showed a completely frozen
  // "Generating voice..." with zero feedback, indistinguishable from a real
  // hang. Opened before the POST, same ordering constraint as
  // renderVideoNatively's SSE connection, so no tick can race ahead of it.
  let es = null;
  if (onProgress) {
    es = new EventSource(`/transcribe-progress/${id}`);
    es.onmessage = (e) => {
      try { onProgress(JSON.parse(e.data)); } catch (err) { /* ignore malformed tick */ }
    };
  }
  try {
    // Bounds the wait against a hung whisper subprocess (server.js kills it
    // after 10 minutes) — without this, a stuck transcription blocked the
    // entire job (and everything showing "Generating voice...", since this
    // runs inside generateSpeech()) with no recovery. Slightly longer than
    // the server's own kill timeout so its error response has a chance to
    // arrive instead of racing it.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 11 * 60 * 1000);
    const resp = await fetch(`/transcribe?id=${id}&model=${encodeURIComponent(model)}`, {
      method: "POST", body: audioBlob, signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data && data.words && data.words.length) ? data.words : null;
  } catch (e) {
    return null;
  } finally {
    // EventSource auto-reconnects by default when its connection drops —
    // once the server ends the response (respond() -> closeProgressChannel),
    // an un-closed EventSource here would keep retrying that same id
    // forever even though the channel is already gone server-side.
    if (es) es.close();
  }
}

// `parseInt(x) || default` / `parseFloat(x) || default` silently replace a
// legitimate 0 (no stroke, no shadow offset, top-of-frame positionY) with
// the fallback, since 0 is falsy — Number.isFinite() correctly distinguishes
// "parsed to a real 0" from "didn't parse" (NaN). Used for every numeric
// caption-style field below and in runJob()/runDebugTestRender()'s style
// blocks, which have the same pattern.
function numOr(raw, parseFn, fallback) {
  const n = parseFn(raw);
  return Number.isFinite(n) ? n : fallback;
}

// Builds the caption `style` payload sent to the render backend (native or
// WASM) — shared by runJob() and runDebugTestRender(), which previously
// each hand-rolled an identical ~15-line copy of this object (one reading
// from a resolved per-job `settings`, the other from the raw
// `globalSettings` snapshot — same field names either way).
function buildCaptionStyle(settings, captionFont, grouping) {
  return {
    fontFile: captionFont.file,
    fontSize: numOr(settings.fontSize, parseInt, 68),
    textColor: settings.textColor,
    strokeColor: settings.strokeColor,
    strokeWidth: numOr(settings.strokeWidth, parseInt, 3),
    positionY: numOr(settings.positionY, parseFloat, 0.55),
    captionGrouping: grouping,
    uppercase: !!settings.captionUppercase,
    highlightColor: settings.highlightColor || "yellow",
    box: !!settings.captionBox,
    boxColor: settings.boxColor || "black",
    boxAlpha: numOr(settings.boxAlpha, parseFloat, 0.5),
    boxBorderW: numOr(settings.boxBorderW, parseInt, 16),
    shadow: !!settings.captionShadow,
    shadowColor: settings.shadowColor || "black",
    shadowX: numOr(settings.shadowX, parseInt, 2),
    shadowY: numOr(settings.shadowY, parseInt, 2),
    entrance: settings.captionEntrance || "none",
  };
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
    fontSize: numOr($("#fontSize").value, parseInt, 68),
    positionY: numOr($("#positionY").value, parseFloat, 0.55),
    textColor: $("#textColor").value,
    strokeColor: $("#strokeColor").value,
    strokeWidth: numOr($("#strokeWidth").value, parseInt, 3),
    captionPreset: $("#captionPreset").value || "word",
    captionUppercase: $("#captionUppercase").checked,
    highlightColor: $("#highlightColor").value || "yellow",
    captionBox: $("#captionBox").checked,
    boxColor: $("#boxColor").value || "black",
    boxAlpha: numOr($("#boxAlpha").value, parseFloat, 0.5),
    boxBorderW: numOr($("#boxBorderW").value, parseInt, 16),
    captionShadow: $("#captionShadow").checked,
    shadowColor: $("#shadowColor").value || "black",
    shadowX: numOr($("#shadowX").value, parseInt, 2),
    shadowY: numOr($("#shadowY").value, parseInt, 2),
    captionEntrance: $("#captionEntrance").value || "none",
    channelName: $("#channelName").value.trim() || "Anonymous",
    ttsEngine: getEngine(),
    encodingQuality: $("#encodingQuality").value || "balanced",
  };
}

// API-key/config bundle a TTS engine's generate() needs, per-engine. Kept
// fully separate from the story-gen #apiKey/#provider fields — a user might
// use DeepSeek for stories and OpenAI for narration at the same time.
function getEngineConfig(engineId) {
  if (engineId === "openaiTts") {
    const key = $("#ttsOpenaiKey").value.trim();
    if (!key) { alert("Enter an OpenAI API key in Settings → Narration Voice first."); return null; }
    return { apiKey: key, model: $("#openaiTtsModel").value || "tts-1", speed: parseFloat($("#openaiTtsSpeed").value) || 1 };
  }
  if (engineId === "elevenlabs") {
    const key = $("#ttsElevenlabsKey").value.trim();
    if (!key) { alert("Enter an ElevenLabs API key in Settings → Narration Voice first."); return null; }
    return {
      apiKey: key, modelId: $("#elevenlabsModel").value || "eleven_multilingual_v2",
      // Every sibling numeric field in this function falls back on a parse
      // failure — these two didn't, so a cleared/empty slider input sent a
      // literal NaN straight into the ElevenLabs request body.
      stability: numOr($("#elevenlabsStability").value, parseFloat, 0.5),
      similarityBoost: numOr($("#elevenlabsSimilarity").value, parseFloat, 0.75),
    };
  }
  // Piper's speed is read directly from #piperSpeed by ensurePiper()'s
  // voiceProvider closure (see applyPiperSpeed()) rather than through this
  // config bundle — returned here anyway so every engine's config shape
  // stays consistent/self-documenting rather than Piper being a silent
  // special case.
  if (engineId === "piper") return { speed: parseFloat($("#piperSpeed").value) || 1 };
  if (engineId === "kokoro") return { speed: parseFloat($("#kokoroSpeed").value) || 1 };
  if (engineId === "browserSpeech") {
    return { rate: parseFloat($("#browserSpeechRate").value) || 1, pitch: parseFloat($("#browserSpeechPitch").value) || 1 };
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
  $("#piperSpeedRow").style.display = engineId === "piper" ? "" : "none";
  $("#kokoroSpeedRow").style.display = engineId === "kokoro" ? "" : "none";
  $("#openaiTtsExtraRow").style.display = engineId === "openaiTts" ? "" : "none";
  $("#elevenlabsExtraRow").style.display = engineId === "elevenlabs" ? "" : "none";
  $("#browserSpeechExtraRow").style.display = engineId === "browserSpeech" ? "" : "none";
  const notes = {
    piper: "Runs fully offline in your browser. Free, no API key.",
    kokoro: "Runs fully offline in your browser, higher quality than Piper. Free, no API key — model is bundled, no download needed.",
    openaiTts: "Cloud API — costs money per character generated.",
    elevenlabs: "Cloud API — free tier (~10k characters/month, requires attribution, no commercial use) then paid.",
    browserSpeech: "Uses your OS's built-in voices. Needs a one-time \"share tab audio\" permission prompt to record narration — less reliable in Firefox than Chrome, and quality varies a lot by OS.",
    pocketTts: nativePocketTtsAvailable
      ? "Runs locally via a small CPU-only Python process. Free, no API key. \"Voice\" is really language — each picks Kyutai's built-in voice for that language."
      : "Not available — needs uv installed (https://docs.astral.sh/uv/) so `uvx pocket-tts` works, then restart the server.",
  };
  $("#engineNote").textContent = notes[engineId] || "";
  await populateVoices(engineId);
}

// Runs one job end-to-end: transcode (if needed) -> voice -> render. Mutates
// `job` in place and calls onUpdate(job) after every state change instead of
// touching the DOM directly, so this is equally usable from the single-video
// sidebar (a "batch of one") and the batch composer. Never throws — check
// job.status/job.error after it resolves.
// Memoizes the decoded background-video bytes per File object — when a
// batch shares one background across many jobs (bulk-generate's "same video
// for all", or the numbered picker cycling through fewer picks than the
// story count), every job holds the exact same File reference, so this
// avoids re-reading/re-decoding identical bytes once per job.
const bgBufferCache = new WeakMap(); // File -> Promise<Uint8Array>
// Same memoization for music — a "same music for all" bulk batch shares one
// File the same way background videos do, but this had no equivalent cache
// before, so every job re-decoded the identical music bytes from scratch.
const musicBufferCache = new WeakMap(); // File -> Promise<Uint8Array>
function readMusicFileBytes(file) {
  let p = musicBufferCache.get(file);
  if (!p) {
    p = file.arrayBuffer().then(b => new Uint8Array(b));
    musicBufferCache.set(file, p);
  }
  return p;
}
function readBgFileBytes(file) {
  let p = bgBufferCache.get(file);
  if (!p) {
    p = file.arrayBuffer().then(b => new Uint8Array(b));
    bgBufferCache.set(file, p);
  }
  return p;
}

// Server-side counterpart: server.js's BG_CACHE_DIR + POST /cache-asset. A
// batch sharing one background (or music track) across many jobs only needs
// to upload it once — every other job just references the hash. Hashing is
// fast/hardware-accelerated via Web Crypto (already available since this
// app requires a secure/cross-origin-isolated context anyway).
async function hashAssetBytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// File -> Promise<string> (SHA-256 hex). readBgFileBytes above already
// memoizes the *decode* of a shared File across a batch — this does the
// same for the hash computed from those bytes, since hashAssetBytes() takes
// raw bytes (not a File) and has no memoization of its own. Without this, a
// 100MB background shared across a 20-job batch re-hashed the full buffer
// once per job instead of once total.
const assetHashCache = new WeakMap();
function hashFileBytesCached(file, bytes) {
  let p = assetHashCache.get(file);
  if (!p) {
    p = hashAssetBytes(bytes);
    assetHashCache.set(file, p);
  }
  return p;
}

// One upload attempt per hash, ever, for the life of the page session —
// concurrent jobs sharing a hash (batch jobs run concurrently) all await the
// SAME promise instead of racing into duplicate uploads. Native-render only;
// the WASM path never uploads anywhere, so it has nothing to dedupe.
const assetUploadPromises = new Map(); // hash -> Promise<void>
function ensureAssetCached(hash, bytes) {
  let p = assetUploadPromises.get(hash);
  if (!p) {
    p = fetch(`/cache-asset?hash=${hash}`, { method: "POST", body: new Blob([bytes]) })
      .then(resp => { if (!resp.ok) throw new Error("Failed to cache asset (" + resp.status + ")"); });
    assetUploadPromises.set(hash, p);
  }
  return p;
}

// Turns one render-progress tick into a patch for the job. The native
// backend (server.js's runNativeRender) reports a rich object — phase plus
// whatever ffmpeg's own `-progress` output included that tick (fps/speed/
// bitrate/frame, thread budget, queue depth); the WASM fallback only ever
// reports a bare percentage number, so that shape is normalized separately
// rather than pretending it carries the same detail.
function describeRenderProgress(data) {
  if (typeof data === "number") return { progressPct: data, progressLabel: "Rendering..." };
  const { phase, pct, fps, speed, bitrate, frame, threads, activeRenders, renderSlots } = data;
  const patch = {};
  if (pct != null) patch.progressPct = pct;
  patch.renderFps = fps || null;
  patch.renderSpeed = speed || null;
  patch.renderBitrate = bitrate || null;
  patch.renderFrame = frame || null;
  patch.renderThreads = threads || null;
  patch.renderPhase = phase || null;
  if (phase === "queued") {
    patch.progressLabel = renderSlots
      ? `Waiting for a render slot (${activeRenders}/${renderSlots} busy)...`
      : "Waiting for a render slot...";
  } else if (phase === "starting") {
    patch.progressLabel = threads ? `Starting ffmpeg (${threads} threads)...` : "Starting ffmpeg...";
  } else if (phase === "encoding") {
    const details = [];
    if (speed) details.push(`${speed}x speed`);
    if (fps) details.push(`${Math.round(fps)} fps`);
    if (bitrate) details.push(bitrate);
    patch.progressLabel = "Rendering..." + (details.length ? ` (${details.join(", ")})` : "");
  } else if (phase === "done") {
    patch.progressLabel = "Finalizing...";
  } else {
    patch.progressLabel = "Rendering...";
  }
  return patch;
}

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

    const w = parseInt(settings.resW) || 1080;
    const h = parseInt(settings.resH) || 1920;
    const fps = parseInt(settings.fps) || 30;

    // Title-card image generation has zero data dependency on TTS output —
    // it only needs title/channelName/w/h, all already available — so it
    // runs concurrently with generateSpeech() instead of waiting for it.
    // Only the post-processing below (slicing narrationWords by how long
    // the title takes to say) actually needs `words`, once TTS resolves.
    const isAutoTitle = job.titleCardEnabled && !job.titleCardText;
    const titleText = job.titleCardEnabled
      ? (job.titleCardText || extractTitleFromStory(story) || "Untitled").trim()
      : null;

    update({ status: "voice", progressPct: 0, progressLabel: job.titleCardEnabled ? "Generating voice & title card..." : "Generating voice..." });
    const [{ audioUrl, words }, cardBlob] = await Promise.all([
      generateSpeech(story, settings.voice, settings.ttsEngine, (tick) => {
        // Native Whisper transcription (when it's the tier that ends up
        // running) can genuinely take minutes for a long story — without
        // this, "Generating voice & title card..." sat completely frozen
        // the whole time, indistinguishable from an actual hang.
        const pct = typeof tick === "number" ? tick : (tick && typeof tick.pct === "number" ? tick.pct : null);
        if (pct != null) update({ progressPct: pct, progressLabel: `Transcribing narration for captions... ${pct}%` });
      }),
      job.titleCardEnabled
        ? renderTitleCardImage({ title: titleText, channelName: globalSettings.channelName, w, h })
        : Promise.resolve(null),
    ]);

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

    // captionPreset holds the GROUPING mode: "word" = one bold word at a
    // time, "phrase" = grouped phrases (the original "classic" style),
    // "karaoke" = 2-3 words visible at once with the current one
    // highlighted. word/phrase both feed the same flat per-cue
    // drawtext+enable() render path; karaoke needs richer per-word group
    // data (section D/E) instead of flattened {start,end,text} subs.
    const grouping = resolveCaptionGrouping(settings.captionPreset);
    const captionFont = getCaptionFont(settings.font);
    let subs = null, karaokeGroups = null;
    if (grouping === "karaoke") {
      const groups = buildKaraokeGroups(narrationWords);
      for (const g of groups) {
        for (const w of g.words) w.text = sanitizeText(w.text);
      }
      await ensureCaptionFontLoaded(captionFont.cssFamily);
      applyKaraokeOffsets(groups, captionFont.cssFamily, parseInt(settings.fontSize) || 68);
      if (narrationDelaySec > 0) {
        for (const g of groups) {
          g.start += narrationDelaySec; g.end += narrationDelaySec;
          for (const w of g.words) { w.start += narrationDelaySec; w.end += narrationDelaySec; }
        }
      }
      karaokeGroups = groups;
    } else {
      const rawSubs = grouping === "phrase" ? buildSubsFromWords(narrationWords) : buildWordCues(narrationWords);
      subs = rawSubs.map(s => ({ start: s.start, end: s.end, text: sanitizeText(s.text) }));
      if (narrationDelaySec > 0) {
        for (const s of subs) { s.start += narrationDelaySec; s.end += narrationDelaySec; }
      }
    }

    let musicPayload = null;
    if (job.musicFile) {
      musicPayload = await readMusicFileBytes(job.musicFile);
    }

    update({ status: "render", progressPct: 30, progressLabel: "Rendering..." });
    const [bg, audioData] = await Promise.all([
      readBgFileBytes(bgFile),
      fetch(audioUrl).then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
    ]);
    // Bytes are now in audioData — the blob URL served its purpose and
    // would otherwise sit pinned in memory for the rest of the page's
    // session (every job in a batch leaked one of these).
    URL.revokeObjectURL(audioUrl);

    // Content-hash dedup (native only — see hashAssetBytes/ensureAssetCached
    // above): when a batch shares a background/music file across jobs, only
    // the first job for a given hash actually uploads the bytes to
    // /cache-asset — every other job's ensureAssetCached() call just awaits
    // that same in-flight upload instead of starting a new one. Either way,
    // once it resolves the server is guaranteed to have the asset cached, so
    // every job's own /render payload always references it by hash and
    // omits the raw bytes — no "am I the first uploader" branching needed.
    let bgHash = null, bgCached = false, musicHash = null, musicCached = false;
    if (useNativeRender()) {
      // Independent assets (different hashes, different upload requests) —
      // run their hash+cache round trips concurrently instead of the
      // background finishing entirely before the music one even starts.
      const [bgResult, musicResult] = await Promise.all([
        (async () => {
          const hash = await hashFileBytesCached(bgFile, bg);
          await ensureAssetCached(hash, bg);
          return hash;
        })(),
        musicPayload
          ? (async () => {
              const hash = await hashFileBytesCached(job.musicFile, musicPayload);
              await ensureAssetCached(hash, musicPayload);
              return hash;
            })()
          : Promise.resolve(null),
      ]);
      bgHash = bgResult; bgCached = true;
      if (musicResult) { musicHash = musicResult; musicCached = true; }
    }

    const style = buildCaptionStyle(settings, captionFont, grouping);
    // Lets the worker skip the scale/crop filter entirely when the
    // background is already at the export resolution.
    const { w: bgW, h: bgH } = await probeVideoDimensions(bgFile);

    const outBytes = await renderVideoInWorker({
      type: "render",
      base: new URL("./", document.baseURI).href,
      bg, audio: audioData, subs, karaokeGroups, style, w, h, fps, bgW, bgH,
      music: musicPayload, musicVolume: job.musicVolume,
      titleCard: titleCardPayload,
      bgHash, bgCached, musicHash, musicCached,
      // CRF 0 (lossless) is a legitimate value in principle — `|| undefined`
      // would silently drop it if a future quality preset ever used it, the
      // same falsy-zero trap as the caption-style fields above.
      crf: CRF_BY_QUALITY[globalSettings.encodingQuality],
    }, (data) => update(describeRenderProgress(data)));

    const blob = new Blob([outBytes], { type: "video/mp4" });
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
  // Batch cards (in #resultsGrid, and the full-page batch progress panel's
  // own grid) show a short title so it's clear which job a card belongs to;
  // the single-flow's #outputContainer never has more than one live card at
  // a time, so it doesn't need one.
  const isBatchGrid = container.id === "resultsGrid" || container.id === "batchProgressGrid";
  const title = isBatchGrid
    ? `<div class="result-card-title">${escapeHtml((job.premise || job.story || "Untitled").slice(0, 60))}</div>`
    : "";
  if (job.status === "done") {
    div.innerHTML = title + `
      <div class="actions">
        <button data-action="preview">Preview</button>
        <button data-action="download">Download</button>
        <button data-action="copy">Copy Link</button>
      </div>
      <div class="publish-section" data-job-id="${job.id}"></div>`;
    div.querySelector('[data-action="preview"]').onclick = () => previewExported(job.resultUrl);
    div.querySelector('[data-action="download"]').onclick = () => downloadVideo(job.resultUrl, videoFilenameFor(job));
    div.querySelector('[data-action="copy"]').onclick = () => copyVideoLink(job.resultUrl);
    renderPublishSection(job, div.querySelector(".publish-section"));
    maybeAutoPublish(job, div.querySelector(".publish-section"));
  } else if (job.status === "error") {
    div.innerHTML = title +
      `<div class="result-error">${escapeHtml(job.error || "Export failed")}</div>` +
      (isBatchGrid ? `<button class="result-retry-btn" data-action="retry">Retry</button>` : "");
    const retryBtn = div.querySelector('[data-action="retry"]');
    if (retryBtn) retryBtn.onclick = () => retryBatchJob(job);
  } else {
    div.innerHTML = title + `
      <div class="result-status">${escapeHtml(job.progressLabel || job.status)}</div>
      <div class="progress-bar-track"><div class="progress-bar-fill" style="width:${job.progressPct || 0}%"></div></div>`;
  }
  return div;
}

// Per-job inline "Publish to YouTube" panel, appended into every finished
// result card by renderResultCard() above. Collapsed to a single button
// until clicked open, then an editable metadata form; becomes a progress
// bar during upload via the exact same status-subline/progress-bar shape
// renderResultCard already uses for render progress. Renders as nothing at
// all when the feature isn't usable (no server, or a server but no
// connected channel yet) — a browser-only/GitHub-Pages build and a fresh
// install both look exactly like they did before this feature existed.
function renderPublishSection(job, container) {
  if (!container) return;
  if (!youtubeAvailable) { container.innerHTML = ""; return; }
  const pub = job.publish;
  if (pub.status === "uploading") {
    container.innerHTML = `
      <div class="result-status">Uploading to YouTube... ${pub.uploadProgressPct || 0}%</div>
      <div class="progress-bar-track"><div class="progress-bar-fill" style="width:${pub.uploadProgressPct || 0}%"></div></div>`;
    return;
  }
  if (pub.status === "uploaded" || pub.status === "scheduled") {
    const link = pub.videoId ? `https://youtube.com/watch?v=${pub.videoId}` : null;
    container.innerHTML = `
      <div class="result-status" style="color:var(--green);">
        ${pub.status === "scheduled" ? "Scheduled" : "Uploaded"} to YouTube.
        ${link ? `<a href="${link}" target="_blank" rel="noopener">View</a>` : ""}
      </div>`;
    return;
  }
  if (pub.status === "failed") {
    container.innerHTML = `
      <div class="result-error">YouTube upload failed: ${escapeHtml(pub.error || "unknown error")}</div>
      <button data-action="publish-retry">Try Again</button>`;
    container.querySelector('[data-action="publish-retry"]').onclick = () => { pub.status = "none"; renderPublishSection(job, container); };
    return;
  }
  if (!youtubeAccountsCache.length) {
    container.innerHTML = `<p style="font-size:0.72rem;color:var(--muted);">Connect a YouTube channel in Settings → Publish to upload directly.</p>`;
    return;
  }
  if (!pub._panelOpen) {
    container.innerHTML = `<button data-action="publish-open">Publish to YouTube</button>`;
    container.querySelector('[data-action="publish-open"]').onclick = () => openPublishPanel(job, container);
    return;
  }
  if (pub._generating) {
    container.innerHTML = `<div class="result-status">Generating title/description/thumbnail from the story...</div>`;
    return;
  }
  container.innerHTML = `
    <div class="publish-form" style="border:1px solid var(--border);border-radius:6px;padding:8px;margin-top:6px;">
      <label>Channel</label>
      <select data-field="accountId">
        ${youtubeAccountsCache.map(a => `<option value="${a.id}" ${a.id === pub.accountId ? "selected" : ""}>${escapeHtml(a.channelTitle)}</option>`).join("")}
      </select>
      <label style="margin-top:6px;">Thumbnail</label>
      <div style="display:flex;gap:8px;align-items:flex-start;">
        <img src="${pub.thumbnailUrl || ""}" style="width:160px;aspect-ratio:16/9;object-fit:cover;border-radius:4px;background:var(--surface);border:1px solid var(--border);${pub.thumbnailUrl ? "" : "display:none;"}">
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button data-action="publish-regen-thumb">Regenerate Thumbnail</button>
          <button data-action="publish-upload-thumb">Upload Custom...</button>
          <input type="file" data-field="thumbnailFile" accept="image/jpeg,image/png" style="display:none;">
        </div>
      </div>
      <label style="margin-top:6px;">Title</label>
      <input type="text" data-field="title" value="${escapeHtml(pub.title || "")}" maxlength="100">
      <label style="margin-top:6px;">Description</label>
      <textarea data-field="description" rows="3">${escapeHtml(pub.description || "")}</textarea>
      <label style="margin-top:6px;">Tags <span style="color:var(--muted);font-weight:normal;">(comma-separated)</span></label>
      <input type="text" data-field="tags" value="${escapeHtml((pub.tags || []).join(", "))}">
      <div class="row" style="margin-top:6px;">
        <div style="flex:1;">
          <label>Privacy</label>
          <select data-field="privacyStatus">
            <option value="private" ${pub.privacyStatus === "private" ? "selected" : ""}>Private</option>
            <option value="unlisted" ${pub.privacyStatus === "unlisted" ? "selected" : ""}>Unlisted</option>
            <option value="public" ${pub.privacyStatus === "public" ? "selected" : ""}>Public</option>
          </select>
        </div>
        <div style="flex:1;">
          <label>Category</label>
          <select data-field="categoryId">
            ${YOUTUBE_CATEGORY_OPTIONS.map(c => `<option value="${c.id}" ${c.id === pub.categoryId ? "selected" : ""}>${c.label}</option>`).join("")}
          </select>
        </div>
      </div>
      <label style="margin-top:6px;">Schedule (optional — leave blank to publish at the privacy status above immediately)</label>
      <input type="datetime-local" data-field="scheduledAt" value="${pub.scheduledAt ? toLocalDatetimeInputValue(pub.scheduledAt) : ""}">
      <div class="row" style="margin-top:8px;">
        <button data-action="publish-regenerate">Regenerate Metadata</button>
        <button data-action="publish-cancel">Cancel</button>
        <button class="primary" data-action="publish-upload">Upload</button>
      </div>
    </div>`;
  container.querySelector('[data-field="accountId"]').onchange = (e) => { pub.accountId = e.target.value; };
  container.querySelector('[data-action="publish-regen-thumb"]').onclick = () => regeneratePublishThumbnail(job, container);
  container.querySelector('[data-action="publish-upload-thumb"]').onclick = () => container.querySelector('[data-field="thumbnailFile"]').click();
  container.querySelector('[data-field="thumbnailFile"]').onchange = (e) => {
    if (e.target.files && e.target.files[0]) setPublishCustomThumbnail(job, container, e.target.files[0]);
  };
  container.querySelector('[data-field="title"]').oninput = (e) => { pub.title = e.target.value; };
  container.querySelector('[data-field="description"]').oninput = (e) => { pub.description = e.target.value; };
  container.querySelector('[data-field="tags"]').oninput = (e) => { pub.tags = e.target.value.split(",").map(t => t.trim()).filter(Boolean); };
  container.querySelector('[data-field="privacyStatus"]').onchange = (e) => { pub.privacyStatus = e.target.value; };
  container.querySelector('[data-field="categoryId"]').onchange = (e) => { pub.categoryId = e.target.value; };
  container.querySelector('[data-field="scheduledAt"]').onchange = (e) => {
    pub.scheduledAt = e.target.value ? new Date(e.target.value).toISOString() : null;
  };
  container.querySelector('[data-action="publish-regenerate"]').onclick = () => generatePublishMetadata(job, container, true);
  container.querySelector('[data-action="publish-cancel"]').onclick = () => { pub._panelOpen = false; renderPublishSection(job, container); };
  container.querySelector('[data-action="publish-upload"]').onclick = () => uploadJobToYoutube(job, container);
}

const YOUTUBE_CATEGORY_OPTIONS = [
  { id: "24", label: "Entertainment" },
  { id: "22", label: "People & Blogs" },
  { id: "23", label: "Comedy" },
  { id: "26", label: "Howto & Style" },
  { id: "27", label: "Education" },
  { id: "1", label: "Film & Animation" },
];

// First open of the panel for a job: apply the Settings tab's default
// privacy/category once (a later re-open respects whatever the user already
// set on this job, since pub.privacyStatus/categoryId are no longer at
// their job-model defaults by then), pick a starting channel, then either
// auto-generate metadata or fall back to the old plain-extraction behavior.
function openPublishPanel(job, container) {
  const pub = job.publish;
  pub._panelOpen = true;
  if (pub.accountId == null) pub.accountId = youtubeAccountsCache[0].id;
  const defaultPrivacy = $("#youtubeDefaultPrivacy");
  const defaultCategory = $("#youtubeDefaultCategoryId");
  if (pub.privacyStatus === "private" && defaultPrivacy && defaultPrivacy.value) pub.privacyStatus = defaultPrivacy.value;
  if (pub.categoryId === "24" && defaultCategory && defaultCategory.value) pub.categoryId = defaultCategory.value;
  if (pub.title != null) { renderPublishSection(job, container); return; } // already generated/edited on a prior open
  generatePublishMetadata(job, container, false);
}

// Shared by openPublishPanel (first open) and the form's own "Regenerate"
// button — the only difference is whether there's already-edited text to
// discard, which the caller decides by whether it calls this at all.
async function generatePublishMetadata(job, container, forceRegenerate) {
  const pub = job.publish;
  const autoGenerate = $("#youtubeAutoGenerateMetadata") && $("#youtubeAutoGenerateMetadata").checked;
  pub._generating = true;
  renderPublishSection(job, container);
  if (!autoGenerate) {
    if (pub.title == null || forceRegenerate) pub.title = extractTitleFromStory(job.story) || "Untitled";
    if (pub.description == null || forceRegenerate) pub.description = "";
  } else {
    try {
      const meta = await generateYoutubeMetadata(job);
      pub.title = meta.title;
      pub.description = meta.description;
      pub.tags = meta.tags;
    } catch (e) {
      if (pub.title == null) pub.title = extractTitleFromStory(job.story) || "Untitled";
      if (pub.description == null) pub.description = "";
      showToast("Auto-generate failed (" + (e && e.message ? e.message : String(e)) + ") — using a plain title instead.");
    }
  }
  await generatePublishThumbnail(job, forceRegenerate);
  pub._generating = false;
  renderPublishSection(job, container);
}

// Only (re)renders a thumbnail when asked to — either there's none yet, or
// the caller explicitly wants a fresh one (a metadata regenerate, or the
// dedicated Regenerate Thumbnail button). Revokes the previous object URL
// first so repeated regeneration during one session doesn't leak blob URLs.
async function generatePublishThumbnail(job, force) {
  const pub = job.publish;
  if (pub.thumbnailBlob && !force) return;
  if (pub.thumbnailUrl) URL.revokeObjectURL(pub.thumbnailUrl);
  const channelName = $("#channelName").value.trim() || "Anonymous";
  const blob = await renderYoutubeThumbnailImage({ resultBlob: job.resultBlob, title: pub.title, channelName });
  pub.thumbnailBlob = blob;
  pub.thumbnailUrl = blob ? URL.createObjectURL(blob) : null;
}

async function regeneratePublishThumbnail(job, container) {
  const pub = job.publish;
  pub._generating = true;
  renderPublishSection(job, container);
  await generatePublishThumbnail(job, true);
  pub._generating = false;
  renderPublishSection(job, container);
}

function setPublishCustomThumbnail(job, container, file) {
  const pub = job.publish;
  if (pub.thumbnailUrl) URL.revokeObjectURL(pub.thumbnailUrl);
  pub.thumbnailBlob = file;
  pub.thumbnailUrl = URL.createObjectURL(file);
  renderPublishSection(job, container);
}

// {{placeholder}} substitution for the Settings → Publish title/description
// templates — deliberately the same {{name}} syntax as nothing else in this
// codebase (storySystemPrompt's override went the other way, hardcoding
// ${wc} outside the editable text specifically to avoid template syntax) —
// here the whole point IS a small template language, so it's the right
// tool this one time.
function substituteYoutubeTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => (vars[key] != null ? vars[key] : ""));
}

// Calls the story-gen LLM (same provider/model/key already configured in
// Settings -> Story, via the existing streamChat()) for a short JSON
// {title, description, tags} response, then composes it through the
// optional Settings -> Publish templates. Template and auto-generation are
// two stages of one pipeline, not separate modes — a blank template just
// means "use the AI text as-is".
async function generateYoutubeMetadata(job) {
  const system = "You write YouTube titles, descriptions, and tags for short narrated Reddit-story videos (AITAH/relationship-drama style). " +
    "Output ONLY a single JSON object with keys \"title\" (under 100 characters, punchy, no surrounding quotes), " +
    "\"description\" (2-4 sentences, no hashtags), and \"tags\" (an array of 5-10 short lowercase keyword strings). " +
    "No markdown, no code fences, no commentary outside the JSON.";
  const user = "Story:\n" + (job.story || "").slice(0, 3000);
  let raw = "";
  await streamChat(
    [{ role: "system", content: system }, { role: "user", content: user }],
    (chunk) => { raw += chunk; }
  );
  let parsed;
  try {
    // A model that ignores "no code fences" still sometimes wraps its
    // output in one — strip it before parsing rather than failing outright.
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error("couldn't parse the AI's response as JSON");
  }
  const aiTitle = typeof parsed.title === "string" ? parsed.title.trim() : "";
  const aiDescription = typeof parsed.description === "string" ? parsed.description.trim() : "";
  const aiTags = Array.isArray(parsed.tags) ? parsed.tags.filter(t => typeof t === "string").map(t => t.trim()).filter(Boolean).slice(0, 15) : [];
  if (!aiTitle) throw new Error("the AI didn't return a title");

  const vars = {
    aiTitle, aiDescription, aiTags: aiTags.join(", "),
    premise: job.premise || "", channelName: $("#channelName").value.trim() || "Anonymous",
  };
  const titleTemplate = $("#youtubeTitleTemplate").value.trim();
  const descTemplate = $("#youtubeDescriptionTemplate").value.trim();
  return {
    title: (titleTemplate ? substituteYoutubeTemplate(titleTemplate, vars) : aiTitle).slice(0, 100),
    description: descTemplate ? substituteYoutubeTemplate(descTemplate, vars) : aiDescription,
    tags: aiTags,
  };
}

// YouTube thumbnails are 1280x720 (16:9) — this app's actual output is
// 1080x1920 (9:16), so cover-fit cropping a mid-point frame the same way
// generateVideoThumbnail() does for the 180x320 Media Library thumbnails
// crops off most of the frame's top/bottom, not letterboxes it. That's a
// real, visible tradeoff (the thumbnail shows a cropped middle strip of the
// vertical video), not a bug — letterboxing a not-actually-widescreen
// source looks worse for a thumbnail than a tight crop does. Same timeout-
// guarded settle-once pattern as generateVideoThumbnail for the same
// reason: a corrupt blob or an unfired "seeked" event must not hang the
// publish panel's "Generating thumbnail..." state forever.
function renderYoutubeThumbnailImage({ resultBlob, title, channelName }) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    const url = URL.createObjectURL(resultBlob);
    let settled = false;
    const cleanup = () => URL.revokeObjectURL(url);
    const settle = (value) => { if (settled) return; settled = true; clearTimeout(timer); cleanup(); resolve(value); };
    const timer = setTimeout(() => settle(null), 8000);
    video.addEventListener("loadedmetadata", () => {
      video.currentTime = (video.duration || 1) / 2;
    });
    video.addEventListener("seeked", () => {
      try {
        const W = 1280, H = 720;
        const canvas = document.createElement("canvas");
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext("2d");
        const vw = video.videoWidth || W, vh = video.videoHeight || H;
        const scale = Math.max(W / vw, H / vh);
        const dw = vw * scale, dh = vh * scale;
        ctx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);

        // A bottom gradient so white title text stays legible over an
        // arbitrary, unpredictable video frame — same reasoning as a caption
        // box/shadow, just baked into the thumbnail instead of configurable.
        const grad = ctx.createLinearGradient(0, H * 0.45, 0, H);
        grad.addColorStop(0, "rgba(0,0,0,0)");
        grad.addColorStop(1, "rgba(0,0,0,0.75)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, H * 0.45, W, H * 0.55);

        const pad = Math.round(W * 0.05);
        const maxTitleFontSize = 64, minTitleFontSize = 32;
        const titleText = title || "Untitled";
        const titleFontSize = shrinkFontToFit(maxTitleFontSize, minTitleFontSize, (size) => {
          ctx.font = `800 ${size}px sans-serif`;
          const lines = wrapCanvasText(ctx, titleText, W - pad * 2);
          return lines.length <= 3;
        });
        ctx.font = `800 ${titleFontSize}px sans-serif`;
        const lines = wrapCanvasText(ctx, titleText, W - pad * 2).slice(0, 3);
        const lineHeight = titleFontSize * 1.2;
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.lineWidth = Math.max(2, titleFontSize * 0.06);
        ctx.textBaseline = "alphabetic";
        let y = H - pad - (lines.length - 1) * lineHeight;
        for (const line of lines) {
          ctx.strokeText(line, pad, y);
          ctx.fillText(line, pad, y);
          y += lineHeight;
        }

        if (channelName) {
          ctx.font = "600 22px sans-serif";
          ctx.fillStyle = "rgba(255,255,255,0.85)";
          ctx.fillText(channelName, pad, pad + 22);
        }

        canvas.toBlob((blob) => settle(blob), "image/png");
      } catch (e) {
        settle(null);
      }
    });
    video.addEventListener("error", () => settle(null));
    video.src = url;
  });
}

function toLocalDatetimeInputValue(isoString) {
  const d = new Date(isoString);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// POSTs the finished job's video (raw bytes, same length-prefixed-JSON-
// header framing convention as renderVideoNatively's /render frame) to
// server.js, which does the actual resumable upload to YouTube — an
// EventSource on /youtube-upload-progress/:id (opened before the POST, same
// ordering constraint as every other id-correlated SSE channel in this app)
// drives the progress bar renderPublishSection shows while status is
// "uploading".
async function uploadJobToYoutube(job, container) {
  const pub = job.publish;
  if (!job.resultBlob) { alert("No finished video to upload."); return; }
  if (!pub.title || !pub.title.trim()) { alert("Enter a title first."); return; }
  pub.status = "uploading";
  pub.uploadProgressPct = 0;
  renderPublishSection(job, container);

  const id = crypto.randomUUID();
  let es = null;
  try {
    es = new EventSource(`/youtube-upload-progress/${id}`);
    es.onmessage = (e) => {
      try {
        const tick = JSON.parse(e.data);
        if (typeof tick.pct === "number") pub.uploadProgressPct = tick.pct;
        renderPublishSection(job, container);
      } catch (err) { /* ignore malformed tick */ }
    };

    const videoBytes = new Uint8Array(await job.resultBlob.arrayBuffer());
    const thumbnailBytes = pub.thumbnailBlob ? new Uint8Array(await pub.thumbnailBlob.arrayBuffer()) : null;
    const meta = {
      accountId: pub.accountId,
      title: pub.title,
      description: pub.description || "",
      tags: pub.tags || [],
      categoryId: pub.categoryId || "24",
      privacyStatus: pub.privacyStatus,
      scheduledAt: pub.scheduledAt,
      hasThumbnail: !!thumbnailBytes,
      videoLen: videoBytes.length,
      thumbnailLen: thumbnailBytes ? thumbnailBytes.length : 0,
      // A Regenerate always produces image/png (our own canvas.toBlob call);
      // a custom "Upload Custom..." File carries its own real type (jpeg is
      // common) — YouTube's thumbnails.set needs the Content-Type to match
      // the actual bytes, so this can't just be hardcoded to png.
      thumbnailMimeType: pub.thumbnailBlob ? (pub.thumbnailBlob.type || "image/png") : null,
    };
    const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, metaBytes.length, true);
    const frame = thumbnailBytes
      ? new Blob([header, metaBytes, videoBytes, thumbnailBytes])
      : new Blob([header, metaBytes, videoBytes]);

    const resp = await fetch(`/youtube-upload?id=${id}`, { method: "POST", body: frame });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Upload failed.");
    pub.status = data.status === "scheduled" ? "scheduled" : "uploaded";
    pub.videoId = data.videoId;
    pub.uploadProgressPct = 100;
    refreshYoutubeQuotaText();
  } catch (e) {
    pub.status = "failed";
    pub.error = e && e.message ? e.message : String(e);
  } finally {
    if (es) es.close();
    renderPublishSection(job, container);
  }
}

// Fires once per job, right after its card first renders as "done" — the
// same generate-then-upload sequence the manual "Publish to YouTube" button
// kicks off, just started automatically instead of waiting for a click.
// _autoUploadAttempted guards against renderResultCard() being called again
// later for the same already-done job (e.g. a stray re-render) re-firing
// this — pub.status !== "none" alone isn't enough, since a manual click
// racing this exact render would also have already moved status off
// "none" by the time a second render happened.
function maybeAutoPublish(job, container) {
  const pub = job.publish;
  if (pub._autoUploadAttempted) return;
  if (!youtubeAvailable) return;
  const toggle = $("#youtubeAutoUpload");
  if (!toggle || !toggle.checked) return;
  if (!youtubeAccountsCache.length) return;
  if (pub.status !== "none") return;
  pub._autoUploadAttempted = true;
  pub._panelOpen = true; // so renderPublishSection shows generating/upload progress instead of a bare "Publish" button
  const preferredId = $("#youtubeAutoUploadAccountId") ? $("#youtubeAutoUploadAccountId").value : "";
  const account = youtubeAccountsCache.find(a => a.id === preferredId) || youtubeAccountsCache[0];
  pub.accountId = account.id;
  const defaultPrivacy = $("#youtubeDefaultPrivacy");
  const defaultCategory = $("#youtubeDefaultCategoryId");
  if (defaultPrivacy && defaultPrivacy.value) pub.privacyStatus = defaultPrivacy.value;
  if (defaultCategory && defaultCategory.value) pub.categoryId = defaultCategory.value;
  (async () => {
    await generatePublishMetadata(job, container, false);
    await uploadJobToYoutube(job, container);
  })();
}

// "Publish All" on the batch progress panel — same per-job pipeline as
// maybeAutoPublish/the manual button, just fired for every eligible job in
// the batch at once instead of one at a time. Runs concurrently (no
// sequential await-in-loop) since youtubeUploadLimiter on the server side
// already caps real concurrent uploads to 2 — this just queues all of them
// rather than needlessly serializing the client-side metadata/thumbnail
// generation too.
async function publishAllBatch() {
  if (!batchProgressState) return;
  const eligible = batchProgressState.jobs.filter(j => j.status === "done" && j.publish.status === "none");
  if (!eligible.length) { showToast("Nothing left to publish."); return; }
  if (!youtubeAccountsCache.length) { showToast("Connect a YouTube channel in Settings → Publish first."); return; }
  const btn = $("#batchPublishAllBtn");
  if (btn) { btn.disabled = true; btn.textContent = `Publishing ${eligible.length}...`; }
  await Promise.all(eligible.map(job => {
    const container = $("#batchProgressGrid").querySelector(`[data-job-id="${job.id}"] .publish-section`);
    if (!container) return Promise.resolve();
    const pub = job.publish;
    pub._autoUploadAttempted = true;
    pub._panelOpen = true;
    const preferredId = $("#youtubeAutoUploadAccountId") ? $("#youtubeAutoUploadAccountId").value : "";
    const account = youtubeAccountsCache.find(a => a.id === preferredId) || youtubeAccountsCache[0];
    pub.accountId = account.id;
    const defaultPrivacy = $("#youtubeDefaultPrivacy");
    const defaultCategory = $("#youtubeDefaultCategoryId");
    if (defaultPrivacy && defaultPrivacy.value) pub.privacyStatus = defaultPrivacy.value;
    if (defaultCategory && defaultCategory.value) pub.categoryId = defaultCategory.value;
    return generatePublishMetadata(job, container, false).then(() => uploadJobToYoutube(job, container));
  }));
  if (btn) { btn.textContent = "Publish All to YouTube"; btn.disabled = false; }
  updateBatchProgressStats();
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
function videoFilenameFor(job) {
  const slug = (job && (job.premise || job.story) || "aitah-story")
    .slice(0, 50).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (slug || "aitah-story") + ".mp4";
}
async function downloadVideo(url, filename) {
  if (!url) { alert("Nothing to download yet."); return; }
  filename = filename || "aitah-story.mp4";
  const outputFolder = $("#outputFolder") ? $("#outputFolder").value : "";
  if (window.electronAPI && window.electronAPI.isElectron && outputFolder) {
    try {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const result = await window.electronAPI.saveVideoFile(bytes, outputFolder, filename);
      if (result.ok) { showToast("Saved to " + result.path); return; }
      alert("Couldn't save to " + outputFolder + ": " + result.error);
    } catch (e) {
      alert("Couldn't save video: " + (e && e.message ? e.message : String(e)));
    }
    return;
  }
  const a = document.createElement("a");
  a.href = url; a.download = filename;
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
const CHANNEL_PROFILE_PIC_KEY = "slopdaddy_channelProfilePic";
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
// Greedy word-wrap into as many lines as needed to stay within maxWidth. A
// single word wider than maxWidth on its own (no spaces to break on — a long
// URL-like title, or a channel name with no spaces) is force-broken
// character by character instead of being left to overflow, so the result
// is always guaranteed to fit horizontally regardless of what shrinkFontToFit
// below settles on.
function wrapCanvasText(ctx, text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const w of words) {
    if (ctx.measureText(w).width > maxWidth) {
      if (current) { lines.push(current); current = ""; }
      let chunk = "";
      for (const ch of w) {
        const test = chunk + ch;
        if (chunk && ctx.measureText(test).width > maxWidth) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk = test;
        }
      }
      current = chunk;
      continue;
    }
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

// Shrinks fontSize (in integer px steps) until `measure(fontSize)` reports
// true, or a floor is hit — the shared mechanism behind both the channel
// name and the title text's shrink-to-fit behavior. `measure` sets
// ctx.font itself (since what "fits" differs — a single fillText width for
// the name, vs. re-wrapping into lines and checking overall card height for
// the title) and returns whether the current fontSize fits.
function shrinkFontToFit(fontSize, minFontSize, measure) {
  while (fontSize > minFontSize && !measure(fontSize)) {
    fontSize -= 1;
  }
  return fontSize;
}

// Last-resort fallback for the channel name once it's already at the
// smallest allowed font: unlike the title, a name can't wrap onto more
// lines (it sits on one line next to the avatar), so a single long/
// space-less name (no word boundaries for wrapCanvasText to break on)
// that still doesn't fit at the font floor gets truncated with an ellipsis
// instead — guarantees it never overflows the card regardless of input.
// ctx.font must already be set to the size this should measure against.
function truncateToFit(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 1 && ctx.measureText(truncated + "…").width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + "…";
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

// ---------- Karaoke caption layout ----------
// The actual ffmpeg render can't lay out multiple words itself — each
// drawtext instance draws one independently-positioned string, with no
// built-in multi-run text flow — so karaoke mode's per-word x positions are
// measured once client-side (same off-screen-canvas technique already used
// for title-card text fitting above) using the exact font/size that will
// actually render, then baked into each word as `xOffset` (signed pixels
// from the group's horizontal center) before the cues ever reach
// buildKaraokeCues()/buildDrawtextFilterChain(). Requires the matching
// @font-face to have already loaded (see ensureCaptionFontLoaded) — until
// then, canvas measureText silently falls back to a generic font and the
// offsets would be wrong for whatever the real render actually uses.
function measureWordOffsets(ctx, words, fontSizePx) {
  const gap = fontSizePx * 0.35;
  const widths = words.map(w => ctx.measureText(w.text).width);
  const totalWidth = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, words.length - 1);
  let x = -totalWidth / 2;
  return widths.map((width) => {
    const offset = x + width / 2;
    x += width + gap;
    return offset;
  });
}
// Mutates each group's words in place with a computed xOffset — called once
// per karaoke render right before building cues. One canvas/context is
// created and reused across every group instead of one per group, since the
// font/size is identical for the whole render.
function applyKaraokeOffsets(groups, cssFontFamily, fontSizePx) {
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = `${fontSizePx}px ${cssFontFamily}`;
  for (const g of groups) {
    const offsets = measureWordOffsets(ctx, g.words, fontSizePx);
    g.words.forEach((w, i) => { w.xOffset = offsets[i]; });
  }
  return groups;
}
// Waits for a specific @font-face to actually be loaded/usable — canvas
// measureText() and CSS font-family both silently fall back to a generic
// font until this resolves, which would desync karaoke's x-offsets from
// what ffmpeg actually renders with the real TTF file.
async function ensureCaptionFontLoaded(cssFontFamily) {
  try {
    await document.fonts.load(`16px ${cssFontFamily}`);
    await document.fonts.ready;
  } catch (e) { /* best-effort — worst case measureText uses a fallback font */ }
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
  const maxTitleFontSize = Math.round(cardW * 0.075);
  const minTitleFontSize = Math.max(12, Math.round(cardW * 0.03));
  const maxNameFontSize = Math.round(avatarSize * 0.4);
  const minNameFontSize = Math.max(10, Math.round(avatarSize * 0.18));

  const headerH = avatarSize + pad * 0.8;
  const footerH = Math.round(cardW * 0.09);
  // The card grows to fit however many lines the title wraps into, but not
  // without limit — past this height it'd dominate (or overflow) the frame,
  // so a long title shrinks its font instead of an ever-taller card.
  const maxCardH = h * 0.62;

  // Shrink the title's font (re-wrapping at each candidate size, since a
  // smaller font both narrows each line and changes how many lines result)
  // until the resulting card height fits, or the floor is hit.
  const titleFontSize = shrinkFontToFit(maxTitleFontSize, minTitleFontSize, (size) => {
    ctx.font = `bold ${size}px sans-serif`;
    const lines = wrapCanvasText(ctx, title || "Untitled", cardW - pad * 2);
    const cardH = pad * 2.4 + headerH + lines.length * (size * 1.28) + footerH;
    return cardH <= maxCardH;
  });
  ctx.font = `bold ${titleFontSize}px sans-serif`;
  let titleLines = wrapCanvasText(ctx, title || "Untitled", cardW - pad * 2);
  const titleLineHeight = titleFontSize * 1.28;

  // Genuine last resort: even at the font floor, a pathologically long
  // title (e.g. a story pasted with no line breaks, so the "first line"
  // extractTitleFromStory grabs is the entire story) can still overflow.
  // Drop trailing words until it fits rather than letting the card overflow
  // the frame — mirrors truncateToFit's same "shrink first, truncate only
  // if shrinking alone can't fit" pattern used for the channel name below.
  if (pad * 2.4 + headerH + titleLines.length * titleLineHeight + footerH > maxCardH) {
    let words = (title || "Untitled").split(/\s+/);
    while (words.length > 1) {
      words = words.slice(0, -1);
      const candidateLines = wrapCanvasText(ctx, words.join(" ") + "…", cardW - pad * 2);
      if (pad * 2.4 + headerH + candidateLines.length * titleLineHeight + footerH <= maxCardH) {
        titleLines = candidateLines;
        break;
      }
      titleLines = candidateLines; // keep shrinking even if not there yet
    }
  }

  const titleH = titleLines.length * titleLineHeight;
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
      // A corrupted/malformed saved data URL can fail to fire EITHER
      // onload or onerror in some browsers, leaving this Promise (and thus
      // the Promise.all it's part of in runJob — the whole "Generating
      // voice & title card..." step) hanging forever with no way to
      // recover short of reloading the page. This is the same class of
      // hang generateVideoThumbnail() was fixed for earlier — a timeout
      // that falls back to the placeholder instead of blocking the job.
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        const timer = setTimeout(() => reject(new Error("avatar image load timed out")), 5000);
        im.onload = () => { clearTimeout(timer); resolve(im); };
        im.onerror = () => { clearTimeout(timer); reject(new Error("bad avatar image")); };
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

  // Channel name + verified badge. Available width is reserved using the
  // badge size at the LARGEST possible name font (maxNameFontSize) — a safe
  // upper-bound reservation, since the actual badge only ever shrinks along
  // with a shrunk name font, never grows past it.
  const nameX = avatarX + avatarSize + pad * 0.6;
  const nameY = avatarY + avatarSize / 2;
  const name = channelName || "Anonymous";
  const badgeReserve = maxNameFontSize * 1.3;
  const nameMaxWidth = (cardX + cardW - pad) - nameX - badgeReserve;
  const nameFontSize = shrinkFontToFit(maxNameFontSize, minNameFontSize, (size) => {
    ctx.font = `bold ${size}px sans-serif`;
    return ctx.measureText(name).width <= nameMaxWidth;
  });
  ctx.fillStyle = "#0f1419";
  ctx.font = `bold ${nameFontSize}px sans-serif`;
  ctx.textBaseline = "middle";
  const displayName = truncateToFit(ctx, name, nameMaxWidth);
  ctx.fillText(displayName, nameX, nameY);
  const nameW = ctx.measureText(displayName).width;
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
// 350 chars is generous — real single-sentence AITAH titles top out well
// under that (verified live up to ~300 chars renders fine) — but it's a
// real cap, not just cosmetic: if the model ever skips the blank line after
// the title (it doesn't always follow formatting instructions), this
// "first line" becomes the entire story with no cap at all, and rendering
// a many-hundred-word title card measurably blocks the main thread
// (confirmed live: ~1.1-1.3s of synchronous canvas work per job) — enough
// for several batch jobs hitting this back to back to look like the whole
// batch has hung.
function extractTitleFromStory(story) {
  const firstLine = (story || "").split("\n").find(l => l.trim());
  return (firstLine || "").trim().slice(0, 350);
}

// ---------- System diagnostics + cache management (Debug tab) ----------
let lastSystemDiagnostics = null;
function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
async function refreshSystemDiagnostics() {
  const grid = $("#systemDiagnosticsGrid");
  if (!grid) return;
  grid.innerHTML = `<div class="batch-stat-tile"><div class="stat-label">Status</div><div class="stat-value">Checking...</div></div>`;
  try {
    const resp = await fetch("/system-info");
    const data = await resp.json();
    lastSystemDiagnostics = data;
    grid.innerHTML = [
      ["ffmpeg", data.ffmpegAvailable ? (data.ffmpegVersion || "available") : "not found"],
      ["whisper", data.whisperAvailable ? "available" : "not found"],
      ["pocket-tts", data.pocketTtsAvailable ? "available" : "not found"],
      ["CPU", `${data.cpuCount} cores`],
      ["Platform", `${data.platform}/${data.arch}`],
      ["Node", data.nodeVersion],
      ["Render slots", `${data.renderActive} / ${data.renderMax} busy`],
      ["Transcribe slots", `${data.transcribeActive} / ${data.transcribeMax} busy`],
      ["PocketTTS slots", `${data.pocketTtsActive} / ${data.pocketTtsMax} busy`],
    ].map(([label, value]) => `
      <div class="batch-stat-tile">
        <div class="stat-label">${escapeHtml(label)}</div>
        <div class="stat-value" style="font-size:0.85rem;">${escapeHtml(String(value))}</div>
      </div>`).join("");
  } catch (e) {
    grid.innerHTML = `<div class="batch-stat-tile"><div class="stat-label">Status</div><div class="stat-value">No backend server (browser-only build)</div></div>`;
  }
}
function copyDiagnostics() {
  const lines = [
    `Slopdaddy v${VERSION}`,
    `User agent: ${navigator.userAgent}`,
    `Native render backend: ${nativeRenderAvailable} (cpuCount=${nativeCpuCount})`,
    `Native whisper backend: ${nativeWhisperAvailable}`,
  ];
  if (lastSystemDiagnostics) {
    for (const [k, v] of Object.entries(lastSystemDiagnostics)) lines.push(`${k}: ${v}`);
  }
  navigator.clipboard.writeText(lines.join("\n")).then(
    () => showToast("Diagnostics copied."),
    () => alert("Couldn't copy to clipboard.")
  );
}
async function refreshCacheInfo() {
  const el = $("#cacheInfoText");
  if (!el) return;
  try {
    const resp = await fetch("/cache-info");
    const data = await resp.json();
    el.textContent = `${data.fileCount} file${data.fileCount === 1 ? "" : "s"}, ${formatBytes(data.totalBytes)}`;
  } catch (e) {
    el.textContent = "Unavailable (no backend server).";
  }
}
async function clearAssetCache() {
  if (!confirm("Clear the cached background/music assets? Batches sharing a file will re-upload it once on the next render.")) return;
  try {
    await fetch("/cache-clear", { method: "POST" });
    await refreshCacheInfo();
    showToast("Cache cleared.");
  } catch (e) {
    alert("Couldn't clear cache: " + (e && e.message ? e.message : String(e)));
  }
}

// ---------- YouTube publish integration ----------
// Catches the two most common copy-paste mistakes (fields swapped, or only
// part of a value copied) with a specific, actionable message right here —
// instead of letting a malformed value sail through to a much more
// confusing failure later, deep inside an actual OAuth redirect.
function validateYoutubeOauthClientFormat(clientId, clientSecret) {
  const looksLikeClientId = (s) => s.endsWith(".apps.googleusercontent.com");
  if (looksLikeClientId(clientSecret) && !looksLikeClientId(clientId)) {
    return "These look swapped — the Client ID ends in \".apps.googleusercontent.com\", the Client Secret doesn't.";
  }
  if (!looksLikeClientId(clientId)) {
    return "That doesn't look like a Client ID — it should end in \".apps.googleusercontent.com\". Copy it again from step 4.";
  }
  if (clientSecret.length < 10 || /\s/.test(clientSecret)) {
    return "That Client Secret looks incomplete or has extra whitespace — copy it again from the popup in step 4.";
  }
  return null;
}

async function saveYoutubeOauthClient() {
  const clientId = $("#youtubeClientId").value.trim();
  const clientSecret = $("#youtubeClientSecret").value.trim();
  const statusEl = $("#youtubeClientStatus");
  if (!clientId || !clientSecret) { statusEl.textContent = "Both fields are required."; return; }
  const formatError = validateYoutubeOauthClientFormat(clientId, clientSecret);
  if (formatError) { statusEl.textContent = formatError; return; }
  try {
    const resp = await fetch("/youtube-oauth-client", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, clientSecret }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Failed to save.");
    statusEl.textContent = "Saved. You can now sign in below.";
  } catch (e) {
    statusEl.textContent = "Error: " + (e && e.message ? e.message : String(e));
  }
}

function renderYoutubeAccountsList(accounts) {
  const list = $("#youtubeAccountsList");
  if (!accounts.length) {
    list.innerHTML = `<p style="font-size:0.8rem;color:var(--muted);">No channels connected yet.</p>`;
    return;
  }
  list.innerHTML = accounts.map(a => `
    <div class="row" style="align-items:center;justify-content:space-between;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px;">
      <div class="row" style="align-items:center;gap:8px;">
        ${a.channelThumbnail ? `<img src="${a.channelThumbnail}" style="width:28px;height:28px;border-radius:50%;">` : ""}
        <span>${a.channelTitle}</span>
      </div>
      <button onclick="removeYoutubeAccount('${a.id}')" style="color:var(--danger);">Remove</button>
    </div>
  `).join("");
}

// Cache of the last-known account list — read by the per-job publish
// panel's account picker (renderPublishPanel) so it doesn't need its own
// separate fetch every time a result card renders.
let youtubeAccountsCache = [];
async function refreshYoutubeAccounts() {
  try {
    const resp = await fetch("/youtube-accounts");
    const data = await resp.json();
    youtubeAccountsCache = data.accounts || [];
    renderYoutubeAccountsList(youtubeAccountsCache);
  } catch (e) {
    youtubeAccountsCache = [];
    $("#youtubeAccountsList").innerHTML = `<p style="font-size:0.8rem;color:var(--danger);">Couldn't load accounts (no backend server).</p>`;
  }
  refreshYoutubeQuotaText();
  refreshYoutubeAutoUploadAccountSelect();
  refreshChannelBrandingSyncAccountSelect();
}

// The auto-upload account picker's options depend on youtubeAccountsCache,
// which only loads once the Publish tab is opened — same "options rebuilt
// once real data exists" issue as #model/#voice at startup (see
// loadSettings()'s comment on those two), so this restores the saved
// selection itself, the same way applyLoadedSettings() does for #voice
// after populateVoices() rebuilds its options.
function refreshYoutubeAutoUploadAccountSelect() {
  const sel = $("#youtubeAutoUploadAccountId");
  if (!sel) return;
  // sel.value itself can't be trusted as "the saved choice" — at page load
  // this select only has the default option, so loadSettings()'s generic
  // restore loop silently no-ops setting it to a not-yet-existing account
  // id. Read the real saved value straight from storage instead, same
  // reasoning as applyLoadedSettings() re-restoring #voice/#model after
  // their options are rebuilt.
  let saved = sel.value;
  try {
    const stored = JSON.parse(localStorage.getItem("slopdaddy_settings") || "{}");
    if (stored.youtubeAutoUploadAccountId) saved = stored.youtubeAutoUploadAccountId;
  } catch (e) { /* keep sel.value fallback */ }
  sel.innerHTML = `<option value="">First connected channel</option>` +
    youtubeAccountsCache.map(a => `<option value="${a.id}">${escapeHtml(a.channelTitle)}</option>`).join("");
  if (youtubeAccountsCache.some(a => a.id === saved)) sel.value = saved;
}

// Same restore-from-localStorage-directly pattern as
// refreshYoutubeAutoUploadAccountSelect above — this select's options don't
// exist yet at page load either. Re-applies the sync (if that's the active
// mode) once the real account list is in, since the very first automatic
// sync attempt at init() necessarily runs before any account data exists.
function refreshChannelBrandingSyncAccountSelect() {
  const sel = $("#channelBrandingSyncAccountId");
  if (!sel) return;
  let saved = sel.value;
  try {
    const stored = JSON.parse(localStorage.getItem("slopdaddy_settings") || "{}");
    if (stored.channelBrandingSyncAccountId) saved = stored.channelBrandingSyncAccountId;
  } catch (e) { /* keep sel.value fallback */ }
  sel.innerHTML = youtubeAccountsCache.length
    ? youtubeAccountsCache.map(a => `<option value="${a.id}">${escapeHtml(a.channelTitle)}</option>`).join("")
    : `<option value="">No channel connected — connect one in Settings → Publish</option>`;
  if (youtubeAccountsCache.some(a => a.id === saved)) sel.value = saved;
  if ($("#channelBrandingMode") && $("#channelBrandingMode").value === "sync") applyChannelBrandingSync();
}

// Toggles between the two Title Card Identity sources. "sync" makes
// Channel Name/Profile Picture read-only, driven entirely by
// applyChannelBrandingSync(); "custom" hands them back to the existing
// manual-edit/upload behavior untouched (nothing about that path changed).
function onChannelBrandingModeChange() {
  const mode = $("#channelBrandingMode").value;
  const isSync = mode === "sync";
  $("#channelBrandingSyncRow").style.display = isSync ? "" : "none";
  $("#channelName").readOnly = isSync;
  $("#channelProfilePicUploadBtn").disabled = isSync;
  $("#channelProfilePicRemoveBtn").disabled = isSync;
  if (isSync) applyChannelBrandingSync();
}

// Pulls the selected (or first) connected account's name + locally-cached
// thumbnail (see server.js's downloadYoutubeChannelThumbnail — a same-
// origin URL, safe to draw into a canvas, unlike Google's raw CDN link)
// into the exact same channelName/channelProfilePicDataUrl storage
// saveChannelProfilePic() already uses for a manual upload — so
// renderTitleCardImage() needs zero changes to support this; from its
// perspective a synced picture and a manually uploaded one are identical.
async function applyChannelBrandingSync() {
  if (!$("#channelBrandingMode") || $("#channelBrandingMode").value !== "sync") return;
  if (!youtubeAccountsCache.length) return;
  const selectedId = $("#channelBrandingSyncAccountId") ? $("#channelBrandingSyncAccountId").value : "";
  const account = youtubeAccountsCache.find(a => a.id === selectedId) || youtubeAccountsCache[0];
  if (!account) return;
  $("#channelName").value = account.channelTitle;
  $("#channelName").dispatchEvent(new Event("input"));
  if (!account.channelThumbnail) { saveChannelProfilePic(null); return; }
  try {
    const resp = await fetch(account.channelThumbnail);
    if (!resp.ok) return;
    const blob = await resp.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("couldn't read synced channel picture"));
      reader.readAsDataURL(blob);
    });
    saveChannelProfilePic(dataUrl);
  } catch (e) { /* best-effort — leaves whatever picture was already set */ }
}

async function refreshYoutubeQuotaText() {
  const el = $("#youtubeQuotaText");
  if (!el) return;
  try {
    const resp = await fetch("/youtube-usage");
    const data = await resp.json();
    el.textContent = `Uploaded ${data.uploadsToday} time${data.uploadsToday === 1 ? "" : "s"} today (across all channels). `;
  } catch (e) {
    el.textContent = "";
  }
}

async function startYoutubeOAuth() {
  const btn = $("#youtubeSignInBtn");
  const originalLabel = btn.textContent;
  btn.disabled = true; btn.textContent = "Opening Google sign-in...";
  let es = null;
  try {
    const resp = await fetch("/youtube-oauth-start", { method: "POST" });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Couldn't start sign-in.");
    // Listen for the result BEFORE opening the tab — same ordering
    // constraint as every other id-correlated SSE channel in this app
    // (renderVideoNatively, transcribeNatively), so no event can race ahead
    // of the listener being attached.
    const result = await new Promise((resolve, reject) => {
      es = new EventSource(`/youtube-oauth-status/${data.state}`);
      es.onmessage = (e) => {
        try { resolve(JSON.parse(e.data)); } catch (err) { reject(err); }
      };
      es.onerror = () => reject(new Error("Lost connection waiting for sign-in to finish."));
      // window.open here (not location.href) — in Electron, main.js's
      // existing setWindowOpenHandler already routes any non-own-origin
      // window.open to the system browser via shell.openExternal, so this
      // needs zero Electron-specific code; in the plain browser build it's
      // just a normal new tab.
      window.open(data.authUrl, "_blank");
      btn.textContent = "Waiting for you to finish signing in...";
    });
    if (result.status === "success") {
      showToast(`Connected ${result.account.channelTitle}.`);
      await refreshYoutubeAccounts();
    } else {
      throw new Error(result.error || "Sign-in failed.");
    }
  } catch (e) {
    alert("YouTube sign-in failed: " + (e && e.message ? e.message : String(e)));
  } finally {
    if (es) es.close();
    btn.disabled = false; btn.textContent = originalLabel;
  }
}

async function removeYoutubeAccount(id) {
  if (!confirm("Disconnect this channel? You'll need to sign in again to publish to it.")) return;
  try {
    await fetch(`/youtube-accounts/${id}`, { method: "DELETE" });
    await refreshYoutubeAccounts();
  } catch (e) {
    alert("Couldn't remove account: " + (e && e.message ? e.message : String(e)));
  }
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
    const grouping = resolveCaptionGrouping(globalSettings.captionPreset);
    const captionFont = getCaptionFont(globalSettings.font);
    let subs = null, karaokeGroups = null;
    if (grouping === "karaoke") {
      const groups = buildKaraokeGroups(words);
      for (const g of groups) { for (const w of g.words) w.text = sanitizeText(w.text); }
      await ensureCaptionFontLoaded(captionFont.cssFamily);
      applyKaraokeOffsets(groups, captionFont.cssFamily, parseInt(globalSettings.fontSize) || 68);
      karaokeGroups = groups;
    } else {
      const rawSubs = grouping === "phrase" ? buildSubsFromWords(words) : buildWordCues(words);
      subs = rawSubs.map(s => ({ start: s.start, end: s.end, text: sanitizeText(s.text) }));
    }
    const lastEnd = karaokeGroups
      ? (karaokeGroups.length ? karaokeGroups[karaokeGroups.length - 1].end : 3)
      : (subs.length ? subs[subs.length - 1].end : 3);
    const narrationSec = Math.max(1, lastEnd + 0.5);

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
      if (karaokeGroups) {
        for (const g of karaokeGroups) {
          g.start += cardDurationSec; g.end += cardDurationSec;
          for (const w of g.words) { w.start += cardDurationSec; w.end += cardDurationSec; }
        }
      } else {
        subs = subs.map(s => ({ start: s.start + cardDurationSec, end: s.end + cardDurationSec, text: s.text }));
      }
    }

    const bg = new Uint8Array(await bgFile.arrayBuffer());
    const audio = audioUrl
      ? new Uint8Array(await (await fetch(audioUrl)).arrayBuffer())
      : makeSilentWavBytes(narrationSec);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    const style = buildCaptionStyle(globalSettings, captionFont, grouping);

    const outBytes = await renderVideoInWorker({
      type: "render",
      base: new URL("./", document.baseURI).href,
      bg, audio, subs, karaokeGroups, style, w, h, fps: 24, bgW, bgH,
      music: null, musicVolume: 0,
      titleCard: titleCardPayload,
    }, (data) => { statusEl.textContent = `Rendering test clip... ${(data && data.pct != null) ? data.pct : data}%`; });

    if (lastDebugPreviewUrl) URL.revokeObjectURL(lastDebugPreviewUrl);
    const url = URL.createObjectURL(new Blob([outBytes], { type: "video/mp4" }));
    lastDebugPreviewUrl = url;
    previewExported(url);
    statusEl.textContent = "Done — captions" + (titleCardPayload ? " + title card" : "") + " above.";
  } catch (e) {
    console.error(e);
    statusEl.textContent = "Failed: " + (e && e.message ? e.message : String(e));
  }
  btn.disabled = false;
}

// ---------- Media library (IndexedDB-backed persistent uploads) ----------
// User-uploaded video/audio files that stay available across sessions,
// unlike bgFile/musicFile (plain in-memory File objects, gone on reload).
// One IndexedDB database, one object store keyed by id, blobs stored
// natively (no base64 tax). Every consumer (single-flow upload, batch-card
// upload, bulk-generate's random assignment) gets a real File back from
// getMediaLibraryFile() and hands it to the exact same setBackground()/
// setBatchCardBackground() entry points a manual upload already uses.
const MEDIA_LIBRARY_DB_NAME = "slopdaddy-media-library";
const MEDIA_LIBRARY_STORE = "items";
let mediaLibraryDB = null;
// Caches the in-flight open promise itself, not just the resolved db —
// without this, every caller that lands before the first open() finishes
// (e.g. a bulk batch's N concurrent jobs, each calling getMediaLibraryFile)
// fired its own fresh indexedDB.open(), leaving several redundant
// connections open simultaneously instead of sharing the one in progress.
let mediaLibraryDBPromise = null;
function openMediaLibraryDB() {
  if (mediaLibraryDB) return Promise.resolve(mediaLibraryDB);
  if (mediaLibraryDBPromise) return mediaLibraryDBPromise;
  mediaLibraryDBPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(MEDIA_LIBRARY_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(MEDIA_LIBRARY_STORE, { keyPath: "id" });
      store.createIndex("kind", "kind", { unique: false });
    };
    req.onsuccess = () => { mediaLibraryDB = req.result; resolve(mediaLibraryDB); };
    req.onerror = () => { mediaLibraryDBPromise = null; reject(req.error); };
  });
  return mediaLibraryDBPromise;
}

// Cache of metadata (no blobs, to keep this light) so bulk-generate's random
// pick and the picker UI don't need to re-await IndexedDB on every call.
// Refreshed after every add/delete and once at startup (see init()).
let mediaLibraryCache = { video: [], audio: [] };
async function refreshMediaLibraryCache() {
  mediaLibraryCache = {
    video: await listMediaLibraryItems("video"),
    audio: await listMediaLibraryItems("audio"),
  };
}

async function addMediaLibraryItem(file, kind) {
  const db = await openMediaLibraryDB();
  const record = buildMediaItemRecord(file, kind);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_LIBRARY_STORE, "readwrite");
    tx.objectStore(MEDIA_LIBRARY_STORE).put({ ...record, blob: file });
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
  });
}

async function listMediaLibraryItems(kind) {
  const db = await openMediaLibraryDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_LIBRARY_STORE, "readonly");
    const store = tx.objectStore(MEDIA_LIBRARY_STORE);
    const source = kind ? store.index("kind") : store;
    const req = kind ? source.getAll(kind) : source.getAll();
    req.onsuccess = () => {
      // Metadata only — strip the blob so the list/cache doesn't hold every
      // stored file's bytes in memory at once.
      resolve(req.result.map(({ blob, ...meta }) => meta));
    };
    req.onerror = () => reject(req.error);
  });
}

async function getMediaLibraryFile(id) {
  const db = await openMediaLibraryDB();
  const record = await new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_LIBRARY_STORE, "readonly");
    const req = tx.objectStore(MEDIA_LIBRARY_STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (!record) return null;
  return new File([record.blob], record.name, { type: record.mimeType });
}

async function deleteMediaLibraryItem(id) {
  const db = await openMediaLibraryDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_LIBRARY_STORE, "readwrite");
    tx.objectStore(MEDIA_LIBRARY_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  mediaLibraryThumbCache.delete(id);
  await refreshMediaLibraryCache();
}

function formatFileSize(bytes) {
  if (!bytes) return "0 KB";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// null when opened in manage mode (delete-only); a callback when opened as a
// single-pick picker (row click hands the picked File to it and closes the
// modal) — used by the per-card "Choose from library" links.
let mediaLibraryPickCallback = null;
let mediaLibraryPickKind = null; // restricts the picker's list to one kind

// Separate multi-pick ("numbered picker", Instagram-style) state, used only
// by the bulk-generate screen's "Choose for each" buttons via
// openMediaLibraryPicker() — an ordered array of ids rather than a single
// immediate pick, with an explicit Confirm/Cancel footer instead of closing
// on the first click.
let mediaLibraryPickerActive = false;
let mediaLibraryPickerMax = 0;
let mediaLibraryPickerOnConfirm = null;
let mediaLibraryPickerSelection = [];
const mediaLibraryThumbCache = new Map(); // itemId -> data URL, session-lived
// Ids currently mid-hydration — without this, re-rendering the list (every
// click in the numbered picker calls renderMediaLibraryList()) before an
// earlier IndexedDB-read + video-decode round trip resolves kicked off a
// brand-new, fully redundant one for the same still-uncached item.
const mediaLibraryThumbPending = new Set();

function openMediaLibrary(onPick, kind) {
  mediaLibraryPickCallback = onPick || null;
  mediaLibraryPickKind = kind || null;
  $("#mediaLibraryOverlay").classList.add("show");
  renderMediaLibraryList();
}

function openMediaLibraryPicker({ kind, max, onConfirm }) {
  mediaLibraryPickCallback = null;
  mediaLibraryPickKind = kind || null;
  mediaLibraryPickerActive = true;
  mediaLibraryPickerMax = max;
  mediaLibraryPickerOnConfirm = onConfirm;
  mediaLibraryPickerSelection = [];
  $("#mediaLibraryOverlay").classList.add("show");
  $("#mediaLibraryPickerFooter").style.display = "flex";
  renderMediaLibraryList();
}

function closeMediaLibrary() {
  $("#mediaLibraryOverlay").classList.remove("show");
  mediaLibraryPickCallback = null;
  mediaLibraryPickerActive = false;
  mediaLibraryPickerOnConfirm = null;
  mediaLibraryPickerSelection = [];
  $("#mediaLibraryPickerFooter").style.display = "none";
}
function cancelMediaLibraryPicker() { closeMediaLibrary(); }
function confirmMediaLibraryPicker() {
  const onConfirm = mediaLibraryPickerOnConfirm;
  const selection = mediaLibraryPickerSelection.slice();
  closeMediaLibrary();
  if (onConfirm) onConfirm(selection);
}

function renderMediaLibraryList() {
  const list = $("#mediaLibraryList");

  if (mediaLibraryPickerActive) {
    const items = mediaLibraryPickKind
      ? mediaLibraryCache[mediaLibraryPickKind]
      : [...mediaLibraryCache.video, ...mediaLibraryCache.audio];
    renderMediaLibraryPickerGrid(list, items);
    return;
  }

  if (!mediaLibraryPickKind) {
    renderMediaLibraryManageGrid(list, mediaLibraryCache.video, mediaLibraryCache.audio);
    return;
  }

  const items = mediaLibraryCache[mediaLibraryPickKind];
  list.className = "media-library-list";
  if (!items.length) {
    list.innerHTML = `<p style="font-size:0.8rem;color:var(--muted);">No ${mediaLibraryPickKind} files saved yet. Drag files above to add them.</p>`;
    return;
  }
  list.innerHTML = items.map(item => {
    const thumb = mediaLibraryThumbCache.get(item.id);
    const preview = thumb
      ? `<img class="media-library-item-thumb" src="${thumb}">`
      : `<span class="media-library-item-kind">${item.kind === "audio" ? "🎵" : "🎬"}</span>`;
    return `
    <div class="media-library-item" data-id="${item.id}">
      ${preview}
      <span class="media-library-item-name">${escapeHtml(item.name)}</span>
      <span class="media-library-item-size">${formatFileSize(item.size)}</span>
      <button class="media-library-item-delete" title="Delete">&times;</button>
    </div>
  `;
  }).join("");
  hydrateMediaLibraryThumbnails(list, items, ".media-library-item", ".media-library-item-kind", "media-library-item-thumb");
  for (const row of list.querySelectorAll(".media-library-item")) {
    const id = row.dataset.id;
    if (mediaLibraryPickCallback) {
      row.querySelector(".media-library-item-name").style.cursor = "pointer";
      row.addEventListener("click", async (e) => {
        if (e.target.classList.contains("media-library-item-delete")) return;
        const file = await getMediaLibraryFile(id);
        if (file) { mediaLibraryPickCallback(file); closeMediaLibrary(); }
      });
    }
    row.querySelector(".media-library-item-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteMediaLibraryItem(id);
      renderMediaLibraryList();
      showToast("Removed from library.");
    });
  }
}

// Shared tile inner-markup (thumb-or-icon + name) for every grid tile —
// picker mode's numbered badge and manage mode's delete button are each
// passed in as extraSlotHtml rather than merged here, since selection vs.
// delete wiring legitimately differs per caller.
function mediaLibraryTileMarkup(item, extraSlotHtml, selected) {
  const thumb = mediaLibraryThumbCache.get(item.id);
  const preview = thumb
    ? `<img class="media-library-tile-thumb" src="${thumb}">`
    : `<span class="media-library-tile-icon">${item.kind === "audio" ? "🎵" : "🎬"}</span>`;
  return `
    <div class="media-library-tile${selected ? " selected" : ""}" data-id="${item.id}">
      ${preview}
      <span class="media-library-tile-name">${escapeHtml(item.name)}</span>
      ${extraSlotHtml || ""}
    </div>`;
}
// Lazy, session-cached thumbnail generation (generateVideoThumbnail) shared
// by every media-library render mode — only for video items, only once per
// item per session. tileSelector/iconSelector parameterize row vs. tile
// markup (`.media-library-item`/`-kind` vs. `.media-library-tile`/`-icon`).
function hydrateMediaLibraryThumbnails(container, items, tileSelector, iconSelector, thumbClass) {
  for (const item of items) {
    if (item.kind !== "video" || mediaLibraryThumbCache.has(item.id) || mediaLibraryThumbPending.has(item.id)) continue;
    mediaLibraryThumbPending.add(item.id);
    getMediaLibraryFile(item.id)
      .then(file => file && generateVideoThumbnail(file))
      .then(dataUrl => {
        if (!dataUrl) return;
        mediaLibraryThumbCache.set(item.id, dataUrl);
        const tile = container.querySelector(`${tileSelector}[data-id="${item.id}"]`);
        const icon = tile && tile.querySelector(iconSelector);
        if (icon) {
          const img = document.createElement("img");
          img.className = thumbClass;
          img.src = dataUrl;
          icon.replaceWith(img);
        }
      })
      .catch(() => {})
      .finally(() => mediaLibraryThumbPending.delete(item.id));
  }
}

// Numbered multi-select grid — click a tile to select it (badge shows its
// position, 1-based, in click order); click again to deselect (the rest
// renumber down automatically on re-render, since the badge is just the
// tile's current index in mediaLibraryPickerSelection).
function renderMediaLibraryPickerGrid(list, items) {
  list.className = "media-library-grid";
  if (!items.length) {
    list.innerHTML = `<p style="font-size:0.8rem;color:var(--muted);">No ${mediaLibraryPickKind || ""} files saved yet — add some from the drop zone above first.</p>`;
    updateMediaLibraryPickerFooter();
    return;
  }
  list.innerHTML = items.map(item => {
    const pos = mediaLibraryPickerSelection.indexOf(item.id);
    const selected = pos !== -1;
    const badge = selected ? `<span class="media-library-tile-badge">${pos + 1}</span>` : "";
    return mediaLibraryTileMarkup(item, badge, selected);
  }).join("");

  for (const tile of list.querySelectorAll(".media-library-tile")) {
    const id = tile.dataset.id;
    tile.addEventListener("click", () => toggleMediaLibraryPick(id));
  }
  hydrateMediaLibraryThumbnails(list, items, ".media-library-tile", ".media-library-tile-icon", "media-library-tile-thumb");
  updateMediaLibraryPickerFooter();
}

// Manage mode: two stacked, thumbnailed grids (Videos, then Music) instead
// of one flat kind-agnostic list — mediaLibraryCache already separates by
// kind, this just gives the UI the same split. Clicking a tile does
// nothing (manage mode has no pick callback); only the delete button acts.
function renderMediaLibraryManageGrid(list, video, audio) {
  list.className = "media-library-list-manage";
  const section = (label, items) => {
    const body = items.length
      ? `<div class="media-library-grid">${items.map(item => {
          const del = `<button class="media-library-tile-delete" title="Delete">&times;</button>`;
          return mediaLibraryTileMarkup(item, del, false);
        }).join("")}</div>`
      : `<p style="font-size:0.8rem;color:var(--muted);">No ${label.toLowerCase()} yet.</p>`;
    return `<div class="media-library-section"><h3 class="media-library-section-heading">${label}</h3>${body}</div>`;
  };
  list.innerHTML = section("Videos", video) + section("Music", audio);

  for (const tile of list.querySelectorAll(".media-library-tile")) {
    const id = tile.dataset.id;
    tile.querySelector(".media-library-tile-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteMediaLibraryItem(id);
      renderMediaLibraryList();
      showToast("Removed from library.");
    });
  }
  hydrateMediaLibraryThumbnails(list, video, ".media-library-tile", ".media-library-tile-icon", "media-library-tile-thumb");
}

function toggleMediaLibraryPick(id) {
  const idx = mediaLibraryPickerSelection.indexOf(id);
  if (idx !== -1) {
    mediaLibraryPickerSelection.splice(idx, 1);
  } else {
    if (mediaLibraryPickerSelection.length >= mediaLibraryPickerMax) {
      showToast(`You can only pick ${mediaLibraryPickerMax}.`);
      return;
    }
    mediaLibraryPickerSelection.push(id);
  }
  renderMediaLibraryList();
}

function updateMediaLibraryPickerFooter() {
  const btn = $("#mediaLibraryConfirmBtn");
  if (!btn) return;
  const n = mediaLibraryPickerSelection.length;
  btn.textContent = `Confirm (${n}/${mediaLibraryPickerMax} picked)`;
  btn.disabled = n === 0;
}

// Off-DOM <video> + <canvas> frame grab — same mechanics as the codec-
// transcode path's frame extraction, just a single frame instead of a full
// re-encode. Seeks to a moment early in the clip (but not literally frame 0,
// which is often a black/fade-in frame) so the thumbnail actually shows
// something recognizable.
function generateVideoThumbnail(file) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    const url = URL.createObjectURL(file);
    let settled = false;
    const cleanup = () => URL.revokeObjectURL(url);
    const settle = (value) => { if (settled) return; settled = true; clearTimeout(timer); cleanup(); resolve(value); };
    // A corrupt file or an unfired loadedmetadata (browser codec quirk)
    // never reaches "seeked" or "error" — without a timeout this hangs
    // forever, permanently holding the object URL open.
    const timer = setTimeout(() => settle(null), 8000);
    video.addEventListener("loadedmetadata", () => {
      video.currentTime = Math.min(0.3, (video.duration || 1) / 2);
    });
    video.addEventListener("seeked", () => {
      try {
        // 9:16 to match this app's short-form output — cover-fit (scale to
        // fill, crop overflow) rather than a plain stretch into the target
        // box, so a source video's real aspect ratio isn't distorted.
        const canvas = document.createElement("canvas");
        canvas.width = 180; canvas.height = 320;
        const ctx = canvas.getContext("2d");
        const vw = video.videoWidth || canvas.width;
        const vh = video.videoHeight || canvas.height;
        const scale = Math.max(canvas.width / vw, canvas.height / vh);
        const dw = vw * scale, dh = vh * scale;
        ctx.drawImage(video, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
        settle(canvas.toDataURL("image/jpeg", 0.7));
      } catch (e) {
        settle(null);
      }
    });
    video.addEventListener("error", () => settle(null));
    video.src = url;
  });
}

// Video files with a codec the in-browser renderer can't read (AV1/VP9/VP8 —
// same check runJob does before rendering, sniffUnsupportedVideoCodec) are
// converted to H.264 up front, before they're stored — so anything pulled
// back out of the library later (single-flow, batch cards, bulk-generate's
// random assignment) is already render-ready and never needs the per-job
// transcode-on-first-render path at all.
async function addFilesToMediaLibrary(files) {
  let added = 0;
  for (let file of files) {
    const kind = inferKindFromMimeType(file.type);
    if (kind !== "video" && kind !== "audio") continue;
    if (!file.type.startsWith("video/") && !file.type.startsWith("audio/")) continue;
    if (kind === "video") {
      const codec = await sniffUnsupportedVideoCodec(file);
      if (codec) {
        showDownloadToast(`Converting ${codec} video to H.264...`);
        try {
          const blob = await autoTranscodeToH264(file, (pct) => showDownloadToast(`Converting ${codec} video to H.264... ${pct}%`));
          file = new File([blob], file.name, { type: "video/mp4" });
        } catch (e) {
          hideDownloadToast();
          showToast(`Couldn't convert "${file.name}" (${codec}): ${e.message}`, 6000);
          continue;
        }
        hideDownloadToast();
      }
    }
    await addMediaLibraryItem(file, kind);
    added++;
  }
  await refreshMediaLibraryCache();
  renderMediaLibraryList();
  if (added) showToast(added === 1 ? "Added to library." : `Added ${added} files to library.`);
}

function handleMediaLibraryUpload(input) {
  if (input.files.length) addFilesToMediaLibrary([...input.files]);
  input.value = "";
}

function initMediaLibraryUI() {
  const dropZone = $("#mediaLibraryDropZone");
  dropZone.addEventListener("click", () => $("#mediaLibraryInput").click());
  dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag");
    if (e.dataTransfer.files.length) addFilesToMediaLibrary([...e.dataTransfer.files]);
  });
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

const MAX_BULK_GENERATE = 15;

// The Batch page has two mutually-exclusive views: "setup" (the default
// bulk-generate screen) and "cards" (the original per-card list — reached
// via "Create Separately", or automatically once "Generate Stories" starts
// producing jobs). Nothing about batchJobs/rendering itself depends on
// which view is showing.
let batchViewMode = "setup";
function setBatchViewMode(mode) {
  batchViewMode = mode;
  $("#bulkSetupView").style.display = mode === "setup" ? "" : "none";
  $("#batchCardsView").style.display = mode === "cards" ? "" : "none";
}

// "Create Separately Instead" — skips bulk generation entirely, seeding one
// blank card the first time (same as this used to happen unconditionally on
// every Batch-tab visit, before the bulk-generate screen became the default).
function createBatchSeparately() {
  if (batchJobs.length === 0) addBatchCard();
  setBatchViewMode("cards");
}

// Ordered lists of library item ids from the numbered multi-select picker
// (see openMediaLibraryPicker below) — populated when "Choose for each" is
// picked for video/music on the bulk-generate screen.
let bulkVideoManualPicks = [];
let bulkMusicManualPicks = [];

function openBulkVideoPicker() {
  const count = parseInt($("#bulkGenerateCount").value) || 1;
  openMediaLibraryPicker({
    kind: "video", max: count,
    onConfirm: (ids) => {
      bulkVideoManualPicks = ids;
      $("#bulkVideoPicksSummary").textContent = ids.length ? `${ids.length} video${ids.length === 1 ? "" : "s"} chosen.` : "";
    },
  });
}
function openBulkMusicPicker() {
  const count = parseInt($("#bulkGenerateCount").value) || 1;
  openMediaLibraryPicker({
    kind: "audio", max: count,
    onConfirm: (ids) => {
      bulkMusicManualPicks = ids;
      $("#bulkMusicPicksSummary").textContent = ids.length ? `${ids.length} track${ids.length === 1 ? "" : "s"} chosen.` : "";
    },
  });
}
function updateBulkVideoSourceUI() {
  const val = document.querySelector('input[name="bulkVideoSource"]:checked').value;
  $("#bulkVideoChooseBtn").style.display = val === "manual" ? "" : "none";
  if (val !== "manual") { $("#bulkVideoPicksSummary").textContent = ""; bulkVideoManualPicks = []; }
}
function updateBulkMusicSourceUI() {
  const val = document.querySelector('input[name="bulkMusicSource"]:checked').value;
  $("#bulkMusicChooseBtn").style.display = val === "manual" ? "" : "none";
  if (val !== "manual") { $("#bulkMusicPicksSummary").textContent = ""; bulkMusicManualPicks = []; }
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

  const countSelect = $("#bulkGenerateCount");
  const countOpts = [];
  for (let i = 1; i <= MAX_BULK_GENERATE; i++) countOpts.push(`<option value="${i}">${i}</option>`);
  countSelect.innerHTML = countOpts.join("");
  countSelect.value = "5";

  const engineOpts = Object.values(TTS_ENGINES).map(e => `<option value="${e.id}">${escapeHtml(e.label)}</option>`).join("");
  $("#bulkTtsEngine").innerHTML = '<option value="">Use settings engine</option>' + engineOpts;
  populateBatchCardVoices(DEFAULT_TTS_ENGINE, $("#bulkVoice"));
  $("#bulkTtsEngine").addEventListener("change", () => {
    populateBatchCardVoices($("#bulkTtsEngine").value || DEFAULT_TTS_ENGINE, $("#bulkVoice"));
  });

  for (const r of document.querySelectorAll('input[name="bulkVideoSource"]')) r.addEventListener("change", updateBulkVideoSourceUI);
  for (const r of document.querySelectorAll('input[name="bulkMusicSource"]')) r.addEventListener("change", updateBulkMusicSourceUI);

  setBatchViewMode("setup");
}

function updateParallelismHint() {
  const n = parseInt($("#batchParallelism").value) || 1;
  if (useNativeRender()) {
    $("#batchParallelismHint").textContent = `Renders up to ${n} at once via your native ffmpeg backend, each getting a share of your CPU cores. Higher than your machine can handle may slow individual renders down — start lower and raise it if it's stable.`;
    return;
  }
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
    <button class="library-pick-link bc-library-pick-video">Choose from library</button>
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
      <div class="field-full"><label>Caption grouping</label>
        <select class="bc-captionPreset">
          <option value="">Use settings grouping</option>
          <option value="word">Word-by-word</option>
          <option value="phrase">Phrase</option>
          <option value="karaoke">Karaoke (multi-word highlight)</option>
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
        <button class="library-pick-link bc-library-pick-music">Choose from library</button>
        <input type="range" class="bc-musicVolume" min="0" max="1" step="0.05" value="0.25">
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
  div.querySelector(".bc-library-pick-video").onclick = () => {
    openMediaLibrary(async (file) => { await setBatchCardBackground(job, file, div); }, "video");
  };

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
  div.querySelector(".bc-library-pick-music").onclick = () => {
    openMediaLibrary((file) => { job.musicFile = file; musicStatus.textContent = file.name; }, "audio");
  };
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

// Applies a bulk-generate plan entry (web/lib/bulk-assignment.js) to a
// freshly-created card — the only piece that touches IndexedDB/File; the
// plan itself is pure and already decided which library item (if any) this
// card gets.
async function applyBulkVideoAssignment(planEntry, job, cardEl) {
  if (planEntry.source !== "library") return;
  const file = await getMediaLibraryFile(planEntry.itemId);
  if (file) await setBatchCardBackground(job, file, cardEl);
}

// Same idea as applyBulkVideoAssignment but for background music — sets
// job.musicFile directly (no codec/transcode concerns for audio) and updates
// the card's own status text, mirroring what the per-card music-upload
// button already does (app.js, .bc-music-status).
async function applyBulkMusicAssignment(planEntry, job, cardEl) {
  if (planEntry.source !== "library") return;
  const file = await getMediaLibraryFile(planEntry.itemId);
  if (!file) return;
  job.musicFile = file;
  const status = cardEl.querySelector(".bc-music-status");
  if (status) status.textContent = file.name;
}

// Applies the bulk-generate screen's voice/engine/caption/title-card
// selections to a freshly-created job, and syncs the card's own DOM
// controls to match — so if the user later opens "Review & Customize Each"
// and expands that card's "Customize style" panel, it reflects what was
// actually used rather than looking unset. Voice population is async per
// engine (populateBatchCardVoices), so the voice <select>'s options may not
// exist yet when this runs; setting .value once that resolves is a no-op if
// the option isn't there yet, so it's re-applied after populate resolves.
function applyBulkJobDefaults(job, cardEl, { voice, ttsEngine, captionPreset, titleCardEnabled }) {
  job.voice = voice || null;
  job.ttsEngine = ttsEngine || null;
  job.captionPreset = captionPreset || null;
  job.titleCardEnabled = titleCardEnabled;

  const engineSel = cardEl.querySelector(".bc-ttsEngine");
  const presetSel = cardEl.querySelector(".bc-captionPreset");
  const titleChk = cardEl.querySelector(".bc-titleCard");
  if (engineSel) engineSel.value = ttsEngine || "";
  if (presetSel) presetSel.value = captionPreset || "";
  if (titleChk) titleChk.checked = titleCardEnabled;

  const voiceSel = cardEl.querySelector(".bc-voice");
  if (voice && voiceSel) {
    populateBatchCardVoices(ttsEngine || DEFAULT_TTS_ENGINE, voiceSel).then(() => { voiceSel.value = voice; });
  }
}

// Headless variant of getIdeasForCard + generateStoryForCard: bulk-generate
// creates all N cards up front (each already mounted in the DOM via
// addBatchCard()), so this streams straight into that card's own textareas
// instead of taking them as separate live-typing targets — same streamChat
// calls, same prompts, just orchestrated in a loop rather than by hand.
async function generateIdeaAndStoryForJob(job, cardEl) {
  const premiseTa = cardEl.querySelector(".bc-premise");
  const storyTa = cardEl.querySelector(".bc-story");

  let premise = "";
  await streamChat(
    [{ role: "system", content: "You output only one short creative idea. No markdown, no quotes." },
     { role: "user", content: ideasPrompt() }],
    (chunk) => { premise += chunk; job.premise = premise; premiseTa.value = premise; autoGrow(premiseTa); }
  );

  let story = "";
  await streamChat(
    [{ role: "system", content: storySystemPrompt() }, { role: "user", content: storyUserPrompt(job.premise || "a dramatic family conflict") }],
    (chunk) => { story += chunk; job.story = story; storyTa.value = story; autoGrow(storyTa); }
  );
}

// Bulk-creates `count` cards in one click, each with an auto-generated
// premise+story (reusing the same story-generation pipeline the per-card
// "Suggest Ideas"/"Generate Story" buttons use), the bulk screen's voice/
// engine/caption/title-card selections applied uniformly (applyBulkJobDefaults),
// and — per the video/music radio choices — either no background video/music,
// a random one from the library, or the manually-chosen ones from the
// numbered picker (web/lib/bulk-assignment.js).
//
// Not a separate step before rendering, and not two global phases either:
// each job runs its own full pipeline (assign media -> generate story ->
// runJob's TTS+render) independently via one Promise.all, so a fast story
// doesn't sit idle waiting on every other job's story to finish before it
// can start rendering — the batch used to await ALL stories before ANY job
// could enter the render phase, which meant one slow LLM response held up
// every already-ready job in the batch. Story generation and rendering each
// still get their own natural concurrency control (queueTTS's one-at-a-time
// lock, renderLimiter's slot cap) inside runJob(), same as the "Generate
// All"/renderAllBatch() path already relies on — this just removes the
// artificial barrier between the two steps.
//
// Concurrent, not sequential: every job already has its own independent card
// in the progress grid, so N stories streaming in (and N renders starting
// as each finishes) updates N separate cards rather than one shared
// indicator — nothing about the UI depends on completion order. The one
// real tradeoff: this fires up to MAX_BULK_GENERATE * 2 concurrent requests
// (ideas + story per job) at the user's own configured provider — a
// free-tier/low-rate-limit key could get throttled where sequential
// wouldn't. Worth it for the speedup; if rate limiting turns out to be a
// common complaint, cap concurrency instead of reverting to fully sequential.
async function bulkGenerateBatch() {
  const count = parseInt($("#bulkGenerateCount").value) || 1;
  const videoMode = $("#bulkVideoMode").value;
  const videoSource = document.querySelector('input[name="bulkVideoSource"]:checked').value;
  const musicSource = document.querySelector('input[name="bulkMusicSource"]:checked').value;

  if (videoSource === "random" && mediaLibraryCache.video.length === 0) {
    showToast("Your media library has no videos — add one first, or choose a different video option.");
    return;
  }
  if (videoSource === "manual" && bulkVideoManualPicks.length === 0) {
    showToast("Choose at least one video first.");
    return;
  }
  if (musicSource === "random" && mediaLibraryCache.audio.length === 0) {
    showToast("Your media library has no music — add some first, or choose a different music option.");
    return;
  }
  if (musicSource === "manual" && bulkMusicManualPicks.length === 0) {
    showToast("Choose at least one music track first.");
    return;
  }

  const noneplan = () => Array.from({ length: count }, () => ({ source: "none" }));
  const videoPlan = videoSource === "random"
    ? planBulkVideoAssignment({ count, videoMode, useRandomLibrary: true, libraryItems: mediaLibraryCache.video })
    : videoSource === "manual"
      ? planManualAssignment({ count, orderedItemIds: bulkVideoManualPicks })
      : noneplan();
  // Music has no same/separate choice on the bulk screen (always one
  // independent pick per video) — "separate" is the right videoMode to pass
  // through to the shared random-assignment planner.
  const musicPlan = musicSource === "random"
    ? planBulkVideoAssignment({ count, videoMode: "separate", useRandomLibrary: true, libraryItems: mediaLibraryCache.audio })
    : musicSource === "manual"
      ? planManualAssignment({ count, orderedItemIds: bulkMusicManualPicks })
      : noneplan();

  const defaults = {
    voice: $("#bulkVoice").value,
    ttsEngine: $("#bulkTtsEngine").value,
    captionPreset: $("#bulkCaptionPreset").value,
    titleCardEnabled: $("#bulkTitleCard").checked,
  };

  const btn = $("#bulkGenerateBtn");
  btn.disabled = true;
  setBatchViewMode("cards");

  const jobs = [];
  for (let i = 0; i < count; i++) {
    const job = addBatchCard();
    const cardEl = document.querySelector(`.batch-card[data-job-id="${job.id}"]`);
    applyBulkJobDefaults(job, cardEl, defaults);
    job.progressLabel = "Queued...";
    jobs.push({ job, cardEl });
  }

  openBatchProgressPanel(jobs.map(j => j.job));

  const grid = $("#batchProgressGrid");
  const resultsGrid = $("#resultsGrid");
  for (const { job } of jobs) {
    job.status = "story";
    job.progressLabel = "Generating story...";
    renderResultCard(job, grid);
  }

  // Set up the render backend once, up front, rather than only after every
  // story finishes — jobs can now start rendering as soon as their own
  // story is ready, which may be well before the batch's slowest story.
  const parallelism = parseInt($("#batchParallelism").value) || 1;
  const globalSettings = getGlobalSettings();
  try {
    await ensureRenderBackend(parallelism);
    await applyRenderConcurrency(parallelism);
  } catch (e) {
    console.error(e);
    alert("Couldn't start the render backend: " + (e && e.message ? e.message : String(e)));
    // openBatchProgressPanel() above already started its 500ms stats
    // interval and every job is still sitting at status "story" — without
    // marking them as failed here, doneCount never reaches totalJobs, so
    // updateBatchProgressStats() never clears that interval and it ticks
    // forever showing a bogus "Estimating..." ETA for a batch that never
    // actually started.
    for (const { job } of jobs) {
      job.status = "error"; job.error = "Render backend failed to start.";
      renderResultCard(job, grid);
    }
    updateBatchProgressStats();
    btn.disabled = false;
    return;
  }

  // Per-job try/catch (not one Promise.all-wide try/catch) so one job's
  // failure — a rate limit, a bad response — doesn't abort every other
  // job's already-in-flight generation/render.
  await Promise.all(jobs.map(async ({ job, cardEl }, i) => {
    try {
      await applyBulkVideoAssignment(videoPlan[i], job, cardEl);
      await applyBulkMusicAssignment(musicPlan[i], job, cardEl);
      await generateIdeaAndStoryForJob(job, cardEl);
      job.progressLabel = "Story ready";
      renderResultCard(job, grid);
      job.status = "queued";
      renderResultCard(job, grid);
      await runJob(job, globalSettings, (j) => {
        renderResultCard(j, resultsGrid);
        renderResultCard(j, grid);
        updateBatchProgressStats();
      });
    } catch (e) {
      console.error(e);
      job.status = "error";
      job.error = (e && e.message) || String(e);
      job.progressLabel = "Failed";
      renderResultCard(job, grid);
    }
  }));

  const failedCount = jobs.filter(({ job }) => job.status === "error").length;
  showToast(failedCount ? `Batch done — ${failedCount} of ${jobs.length} failed.` : "Batch complete!");
  updateBatchProgressStats();

  btn.disabled = false;
}

// ---------- Full-page batch progress panel ----------
// Opened by renderAllBatch() for the duration of a batch render — a
// dashboard-style view (stats + a live-updating grid of per-job cards,
// reusing renderResultCard so a finished/failed card gets the exact same
// Preview/Download/Retry buttons it would in #resultsGrid) rather than a
// single progress bar, since a batch run can take a while and the user
// asked to see resource use / ETA / elapsed time while it's in flight.
let batchProgressState = null; // { startTime, totalJobs, jobs, tickHandle }

function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function openBatchProgressPanel(jobs) {
  if (batchProgressState) clearInterval(batchProgressState.tickHandle);
  batchProgressState = { startTime: Date.now(), totalJobs: jobs.length, jobs };
  $("#batchProgressOverlay").classList.add("show");
  $("#batchProgressCloseBtn").textContent = "Minimize";
  $("#batchProgressReopenBtn").style.display = "none";
  const grid = $("#batchProgressGrid");
  grid.innerHTML = "";
  for (const job of jobs) renderResultCard(job, grid);
  updateBatchProgressStats();
  batchProgressState.tickHandle = setInterval(updateBatchProgressStats, 500);
}

// Not real system-wide CPU/memory (no browser API exposes that) — CPU
// cores and this page's own JS heap usage are the closest honest proxies
// for "resource use" available client-side, alongside the concurrency/
// backend settings that actually govern how much of the machine gets used.
function updateBatchProgressStats() {
  if (!batchProgressState) return;
  const { startTime, totalJobs, jobs } = batchProgressState;
  const elapsedMs = Date.now() - startTime;
  const doneCount = jobs.filter(j => j.status === "done" || j.status === "error").length;
  const activeCount = jobs.filter(j => !["draft", "queued", "done", "error"].includes(j.status)).length;
  const overallPct = totalJobs
    ? Math.round(jobs.reduce((sum, j) => sum + (j.status === "done" ? 100 : (j.progressPct || 0)), 0) / totalJobs)
    : 0;

  let etaLabel = "Estimating...";
  if (doneCount >= totalJobs) {
    etaLabel = "Done";
  } else if (doneCount > 0) {
    const msPerJob = elapsedMs / doneCount;
    etaLabel = "~" + formatElapsed(msPerJob * (totalJobs - doneCount));
  }

  const concurrency = parseInt($("#batchParallelism").value) || 1;
  const backendLabel = useNativeRender() ? "Native (ffmpeg)" : "Browser (WASM)";
  const cores = navigator.hardwareConcurrency || nativeCpuCount || 1;
  const memInfo = (performance.memory)
    ? `${Math.round(performance.memory.usedJSHeapSize / 1048576)} MB`
    : "n/a";

  const tiles = [
    ["Elapsed", formatElapsed(elapsedMs)],
    ["Est. remaining", etaLabel],
    ["Videos done", `${doneCount} / ${totalJobs}`],
  ];
  // Only shown once the feature is actually usable AND at least one job in
  // this batch has touched publishing — an all-"none" batch (nobody clicked
  // "Publish to YouTube" on anything yet) would otherwise show a permanent,
  // always-zero tile with no useful information.
  if (youtubeAvailable && jobs.some(j => j.publish && j.publish.status !== "none")) {
    const uploadedCount = jobs.filter(j => j.publish.status === "uploaded" || j.publish.status === "scheduled").length;
    const eligibleCount = jobs.filter(j => j.status === "done").length;
    tiles.push(["Uploaded to YouTube", `${uploadedCount} / ${eligibleCount}`]);
  }
  // The native backend's own render slots (renderLimiter, capped by
  // "Parallel renders") are what actually gate concurrency — split the
  // client-side "active" count into "really encoding right now" vs "waiting
  // its turn for a slot" instead of one opaque number, since a job can sit
  // in job.status === "render" for a while just waiting on renderLimiter.
  if (useNativeRender()) {
    const encoding = jobs.filter(j => j.renderPhase === "encoding");
    const waiting = jobs.filter(j => j.renderPhase === "queued" || j.renderPhase === "starting").length;
    tiles.push(["Encoding now", `${encoding.length} / ${concurrency}`]);
    tiles.push(["Waiting for slot", waiting]);
    const speeds = encoding.map(j => j.renderSpeed).filter(s => s != null);
    if (speeds.length) {
      const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
      tiles.push(["Avg. encode speed", `${avgSpeed.toFixed(2)}x`]);
    }
  } else {
    tiles.push(["Active renders", `${activeCount} / ${concurrency}`]);
  }
  tiles.push(["CPU cores", cores]);
  tiles.push(["Render backend", backendLabel]);
  tiles.push(["Page memory", memInfo]);

  $("#batchProgressStats").innerHTML = tiles.map(([label, value]) => `
    <div class="batch-stat-tile">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${value}</div>
    </div>`).join("");

  $("#batchProgressOverallFill").style.width = overallPct + "%";
  $("#batchProgressOverallLabel").textContent = `${overallPct}% overall — ${doneCount} of ${totalJobs} videos finished`;
  // "Processing", not "Rendering" — bulkGenerateBatch()'s jobs pipeline
  // independently now, so at any moment some may still be generating their
  // story while others are already rendering; there's no single global
  // phase to name.
  $("#batchProgressTitle").textContent = doneCount >= totalJobs ? "Batch complete" : `Processing ${totalJobs} video${totalJobs === 1 ? "" : "s"}...`;
  if (doneCount >= totalJobs) {
    clearInterval(batchProgressState.tickHandle);
    $("#batchProgressCloseBtn").textContent = "Close";
  }
  // Shown once every job has actually finished rendering AND there's at
  // least one that hasn't already been published/auto-published — keeps it
  // from lingering as a dead button once auto-upload (or a prior manual
  // click) has already handled everything.
  const publishAllBtn = $("#batchPublishAllBtn");
  if (publishAllBtn) {
    const hasUnpublished = jobs.some(j => j.status === "done" && j.publish.status === "none");
    publishAllBtn.style.display = (youtubeAvailable && doneCount >= totalJobs && hasUnpublished) ? "" : "none";
  }
}

function minimizeBatchProgress() {
  $("#batchProgressOverlay").classList.remove("show");
  if (batchProgressState) $("#batchProgressReopenBtn").style.display = "block";
}
function reopenBatchProgress() {
  $("#batchProgressOverlay").classList.add("show");
  $("#batchProgressReopenBtn").style.display = "none";
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
  const progressGrid = $("#batchProgressGrid");

  openBatchProgressPanel(jobsToRun);

  try {
    await ensureRenderBackend(parallelism);
    // ensureRenderBackend ignores poolSize on the native path (it's a no-op
    // there) — apply the batch screen's own "Parallel renders" choice as
    // the actual native concurrency cap too, so this control isn't cosmetic.
    await applyRenderConcurrency(parallelism);
    jobsToRun.forEach(j => {
      j.status = "queued"; j.progressLabel = "Queued...";
      renderResultCard(j, grid);
      renderResultCard(j, progressGrid);
    });
    await Promise.all(jobsToRun.map(job => runJob(job, globalSettings, (j) => {
      renderResultCard(j, grid);
      renderResultCard(j, progressGrid);
      updateBatchProgressStats();
    })));
    const failed = jobsToRun.filter(j => j.status === "error").length;
    showToast(failed ? `Batch done — ${failed} of ${jobsToRun.length} failed.` : "Batch complete!");
  } catch (e) {
    console.error(e);
    alert("Batch failed to start: " + (e && e.message ? e.message : String(e)));
    // Same interval-leak risk as bulkGenerateBatch's equivalent catch: any
    // job still sitting at "draft" here never reaches "done"/"error" on its
    // own, so openBatchProgressPanel's 500ms stats interval (started above)
    // would otherwise never see doneCount reach totalJobs and tick forever.
    for (const j of jobsToRun) {
      if (j.status !== "done" && j.status !== "error") {
        j.status = "error"; j.error = "Render backend failed to start.";
        renderResultCard(j, grid);
        renderResultCard(j, progressGrid);
      }
    }
  }
  updateBatchProgressStats();

  btn.textContent = "Generate All";
  btn.disabled = false;
}

// Re-submits one failed batch job without touching the others.
async function retryBatchJob(job) {
  job.status = "queued";
  job.error = null;
  renderResultCard(job, $("#resultsGrid"));
  if ($("#batchProgressGrid").querySelector(`[data-job-id="${job.id}"]`)) {
    renderResultCard(job, $("#batchProgressGrid"));
  }
  const parallelism = parseInt($("#batchParallelism").value) || 1;
  await ensureRenderBackend(parallelism);
  await applyRenderConcurrency(parallelism);
  await runJob(job, getGlobalSettings(), (j) => {
    renderResultCard(j, $("#resultsGrid"));
    if ($("#batchProgressGrid").querySelector(`[data-job-id="${j.id}"]`)) {
      renderResultCard(j, $("#batchProgressGrid"));
      updateBatchProgressStats();
    }
  });
}

// ---------- Prompts ----------
// The word-count rule is deliberately NOT part of this template — it's
// always appended separately by storySystemPrompt() below, based on the
// Story Length setting, so the editable Settings -> Story textarea never
// needs to contain `${wc}`-style syntax a user could break while tweaking
// the writing-style rules.
const DEFAULT_STORY_SYSTEM_PROMPT = `You are a master of writing fake-but-believable AITAH (Am I The Asshole Here) Reddit posts.
Your stories must follow these rules:

1. Casual, slightly dramatic first-person storytelling
2. NO throwaway-account disclaimer — never start with "Throwaway because..." or anything similar.
3. Open the story immediately with a hook that sets up the conflict.
4. Vary your opening every time — never repeat the same first sentence across stories.
5. Short paragraphs (2-4 sentences) — Reddit style
6. Family/friend/relationship/financial drama
7. A clear conflict where the narrator might actually be wrong
8. End with "So Reddit AITAH" — no question mark, nothing after
9. Write in a natural slightly messy style — as if typed on a phone at 2am
10. DO NOT make it obviously AI-generated
11. CRITICAL: Your very first line MUST be the title in "AITAH for [doing the thing]" format
12. Use natural punctuation — commas, periods, quotes.
13. Break the story into short paragraphs separated by blank lines.

IMPORTANT: First line is ALWAYS the AITAH title. Then a blank line, then the story. NEVER use a "Throwaway because" opener. Plain text only.`;

// Settings -> Story's textarea holds the actual live prompt (pre-filled
// with the default above on first run by applyLoadedSettings(), not an
// empty box) — this reads whatever's currently there, falling back to the
// default if it's ever empty, and always appends the word-count rule.
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
