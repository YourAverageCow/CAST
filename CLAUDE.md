# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Slopdaddy generates narrated AITAH/Reddit-story videos with burned-in captions over a background clip. Piper/Kokoro TTS (client-side ONNX) for narration and a pluggable set of AI providers for story generation (see "Story-generation providers" below) always run in-browser. Rendering and caption-sync transcription both have two tiers: `server.js` shells out to the user's own installed native `ffmpeg`/`whisper` when present and capable (see "Native rendering backend" and "Caption-sync cascade" below) — falling back to ffmpeg.wasm / an in-browser estimate otherwise. No bundler, no framework either way.

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

`web/app.js`'s `init()` probes `/render-capability` once (`nativeRenderAvailable`, cached for the session) and `renderVideoInWorker()` branches on it: native via `renderVideoNatively()` (a hand-rolled length-prefixed binary frame over `POST /render` — no multipart parser, matching this repo's zero-dependency convention) when available, or the original `ffmpegPool.submit(...)` WASM path otherwise. This branch itself is silent and automatic, no user-visible difference beyond speed/reliability. The deployed GitHub Pages build always takes the WASM branch, since there's no server there to answer the probe; nothing about that build's behavior changed. Concurrent native renders (batch "Generate All") are bounded by a simple in-process queue in `server.js` (`renderLimiter`, a `makeSlotLimiter`), mirroring what `FFmpegWorkerPool` already does for WASM workers; `transcribeLimiter` is the equivalent independent queue for native Whisper transcriptions.

Both limiters default to every CPU core (`os.cpus().length`, exposed as `cpuCount` in `/render-capability`'s response) rather than reserving one for the OS/UI — the render/transcribe backend is meant to use as much of the machine as the user wants. `POST /performance-settings` (body `{renderConcurrency, transcribeConcurrency}`, each clamped to `[1, cpuCount]`) lets the client adjust either limiter's cap at runtime via `setMax()` — wired to the Settings -> Performance slider (`#renderConcurrency` in `web/index.html`, only shown when `nativeRenderAvailable`), which lets the user dial back if a full-throttle batch render makes the machine unresponsive. Each render/transcribe subprocess also gets an explicit `-threads`/`-filter_complex_threads`/`--threads` budget (`threadBudget()` in `server.js`, `cpuCount / limiter.getMax()`) rather than leaving them unset — unset means every concurrent ffmpeg/whisper process auto-detects and tries to use *all* cores, so N concurrent jobs fight each other instead of sharing cores cleanly.

Native TTS is explicitly not part of this — Piper/Kokoro still run as WASM/ONNX in the browser either way. Native Whisper-based caption alignment (below) followed the same pattern once it was built.

### Vendored TTS assets for offline-first-launch (`main` only)

Unlike `web` (which fetches Kokoro's model/library and Piper's per-voice files from a CDN/HuggingFace at runtime, same as ever), `main` vendors these locally so a fresh install works with zero network dependency:
- `web/vendor/kokoro/` — `kokoro-js@1.2.1`'s bundled `kokoro.web.js` itself, plus the ONNX-runtime WASM binaries (`onnx/ort-wasm-simd-threaded.jsep.{wasm,mjs}`) it needs — the latter wired via `kokoro.web.js`'s own exported `env.wasmPaths` setter, a supported override.
- `web/vendor/kokoro-model/` — the full Kokoro q8 model (`onnx/model_quantized.onnx`, ~92MB) plus `config.json`/`tokenizer.json`/`tokenizer_config.json` and all 10 of this app's voice embeddings (`voices/*.bin`, ~522KB each — one shared model covers every voice, so vendoring these ten small files is enough for all of them).
- `web/vendor/piper-voices/` — just the default voice (`en_US-ryan-medium`, ~63MB); every other Piper voice still fetches from HuggingFace on first use, unchanged.

The tricky part: `kokoro.web.js` hardcodes its model/config/tokenizer/voice fetches to `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/...` with no exposed config knob for that (confirmed by inspecting the bundled source — it only re-exports a narrow `env.wasmPaths` setter, not the full transformers.js `env` object that would otherwise support `localModelPath`/`remoteHost`). `web/app.js`'s `patchKokoroFetch()` narrowly intercepts `window.fetch` for exactly that URL prefix and redirects to `web/vendor/kokoro-model/`, installed once and left active permanently (a new/already-vendored voice's `.bin` can be requested by a later `.generate()` call, not just during `from_pretrained`) — everything else's fetch calls pass through untouched. Piper's `voiceProvider.fetch()` in `ensurePiper()` needed no such trick — it's this app's own code, so the default-voice case just branches to a local path directly.

