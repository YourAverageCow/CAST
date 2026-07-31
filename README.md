# Slopdaddy

An AI video factory for making AITAH story videos. Name checks out.

## About

This project was vibe-coded — built with an AI assistant in an afternoon, one questionable prompt at a time. It's held together by:

- a browser WASM engine the size of a small OS
- zero tests
- commit messages nobody was paying attention to

It works. Probably. We did not put a "probably" in the production docs because there are no production docs.

## What it does

Turns AITAH Reddit stories into narrated videos with captions burned onto a background clip. If you've seen those AI voiceover videos on TikTok, this is the machine behind them.

The whole thing runs in your browser: Piper TTS for the voice, ffmpeg.wasm for rendering, DeepSeek/OpenAI for the story writing. No server, no install.

## Running it

```bash
python3 serve_web.py
```

Then open http://localhost:8123.

Or just use the deployed version: https://youraveragecow.github.io/Slopdaddy/

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

Do whatever. No refunds.
