# AITAH Video Creator — Web Version

A fully client-side version that runs 100% in the browser:
- **No server, no install** — everything runs locally in your browser
- **Story generation** — DeepSeek / OpenAI API called directly from the browser
- **TTS** — Piper neural TTS running in-browser via WASM (free, no server)
- **Video rendering** — ffmpeg.wasm renders the MP4 with burned-in captions in-browser

## Run it

```bash
python3 serve_web.py
```

Then open **http://localhost:8123**

> Note: the app must be served over HTTP (not opened as a plain `file://`) because
> the TTS/video engines load WASM + workers. The bundled `serve_web.py` handles this.
> For real deployment, upload the `web/` folder to any static host (GitHub Pages,
> Netlify, Vercel, etc.) and it works the same.

## What's in the folder

```
web/
├── index.html            # UI
├── app.js                # all browser logic
├── onnx/                 # ONNX runtime wasm (Piper TTS)
├── piper/                # piper_phonemize wasm + data (Piper TTS)
├── worker/               # piper worker scripts
└── vendor/
    ├── piper-tts-web.js  # Piper TTS engine bundle
    └── ffmpeg/           # ffmpeg.wasm (renders video in-browser)
```

## First-use downloads

On first use, the browser downloads:
- The Piper voice model (~60MB) from HuggingFace
- (ffmpeg.wasm ~25MB is bundled locally)

These are cached by the browser after the first time.

## Limitations vs. the desktop version

- TTS quality: Piper is good, slightly below Edge TTS
- Video rendering runs in JS (WASM) so it's slower than native ffmpeg for long videos
- The API key is entered in Settings and only used for direct browser calls to your chosen provider
