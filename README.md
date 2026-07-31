# Slopdaddy

A totally real, 100% production-ready AI video factory. Don't read too much into the name.

## ⚠️ IMPORTANT: Do not use this

Seriously. This was **vibe-coded** — dragged into existence by an AI assistant one questionable prompt at a time over the course of an afternoon. It is held together with:

- dueling Python modules that argue about who owns the prompts
- a browser WASM engine bigger than your operating system
- exactly zero tests
- commit messages written by someone who was clearly not paying attention

Do I recommend using it? No. I recommend you look at it, laugh, and then go find an actual product. This is the software equivalent of a car held together with duct tape and optimism.

## What it does

It mass-produces "AITAH" Reddit stories with dramatic AI narration and TikTok-style captions burned onto a background video. You know, content. The kind that makes you question humanity. Slopdaddy's right in the name.

It's a "vibecoded" project in the purest sense:
- The captions are synced to the audio using timestamps we fully believe are correct (they are not)
- The TTS runs in your browser because installing Python on the server was "too much work"
- There's a `desktop/` folder with an older, different version that also kind of works
- Everything is over-engineered, under-tested, and vibe-forward

## Running it

```bash
python3 serve_web.py
```

Then open http://localhost:8123. If something breaks, that's intended behavior.

## Live on GitHub Pages

It's deployed at https://youraveragecow.github.io/Slopdaddy/ — because why not let the whole world experience this.

## Requirements

- A web browser that believes in you
- An OpenAI-compatible API key you're willing to throw at DeepSeek
- A background video (Subway Surfers gameplay recommended)
- Low standards (non-negotiable)

## Known issues

- All of them
- The captions might drift
- The video render is slow because it's literally running ffmpeg in your browser
- The "it just works" promise does not extend to this project

## Disclaimer

If you use this and go viral, great. If you use this and lose followers, that's on you. If you use this at all, that's on you. This project was built to prove a point and the point was "we can", not "we should".

© vibecoded by YourAverageCow. No refunds.
