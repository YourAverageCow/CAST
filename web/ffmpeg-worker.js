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

async function ensureLoaded(base, fonts, forceST) {
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
    return ensureLoaded(base, fonts, true);
  }
  if (!ffmpeg || !ffmpeg.FS || typeof ffmpeg.FS.writeFile !== "function") {
    throw new Error("ffmpeg module did not expose FS");
  }
  ffmpeg.FS.mkdir("fonts");
  if (fonts) {
    for (const f of fonts) ffmpeg.FS.writeFile("fonts/" + f.file, new Uint8Array(f.buf));
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

// Writes each cue's text file to ffmpeg's virtual FS and returns the
// filter-graph string for the render. The cue list and filter-chain string
// building live in lib/ffmpeg-filters.js (pure, no ffmpeg.FS dependency,
// unit-tested in web/lib/*.test.js) — this is just the thin FS-writing
// wrapper around it.
// `parseInt(x) || default` silently replaces a legitimate 0 (no stroke, no
// shadow offset) with the fallback, since 0 is falsy — mirrors web/app.js's
// numOr()/server.js's numOr(), the equivalent fix for the same style object
// on the other two backends (native render, and where the client itself
// first builds this object).
function numOr(raw, parseFn, fallback) {
  const n = parseFn(raw);
  return Number.isFinite(n) ? n : fallback;
}

function buildCaptionFilter(subs, karaokeGroups, style, w, h, bgW, bgH) {
  const fontSize = numOr(style.fontSize, parseInt, 68);
  const textColor = safeColor(style.textColor, "white");
  const strokeColor = safeColor(style.strokeColor, "black");
  const strokeWidth = Math.max(0, Math.min(10, numOr(style.strokeWidth, parseInt, 3)));
  const positionY = Math.max(0.05, Math.min(0.95, numOr(style.positionY, parseFloat, 0.55)));
  const grouping = style.captionGrouping || "phrase";

  const cues = grouping === "karaoke"
    ? buildKaraokeCues(karaokeGroups || [], !!style.uppercase)
    : buildCaptionCues(subs, !!style.uppercase);
  const writtenFiles = [];
  for (const cue of cues) {
    ffmpeg.FS.writeFile(cue.file, new TextEncoder().encode(cue.text));
    writtenFiles.push(cue.file);
  }

  const { filterComplex, outLabel } = buildDrawtextFilterChain({
    w, h, bgW, bgH, fontFile: style.fontFile || "DejaVuSans.ttf",
    fontSize, textColor, strokeColor, strokeWidth, positionY,
    highlightColor: safeColor(style.highlightColor, "yellow"),
    box: !!style.box, boxColor: safeColor(style.boxColor, "black"),
    boxAlpha: numOr(style.boxAlpha, parseFloat, 0.5),
    boxBorderW: numOr(style.boxBorderW, parseInt, 16),
    boxBevel: Math.max(0, Math.min(20, numOr(style.boxBevel, parseInt, 0))),
    shadow: !!style.shadow, shadowColor: safeColor(style.shadowColor, "black"),
    shadowX: numOr(style.shadowX, parseInt, 2), shadowY: numOr(style.shadowY, parseInt, 2),
    entrance: ["none", "fade", "pop"].includes(style.entrance) ? style.entrance : "none",
    grouping, cues,
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

      const hasMusic = !!msg.music;
      const hasTitleCard = !!(msg.titleCard && msg.titleCard.imageBytes);
      const cardDurationSec = hasTitleCard ? (msg.titleCard.cardDurationSec || 0) : 0;
      // Distinct from cardDurationSec: when the card shows the story's own
      // auto-extracted first line, its narration plays unshifted (0 delay)
      // in sync with the card, so the two only coincidentally match when a
      // custom title falls back to the old fixed-delay behavior — see
      // app.js's runJob for which case sets which value.
      const narrationDelaySec = hasTitleCard ? (msg.titleCard.narrationDelaySec || 0) : 0;
      if (hasMusic) ffmpeg.FS.writeFile("music.mp3", new Uint8Array(msg.music));
      if (hasTitleCard) ffmpeg.FS.writeFile("titlecard.png", new Uint8Array(msg.titleCard.imageBytes));

      let { filterComplex: videoFC, outLabel: videoOutLabel, writtenFiles } =
        buildCaptionFilter(msg.subs || [], msg.karaokeGroups, msg.style || {}, msg.w, msg.h, msg.bgW, msg.bgH);

      // Input indices: 0=bg (looped), 1=narration, then whichever of
      // music/title-card are actually present, in that order.
      let nextInput = 2;
      const musicInputIndex = hasMusic ? nextInput++ : null;
      const titleCardInputIndex = hasTitleCard ? nextInput++ : null;

      if (hasTitleCard) {
        const overlay = buildTitleCardOverlay({
          videoFilterComplex: videoFC, videoOutLabel,
          w: msg.w, h: msg.h, titleCardInputIndex, cardDurationSec,
        });
        videoFC = overlay.filterComplex;
        videoOutLabel = overlay.outLabel;
      }
      // narrationDelaySec is 0 whenever the card's own duration already
      // matches the spoken length of what it displays (app.js keeps caption
      // cue timings unshifted to match); otherwise it silence-pads narration
      // by adelay so speech starts only once the card's window ends, with
      // caption cues shifted by the same amount before they reach this worker.
      let audio = buildAudioFilterChain({
        narrationInputIndex: 1, musicInputIndex, musicVolume: msg.musicVolume, delaySec: narrationDelaySec,
      });
      const speed = Math.max(1, Math.min(2, numOr(msg.speed, parseFloat, 1)));
      if (speed !== 1) {
        const sped = applyPlaybackSpeed({
          videoFilterComplex: videoFC, videoOutLabel, audioFilterChain: audio.filterChain, audioOutLabel: audio.outLabel, speed,
        });
        videoFC = sped.videoFilterComplex; videoOutLabel = sped.videoOutLabel;
        audio = { filterChain: sped.audioFilterChain, outLabel: sped.audioOutLabel };
      }
      const filterComplex = `${videoFC};${audio.filterChain}`;

      const inputArgs = ["-stream_loop", "-1", "-i", "bg.mp4", "-i", "audio.wav"];
      if (hasMusic) inputArgs.push("-i", "music.mp3");
      // -loop 1 alone makes this an unbounded stream with no framerate of
      // its own — pin both explicitly (matching the main output's fps, and
      // a duration comfortably past when the overlay stops drawing it) so
      // it can't desync from -shortest's bound on the other streams or
      // starve the overlay filter waiting on frames at a mismatched rate.
      if (hasTitleCard) {
        inputArgs.push("-loop", "1", "-framerate", String(msg.fps), "-t", String(cardDurationSec + 1), "-i", "titlecard.png");
      }

      // Only the mt core has real OS threads for libx264 to use — on the st
      // core this would be a silent no-op, but there's no reason to ask. No
      // upper clamp beyond hardwareConcurrency itself: this only ever runs
      // in a pool of exactly one worker (forceST kicks in above that), so
      // there's no oversubscription risk from using every reported core.
      const threadArgs = usingMT
        ? ["-threads", String(Math.max(1, self.navigator.hardwareConcurrency || 4))]
        : [];

      // -shortest alone was observed to let the (infinitely-looped)
      // background run well past the narration's real end once a title-card
      // overlay input was added to the graph — give the encode an explicit
      // hard stop, computed from the narration's actual WAV duration, as a
      // belt-and-suspenders bound rather than trusting -shortest here.
      const durationArgs = [];
      if (hasTitleCard) {
        const narrDurationSec = parseWavDurationSec(new Uint8Array(msg.audio));
        if (narrDurationSec) durationArgs.push("-t", (cardDurationSec + narrDurationSec + 0.5).toFixed(3));
      }

      runFFmpeg([
        ...inputArgs,
        "-filter_complex", filterComplex,
        "-map", `[${videoOutLabel}]`, "-map", `[${audio.outLabel}]`,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", String(msg.crf || 28), ...threadArgs,
        "-c:a", "aac", "-b:a", "128k", "-pix_fmt", "yuv420p",
        "-r", String(msg.fps),
        "-shortest", ...durationArgs, "-y", "out.mp4",
      ]);

      const data = ffmpeg.FS.readFile("out.mp4");
      const out = new Uint8Array(data);
      self.postMessage({ type: "done", data: out.buffer }, [out.buffer]);
      safeUnlink("bg.mp4"); safeUnlink("audio.wav"); safeUnlink("out.mp4");
      if (hasMusic) safeUnlink("music.mp3");
      if (hasTitleCard) safeUnlink("titlecard.png");
      writtenFiles.forEach(safeUnlink);
    } else if (msg.type === "ready") {
      await ensureLoaded(msg.base, msg.fonts, msg.forceST);
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
