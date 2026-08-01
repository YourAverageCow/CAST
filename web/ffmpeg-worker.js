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
      const args = [
        "-stream_loop", "-1",
        "-i", "bg.mp4",
        "-i", "audio.wav",
        "-filter_complex", `[0:v]${vf}[v]`,
        "-map", "[v]", "-map", "1:a",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
        "-c:a", "aac", "-b:a", "128k", "-pix_fmt", "yuv420p",
        "-r", String(msg.fps),
        "-shortest", "-y", "out.mp4",
      ];

      self.__log.length = 0;
      if (ffmpeg.setTimeout) ffmpeg.setTimeout(-1);
      if (typeof ffmpeg.exec === "function") {
        ffmpeg.exec(...args);
        const ret = ffmpeg.ret;
        if (ffmpeg.reset) ffmpeg.reset();
        if (ret !== 0) throw new Error("ffmpeg exited with code " + ret + " | log=" + self.__log.slice(-20).join(" || "));
      } else if (typeof ffmpeg.callMain === "function") {
        const ret = ffmpeg.callMain(args);
        if (ret !== 0) throw new Error("ffmpeg exited with code " + ret + " | log=" + self.__log.slice(-20).join(" || "));
      } else {
        throw new Error("ffmpeg has no exec/callMain");
      }

      const data = ffmpeg.FS.readFile("out.mp4");
      const out = new Uint8Array(data);
      self.postMessage({ type: "done", data: out.buffer }, [out.buffer]);
    } else if (msg.type === "ready") {
      await ensureLoaded(msg.base);
      self.postMessage({ type: "ready" });
    }
  } catch (err) {
    self.postMessage({ type: "error", message: (err && err.message) || String(err) });
  }
};
