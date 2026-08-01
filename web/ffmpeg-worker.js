// ffmpeg worker — runs rendering off the main thread so the UI never freezes.
// The multi-threaded core (vendor/ffmpeg/mt/) lets libx264 use every core
// instead of one, but it needs SharedArrayBuffer, which only exists when
// this worker is itself cross-origin isolated (same prerequisite Piper's
// threaded ONNX runtime already relies on, via coi-serviceworker.js). We
// pick the core to load lazily, once, based on that — no static
// importScripts at module load time like before.
let ffmpeg = null;
let loaded = false;
let usingMT = false;

async function ensureLoaded(base, font) {
  if (loaded) return;
  usingMT = self.crossOriginIsolated === true && typeof SharedArrayBuffer !== "undefined";
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
    return ensureLoaded(base, font);
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

// One drawtext instance, driven by sendcmd swapping its `textfile` at each
// cue's start/end timestamp via the `reinit` command. drawtext's own AVOption
// table only flags `text` as directly runtime-settable — `textfile` is not,
// so sending it as a bare command (as this used to) is silently rejected by
// ffmpeg and the on-screen text never advances past the initial empty file.
// `reinit` (documented, always supported) re-applies a `key=value` option
// string on top of the filter's current options, so `textfile=<file>` here
// swaps just that one option while leaving fontsize/color/etc. untouched.
// Previously this chained a *separate* drawtext filter per cue
// (each gated by enable='between(t,...)') — for a full story that's
// routinely 100+ filter nodes every single output frame has to pass
// through, which is the dominant cost in render time. sendcmd collapses
// that to two filter nodes total, independent of caption count, with the
// same visual result. drawtext uses FreeType directly against an exact
// font file — unlike the `subtitles` (libass) filter, it doesn't need a
// font *provider* (fontconfig/CoreText/DirectWrite), which this WASM build
// doesn't have, so this is what actually renders visible glyphs. Cue text
// goes in its own file rather than inline in the command script, since
// arbitrary story text would easily break the sendcmd/filter-graph string
// parsers' own comma/colon/quote escaping rules.
function buildCaptionFilter(subs, style, w, h, bgW, bgH) {
  const fontSize = parseInt(style.fontSize) || 68;
  const textColor = safeColor(style.textColor, "white");
  const strokeColor = safeColor(style.strokeColor, "black");
  const strokeWidth = Math.max(0, Math.min(10, parseInt(style.strokeWidth) || 3));
  const positionY = Math.max(0.05, Math.min(0.95, parseFloat(style.positionY) || 0.55));

  const writtenFiles = ["capempty.txt"];
  ffmpeg.FS.writeFile("capempty.txt", new Uint8Array(0));

  const events = []; // {time, file}
  let i = 0;
  for (const s of subs) {
    if (s.end - s.start < 0.04) continue;
    const text = (s.text || "").trim();
    if (!text) continue;
    const fname = "cap" + String(i).padStart(5, "0") + ".txt";
    ffmpeg.FS.writeFile(fname, new TextEncoder().encode(text));
    writtenFiles.push(fname);
    events.push({ time: s.start, file: fname });
    events.push({ time: s.end, file: "capempty.txt" });
    i++;
  }
  // Stable sort: for two events at the identical timestamp (a cue's end
  // exactly meeting the next cue's start), insertion order is preserved,
  // and since each cue pushes [start, end] in that order across cues
  // processed chronologically, "show next cue" always lands after
  // "clear this cue" at a tie — text wins over a blank gap, as intended.
  events.sort((a, b) => a.time - b.time);
  const cmds = events.map(e => `${e.time.toFixed(3)} drawtext@cap reinit 'textfile=${e.file}';`).join("\n");
  ffmpeg.FS.writeFile("cmds.txt", new TextEncoder().encode(cmds));
  writtenFiles.push("cmds.txt");

  // Background is already at the target resolution (the common case for a
  // purpose-shot/pre-cropped clip) — skip scale+crop entirely rather than
  // running that per-frame work for a no-op.
  const needsScale = !(bgW && bgH && bgW === w && bgH === h);
  const vf =
    (needsScale ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},` : "") +
    `sendcmd=f=cmds.txt,` +
    `drawtext@cap=fontfile=fonts/DejaVuSans.ttf:textfile=capempty.txt:fontsize=${fontSize}` +
    `:fontcolor=${textColor}:borderw=${strokeWidth}:bordercolor=${strokeColor}` +
    `:x=(w-text_w)/2:y=h*${positionY}-text_h/2`;

  return { filterComplex: `[0:v]${vf}[vout]`, outLabel: "vout", writtenFiles };
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "render") {
      await ensureLoaded(msg.base, msg.font);
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
      await ensureLoaded(msg.base, msg.font);
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
