// ffmpeg worker — runs rendering off the main thread so the UI never freezes.
importScripts("./vendor/ffmpeg/ffmpeg-core.js");

let ffmpeg = null;
let loaded = false;

async function ensureLoaded(base, font) {
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

// Only allow plain color names or hex, since this gets interpolated straight
// into an ffmpeg filter-graph string.
function safeColor(c, fallback) {
  if (typeof c !== "string") return fallback;
  c = c.trim();
  if (/^[a-zA-Z]+$/.test(c)) return c;
  if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(c)) return c;
  if (/^0x[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(c)) return c;
  return fallback;
}

// Build a chained drawtext filter graph, one filter per caption cue, each
// gated by enable='between(t,start,end)'. drawtext uses FreeType directly
// against an exact font file — unlike the `subtitles` (libass) filter, it
// doesn't need a font *provider* (fontconfig/CoreText/DirectWrite), which
// this WASM build doesn't have, so this is what actually renders visible
// glyphs. Each cue's text goes in its own file (FS.writeFile) rather than
// inline in the filter string, since ffmpeg's filter-graph string parser has
// its own comma/colon/quote escaping rules that arbitrary story text would
// easily break.
function buildCaptionFilter(subs, style, w, h) {
  const fontSize = parseInt(style.fontSize) || 68;
  const textColor = safeColor(style.textColor, "white");
  const strokeColor = safeColor(style.strokeColor, "black");
  const strokeWidth = Math.max(0, Math.min(10, parseInt(style.strokeWidth) || 3));
  const positionY = Math.max(0.05, Math.min(0.95, parseFloat(style.positionY) || 0.55));

  // Loop inside the filter graph (not via -stream_loop on the input) so frame
  // timestamps stay continuous across loop cycles — -stream_loop restarts the
  // demuxer each cycle, and depending on the input's own timestamps that can
  // reset `t` back near 0, which would make enable='between(t,...)' never
  // fire for any caption past the first loop.
  const chain = [`[0:v]loop=loop=-1:size=32767:start=0,scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}[base0]`];
  const writtenFiles = [];
  let prev = "base0";
  let i = 0;
  for (const s of subs) {
    if (s.end - s.start < 0.04) continue;
    const text = (s.text || "").trim();
    if (!text) continue;
    const fname = "cap" + String(i).padStart(5, "0") + ".txt";
    ffmpeg.FS.writeFile(fname, new TextEncoder().encode(text));
    writtenFiles.push(fname);
    const next = "v" + i;
    chain.push(
      `[${prev}]drawtext=fontfile=fonts/DejaVuSans.ttf:textfile=${fname}:fontsize=${fontSize}` +
      `:fontcolor=${textColor}:borderw=${strokeWidth}:bordercolor=${strokeColor}` +
      `:x=(w-text_w)/2:y=h*${positionY}-text_h/2` +
      `:enable='between(t,${s.start.toFixed(3)},${s.end.toFixed(3)})'[${next}]`
    );
    prev = next;
    i++;
  }
  return { filterComplex: chain.join(";"), outLabel: prev, writtenFiles };
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "render") {
      await ensureLoaded(msg.base, msg.font);
      ffmpeg.FS.writeFile("bg.mp4", new Uint8Array(msg.bg));
      ffmpeg.FS.writeFile("audio.wav", new Uint8Array(msg.audio));

      const { filterComplex, outLabel, writtenFiles } =
        buildCaptionFilter(msg.subs || [], msg.style || {}, msg.w, msg.h);

      runFFmpeg([
        "-i", "bg.mp4",
        "-i", "audio.wav",
        "-filter_complex", filterComplex,
        "-map", `[${outLabel}]`, "-map", "1:a",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
        "-c:a", "aac", "-b:a", "128k", "-pix_fmt", "yuv420p",
        "-r", String(msg.fps),
        "-shortest", "-y", "out.mp4",
      ]);

      const data = ffmpeg.FS.readFile("out.mp4");
      const out = new Uint8Array(data);
      self.postMessage({
        type: "done", data: out.buffer,
        debug: { filterComplex, cueCount: writtenFiles.length, log: self.__log.slice(-30) },
      }, [out.buffer]);
      safeUnlink("bg.mp4"); safeUnlink("audio.wav"); safeUnlink("out.mp4");
      writtenFiles.forEach(safeUnlink);
    } else if (msg.type === "ready") {
      await ensureLoaded(msg.base, msg.font);
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
