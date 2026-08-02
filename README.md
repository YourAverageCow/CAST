# Slopdaddy (Name Pending)

An AI slop video factory for making AITAH story videos. 

## About

This project was completely vibe-coded, built in an afternoon, It's held together by:

- a browser WASM engine the size of a small OS
- a few tests, for the parts that kept silently breaking
- commit messages nobody was paying attention to

It works. Probably. 

## What it does

Generates or Turns your AITAH Reddit stories into narrated videos with captions on a background clip, as seen on your favorite doom scrolling platform 

Piper/Kokoro TTS for the voice, DeepSeek/OpenAI for the story writing — those still run in-browser either way. Rendering has two tiers:

- **Local (`node server.js`)**: if you have `ffmpeg` installed (with drawtext/libfreetype support — most installs have this), rendering runs natively via your own ffmpeg instead of ffmpeg.wasm. Faster, and doesn't have ffmpeg.wasm's occasional hangs on some machines. This is detected automatically — nothing to configure.
- **Deployed / no local ffmpeg**: falls back to ffmpeg.wasm, entirely in-browser, exactly as before. Slower for longer videos, but zero install.

## Running it

```bash
node server.js
```

Then open http://localhost:8123. Or double-click `Open AITAH Creator Web.command`, which does the same thing and opens the browser for you. If `ffmpeg` is on your PATH, rendering uses it automatically — otherwise it falls back to the in-browser engine with no extra setup.

Or just use the deployed version (no local install, always uses the in-browser engine): https://youraveragecow.github.io/Slopdaddy/

## Tests

The pure logic (caption timing/chunking, codec sniffing, the ffmpeg filter-graph/sendcmd string building) has unit tests in `web/lib/`, using Node's built-in test runner — no dependencies to install:

```bash
node --test web/lib/*.test.js
```

Runs automatically on every push/PR via `.github/workflows/test.yml`.

## What you need

- A browser
- An API key for an OpenAI-compatible provider (settings panel, top-right)
- A background video (Subway Surfers gameplay is the classic choice)
- `ffmpeg` on your PATH, if you want native rendering speed when running locally (optional — falls back to the in-browser engine without it)
- Reasonable expectations

## Known limitations

- Caption sync is "close enough", not frame-perfect
- Rendering is native-ffmpeg-speed when running locally with a compatible `ffmpeg` install, ffmpeg.wasm speed otherwise (deployed site, or no local `ffmpeg`)
- It's vibe-coded, so treat it accordingly

## License

Do whatever. 
