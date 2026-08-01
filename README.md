# Slopdaddy

An AI slop video factory for making AITAH story videos. 

## About

This project was completely vibe-coded, built in an afternoon, It's held together by:

- a browser WASM engine the size of a small OS
- a few tests, for the parts that kept silently breaking
- commit messages nobody was paying attention to

It works. Probably. 

## What it does

Generates or Turns your AITAH Reddit stories into narrated videos with captions on a background clip, as seen on your favorite doom scrolling platform 

The whole thing runs in your browser: Piper TTS for the voice, ffmpeg.wasm for rendering, DeepSeek/OpenAI for the story writing. No server, no install.

## Running it

```bash
node server.js
```

Then open http://localhost:8123. Or double-click `Open AITAH Creator Web.command`, which does the same thing and opens the browser for you.

Or just use the deployed version: https://youraveragecow.github.io/Slopdaddy/

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
- Reasonable expectations

## Known limitations

- Caption sync is "close enough", not frame-perfect
- Browser-based rendering is slower than native ffmpeg for longer videos
- It's vibe-coded, so treat it accordingly

## License

Do whatever. 
