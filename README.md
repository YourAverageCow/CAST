# Slopdaddy (Name Pending)

> This is the actively-developed `main` branch, moving toward a standalone local app. The `web` branch is the frozen, zero-install "click a link" browser-only version — the [deployed GitHub Pages site](https://youraveragecow.github.io/Slopdaddy/) builds from `web`, not `main`.

An AI slop video factory for making AITAH story videos.

## About

This project was completely vibe-coded, built one late-night session at a time. It's held together by:

- a browser WASM engine the size of a small OS
- an increasingly suspicious number of TTS engines
- a few tests, for the parts that kept silently breaking
- commit messages nobody was paying attention to

It works. Probably.

## What it does

Turns your AITAH Reddit stories into narrated videos with burned-in captions over a background clip, as seen on your favorite doom-scrolling platform. Generate one at a time, or bulk-generate a whole batch in one go from a persistent media library of your own background videos/music.

**Story writing**: DeepSeek, OpenAI, Groq, OpenRouter, Mistral, Gemini, Anthropic, or a local Ollama model — pick a provider in Settings, bring your own API key (or none, for Ollama). The system prompt that controls tone/structure is editable too.

**Narration**: six TTS engines, each with its own tuning knobs (speed, stability, pitch, model tier, etc. — whatever that engine actually exposes) and a "▶ Preview" button next to every voice picker:
- **Piper** / **Kokoro** — free, run entirely in your browser, no API key, no per-use cost
- **OpenAI TTS** / **ElevenLabs** — cloud, paid (ElevenLabs has a free tier)
- **Browser Speech** — free, your OS's built-in voices
- **PocketTTS** — free, local, runs on CPU via a small Python process (`uvx pocket-tts`)

**Captions**: burned in via ffmpeg's `drawtext`, with real style presets (Hormozi, MrBeast Pop, Karaoke Bar, and more) — word-by-word, grouped phrases, or true multi-word karaoke highlighting, with pop/fade entrance animation, background boxes, drop shadows, and a handful of real vendored fonts. Caption-sync (matching captions to the actual spoken audio) cascades from best to good-enough: real per-word timestamps from whichever engine can provide them, then native Whisper if it's installed, then a silence-aware estimate.

**Rendering** has two tiers:
- **Local (`node server.js`)**: if you have `ffmpeg` installed (with drawtext/libfreetype support — most installs have this), rendering runs natively via your own ffmpeg instead of ffmpeg.wasm. Faster, and doesn't have ffmpeg.wasm's occasional hangs on some machines. Detected automatically — nothing to configure.
- **Deployed / no local ffmpeg**: falls back to ffmpeg.wasm, entirely in-browser, exactly as before. Slower for longer videos, but zero install.

## Running it

```bash
node server.js
```

Then open http://localhost:8123. Or double-click `Open AITAH Creator Web.command`, which does the same thing and opens the browser for you. If `ffmpeg`/`whisper` are on your PATH, rendering/caption-sync use them natively — otherwise it falls back to in-browser engines with no extra setup.

Or run it as a standalone app instead of a browser tab (same backend, real app window — early/first version, no installer yet):
```bash
npm install
npm start
```

Or just use the deployed version (no local install, always uses the in-browser engine, may lag behind the features above): https://youraveragecow.github.io/Slopdaddy/

## Tests

The pure logic (caption timing/chunking/presets, codec sniffing, the ffmpeg filter-graph string building) has unit tests in `web/lib/`, using Node's built-in test runner — no dependencies to install:

```bash
node --test web/lib/*.test.js
```

Runs automatically on every push/PR via `.github/workflows/test.yml`.

## What you need

- A browser
- An API key for an OpenAI-compatible story-writing provider (settings panel, top-right) — or Ollama running locally for free
- A background video (Subway Surfers gameplay is the classic choice)
- `ffmpeg` on your PATH, if you want native rendering speed when running locally (optional — falls back to the in-browser engine without it)
- Reasonable expectations

## Known limitations

- Caption sync is "close enough", not frame-perfect, unless the TTS engine/Whisper gives real per-word timestamps
- Rendering is native-ffmpeg-speed when running locally with a compatible `ffmpeg` install, ffmpeg.wasm speed otherwise (deployed site, or no local `ffmpeg`)
- Some TTS engines (PocketTTS, native Whisper) need their own local install and will just show as unavailable without it — no auto-install
- It's vibe-coded, so treat it accordingly

## License

Do whatever.
