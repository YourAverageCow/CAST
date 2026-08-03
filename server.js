#!/usr/bin/env node
// Static server for the web version, PLUS (new) a native rendering backend.
//
// Run:  node server.js
// Then open http://localhost:8123
// Everything (TTS engine, video engine, UI) is served from the web/ folder.
//
// A real HTTP server (not a file:// open) is required because the app needs
// COOP/COEP headers for cross-origin isolation (SharedArrayBuffer, threaded
// wasm) — browsers won't grant that to files opened directly from disk.
//
// This file used to be pure static serving. It now also exposes a render
// backend that shells out to the user's own installed `ffmpeg` instead of
// ffmpeg.wasm — real native rendering is faster and doesn't hang the way the
// WASM multi-thread core occasionally does. This is purely additive: the
// deployed GitHub Pages build has no server, so it always falls back to the
// original WASM path automatically (see web/app.js's native-probe-then-
// fallback logic) — nothing here changes what that build does.
//
// Deliberately zero npm dependencies itself, matching the rest of this repo
// — the render path reuses web/lib/ffmpeg-filters.js's pure filter-graph
// builders directly via require() (already Node-compatible; that's how its
// own tests run) and only Node builtins (http/fs/path/child_process/crypto)
// otherwise. Also required (not just run as a CLI entrypoint) by
// electron/main.js, which starts this exact same backend in-process for the
// standalone app — everything below runs identically either way.
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");

const PORT = 8123;
const ROOT = path.join(__dirname, "web");
const FONT_PATH = path.join(ROOT, "vendor", "fonts", "DejaVuSans.ttf");

const {
  safeColor, buildCaptionCues, buildDrawtextFilterChain,
  buildAudioFilterChain, buildTitleCardOverlay, parseWavDurationSec,
} = require(path.join(ROOT, "lib", "ffmpeg-filters.js"));

// ---------- ffmpeg availability ----------
// Not just "does `ffmpeg` exist" — captions are burned in via the drawtext
// filter, which needs ffmpeg built with libfreetype. Plenty of real ffmpeg
// installs (confirmed on this exact machine's homebrew build) omit it, so
// checking `-version` alone would report "available" and then fail every
// single render with an opaque "No such filter" error. Treat "no drawtext"
// the same as "no ffmpeg" — /render-capability reports unavailable either
// way, and the client falls back to the WASM path automatically, which
// bundles its own drawtext-capable ffmpeg core.
let ffmpegAvailable = null; // null = not checked yet, else boolean
function checkFfmpeg(cb) {
  if (ffmpegAvailable !== null) { cb(ffmpegAvailable); return; }
  execFile("ffmpeg", ["-filters"], (err, stdout) => {
    ffmpegAvailable = !err && /drawtext/.test(stdout || "");
    cb(ffmpegAvailable);
  });
}

// ---------- whisper availability ----------
// Same shape as checkFfmpeg — cached, and checks for a specific capability
// (word_timestamps support showing up in --help) rather than just "does a
// binary named `whisper` exist", so an ancient/incompatible install reports
// unavailable instead of failing every single transcription request.
let whisperAvailable = null; // null = not checked yet, else boolean
function checkWhisper(cb) {
  if (whisperAvailable !== null) { cb(whisperAvailable); return; }
  execFile("whisper", ["--help"], (err, stdout) => {
    whisperAvailable = !err && /word_timestamps/.test(stdout || "");
    cb(whisperAvailable);
  });
}

