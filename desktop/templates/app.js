const $ = (s) => document.querySelector(s);
const toast = $("#toast");
const VERSION = 17;
let allModels = {};
let currentVideoId = null;
let ttsAudio = null;
let subtitles = [];
let previewActive = false;
let previewRAF = null;
let syncOffset = 0;
let lastVideoUrl = null;

const api = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error((await r.json()).detail || "Request failed");
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: body instanceof FormData ? {} : { "Content-Type": "application/json" },
      body: body instanceof FormData ? body : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(((await r.json()).detail) || "Request failed");
    return r.json();
  },
};

function openSettings() {
  $("#settingsOverlay").classList.add("show");
  $("#settingsPanel").classList.add("open");
}
function closeSettings() {
  $("#settingsOverlay").classList.remove("show");
  $("#settingsPanel").classList.remove("open");
}
function onProviderChange() { updateModelDropdown(); }

async function init() {
  const ver = $("#versionBadge");
  if (ver) ver.textContent = `v${VERSION}`;

  const [models, voices, fonts, defaults] = await Promise.all([
    api.get("/api/models"),
    api.get("/api/voices"),
    api.get("/api/fonts"),
    api.get("/api/default-key"),
  ]);
  allModels = models;
  populateVoices(voices.voices);
  populateFonts(fonts.fonts);
  updateModelDropdown();
  $("#apiKey").value = defaults.api_key;
  $("#provider").value = defaults.default_provider;
  updateModelDropdown();
  setTimeout(() => { $("#model").value = defaults.default_model; }, 50);
  $("#provider").addEventListener("change", onProviderChange);

  // Pre-load the default background video (video.mp4) if present.
  try {
    const dv = await api.get("/api/default-video");
    if (dv.video_id && dv.video_url) {
      currentVideoId = dv.video_id;
      const vid = $("#videoPreview");
      vid.src = dv.video_url;
      vid.style.display = "block";
      $("#previewPlaceholder").style.display = "none";
      const area = $("#videoUploadArea");
      area.classList.add("uploaded");
      area.querySelector(".icon").textContent = "✓";
      $("#uploadStatus").textContent = "Default video loaded";
    }
  } catch (e) {}
}

function populateVoices(voices) {
  $("#voice").innerHTML = voices.map(v => `<option value="${v.id}">${v.name}</option>`).join("");
  $("#voiceQuick").innerHTML = '<option value="">Use settings voice</option>' +
    voices.map(v => `<option value="${v.id}">${v.name}</option>`).join("");
}

function populateFonts(fonts) {
  const sel = $("#font");
  sel.innerHTML = fonts.map(f => `<option value="${f.name}" data-path="${f.path}">${f.name}</option>`).join("");
}

function syncVoiceQuick() {
  const v = $("#voiceQuick").value;
  if (v) $("#voice").value = v;
}
function getVoice() { syncVoiceQuick(); return $("#voice").value; }

function updateModelDropdown() {
  const models = allModels[$("#provider").value] || [];
  $("#model").innerHTML = models.map((m, i) => `<option value="${m.id}" ${i===0?'selected':''}>${m.name}</option>`).join("");
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2000);
}
async function handleVideoUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const area = $("#videoUploadArea");
  area.classList.add("uploaded");
  $("#uploadStatus").textContent = "Uploading...";
  const form = new FormData();
  form.append("file", file);
  const result = await api.post("/api/upload-video", form);
  currentVideoId = result.video_id;
  const vid = $("#videoPreview");
  vid.src = URL.createObjectURL(file);
  vid.style.display = "block";
  $("#previewPlaceholder").style.display = "none";
  area.querySelector(".icon").textContent = "✓";
  $("#uploadStatus").textContent = `Uploaded: ${result.filename}`;
}

async function generateStory() {
  const btn = $("#genStoryBtn");
  const textarea = $("#storyText");
  btn.textContent = "Generating...";
  btn.disabled = true;
  textarea.value = "";

  try {
    const payload = {
      provider: $("#provider").value,
      api_key: $("#apiKey").value,
      model: $("#model").value,
      premise: $("#premise").value.trim(),
      word_count: parseInt($("#storyLength").value) || 400,
    };

    const r = await fetch("/api/generate-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.chunk) {
              textarea.value += parsed.chunk;
              textarea.scrollTop = textarea.scrollHeight;
              autoGrow(textarea);
              validateInputs();
            }
            if (parsed.error) {
              textarea.value += "\n\n[ERROR: " + parsed.error + "]";
            }
          } catch (e) {}
        }
      }
    }
    showToast("Story generated!");
  } catch (e) { alert("Generation failed: " + e.message); }
  btn.textContent = "Generate Story";
  btn.disabled = false;
}

