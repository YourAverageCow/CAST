# CAST

[![Tests](https://github.com/YourAverageCow/CAST/actions/workflows/test.yml/badge.svg)](https://github.com/YourAverageCow/CAST/actions/workflows/test.yml)
[![Live demo](https://img.shields.io/badge/demo-GitHub%20Pages-blue)](https://youraveragecow.github.io/CAST/)
[![License](https://img.shields.io/badge/license-unlicensed-lightgrey)](#license)

**CAST** — Content Automation & Story Tool — converts Reddit/AITAH-style stories into narrated short-form video: TTS narration, burned-in captions, and a background clip, generated one at a time or in bulk.

**[Try it now, no install](https://youraveragecow.github.io/CAST/)** — or run it locally for native-speed rendering (see below).

> **Branches**: `main` is active development, building toward a standalone local app (this README). `web` is a frozen, zero-install snapshot that the [live demo](https://youraveragecow.github.io/CAST/) builds from.

## Features

**Story writing** — DeepSeek, OpenAI, Groq, OpenRouter, Mistral, Gemini, Anthropic, or a local Ollama model. Bring your own API key, or run Ollama for free. The system prompt controlling tone and structure is editable in Settings.

**Narration** — seven TTS engines, each with its own tuning parameters (speed, stability, pitch, model tier) and a preview button on every voice picker:

| Engine | Cost | Runs |
|---|---|---|
| Piper | Free | In-browser |
| Kokoro | Free | In-browser |
| Kokoro (native) | Free | Local CPU process — real per-word timestamps |
| Browser Speech | Free | Your OS's built-in voices |
| PocketTTS | Free | Local CPU process (`uvx pocket-tts`) |
| OpenAI TTS | Paid | Cloud |
| ElevenLabs | Paid (free tier available) | Cloud |

**Captions** — burned in via ffmpeg's `drawtext`, with style presets (word-by-word, grouped phrases, or true multi-word karaoke highlighting), pop/fade entrance animation, background boxes, drop shadows, and several vendored fonts. Caption timing cascades from best to good-enough: real per-word timestamps from whichever TTS engine provides them, then native Whisper if installed, then a silence-aware estimate.

**Batch generation** — generate a whole batch of videos in one pass from a persistent library of your own background clips and music, with configurable render concurrency and a batch-scoped warm TTS pool for faster narration across a run.

**Publishing** — connect one or more YouTube channels, auto-generate titles/descriptions/thumbnails, and schedule uploads across a batch.

**Rendering** — two tiers, chosen automatically:
- **Native** (with `ffmpeg` on your `PATH`): faster and more reliable than the WASM fallback.
- **WASM** (the live demo, or no local `ffmpeg`): runs entirely in-browser, zero install, slower on longer videos.

## Quickstart

```bash
node server.js
```

Open `http://localhost:8123`, or double-click `Open AITAH Creator Web.command` to do the same and launch your browser automatically.

If `ffmpeg`/`whisper` are on your `PATH`, rendering and caption sync use them natively; otherwise everything falls back to in-browser engines with no extra setup.

### Standalone app

Same backend, a real app window instead of a browser tab (early version — no installer yet):

```bash
npm install
npm start
```

### No install at all

Use the [deployed demo](https://youraveragecow.github.io/CAST/) — runs entirely in-browser, may lag behind `main`'s newest features.

## Requirements

- A browser
- An API key for an OpenAI-compatible story-writing provider (Settings panel), or Ollama running locally for free
- A background video (Subway Surfers gameplay is the classic choice)
- `ffmpeg` on your `PATH`, for native rendering speed when running locally (optional)

## Testing

```bash
node --test web/lib/*.test.js
```

Pure logic — caption timing/chunking/presets, codec sniffing, ffmpeg filter-graph construction — lives in `web/lib/` and runs on Node's built-in test runner, no dependencies to install. Runs automatically on every push and pull request.

## Dev tooling

```bash
CAST_PORT=8199 node server.js   # run a second instance without killing a live app
CAST_DEBUG=1 node server.js     # log real ffmpeg/whisper spawn args and request timing
npm run smoke                   # scripted round-trip check against /render, /transcribe, cache endpoints
npm run free-port               # kill whatever's holding CAST_PORT (default 8123)
```

## Known limitations

- Caption sync is close, not frame-perfect, unless the TTS engine or Whisper provides real per-word timestamps.
- Some backends (PocketTTS, native Whisper, native Kokoro) require their own local install and simply show as unavailable without one — no auto-install.
- Native rendering speed depends on a compatible local `ffmpeg` install; without one, rendering falls back to the slower in-browser WASM engine.

## License

No formal license is attached. Free to use, modify, and redistribute.
