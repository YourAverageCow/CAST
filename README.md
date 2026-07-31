# Slopdaddy

An AI slop video factory for making AITAH story videos. 

## About

This project was completely vibe-coded, built in an afternoon, It's held together by:

- a browser WASM engine the size of a small OS
- zero tests
- commit messages nobody was paying attention to

It works. Probably. 

## What it does

Generates or Turns your AITAH Reddit stories into narrated videos with captions on a background clip, as seen on your favorite doom scrolling platform 

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

Do whatever. 
