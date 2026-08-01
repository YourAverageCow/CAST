// ffmpeg worker — runs rendering off the main thread so the UI never freezes.
importScripts("./lib/ffmpeg-filters.js");

// The multi-threaded core (vendor/ffmpeg/mt/) lets libx264 use every core
// instead of one, but it needs SharedArrayBuffer, which only exists when
// this worker is itself cross-origin isolated (same prerequisite Piper's
// threaded ONNX runtime already relies on, via coi-serviceworker.js). We
// pick the core to load lazily, once, based on that — no static
// importScripts at module load time like before.
let ffmpeg = null;
let loaded = false;
let usingMT = false;

async function ensureLoaded(base, font, forceST) {
  if (loaded) return;
  // Set by the worker pool whenever more than one ffmpeg-worker.js instance
  // is running at once — the mt core's own pthread pool (sized to
  // hardwareConcurrency) would oversubscribe the CPU badly if N instances
  // each spun one up, so parallel batches force every instance onto the
  // single-thread core instead. A lone worker (forceST falsy) still prefers
  // mt when available, unchanged from before.
  usingMT = !forceST && self.crossOriginIsolated === true && typeof SharedArrayBuffer !== "undefined";
  const dir = usingMT ? "vendor/ffmpeg/mt/" : "vendor/ffmpeg/";
  const coreURL = base + dir + "ffmpeg-core.js";
  const wasmURL = base + dir + "ffmpeg-core.wasm";
  // For the mt core, workerURL must point at its ffmpeg-core.worker.js (each
  // pthread is a real Worker); the st core has no such file, so pointing it
  // at coreURL itself is harmless (locateFile only consults it for .wasm/.worker.js).
  const workerURL = usingMT ? base + dir + "ffmpeg-core.worker.js" : coreURL;
  importScripts(coreURL);
  const payload = btoa(JSON.stringify({ wasmURL, workerURL }));
  try {
    ffmpeg = await self.createFFmpegCore({ mainScriptUrlOrBlob: coreURL + "#" + payload });
  } catch (e) {
    if (!usingMT) throw e;
    // Shouldn't happen given the crossOriginIsolated gate above, but don't
    // leave the user stuck on a core that failed to even start loading —
    // fall back to the single-thread core instead of a hard failure.
    self.createFFmpegCore = undefined;
    usingMT = false;
    return ensureLoaded(base, font, true);
  }
  if (!ffmpeg || !ffmpeg.FS || typeof ffmpeg.FS.writeFile !== "function") {
    throw new Error("ffmpeg module did not expose FS");
  }
  ffmpeg.FS.mkdir("fonts");
  if (font) ffmpeg.FS.writeFile("fonts/DejaVuSans.ttf", new Uint8Array(font));
  // Wire ffmpeg's own progress reporting (progress 0..1, time in seconds).
  if (typeof ffmpeg.setProgress === "function") {
    ffmpeg.setProgress(({ progress, time }) => {
      self.postMessage({ type: "progress", progress: progress || 0, time: time || 0 });
    });
  }
  self.__log = [];
  if (typeof ffmpeg.setLogger === "function") {
    ffmpeg.setLogger(({ type, message }) => { self.__log.push(type + ": " + message); });
  }
  loaded = true;
}

// Runs an ffmpeg CLI invocation synchronously and returns its exit code.
function runFFmpeg(args) {
  self.__log.length = 0;
  if (ffmpeg.setTimeout) ffmpeg.setTimeout(-1);
  let ret;
  if (typeof ffmpeg.exec === "function") {
    ffmpeg.exec(...args);
    ret = ffmpeg.ret;
    if (ffmpeg.reset) ffmpeg.reset();
  } else if (typeof ffmpeg.callMain === "function") {
    ret = ffmpeg.callMain(args);
  } else {
    throw new Error("ffmpeg has no exec/callMain");
  }
  if (ret !== 0) throw new Error("ffmpeg exited with code " + ret + " | log=" + self.__log.slice(-20).join(" || "));
}

// Best-effort FS cleanup — never let a missing/already-gone file surface as
// an "error" postMessage after we've already sent a "done"/"convertDone".
function safeUnlink(name) {
  try { ffmpeg.FS.unlink(name); } catch (e) { /* ignore */ }
}