async function getIdeas() {
  const btn = $("#ideasBtn");
  const textarea = $("#premise");
  btn.textContent = "Loading...";
  btn.disabled = true;
  textarea.value = "";

  try {
    const payload = {
      provider: $("#provider").value,
      api_key: $("#apiKey").value,
      model: $("#model").value,
      premise: "",
    };

    const r = await fetch("/api/ideas-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const reader = r.body.getReader();
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
        const data = line.slice(6);
        try {
          const parsed = JSON.parse(data);
          if (parsed.chunk) {
            textarea.value += parsed.chunk;
            textarea.scrollTop = textarea.scrollHeight;
            autoGrow(textarea);
          }
          if (parsed.done) {
            validateInputs();
            showToast("Idea ready!");
          }
          if (parsed.error) textarea.value = "[Error: " + parsed.error + "]";
        } catch (e) {}
      }
    }
  } catch (e) { alert("Failed: " + e.message); }
  btn.textContent = "Suggest Ideas";
  btn.disabled = false;
}

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

function stopPreview() {
  previewActive = false;
  if (previewRAF) { cancelAnimationFrame(previewRAF); previewRAF = null; }
  if (ttsAudio) {
    ttsAudio.pause();
    ttsAudio.currentTime = 0;
    ttsAudio = null;
  }
  const vid = $("#videoPreview");
  vid.pause();
  vid.currentTime = 0;
  $("#captionOverlay").classList.remove("show");
  $("#captionOverlay").textContent = "";
  $("#previewBtn").textContent = "Preview";
}

function updateCaptionStyle() {
  const el = $("#captionOverlay");
  el.style.fontFamily = $("#font").value + ", sans-serif";
  el.style.fontSize = $("#fontSize").value + "px";
  el.style.color = $("#textColor").value;
  el.style.textShadow = `-${$("#strokeWidth").value}px -${$("#strokeWidth").value}px 0 ${$("#strokeColor").value},
    ${$("#strokeWidth").value}px -${$("#strokeWidth").value}px 0 ${$("#strokeColor").value},
    -${$("#strokeWidth").value}px ${$("#strokeWidth").value}px 0 ${$("#strokeColor").value},
    ${$("#strokeWidth").value}px ${$("#strokeWidth").value}px 0 ${$("#strokeColor").value}`;
  el.style.top = ($("#positionY").value * 100) + "%";
  el.style.transform = "translateY(-50%)";
}

function renderCaption(time) {
  const caption = subtitles.find(s => time >= s.start && time <= s.end);
  const el = $("#captionOverlay");
  if (caption) {
    el.textContent = caption.text;
    el.classList.add("show");
  } else {
    el.classList.remove("show");
  }
}

function captionsLoop() {
  if (!previewActive) return;
  if (ttsAudio && !ttsAudio.paused) {
    renderCaption(ttsAudio.currentTime + (syncOffset || 0));
  }
  previewRAF = requestAnimationFrame(captionsLoop);
}

async function startPreview() {
  const storyText = $("#storyText").value.trim();
  if (!storyText) { alert("Generate or paste a story first."); return; }
  if (!currentVideoId) { alert("Upload a background video first."); return; }

  if (previewActive) { stopPreview(); return; }

  const btn = $("#previewBtn");
  btn.textContent = "Loading...";
  btn.disabled = true;

  try {
    const result = await api.post("/api/preview", {
      story_text: storyText,
      voice: getVoice(),
      rate: $("#rate").value,
    });

    subtitles = result.subtitles;
    if (!subtitles.length) { alert("No captions generated."); btn.textContent = "Preview"; btn.disabled = false; return; }

    updateCaptionStyle();

    const vid = $("#videoPreview");
    vid.currentTime = 0;
    vid.muted = true;
    vid.loop = true;

    if (ttsAudio) { ttsAudio.pause(); ttsAudio.remove(); }
    ttsAudio = new Audio(result.audio_url);

    ttsAudio.addEventListener("ended", () => { stopPreview(); });
    ttsAudio.addEventListener("pause", () => {
      vid.pause();
      $("#captionOverlay").classList.remove("show");
    });

    vid.play();
    ttsAudio.play();
    $("#videoPreview").style.display = "block";
    $("#previewPlaceholder").style.display = "none";

    previewActive = true;
    btn.textContent = "Stop";
    captionsLoop();

    showToast(`Previewing — ${Math.round(result.duration)}s`);
  } catch (e) {
    alert("Preview failed: " + e.message);
    btn.textContent = "Preview";
  }
  btn.disabled = false;
}