Verified live (not just configured): cleared the browser's `transformers-cache`/`kokoro-voices` Cache Storage buckets first (to rule out a stale cache masking a broken redirect), then confirmed via network-request inspection that a real Kokoro generation hits only `vendor/kokoro-model/*` paths — zero requests to `huggingface.co` or `cdn.jsdelivr.net` — and same for a Piper `en_US-ryan-medium` generation hitting only `vendor/piper-voices/*`.

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

### Batch page: bulk-generate screen, "done" screen, and the manual card list are three views, not three features

The Batch tab (`#batchFlow`) is one `batchViewMode` state machine (`"setup" | "done" | "cards"`, `setBatchViewMode()` in `app.js`) toggling three sibling containers in `web/index.html`: `#bulkSetupView` (default), `#bulkDoneView`, `#batchCardsView` (the original per-card list, unchanged internally — just now one of three views instead of always-visible). None of `batchJobs`/rendering logic is aware of which view is showing; this is purely a display toggle, same idea as the existing single/batch `setFlow()`.

`#bulkSetupView` is a dedicated form (count, video/music source, voice, TTS engine, caption preset, title card) — not just the thin "count + Generate" row it used to be. Video/music each get a 3-way radio (`bulkVideoSource`/`bulkMusicSource`: `none`/`random`/`manual`) rather than a single "use random" checkbox, since "manually choose per video" needed a third option. `bulkGenerateBatch()` builds one assignment plan per radio's value: `random` → the existing `planBulkVideoAssignment()` (`web/lib/bulk-assignment.js`), `manual` → the new `planManualAssignment()` (same file — cycles through the numbered picker's ordered id list rather than randomizing), `none` → an all-`{source:"none"}` plan. `applyBulkJobDefaults()` applies the screen's voice/engine/caption/title-card selections to each newly-created job **and** syncs that card's own DOM controls to match, so "Review & Customize Each" afterward shows accurate state rather than blank overrides.

"Choose for each" (either radio) opens the Media Library modal in a new **numbered multi-select mode** (`openMediaLibraryPicker({kind, max, onConfirm})`, distinct from the existing single-pick `openMediaLibrary(onPick, kind)` used by per-card "Choose from library" links) — `renderMediaLibraryList()` branches into `renderMediaLibraryPickerGrid()`, a CSS grid of thumbnail tiles instead of the plain text list. Clicking a tile toggles it into `mediaLibraryPickerSelection` (an ordered array — append on select, splice on deselect, re-rendering assigns each remaining tile's badge from its current array index, which is what makes deselecting renumber the rest automatically) up to a `max` cap (the bulk screen's chosen story count), with a Confirm/Cancel footer instead of closing on first click. Video thumbnails are generated lazily per tile via `generateVideoThumbnail()` (off-DOM `<video>` seek + `<canvas>` frame grab, same mechanics as the codec-transcode path's frame extraction) and cached in a session-lived `Map` keyed by item id; audio items just show a fixed icon (no waveform rendering).

"Done — Start Rendering" on `#bulkDoneView` (`finishBulkGenerate()`) switches to the `"cards"` view and immediately calls `renderAllBatch()` — a shortcut straight into the existing full-page render panel without requiring a stop in the card list first. "Review & Customize Each" just switches to `"cards"` without rendering. "Create Separately Instead" (`createBatchSeparately()`) skips bulk generation entirely, seeding one blank card the same way `initBatchUI()` used to unconditionally (that auto-seed was removed from `initBatchUI()` — the bulk-generate screen is the default now, so nothing should assume a card already exists on first visit).

### Job model: single export and batch export share one pipeline

`web/lib/job-model.js`'s `createJob()`/`resolveJobSettings()` define a "job" — one video's full state (premise/story/background/voice/style), where per-job style fields fall back to the global settings panel's values when unset. `runJob(job, globalSettings, onUpdate)` in `app.js` is the single render pipeline (transcode-if-needed → TTS → render), used both by the sidebar's single-video export (a "batch of one") and by the batch composer's "Generate All". Don't fork a second render pipeline for batch-specific behavior — extend `runJob`/the job model instead.

TTS generation goes through a one-at-a-time queue (`queueTTS` in `app.js`) even when video rendering is running in parallel across the worker pool — Piper's single shared engine instance doesn't have verified concurrent-call safety, and TTS is fast enough relative to rendering that serializing it is cheap.

`renderAllBatch()`'s "Generate All" opens a full-page dashboard overlay (`#batchProgressOverlay`, `openBatchProgressPanel()`/`updateBatchProgressStats()` in `app.js`) for the duration of the run — stat tiles (elapsed, ETA extrapolated from completed-count/elapsed-time throughput, CPU cores via `navigator.hardwareConcurrency`, active-renders-vs-concurrency, render backend, and `performance.memory`'s JS heap usage as the closest available proxy for "resource use" — no browser API exposes real system-wide CPU/RAM) plus a live grid of per-job cards. That grid reuses `renderResultCard()` directly rather than a separate rendering path — a finished/failed card gets the exact same Preview/Download/Retry buttons it would in `#resultsGrid`, just also mirrored into this grid. `renderResultCard()`'s batch-styling branch (title + retry button) checks for either `#resultsGrid` or `#batchProgressGrid` by id. The panel can be minimized (a floating "View Batch Progress" button reopens it) without affecting the render itself, which runs independently of whether the panel is visible.

