// AITAH Video Creator — fully client-side web version.
// Everything runs in the browser: DeepSeek API, Piper TTS, ffmpeg.wasm.

const $ = (s) => document.querySelector(s);
const VERSION = 19;

// Compute the app's base path so it works on GitHub Pages (where the site
// lives under /username/repo/ rather than the domain root).
const BASE = document.currentScript ? new URL('.', document.currentScript.src).pathname : '/';
let currentVideo = null;      // File / Blob of background
let currentVideoUrl = null;
let subtitles = [];           // [{start, end, text}]
let previewActive = false;
let previewRAF = null;
let ttsAudio = null;
let lastVideoUrl = null;

// CDN sources (fallback) — vendor files served locally are preferred
const PIPER_JS = "./vendor/piper-tts-web.js";
// Piper voice model (HuggingFace)
const PIPER_VOICE = {
  name: "en_US-libritts_r-medium",
  onnx: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/libritts_r/medium/en_US-libritts_r-medium.onnx",
  json: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/libritts_r/medium/en_US-libritts_r-medium.onnx.json",
};

let piperEngine = null;
let ffmpeg = null;
let ffmpegLoaded = false;

// ---------- Tiny helpers ----------
function showToast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2500);
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

// ---------- Init ----------
async function init() {
  $("#versionBadge").textContent = `v${VERSION}`;
  $("#provider").value = "deepseek";
  populateModels();
  populateVoices(["en_US-libritts_r-medium"]);
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
function getVoice() { syncVoiceQuick(); return $("#voice").value || PIPER_VOICE.name; }

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
async function handleVideoUpload(input) {
  const file = input.files[0];
  if (!file) return;
  await setBackground(file, file.name);
}
async function setBackground(file, label) {
  currentVideo = file;
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

async function ensurePiper() {
  if (piperEngine) return piperEngine;
  showDownloadToast("Loading TTS engine (first time only)...");
  try {
    const mod = await import(PIPER_JS);
    const { PiperWebEngine, OnnxWebRuntime, PhonemizeWebRuntime, HuggingFaceVoiceProvider } = mod;
    const voiceProvider = new HuggingFaceVoiceProvider();
    piperEngine = new PiperWebEngine({
      onnxRuntime: new OnnxWebRuntime({ basePath: BASE + "onnx/" }),
      phonemizeRuntime: new PhonemizeWebRuntime({ basePath: BASE + "piper/" }),
      voiceProvider,
    });
  } catch (e) {
    hideDownloadToast();
    throw e;
  }
  return piperEngine;
}

let ttsModelReady = false;

async function generateSpeech(text) {
  const engine = await ensurePiper();
  const voice = getVoice();
  let response;
  if (!ttsModelReady) {
    showDownloadToast(`Downloading TTS voice model (${voice})...`);
    try {
      response = await engine.generate(text, voice, 0);
      ttsModelReady = true;
      hideDownloadToast();
    } catch (e) {
      hideDownloadToast();
      throw e;
    }
  } else {
    showToast("Generating voice...");
    response = await engine.generate(text, voice, 0);
  }
  const audioUrl = URL.createObjectURL(response.file);
  const words = computeWordTimings(text, response.duration / 1000);
  return { audioUrl, words };
}

// Estimate per-word timing from the full audio duration.
// We align words to the audio by distributing the narration time across
// words proportional to character length (better than uniform since it
// reflects word size), and respect paragraph pauses in the source text.
function computeWordTimings(text, totalDuration) {
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
  const story = $("#storyText").value.trim();
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

async function ensureFFmpeg() {
  if (ffmpegLoaded) return;
  showDownloadToast("Loading video engine (first time only, ~25MB)...");
  try {
    await loadScript("./vendor/ffmpeg/ffmpeg-core.js");
    if (typeof window.createFFmpegCore !== "function") {
      throw new Error("ffmpeg core failed to load (createFFmpegCore not found)");
    }
    ffmpeg = await window.createFFmpegCore({
      mainScriptUrlOrBlob: new URL("./vendor/ffmpeg/ffmpeg-core.js", document.baseURI).href,
    });
    ffmpegLoaded = true;
    hideDownloadToast();
  } catch (e) {
    hideDownloadToast();
    throw e;
  }
}

async function exportVideo() {
  if (!currentVideo) { alert("Upload a background video first."); return; }
  const story = $("#storyText").value.trim();
  if (!story) { alert("Generate or paste a story first."); return; }

  stopPreview();
  const btn = $("#exportBtn");
  btn.textContent = "Exporting...";
  btn.disabled = true;
  setProgress(0, "Generating voice...");

  try {
    const { audioUrl, words } = await generateSpeech(story);
    subtitles = buildSubsFromWords(words);

    await ensureFFmpeg();
    const w = parseInt($("#resW").value) || 1080;
    const h = parseInt($("#resH").value) || 1920;
    const fps = parseInt($("#fps").value) || 30;

    // Load background video + audio into ffmpeg's virtual FS
    ffmpeg.FS("writeFile", "bg.mp4", await currentVideo.arrayBuffer());
    const audioData = new Uint8Array(await (await fetch(audioUrl)).arrayBuffer());
    ffmpeg.FS("writeFile", "audio.mp3", audioData);
    const assText = buildASS(subtitles, $("#font").value, parseInt($("#fontSize").value) || 68, $("#textColor").value, $("#strokeColor").value, parseInt($("#strokeWidth").value) || 3, parseFloat($("#positionY").value) || 0.55, w, h);
    ffmpeg.FS("writeFile", "subs.ass", new TextEncoder().encode(assText));

    const vf = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},subtitles=subs.ass`;
    const ret = await ffmpeg.callMain([
      "-stream_loop", "-1",
      "-i", "bg.mp4",
      "-i", "audio.mp3",
      "-filter_complex", `[0:v]${vf}[v]`,
      "-map", "[v]", "-map", "1:a",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
      "-c:a", "aac", "-b:a", "128k", "-pix_fmt", "yuv420p",
      "-r", String(fps),
      "-shortest", "-y", "out.mp4",
    ]);
    if (ret !== 0) throw new Error("ffmpeg exited with code " + ret);

    setProgress(50, "Rendering...");
    const data = ffmpeg.FS("readFile", "out.mp4");
    const blob = new Blob([data.buffer], { type: "video/mp4" });
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
    alert("Export failed: " + e.message);
  }
  btn.textContent = "Export Video";
  btn.disabled = false;
}

// ---------- ASS building ----------
function buildASS(subs, font, size, textColor, strokeColor, strokeWidth, positionY, w, h) {
  const colorMap = { white: "&H00FFFFFF", black: "&H00000000", red: "&H000000FF", yellow: "&H0000FFFF", green: "&H0000FF00", blue: "&H00FF0000" };
  function pc(c) {
    c = (c || "").toLowerCase().trim();
    if (c.startsWith("#")) c = c.slice(1);
    if (colorMap[c]) return colorMap[c];
    if (/^[0-9a-f]{6}$/.test(c)) return "&H00" + c.slice(4,6) + c.slice(2,4) + c.slice(0,2);
    return "&H00FFFFFF";
  }
  const primary = pc(textColor), outline = pc(strokeColor);
  const marginV = Math.round((positionY - 0.5) * h);
  const lines = [
    "[Script Info]", "Title: Captions", "ScriptType: v4.00+", "WrapStyle: 0",
    `PlayResX: ${w}`, `PlayResY: ${h}`, "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${font},${size},${primary},&H00000000,${outline},&H00000000,-1,0,0,0,100,100,0,0,1,${strokeWidth},0,5,20,20,${marginV},1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  function fmt(t) {
    const H = Math.floor(t/3600), M = Math.floor((t%3600)/60), S = t % 60;
    return `${H}:${String(M).padStart(2,"0")}:${S.toFixed(2).padStart(5,"0")}`;
  }
  for (const s of subs) {
    if (s.end - s.start < 0.04) continue;
    lines.push(`Dialogue: 0,${fmt(s.start)},${fmt(s.end)},Default,,0,0,0,,${s.text.replace(/\n/g,"\\N")}`);
  }
  return lines.join("\n");
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
