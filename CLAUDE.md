# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Slopdaddy generates narrated AITAH/Reddit-story videos with burned-in captions over a background clip. Piper/Kokoro TTS (client-side ONNX) for narration and DeepSeek/OpenAI for story generation always run in-browser. Rendering and caption-sync transcription both have two tiers: `server.js` shells out to the user's own installed native `ffmpeg`/`whisper` when present and capable (see "Native rendering backend" and "Caption-sync cascade" below) — falling back to ffmpeg.wasm / an in-browser estimate otherwise. No bundler, no framework either way.

**Two branches, two purposes** (as of the native-backend work): `main` is where active development happens, heading toward a standalone local app (this is that work — see "Standalone app" below). `web` is a frozen-ish snapshot kept as the zero-install "click a link" browser-only version — that's what the deployed GitHub Pages site (https://youraveragecow.github.io/Slopdaddy/) builds from, gated by `.github/workflows/pages.yml`'s `workflow_run` filter on `web`'s own `Tests` runs, not `main`'s. Backport pure-logic fixes/features to `web` when practical (cherry-pick or manual port); native-only features (this whole file's "Native rendering backend"/"Caption-sync cascade"/"Standalone app" sections) don't apply there at all, since `web`'s `server.js` stays as plain static-file serving.

## Commands

```bash
node server.js              # local dev server at http://localhost:8123 (needed for COOP/COEP headers — opening index.html via file:// breaks isolation)
npm start                    # (main branch only) launches the standalone Electron app — same UI/backend, real app window instead of a browser tab
node --test web/lib/*.test.js   # run all tests (Node's built-in test runner, zero dependencies)
node --test web/lib/foo.test.js # run a single test file
node -c web/app.js           # syntax-check a file (no linter configured — this is the closest thing)
```

`web/` itself has no build step, no bundler, no lint config — everything there is served as-is, and `server.js`'s render/transcribe backends shell out to native `ffmpeg`/`whisper` rather than adding npm dependencies to bundle them. **`main`'s `package.json`/`package-lock.json`/`node_modules/` are new** (first-ever npm dependency in this repo's history) — `electron` only, for the standalone app wrapper; `web/` stays dependency-free regardless. Double-clicking `Open AITAH Creator Web.command` runs `node run.js`, which starts `server.js` and opens the browser for you — this still works identically on `main`, independent of the Electron app.

Tests run automatically on push/PR via `.github/workflows/test.yml` (on both `main` and `web` pushes). `.github/workflows/pages.yml` (the GitHub Pages deploy) is gated on `web`'s Tests runs specifically: it triggers via `workflow_run`, not `push` directly, and only proceeds `if` that run succeeded (or on manual `workflow_dispatch`). A red test run on `web` blocks deployment; the `github-pages` environment's deployment-branch policy was updated to allow `web` (previously only `main`).

## Architecture

### Native rendering backend (`server.js`), with automatic WASM fallback

`server.js` was originally pure static file serving. It now also exposes `POST /render` (plus `GET /render-capability` and an SSE `GET /render-progress/:id` for progress), which shells out to the user's own `ffmpeg` via `child_process` instead of ffmpeg.wasm — real native rendering is faster and doesn't hang the way the WASM multi-thread core occasionally does. It reuses `web/lib/ffmpeg-filters.js`'s pure filter-graph builders directly via `require()` (already Node-`require()`-able — that's how its own tests run) — only the exec mechanism and file I/O differ from `ffmpeg-worker.js`'s WASM path, not the actual ffmpeg invocation.

`checkFfmpeg()` in `server.js` doesn't just check that `ffmpeg` exists — captions are burned in via the `drawtext` filter, which needs ffmpeg built with libfreetype, and plenty of real-world ffmpeg installs (confirmed: a stock Homebrew build) omit it. `/render-capability` greps `ffmpeg -filters` for `drawtext` and reports unavailable if it's missing, same as if `ffmpeg` weren't installed at all.

`web/app.js`'s `init()` probes `/render-capability` once (`nativeRenderAvailable`, cached for the session) and `renderVideoInWorker()` branches on it: native via `renderVideoNatively()` (a hand-rolled length-prefixed binary frame over `POST /render` — no multipart parser, matching this repo's zero-dependency convention) when available, or the original `ffmpegPool.submit(...)` WASM path otherwise. This is silent and automatic — no settings toggle, no user-visible difference beyond speed/reliability. The deployed GitHub Pages build always takes the WASM branch, since there's no server there to answer the probe; nothing about that build's behavior changed. Concurrent native renders (batch "Generate All") are bounded by a simple in-process queue in `server.js` (`MAX_CONCURRENT_RENDERS`), mirroring what `FFmpegWorkerPool` already does for WASM workers.