// ---------- concurrency limiter ----------
// Mirrors FFmpegWorkerPool's job (web/worker-pool.js) for native processes —
// batch "Generate All" can fire off several renders (and now transcriptions)
// at once; cap how many real subprocesses of a given kind run concurrently.
// Rendering (ffmpeg) and transcription (whisper, CPU/PyTorch-heavy) are
// different resource profiles, so each kind gets its own independent limiter
// rather than sharing one pool — a render and a transcribe can run at once
// without either starving the other's queue.
//
// max is mutable (setMax) rather than fixed at construction — the client can
// raise or lower it at runtime via POST /performance-settings (Settings ->
// Performance), so a batch already queued respects a change immediately
// rather than needing a server restart.
function makeSlotLimiter(max) {
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
      // A raised cap may free up waiters immediately.
      while (active < state.max && queue.length) queue.shift()();
    },
    getMax() { return state.max; },
  };
}
// Default to every core — the user explicitly wants max resource usage by
// default; Settings -> Performance lets them dial back to leave headroom for
// the OS/UI if a full-throttle batch render makes the machine unresponsive.
const CPU_COUNT = os.cpus().length;
const renderLimiter = makeSlotLimiter(CPU_COUNT);
const transcribeLimiter = makeSlotLimiter(CPU_COUNT);
function clampConcurrency(n) {
  n = parseInt(n, 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(CPU_COUNT, n));
}
// Per-job thread budget: divide the core count across however many jobs of
// that kind are currently allowed to run at once, so N concurrent renders
// together target ~100% of cores instead of each auto-detecting and
// fighting the others for every core (ffmpeg/whisper both default to
// "use all cores" when no thread count is given).
function threadBudget(limiter) {
  return Math.max(1, Math.floor(CPU_COUNT / limiter.getMax()));
}

// ---------- SSE progress channels ----------
// Keyed by a client-generated render id: the client opens an SSE connection
// on /render-progress/:id BEFORE posting the binary payload to /render, so
// the id correlates the two requests. Plain Node http, no ws/sse library.
const progressChannels = new Map();
function sendProgress(id, pct) {
  const res = progressChannels.get(id);
  if (res) res.write(`data: ${JSON.stringify({ pct })}\n\n`);
}
function closeProgressChannel(id) {
  const res = progressChannels.get(id);
  if (res) { res.end(); progressChannels.delete(id); }
}

// ---------- binary request framing ----------
// No multipart parser (zero dependencies) — a simple length-prefixed frame
// instead: [4 bytes LE uint32: JSON metadata length][JSON metadata][bg
// bytes][audio bytes][music bytes if meta.hasMusic][title-card PNG bytes if
// meta.hasTitleCard]. Metadata carries each segment's byte length plus every
// non-binary field runJob already sends to the WASM worker (subs, style,
// w/h/fps, bgW/bgH, musicVolume, titleCard timing). Mirrors web/app.js's
// renderVideoNatively(), which builds this exact frame client-side.
function parseRenderBody(body) {
  const metaLen = body.readUInt32LE(0);
  const meta = JSON.parse(body.subarray(4, 4 + metaLen).toString("utf8"));
  let offset = 4 + metaLen;
  const bg = body.subarray(offset, offset + meta.bgLen); offset += meta.bgLen;
  const audio = body.subarray(offset, offset + meta.audioLen); offset += meta.audioLen;
  let music = null, titleCardImage = null;
  if (meta.hasMusic) { music = body.subarray(offset, offset + meta.musicLen); offset += meta.musicLen; }
  if (meta.hasTitleCard) { titleCardImage = body.subarray(offset, offset + meta.titleCardImageLen); offset += meta.titleCardImageLen; }
  return { meta, bg, audio, music, titleCardImage };
}

