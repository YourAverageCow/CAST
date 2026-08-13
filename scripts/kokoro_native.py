#!/usr/bin/env python3
# Invoked via `uvx --with kokoro --with soundfile python3 kokoro_native.py ...` —
# see server.js's runNativeKokoro(). Uses the official Python `kokoro` package
# (hexgrad/Kokoro-82M, the same model the browser's kokoro-js/ONNX build uses)
# via its KPipeline, which exposes real per-word start_ts/end_ts derived
# directly from the model's own predicted phoneme durations during synthesis —
# not a separate ASR transcribe-and-align step, so there's nothing for the
# words to mismatch against.
import argparse
import json
import sys

import numpy as np
import soundfile as sf
from kokoro import KPipeline

# Same sentence-boundary split used by the browser build (web/lib/tts-engines.js's
# KokoroEngine) so both backends bound how much text one pipeline() chunk
# receives at once, consistent with the model's known token-limit behavior.
SPLIT_PATTERN = r"\n+|(?<=[.!?])\s+"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--text-file", required=True)
    p.add_argument("--voice", required=True)
    p.add_argument("--lang", required=True)
    p.add_argument("--speed", type=float, default=1.0)
    p.add_argument("--out", required=True)
    args = p.parse_args()

    with open(args.text_file, "r", encoding="utf-8") as f:
        text = f.read()

    pipeline = KPipeline(lang_code=args.lang)
    words = []
    chunks = []
    offset = 0.0
    sample_rate = 24000
    for result in pipeline(text, voice=args.voice, speed=args.speed, split_pattern=SPLIT_PATTERN):
        if result.audio is None:
            continue
        audio = result.audio.numpy().astype(np.float32)
        if result.tokens:
            for t in result.tokens:
                if t.start_ts is None or t.end_ts is None:
                    continue
                words.append({"text": t.text, "start": offset + t.start_ts, "end": offset + t.end_ts})
        chunks.append(audio)
        offset += len(audio) / sample_rate

    audio = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
    sf.write(args.out, audio, sample_rate)
    # Real stdout contract with runNativeKokoro(): the LAST line of stdout is
    # the JSON metadata payload — everything kokoro/spacy/torch may have
    # printed before it (warnings, HF download progress) is ignored.
    print(json.dumps({"words": words, "durationSec": len(audio) / sample_rate}))


if __name__ == "__main__":
    main()