Native TTS is explicitly not part of this — Piper/Kokoro still run as WASM/ONNX in the browser either way. Native Whisper-based caption alignment (below) followed the same pattern once it was built.

### Caption-sync cascade: real alignment first, estimate last

Caption timing used to be a pure guess (`computeWordTimings` in `web/lib/captions.js` — spreads an engine's total audio duration across words proportional to a per-word weight; still exists as the final fallback). `web/app.js`'s `resolveWordTimings(text, audioBlob, durationSec, engineWordTimings)` — called from `generateSpeech()` — is the cascade, evaluated in order:

0. **Engine's own real timing** — ElevenLabs' `/with-timestamps` (character-level, via `alignWordsFromCharacters`) or Browser Speech's native `boundary` events, passed straight through as `engineWordTimings` if present. Short-circuits everything below.
1. **Native Whisper** — mirrors the render backend's pattern exactly: `checkWhisper()` in `server.js` (same shape as `checkFfmpeg`, checks `whisper --help` mentions `word_timestamps` rather than just "does a binary exist"), `GET /transcribe-capability`, `POST /transcribe` (no framing needed — just raw audio bytes as the body, since whisper doesn't need the known script text), `runNativeTranscribe()` shells out to `whisper <audio> --model tiny.en --word_timestamps True --output_format json --fp16 False` and flattens `segments[].words[]` (confirmed live: `{word, start, end, probability}`, `word` has a leading space) into `{text,start,end}`. Client-side: `probeNativeWhisperBackend()`/`nativeWhisperAvailable` (probed in `init()` alongside the render probe), `transcribeNatively()`.
2. **VAD-corrected estimate** (the always-on default when native Whisper isn't available) — `detectSilenceGaps()` in `web/app.js` is a lightweight Web Audio energy-threshold pass (no ML model — confirmed via research that a trained VAD's noise-robustness advantage is wasted on clean TTS output) over the decoded audio, returning real silence-run boundaries. Threshold tuning note: real inter-sentence pauses in Piper output were measured live at ~100-140ms, not the initially-assumed 150ms — `minSilenceWindows` reflects the measured value. `snapPausesToWords()` (`web/lib/captions.js`) then nudges `computeWordTimings`' punctuation-pause guess to match a real gap when one's within tolerance, redistributing the words between real anchors via the shared `distributeWordsInSpan` helper.
3. **Opt-in browser Whisper** (`#enableBrowserAsr` setting, off by default, only tried when native isn't available) — `ensureBrowserWhisper()`/`transcribeInBrowser()` mirror `ensureKokoro()`'s lazy-singleton CDN-import pattern for `@huggingface/transformers`' ASR pipeline (`Xenova/whisper-tiny.en`, `return_timestamps: "word"`).

Both Whisper tiers (native and browser) return the same raw shape and both feed `alignWordsBySequence()` (`web/lib/captions.js`) — an LCS-style word-sequence alignment, **not** a reuse of `alignWordsFromCharacters` (that needs an exactly reconstructable character string; Whisper's transcription can diverge from the known script — confirmed live: "AITAH" transcribed as "ADA", and "$15,000" split into two separate word tokens). Matched words get real timestamps; unmatched runs interpolate between the nearest real anchors via `distributeWordsInSpan`, so a few ASR misses self-correct locally instead of reintroducing drift. Captions always show the known script's word, never Whisper's transcription. Returns `null` (never throws) on total mismatch, same fail-closed convention as `alignWordsFromCharacters`.

`SETTINGS_FIELDS`/`saveSettings`/`loadSettings` gained checkbox support (`el.type === "checkbox" ? el.checked : el.value`) for `#enableBrowserAsr` — no checkbox had ever been persisted before this.

### Standalone app (`electron/main.js`)

`npm start` (`main` branch only) launches the same `web/` UI + `server.js` backend as a real Electron app window instead of a browser tab — "Discord-style": Chromium + a Node backend, packaged as one app, not something you visit via a URL. There is deliberately no separate backend implementation for this: `electron/main.js`'s `startBackend()` just `require()`s `server.js`, which runs its top-level `server.listen(...)` as a side effect — identical to `node server.js`'s CLI path, just invoked from Electron's main process instead. `waitForServer()` polls briefly before `BrowserWindow.loadURL()` since the OS-level listen can take a beat after `require()` returns.

`server.js`'s `server.on("error", ...)` handler (treats `EADDRINUSE` as "another instance is already serving this" rather than crashing) exists specifically so requiring it unconditionally from Electron's main process is safe even if the app is launched twice, or launched while a standalone `node server.js` happens to already be running on the same port — confirmed live: a second `node server.js` invocation while the Electron app was running logged the graceful message and exited cleanly rather than crashing.

This is a first working version, not a full packaging/distribution pipeline — no `electron-builder` config, no per-OS installers, no icons, no code signing, no auto-update yet. Those are a real separate follow-up phase.

Native rendering/transcription (`server.js`'s `/render`/`/transcribe`) work identically whether the UI is a browser tab (`node server.js`) or this Electron window — same backend, same probes, same fallback logic. Nothing in `web/app.js`'s native-probe code needed to change for the Electron wrapper to work.

### No modules, no bundler — plain classic scripts sharing global scope

Everything in `web/` is loaded via `<script src="...">` tags in `index.html`, in a specific required order (later scripts call earlier ones as bare globals):
```
lib/captions.js, lib/video-utils.js, lib/job-model.js  →  worker-pool.js  →  app.js
```
`web/ffmpeg-worker.js` (a Worker, not a page script) pulls in `lib/ffmpeg-filters.js` via `importScripts()` at its own top.

The `web/lib/*.js` files use an **isomorphic module pattern**: plain top-level `function` declarations (which become globals in a classic script) plus a guarded CommonJS export at the bottom:
```js
if (typeof module !== "undefined" && module.exports) {
  module.exports = { someFunction };
}
```
This lets the exact same file work as a browser global *and* as a `require()`-able module in Node tests, with zero build step. Every file in `web/lib/` is pure (no DOM, no `fetch`, no Worker/ffmpeg globals) and has a paired `*.test.js`. When extracting logic to be testable, this is the pattern to follow — put pure logic in `web/lib/`, keep DOM/Worker-coupled glue code in `app.js`/`ffmpeg-worker.js`.

### Cross-origin isolation is load-bearing

`web/coi-serviceworker.js` is a service worker that injects `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` headers on every response (GitHub Pages doesn't set these itself), which is what makes `SharedArrayBuffer` available. Both Piper's threaded ONNX runtime and ffmpeg.wasm's multi-threaded core depend on this. It also cache-first-serves the large vendored assets (`vendor/`, `onnx/`, `piper/` paths) via the Cache API, independent of the app's own `VERSION` bump cycle — app code (`app.js`, `index.html`, `ffmpeg-worker.js`, itself) stays network-first so version bumps propagate immediately, while multi-megabyte binaries that rarely change get cached long-term. `CACHE_NAME` in that file must be bumped by hand if the vendored asset *set* ever changes.

### Two ffmpeg.wasm cores, chosen per Worker instance

`web/vendor/ffmpeg/` (single-thread) and `web/vendor/ffmpeg/mt/` (multi-thread, needs `SharedArrayBuffer`) are both vendored. `ffmpeg-worker.js`'s `ensureLoaded()` picks one per Worker instance at load time. The multi-thread core spawns its own pthread pool sized to `navigator.hardwareConcurrency` — running several multi-thread instances at once oversubscribes the CPU badly, so `web/worker-pool.js`'s `FFmpegWorkerPool` forces every instance onto the single-thread core (`forceST`) whenever the pool size is greater than 1. A lone worker (single-video export) still prefers the multi-thread core.

### Worker pool for concurrent rendering

`FFmpegWorkerPool`/`PoolWorker` in `web/worker-pool.js` manage N independent `ffmpeg-worker.js` Worker instances (each fully self-contained — no shared state across instances). `pool.submit(taskFn)` acquires an idle worker (queueing if all are busy) and guarantees exactly one in-flight request per worker instance at a time — this is what makes concurrent rendering safe; each `PoolWorker` owns a persistent message dispatcher rather than reassigning `onmessage` per call. `ensureFFmpeg(poolSize)` in `app.js` lazily creates/grows the shared pool; growing to a larger size destroys and replaces the old (smaller) pool rather than leaking its Workers.

### Job model: single export and batch export share one pipeline

`web/lib/job-model.js`'s `createJob()`/`resolveJobSettings()` define a "job" — one video's full state (premise/story/background/voice/style), where per-job style fields fall back to the global settings panel's values when unset. `runJob(job, globalSettings, onUpdate)` in `app.js` is the single render pipeline (transcode-if-needed → TTS → render), used both by the sidebar's single-video export (a "batch of one") and by the batch composer's "Generate All". Don't fork a second render pipeline for batch-specific behavior — extend `runJob`/the job model instead.

TTS generation goes through a one-at-a-time queue (`queueTTS` in `app.js`) even when video rendering is running in parallel across the worker pool — Piper's single shared engine instance doesn't have verified concurrent-call safety, and TTS is fast enough relative to rendering that serializing it is cheap.

### Captions: burned in via `drawtext`, not `subtitles`/libass

The ffmpeg.wasm build has no font *provider* (no fontconfig/CoreText/DirectWrite), so the `subtitles` filter can't render anything. Captions are burned in via `drawtext` (FreeType-direct, works with an exact bundled font file — `vendor/fonts/DejaVuSans.ttf`) instead. Each caption cue is its own `drawtext` filter instance, gated by `enable='between(t,start,end)'`, with every option set once at filter-construction time (`web/lib/ffmpeg-filters.js`'s `buildCaptionCues`/`buildDrawtextFilterChain`). There is deliberately no use of `sendcmd`/runtime filter commands anywhere in this codebase — an earlier version drove a single reused `drawtext` filter via `sendcmd`, which depended on which AVOptions ffmpeg happens to flag as runtime-settable and silently broke captions in production twice. If you're touching caption rendering, keep it at filter-construction time; don't reintroduce runtime command dispatch.

### Codec support is narrow, and unsupported input is transcoded client-side first

The bundled ffmpeg.wasm core can't decode AV1/VP9/VP8 — feeding it those hangs forever with no error. `web/lib/video-utils.js`'s `detectUnsupportedCodec` sniffs the MP4 sample-entry fourcc before render; if unsupported, `autoTranscodeToH264` in `app.js` re-encodes it client-side first by seeking a `<video>` element frame-by-frame, drawing each frame to a `<canvas>`, and streaming JPEGs into the worker to be assembled with ffmpeg's own libx264 path (not `MediaRecorder`, whose H.264 *encode* support Firefox lacks).

Render calls also have a stall watchdog (`RENDER_STALL_TIMEOUT_MS` in `worker-pool.js`) — if a render produces no progress tick for 45s (typically an unsupported codec that got past sniffing), the stuck `PoolWorker`'s underlying Worker is terminated and replaced rather than leaving the UI hung.