// Builds the exact same filter-graph/args ffmpeg-worker.js constructs for
// the WASM path (see that file's `self.onmessage` "render" case) — only the
// exec mechanism differs (child_process vs ffmpeg.wasm's FS+exec). Writes
// inputs into `dir` and returns the full ffmpeg CLI args array plus the
// expected total output duration (for progress-percentage math).
function buildRenderArgs(dir, meta, bg, audio, music, titleCardImage) {
  fs.writeFileSync(path.join(dir, "bg.mp4"), bg);
  fs.writeFileSync(path.join(dir, "audio.wav"), audio);
  const hasMusic = !!music;
  const hasTitleCard = !!titleCardImage;
  const cardDurationSec = hasTitleCard ? (meta.titleCard.cardDurationSec || 0) : 0;
  const narrationDelaySec = hasTitleCard ? (meta.titleCard.narrationDelaySec || 0) : 0;
  if (hasMusic) fs.writeFileSync(path.join(dir, "music.mp3"), music);
  if (hasTitleCard) fs.writeFileSync(path.join(dir, "titlecard.png"), titleCardImage);

  fs.mkdirSync(path.join(dir, "fonts"));
  fs.copyFileSync(FONT_PATH, path.join(dir, "fonts", "DejaVuSans.ttf"));

  const style = meta.style || {};
  const cues = buildCaptionCues(meta.subs || []);
  for (const cue of cues) fs.writeFileSync(path.join(dir, cue.file), cue.text);
  let { filterComplex: videoFC, outLabel: videoOutLabel } = buildDrawtextFilterChain({
    w: meta.w, h: meta.h, bgW: meta.bgW, bgH: meta.bgH,
    fontSize: parseInt(style.fontSize) || 68,
    textColor: safeColor(style.textColor, "white"),
    strokeColor: safeColor(style.strokeColor, "black"),
    strokeWidth: parseInt(style.strokeWidth) || 3,
    positionY: parseFloat(style.positionY) || 0.55,
    cues,
  });

  let nextInput = 2;
  const musicInputIndex = hasMusic ? nextInput++ : null;
  const titleCardInputIndex = hasTitleCard ? nextInput++ : null;

  if (hasTitleCard) {
    const overlay = buildTitleCardOverlay({
      videoFilterComplex: videoFC, videoOutLabel,
      w: meta.w, h: meta.h, titleCardInputIndex, cardDurationSec,
    });
    videoFC = overlay.filterComplex;
    videoOutLabel = overlay.outLabel;
  }
  const audioChain = buildAudioFilterChain({
    narrationInputIndex: 1, musicInputIndex, musicVolume: meta.musicVolume, delaySec: narrationDelaySec,
  });
  const filterComplex = `${videoFC};${audioChain.filterChain}`;

  const inputArgs = ["-stream_loop", "-1", "-i", "bg.mp4", "-i", "audio.wav"];
  if (hasMusic) inputArgs.push("-i", "music.mp3");
  if (hasTitleCard) {
    inputArgs.push("-loop", "1", "-framerate", String(meta.fps), "-t", String(cardDurationSec + 1), "-i", "titlecard.png");
  }

  const durationArgs = [];
  let expectedDurationSec = parseWavDurationSec(audio) || 0;
  if (hasTitleCard) {
    const narrDurationSec = parseWavDurationSec(audio);
    if (narrDurationSec) {
      const bound = cardDurationSec + narrDurationSec + 0.5;
      durationArgs.push("-t", bound.toFixed(3));
      expectedDurationSec = bound;
    }
  }

  // Explicit thread budget (see threadBudget() above) rather than leaving
  // -threads/-filter_complex_threads unset — unset means "auto-detect and
  // use every core", which is fine for a single render but means N
  // concurrent renders all fight over the same cores instead of sharing them.
  const threads = String(threadBudget(renderLimiter));
  const args = [
    ...inputArgs,
    "-filter_complex_threads", threads,
    "-filter_complex", filterComplex,
    "-map", `[${videoOutLabel}]`, "-map", `[${audioChain.outLabel}]`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-threads", threads,
    "-c:a", "aac", "-b:a", "128k", "-pix_fmt", "yuv420p",
    "-r", String(meta.fps),
    "-shortest", ...durationArgs,
    "-progress", "pipe:1", "-y", "out.mp4",
  ];
  return { args, expectedDurationSec };
}