### Story-generation providers: one registry, two wire formats

`web/lib/story-providers.js`'s `STORY_PROVIDERS` registry (mirrors `tts-engines.js`'s `TTS_ENGINES` pattern) is the single source of truth for every story-gen provider — DeepSeek, OpenAI, Groq, OpenRouter, Mistral, Google Gemini (via its OpenAI-compatibility endpoint), Anthropic, and Ollama (local, no API key, editable base URL for any other self-hosted OpenAI-compatible server too). Adding a plain OpenAI-compatible provider is just a new registry entry (`baseUrl`, `models`, `api: "openai"`) — no code changes needed, since `app.js`'s `streamChat()` is one shared fetch+SSE-read loop for every provider, parameterized by `buildChatRequest()`/`parseSSEDelta()` (both pure, in `story-providers.js`, unit-tested). Only Anthropic's Messages API is genuinely different (separate `system` field instead of a `role:"system"` message, `x-api-key`/`anthropic-version` headers instead of `Bearer`, `max_tokens` required, typed SSE events) — that's the one place both builder functions branch on `provider.api === "anthropic"`; every other provider takes the default OpenAI-compatible branch.

`populateModels()` in `app.js` toggles three settings-panel fields per provider's registry flags: `#modelCustomRow` (free-text model input) when `customModel` is set (Ollama has no fixed model list), `#customBaseUrlRow` when `editableBaseUrl` is set, and `#apiKeyRow` when `needsApiKey` is false (Ollama needs no key). `getApiKey()` only alerts/blocks generation for providers that actually declare `needsApiKey: true`.

### Captions: burned in via `drawtext`, not `subtitles`/libass

The ffmpeg.wasm build has no font *provider* (no fontconfig/CoreText/DirectWrite), so the `subtitles` filter can't render anything. Captions are burned in via `drawtext` (FreeType-direct, works with an exact bundled font file — `vendor/fonts/DejaVuSans.ttf`) instead. Each caption cue is its own `drawtext` filter instance, gated by `enable='between(t,start,end)'`, with every option set once at filter-construction time (`web/lib/ffmpeg-filters.js`'s `buildCaptionCues`/`buildDrawtextFilterChain`). There is deliberately no use of `sendcmd`/runtime filter commands anywhere in this codebase — an earlier version drove a single reused `drawtext` filter via `sendcmd`, which depended on which AVOptions ffmpeg happens to flag as runtime-settable and silently broke captions in production twice. If you're touching caption rendering, keep it at filter-construction time; don't reintroduce runtime command dispatch.

### Codec support is narrow, and unsupported input is transcoded client-side first

The bundled ffmpeg.wasm core can't decode AV1/VP9/VP8 — feeding it those hangs forever with no error. `web/lib/video-utils.js`'s `detectUnsupportedCodec` sniffs the MP4 sample-entry fourcc before render; if unsupported, `autoTranscodeToH264` in `app.js` re-encodes it client-side first by seeking a `<video>` element frame-by-frame, drawing each frame to a `<canvas>`, and streaming JPEGs into the worker to be assembled with ffmpeg's own libx264 path (not `MediaRecorder`, whose H.264 *encode* support Firefox lacks).

Render calls also have a stall watchdog (`RENDER_STALL_TIMEOUT_MS` in `worker-pool.js`) — if a render produces no progress tick for 45s (typically an unsupported codec that got past sniffing), the stuck `PoolWorker`'s underlying Worker is terminated and replaced rather than leaving the UI hung.