function setProgress(pct, stage) {
  const bar = $("#progressBar");
  const fill = $("#progressFill");
  const pctText = $("#progressPercent");
  bar.style.display = "block";
  fill.style.width = pct + "%";
  pctText.textContent = stage ? `${pct}% — ${stage}` : `${pct}%`;
  if (pct >= 100) {
    setTimeout(() => { bar.style.display = "none"; }, 1500);
  }
}

async function exportVideo() {
  if (!currentVideoId) { alert("Upload a background video first."); return; }
  const storyText = $("#storyText").value.trim();
  if (!storyText) { alert("Generate or paste a story first."); return; }

  stopPreview();

  const btn = $("#exportBtn");
  btn.textContent = "Exporting...";
  btn.disabled = true;
  setProgress(0);

  try {
    const form = new FormData();
    form.append("video_id", currentVideoId);
    form.append("story_text", storyText);
    form.append("voice", getVoice());
    form.append("rate", $("#rate").value);
    form.append("font_size", $("#fontSize").value);
    form.append("font", $("#font").value);
    form.append("text_color", $("#textColor").value);
    form.append("stroke_color", $("#strokeColor").value);
    form.append("stroke_width", $("#strokeWidth").value);
    form.append("position_y", $("#positionY").value);
    form.append("resolution_w", $("#resW").value);
    form.append("resolution_h", $("#resH").value);
    form.append("fps", $("#fps").value);

    const startRes = await api.post("/api/create-video", form);
    if (startRes.error) { alert("Error: " + startRes.error); btn.textContent = "Export Video"; btn.disabled = false; return; }

    const jobId = startRes.job_id;
    let resultShown = false;

    // Poll the job status endpoint — this is reliable and returns
    // progress + stage + result all in one place.
    for (let i = 0; i < 600; i++) {
      let status;
      try {
        status = await api.get("/api/job/" + jobId);
      } catch (e) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      if (status.progress !== undefined) {
        setProgress(status.progress, status.stage === "voice" ? "Generating voice..." : null);
      }

      if (status.status === "done" && status.result && !resultShown) {
        resultShown = true;
        if (status.result.video_url) {
          lastVideoUrl = status.result.video_url;
          const url = status.result.video_url;
          const div = document.createElement("div");
          div.className = "video-result";
          div.innerHTML = `
            <div class="actions">
              <button onclick="previewExported('${url}')">Preview</button>
              <button onclick="downloadVideo('${url}')">Download</button>
              <button onclick="copyVideoLink('${url}')">Copy Link</button>
            </div>`;
          $("#outputContainer").prepend(div);
          showToast("Video exported!");
        } else if (status.result.error) {
          alert("Export error: " + status.result.error);
        }
        setProgress(100);
        btn.textContent = "Export Video";
        btn.disabled = false;
        break;
      }

      if (status.status === "gone") {
        alert("Export job was lost (server restarted?).");
        btn.textContent = "Export Video";
        btn.disabled = false;
        break;
      }

      await new Promise(r => setTimeout(r, 400));
    }

    if (!resultShown) {
      btn.textContent = "Export Video";
      btn.disabled = false;
    }
  } catch (e) {
    alert("Export failed: " + e.message);
    btn.textContent = "Export Video";
    btn.disabled = false;
  }
}

function downloadVideo(url) {
  const a = document.createElement("a");
  a.href = url; a.download = "aitah-story.mp4";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
function copyVideoLink(url) {
  navigator.clipboard.writeText(window.location.origin + url).then(() => showToast("Link copied!"));
}

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

// Resize handle
let resizeDragging = false;
$("#resizeHandle").addEventListener("mousedown", (e) => {
  e.preventDefault();
  resizeDragging = true;
  $("#resizeHandle").classList.add("dragging");
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
});
document.addEventListener("mousemove", (e) => {
  if (!resizeDragging) return;
  const r = $("#sidebar").getBoundingClientRect();
  const w = e.clientX - r.left;
  if (w >= 280 && w <= 700) $("#sidebar").style.width = w + "px";
});
document.addEventListener("mouseup", () => {
  if (!resizeDragging) return;
  resizeDragging = false;
  $("#resizeHandle").classList.remove("dragging");
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

// Drag-and-drop upload
document.addEventListener("dragover", (e) => { e.preventDefault(); $("#videoUploadArea").classList.add("drag"); });
document.addEventListener("dragleave", () => { $("#videoUploadArea").classList.remove("drag"); });
document.addEventListener("drop", (e) => {
  e.preventDefault();
  $("#videoUploadArea").classList.remove("drag");
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith("video/")) {
    const dt = new DataTransfer(); dt.items.add(file);
    $("#videoInput").files = dt.files;
    handleVideoUpload($("#videoInput"));
  }
});

init();