function runNativeRender(renderId, meta, bg, audio, music, titleCardImage, respond) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopdaddy-render-"));
  const cleanup = () => { fs.rm(dir, { recursive: true, force: true }, () => {}); };
  let args, expectedDurationSec;
  try {
    ({ args, expectedDurationSec } = buildRenderArgs(dir, meta, bg, audio, music, titleCardImage));
  } catch (e) {
    cleanup();
    respond(500, { error: "Failed to build render: " + e.message });
    return;
  }
  const proc = spawn("ffmpeg", args, { cwd: dir });
  let stderrTail = "";
  proc.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });
  let stdoutBuf = "";
  proc.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop();
    for (const line of lines) {
      const m = /^out_time_ms=(\d+)/.exec(line);
      if (m && expectedDurationSec > 0) {
        const pct = Math.min(99, Math.round((parseInt(m[1], 10) / 1e6 / expectedDurationSec) * 100));
        sendProgress(renderId, pct);
      }
    }
  });
  proc.on("error", (err) => {
    cleanup();
    respond(500, { error: "Couldn't run ffmpeg: " + err.message });
  });
  proc.on("close", (code) => {
    if (code !== 0) {
      cleanup();
      respond(500, { error: `ffmpeg exited with code ${code}\n${stderrTail.slice(-1000)}` });
      return;
    }
    sendProgress(renderId, 100);
    let data;
    try {
      data = fs.readFileSync(path.join(dir, "out.mp4"));
    } catch (e) {
      cleanup();
      respond(500, { error: "Render finished but output was missing: " + e.message });
      return;
    }
    cleanup();
    respond(200, data, "video/mp4");
  });
}