// Writes each cue's text file to ffmpeg's virtual FS and returns the
// filter-graph string for the render. The cue list and filter-chain string
// building live in lib/ffmpeg-filters.js (pure, no ffmpeg.FS dependency,
// unit-tested in web/lib/*.test.js) — this is just the thin FS-writing
// wrapper around it.
function buildCaptionFilter(subs, style, w, h, bgW, bgH) {
  const fontSize = parseInt(style.fontSize) || 68;
  const textColor = safeColor(style.textColor, "white");
  const strokeColor = safeColor(style.strokeColor, "black");
  const strokeWidth = Math.max(0, Math.min(10, parseInt(style.strokeWidth) || 3));
  const positionY = Math.max(0.05, Math.min(0.95, parseFloat(style.positionY) || 0.55));

  const cues = buildCaptionCues(subs);
  const writtenFiles = [];
  for (const cue of cues) {
    ffmpeg.FS.writeFile(cue.file, new TextEncoder().encode(cue.text));
    writtenFiles.push(cue.file);
  }

  const { filterComplex, outLabel } = buildDrawtextFilterChain({
    w, h, bgW, bgH, fontSize, textColor, strokeColor, strokeWidth, positionY, cues,
  });

  return { filterComplex, outLabel, writtenFiles };
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "render") {
      await ensureLoaded(msg.base, msg.font, msg.forceST);
      ffmpeg.FS.writeFile("bg.mp4", new Uint8Array(msg.bg));
      ffmpeg.FS.writeFile("audio.wav", new Uint8Array(msg.audio));

      const { filterComplex, outLabel, writtenFiles } =
        buildCaptionFilter(msg.subs || [], msg.style || {}, msg.w, msg.h, msg.bgW, msg.bgH);

      // Only the mt core has real OS threads for libx264 to use — on the st
      // core this would be a silent no-op, but there's no reason to ask.
      const threadArgs = usingMT
        ? ["-threads", String(Math.max(1, Math.min(8, self.navigator.hardwareConcurrency || 4)))]
        : [];

      runFFmpeg([
        "-stream_loop", "-1",
        "-i", "bg.mp4",
        "-i", "audio.wav",
        "-filter_complex", filterComplex,
        "-map", `[${outLabel}]`, "-map", "1:a",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", ...threadArgs,
        "-c:a", "aac", "-b:a", "128k", "-pix_fmt", "yuv420p",
        "-r", String(msg.fps),
        "-shortest", "-y", "out.mp4",
      ]);

      const data = ffmpeg.FS.readFile("out.mp4");
      const out = new Uint8Array(data);
      self.postMessage({ type: "done", data: out.buffer }, [out.buffer]);
      safeUnlink("bg.mp4"); safeUnlink("audio.wav"); safeUnlink("out.mp4");
      writtenFiles.forEach(safeUnlink);
    } else if (msg.type === "ready") {
      await ensureLoaded(msg.base, msg.font, msg.forceST);
      self.postMessage({ type: "ready", mt: usingMT });

    // ---- Frame-sequence conversion path: used to re-encode codecs (AV1,
    // VP9, VP8) ffmpeg.wasm can't decode into H.264. The main thread decodes
    // via the browser's own <video> element (works everywhere, unlike
    // MediaRecorder's H.264 *encode* support, which Firefox lacks) and ships
    // JPEG frames here one at a time; we assemble + encode them ourselves.
    } else if (msg.type === "convertFrame") {
      const name = "conv_" + String(msg.index).padStart(6, "0") + ".jpg";
      ffmpeg.FS.writeFile(name, new Uint8Array(msg.data));
    } else if (msg.type === "convertFinish") {
      const fps = msg.fps || 12;
      runFFmpeg([
        "-framerate", String(fps), "-i", "conv_%06d.jpg",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-y", "converted.mp4",
      ]);
      const data = ffmpeg.FS.readFile("converted.mp4");
      const out = new Uint8Array(data);
      self.postMessage({ type: "convertDone", data: out.buffer }, [out.buffer]);
      for (let i = 0; i < msg.frameCount; i++) {
        safeUnlink("conv_" + String(i).padStart(6, "0") + ".jpg");
      }
      safeUnlink("converted.mp4");
    }
  } catch (err) {
    self.postMessage({ type: "error", message: (err && err.message) || String(err) });
  }
};
