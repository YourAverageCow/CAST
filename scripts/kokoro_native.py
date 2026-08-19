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
import re
import sys

import numpy as np
import soundfile as sf
from kokoro import KPipeline

# Same sentence-boundary split used by the browser build (web/lib/tts-engines.js's
# KokoroEngine) so both backends bound how much text one pipeline() chunk
# receives at once, consistent with the model's known token-limit behavior.
SPLIT_PATTERN = r"\n+|(?<=[.!?])\s+"

# KPipeline's own 510-phoneme budget (see kokoro/pipeline.py's en_tokenize)
# doesn't reset at our SPLIT_PATTERN boundaries when the whole story is
# handed to one pipeline(text, split_pattern=SPLIT_PATTERN) call — it just
# keeps accumulating tokens across sentence after sentence until the budget
# runs out, then cuts wherever that happens to land, which is often mid-
# sentence rather than at a period. Splitting the text ourselves first and
# calling pipeline() once per resulting segment (split_pattern=None, so
# there's nothing left for it to further split on) resets that budget at
# every real sentence/paragraph boundary, so a cut can only ever land
# mid-sentence for one single sentence that's itself implausibly long
# (still possible in principle, but no longer the common case).


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--text-file", required=True)
    p.add_argument("--voice", required=True)
    p.add_argument("--lang", required=True)
    p.add_argument("--speed", type=float, default=1.0)
    p.add_argument("--out", required=True)
    p.add_argument("--threads", type=int, default=0)
    args = p.parse_args()

    if args.threads > 0:
        # torch is a transitive dependency of kokoro — set its thread budget
        # before constructing KPipeline so N concurrent invocations (see
        # server.js's threadBudget()) don't each try to grab every core.
        import torch
        torch.set_num_threads(args.threads)

    with open(args.text_file, "r", encoding="utf-8") as f:
        text = f.read()

    segments = [s for s in re.split(SPLIT_PATTERN, text.strip()) if s.strip()]

    pipeline = KPipeline(lang_code=args.lang)
    words = []
    chunks = []
    offset = 0.0
    sample_rate = 24000
    for segment in segments:
        for result in pipeline(segment, voice=args.voice, speed=args.speed, split_pattern=None):
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
