// ffmpeg worker — runs rendering off the main thread so the UI never freezes.
importScripts("./vendor/ffmpeg/ffmpeg-core.js");

let ffmpeg = null;
let loaded = false;

async function ensureLoaded(base) {
  if (loaded) return;
  const coreURL = base + "vendor/ffmpeg/ffmpeg-core.js";
  const wasmURL = base + "vendor/ffmpeg/ffmpeg-core.wasm";
  const payload = btoa(JSON.stringify({ wasmURL, workerURL: coreURL }));
  const result = self.createFFmpegCore({
    mainScriptUrlOrBlob: coreURL + "#" + payload,
  });
  ffmpeg = await result;
  if (!ffmpeg || !ffmpeg.FS || typeof ffmpeg.FS.writeFile !== "function") {
    throw new Error("ffmpeg module did not expose FS");
  }
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

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "render") {
      await ensureLoaded(msg.base);
      ffmpeg.FS.writeFile("bg.mp4", new Uint8Array(msg.bg));
      ffmpeg.FS.writeFile("audio.wav", new Uint8Array(msg.audio));
      const assBytes = typeof msg.ass === "string"
        ? new TextEncoder().encode(msg.ass)
        : new Uint8Array(msg.ass);
      ffmpeg.FS.writeFile("subs.ass", assBytes);

      const vf = `scale=${msg.w}:${msg.h}:force_original_aspect_ratio=increase,crop=${msg.w}:${msg.h},subtitles=subs.ass`;
      runFFmpeg([
        "-stream_loop", "-1",
        "-i", "bg.mp4",
        "-i", "audio.wav",
        "-filter_complex", `[0:v]${vf}[v]`,
        "-map", "[v]", "-map", "1:a",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
        "-c:a", "aac", "-b:a", "128k", "-pix_fmt", "yuv420p",
        "-r", String(msg.fps),
        "-shortest", "-y", "out.mp4",
      ]);

      const data = ffmpeg.FS.readFile("out.mp4");
      const out = new Uint8Array(data);
      self.postMessage({ type: "done", data: out.buffer }, [out.buffer]);
      safeUnlink("bg.mp4"); safeUnlink("audio.wav");
      safeUnlink("subs.ass"); safeUnlink("out.mp4");
    } else if (msg.type === "ready") {
      await ensureLoaded(msg.base);
      self.postMessage({ type: "ready" });

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