// Shells out to the user's own `whisper` CLI (openai-whisper) instead of any
// in-browser ASR — real per-word timestamps from actually transcribing the
// generated audio. Mirrors runNativeRender's temp-dir/cleanup/respond
// conventions exactly; only the subprocess and output-parsing differ.
// --fp16 False avoids a CPU-only slowdown/warning (confirmed live on this
// machine: fp16 needs CUDA, and warns+degrades on CPU/Apple Silicon).
function runNativeTranscribe(transcribeId, audio, respond) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopdaddy-transcribe-"));
  const cleanup = () => { fs.rm(dir, { recursive: true, force: true }, () => {}); };
  fs.writeFileSync(path.join(dir, "audio.wav"), audio);

  sendProgress(transcribeId, 10);
  const proc = spawn("whisper", [
    path.join(dir, "audio.wav"),
    "--model", "tiny.en",
    "--word_timestamps", "True",
    "--output_format", "json",
    "--output_dir", dir,
    "--fp16", "False",
    "--threads", String(threadBudget(transcribeLimiter)),
  ], { cwd: dir });
  let stderrTail = "";
  proc.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });
  proc.on("error", (err) => {
    cleanup();
    respond(500, { error: "Couldn't run whisper: " + err.message });
  });
  proc.on("close", (code) => {
    if (code !== 0) {
      cleanup();
      respond(500, { error: `whisper exited with code ${code}\n${stderrTail.slice(-1000)}` });
      return;
    }
    sendProgress(transcribeId, 90);
    let json;
    try {
      // whisper names its output <input-basename>.json in --output_dir.
      json = JSON.parse(fs.readFileSync(path.join(dir, "audio.json"), "utf8"));
    } catch (e) {
      cleanup();
      respond(500, { error: "Transcription finished but output was missing/malformed: " + e.message });
      return;
    }
    cleanup();
    // Confirmed live against a real whisper run: segments[].words[] each
    // {word, start, end, probability}, `word` with a leading space — flatten
    // into the {text,start,end} shape alignWordsBySequence expects.
    const words = (json.segments || []).flatMap(seg =>
      (seg.words || []).map(w => ({ text: (w.word || "").trim(), start: w.start, end: w.end }))
    );
    sendProgress(transcribeId, 100);
    respond(200, { words });
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function log(req) {
  console.log(`[${new Date().toISOString()}] ${req.socket.remoteAddress} ${req.method} ${req.url}`);
}

const server = http.createServer((req, res) => {
  log(req);

  const urlNoQuery = req.url.split("?")[0];

  // ---- Native render backend routes (see the block above) ----
  if (urlNoQuery === "/render-capability" && req.method === "GET") {
    checkFfmpeg((available) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ available, cpuCount: CPU_COUNT }));
    });
    return;
  }
  if (urlNoQuery === "/performance-settings" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Malformed JSON body" }));
        return;
      }
      const renderConcurrency = clampConcurrency(body.renderConcurrency);
      const transcribeConcurrency = clampConcurrency(body.transcribeConcurrency);
      if (renderConcurrency !== null) renderLimiter.setMax(renderConcurrency);
      if (transcribeConcurrency !== null) transcribeLimiter.setMax(transcribeConcurrency);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        renderConcurrency: renderLimiter.getMax(),
        transcribeConcurrency: transcribeLimiter.getMax(),
      }));
    });
    return;
  }
  if (urlNoQuery.startsWith("/render-progress/") && req.method === "GET") {
    const id = urlNoQuery.slice("/render-progress/".length);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    progressChannels.set(id, res);
    req.on("close", () => { progressChannels.delete(id); });
    return;
  }
  if (urlNoQuery === "/render" && req.method === "POST") {
    const id = new URL(req.url, "http://localhost").searchParams.get("id") || crypto.randomUUID();
    checkFfmpeg((available) => {
      if (!available) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "ffmpeg isn't installed (or not on PATH) — install it and restart the server." }));
        return;
      }
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        const body = Buffer.concat(chunks);
        let parsed;
        try {
          parsed = parseRenderBody(body);
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Malformed render request: " + e.message }));
          return;
        }
        await renderLimiter.acquire();
        const respond = (status, data, contentType) => {
          renderLimiter.release();
          closeProgressChannel(id);
          if (contentType) {
            res.writeHead(status, { "Content-Type": contentType, "Content-Length": data.length });
            res.end(data);
          } else {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        };
        runNativeRender(id, parsed.meta, parsed.bg, parsed.audio, parsed.music, parsed.titleCardImage, respond);
      });
    });
    return;
  }

  // ---- Native transcribe backend routes (tier 1 of caption sync) ----
  if (urlNoQuery === "/transcribe-capability" && req.method === "GET") {
    checkWhisper((available) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ available }));
    });
    return;
  }
  if (urlNoQuery.startsWith("/transcribe-progress/") && req.method === "GET") {
    const id = urlNoQuery.slice("/transcribe-progress/".length);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    progressChannels.set(id, res);
    req.on("close", () => { progressChannels.delete(id); });
    return;
  }
  if (urlNoQuery === "/transcribe" && req.method === "POST") {
    const id = new URL(req.url, "http://localhost").searchParams.get("id") || crypto.randomUUID();
    checkWhisper((available) => {
      if (!available) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "whisper isn't installed (or not on PATH)." }));
        return;
      }
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        // No framing needed — the POST body is just the raw narration audio
        // bytes. Unlike /render, whisper doesn't need the known script text
        // (it transcribes freely); alignment against the known text happens
        // client-side via alignWordsBySequence once this responds.
        const audio = Buffer.concat(chunks);
        await transcribeLimiter.acquire();
        const respond = (status, data) => {
          transcribeLimiter.release();
          closeProgressChannel(id);
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        };
        runNativeTranscribe(id, audio, respond);
      });
    });
    return;
  }

  let urlPath = decodeURIComponent(urlNoQuery);
  if (urlPath === "/") urlPath = "/index.html";
  // Prevent escaping ROOT via "..".
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": stat.size,
      // Allow the wasm/worker assets to be used cross-origin-isolation-free.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

// Required (not just run as a CLI script) by electron/main.js to start the
// same backend in-process for the standalone app — handle "something's
// already listening on this port" gracefully instead of crashing the whole
// process, since that's expected whenever the app is launched twice, or
// launched while a standalone `node server.js` is already running.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`Port ${PORT} is already in use — assuming another instance of this server is already running there.`);
    return;
  }
  throw err;
});
server.listen(PORT, () => {
  console.log(`Serving AITAH Video Creator (web) at http://localhost:${PORT}`);
  console.log("Press Ctrl+C to stop.");
});
